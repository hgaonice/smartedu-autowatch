// ==UserScript==
// @name         智慧教育平台 · 反暂停挂课助手
// @namespace    smartedu-autowatch
// @version      0.1.0
// @description  屏蔽切窗口/切标签页导致的视频自动暂停；自动播放下一节；倍速；学时上报嗅探；内置侦察模式
// @author       local
// @match        *://basic.smartedu.cn/*
// @match        *://*.zxx.edu.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 设计说明（为什么不是简单地把 pause 干掉）
 * ---------------------------------------------------------------
 * 平台至少叠了 4 层防御：
 *   1. document.visibilitychange -> video.pause()
 *   2. window.blur / onblur      -> video.pause()
 *   3. Chrome 后台标签页节流      -> rAF 停止 / timer 限 1s / 5min 后 intensive throttle
 *   4. 防挂机心跳 setInterval(1000)-> 校验 currentTime 是否推进
 * 只破 1、2 层时窗口是"不暂停了"，但学时依然不涨 —— 因为第 3、4 层让上报失效。
 * 因此本脚本分四块，缺一不可：
 *   M1 反暂停   : 伪造 visibility + 拦截事件注册 + 有条件劫持 pause + 自动恢复播放
 *   M2 防节流   : Web Lock 免疫 intensive throttling + 可选 keep-alive 音频
 *   M3 自动播放 : 自动下一节 / 关弹窗 / 倍速
 *   M4 学时核对 : 嗅探上报接口，本地累计时长 vs 平台已学时长
 * 另内置侦察模式（Ctrl+Alt+D）——先用它把真实触发源抓出来，再谈修。
 */

(function () {
  'use strict';

  // ============================================================
  //  0. 防止重复注入
  // ============================================================
  if (window.__SMARTEDU_AUTOWATCH__) return;

  // ============================================================
  //  1. 配置
  // ============================================================
  const CONFIG = {
    // --- M1 反暂停 ---
    blockFocusEvents: true,   // 拦截 document/window 上的 visibilitychange/blur 注册
    fakeVisibility: true,     // 伪造 document.hidden=false / visibilityState='visible'
    blockPause: true,         // 劫持 HTMLMediaElement.prototype.pause
    autoResume: true,         // 发现被暂停就自动恢复播放
    resumeIntervalMs: 1000,
    resumeWarnAfter: 5,       // 连续恢复失败多少次后提示（避免和目标页面死磕）

    // --- M2 防节流 ---
    holdWebLock: true,        // 用 Web Lock 让标签页豁免 intensive throttling
    keepAliveAudio: false,    // 用超声频振荡器让 Chrome 认为是"正在播放音频"的标签页
    keepAliveFreq: 20000,     // 20kHz，基本听不见

    // --- M3 自动播放 ---
    playbackRate: 2,          // 默认 2x（用户选定）
    autoNext: true,           // 看完自动下一节
    nextDelayMs: 2500,        // 结束后等多久再点下一节（留给上报时间）
    autoDismissModal: true,   // 自动点"我知道了/确定"这类确认弹窗
    autoAnswerQuestion: false,// 自动答题（默认关：答题多半计分，脚本不该替你决定答案）

    // --- M4 学时核对 ---
    watchNetwork: true,
    reportEndpointHint: /(study|progress|period|duration|learn|train|course|activity)/i,
    verifyRate: true,         // 主动核对「平台已认定学时 vs 本地播放学时」
    progressPollMs: 30000,    // 轮询间隔
    // 专题侧【权威读数】：{ "<courseId>": 已学习学时, "<courseId>-status": 枚举, "<trainId>": 0 }
    //
    // ★ 为什么换掉进度接口：早先用 /v1/study_details/{rid}/{uid} 是错的 ——
    //   那里的 progress 是【状态枚举/已完成活动数】，不是秒数。拿它当“已学时长”
    //   会永远停在 2，还误报过「本地涨了 1800s 平台没动」。
    //   而且相对路径 /v1/... 在 basic.smartedu.cn 上根本没反代，实测 403 ——
    //   即旧轮询一直在静默失败，那个「平台=2」其实是被动嗅探来的。
    //
    // ★ 必须写【绝对地址】：各微服务不在同一个 host 上（实测 plain fetch 200，
    //   带 credentials 反而 CORS 挂）。
    periodApi:
      'https://elearning-train-api.ykt.eduyun.cn/v1/users/{uid}/trains/{tid}/courses_period/actions/list',
    identityApi: 'https://x-user-connect-api.ykt.eduyun.cn/v1/users/identities?edu_stage=BASIC_EDU',
    trainId: null,            // 宿主注入（或油猴下手填）：专题 id
    trainCaps: null,          // 宿主注入：{courseId: max_period}，把「已学习」截成「已认定」

    // --- 运行时 ---
    noUI: false,              // headless / CDP 模式下由外部置 true
    statePushMs: 2000,        // 向宿主（Playwright）推送状态的间隔
  };

  // 允许宿主（Playwright addInitScript / CDP Runtime.evaluate）在注入前覆盖配置
  if (window.__SMARTEDU_CONFIG__ && typeof window.__SMARTEDU_CONFIG__ === 'object') {
    for (const [k, v] of Object.entries(window.__SMARTEDU_CONFIG__)) {
      if (k in CONFIG) CONFIG[k] = v;
    }
  }

  // ============================================================
  //  2. 基础设施 / 状态
  // ============================================================
  const TAG = '[SMARTEDU]';
  const S = {
    pauseBlocked: 0,
    pauseBlockedByVisibility: 0,
    resumeAttempts: 0,
    resumeFails: 0,
    eventsDropped: [],
    pauseStacks: [],          // 侦察：谁在暂停
    netLog: [],               // 侦察：全量网络
    reportLog: [],            // 学时上报
    localWatchedSec: 0,
    platformWatchedSec: null,
    // ★ 专题侧权威学时（单位=学时，和 max_period 同量纲）。
    //   早先这里存的是 study_details.progress —— 那是状态枚举，量纲是错的。
    //   现在 platform_watched_sec 由 platform_period × 3600 得出，字段名才名副其实。
    platformPeriod: null,     // 本课「已学习」学时
    trainEarnedPeriod: null,  // 专题「已认定」合计学时（按 max_period 截断后求和）
    periodMap: null,          // 全专题原始 map
    periodNote: '',           // 上一次轮询的结果说明（ok / 失败原因），给日志和宿主看
    // 学时核对：墙钟 vs 媒体时间（2x 下 1 秒墙钟 = 2 秒媒体）
    watchedWallSec: 0,
    watchedMediaSec: 0,
    platformProgress: null,
    progressSamples: [],      // [{at, wall, media, platform, key}] → 算倍速是否被认可
    userId: null,             // 从平台自己的上报请求体里学出来
    resourceId: null,
    lastPollAt: 0,
    lastReportAt: 0,
    // 本节「播完」的边界信号：每次 video 'ended' 自增。
    // 宿主（run.mjs）靠它实现「学时挂够了也要先把本节播完再切课」——
    // 否则切点落在活动中间，这一节可能不被平台计入学时。
    activityEndedCount: 0,
    lastEndedAt: 0,
    recon: false,
    userPaused: false,
    userIntentUntil: 0,
    finished: false,
    startedAt: Date.now(),
  };
  window.__SMARTEDU_AUTOWATCH__ = { config: CONFIG, state: S, dump: dumpRecon, snapshot };

  /** 状态快照：既给人看，也给 Playwright 宿主读 */
  function snapshot() {
    const v = video();
    return {
      at: Date.now(),
      href: location.href,
      hasVideo: !!v,
      currentTime: v ? +v.currentTime.toFixed(2) : null,
      duration: v && Number.isFinite(v.duration) ? +v.duration.toFixed(2) : null,
      paused: v ? v.paused : null,
      ended: v ? v.ended : null,
      readyState: v ? v.readyState : null,
      mediaError: v && v.error ? { code: v.error.code, message: v.error.message } : null,
      playbackRate: v ? v.playbackRate : null,
      paused_blocked: S.pauseBlocked,
      resume_attempts: S.resumeAttempts,
      resume_fails: S.resumeFails,
      local_watched_sec: S.localWatchedSec,
      platform_watched_sec: S.platformWatchedSec,
      watched_wall_sec: Math.round(S.watchedWallSec),
      watched_media_sec: Math.round(S.watchedMediaSec),
      platform_progress: S.platformProgress,
      // ★ 平台权威学时：宿主靠它决定「本课还差多少」「该不该跳过」「够没够 10 学时」
      platform_period: S.platformPeriod,
      train_earned_period: S.trainEarnedPeriod,
      period_note: S.periodNote,
      rate_verdict: rateVerdict(),
      last_report_ms_ago: S.lastReportAt ? Date.now() - S.lastReportAt : null,
      // 活动边界信号：宿主用它决定「何时才允许切下一门课」
      activity_ended_count: S.activityEndedCount,
      last_ended_ms_ago: S.lastEndedAt ? Date.now() - S.lastEndedAt : null,
      really_hidden: reallyHidden(),
      user_paused: S.userPaused,
      finished: S.finished,
      fake_visibility: CONFIG.fakeVisibility,
    };
  }

  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // 在覆盖之前抓住原生实现，脚本自己需要知道"真实"的可见性
  const native = {
    visibilityState: Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState'),
    hidden: Object.getOwnPropertyDescriptor(Document.prototype, 'hidden'),
    webkitVisibilityState: Object.getOwnPropertyDescriptor(Document.prototype, 'webkitVisibilityState'),
    webkitHidden: Object.getOwnPropertyDescriptor(Document.prototype, 'webkitHidden'),
    addEventListener: EventTarget.prototype.addEventListener,
    removeEventListener: EventTarget.prototype.removeEventListener,
    pause: HTMLMediaElement.prototype.pause,
    play: HTMLMediaElement.prototype.play,
    videoPause: window.HTMLVideoElement && HTMLVideoElement.prototype.pause,
    setInterval: window.setInterval,
    fetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
  };

  /** 读取真实（未被伪造）的后台状态，脚本自用 */
  function reallyHidden() {
    try {
      return native.hidden ? native.hidden.get.call(document) : false;
    } catch { return false; }
  }

  // ============================================================
  //  3. M1 · 伪造可见性（最高优先级，必须在页面脚本之前）
  // ============================================================
  function installVisibilitySpoof() {
    if (!CONFIG.fakeVisibility) return;
    const defs = [
      ['visibilityState', 'visible'],
      ['hidden', false],
      ['webkitVisibilityState', 'visible'],
      ['webkitHidden', false],
    ];
    for (const [prop, value] of defs) {
      try {
        Object.defineProperty(document, prop, {
          get: () => value,
          set: () => {},
          configurable: true,
          enumerable: true,
        });
      } catch { /* 某些环境下是只读的，忽略 */ }
    }
    // 兜底：万一上面没生效，也在 prototype 上再盖一层
    try {
      Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    } catch {}
    log('已伪造可见性（页面将始终认为自己在前台）');
  }

  // ============================================================
  //  4. M1 · 拦截前台/后台事件注册
  // ============================================================
  const FOCUS_EVENTS = new Set([
    'visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange', 'msvisibilitychange',
    'blur', 'pagehide', 'freeze', 'pageshow',
  ]);

  function isDocOrWin(t) { return t === document || t === window || t === document.body; }

  function installEventBlocker() {
    if (!CONFIG.blockFocusEvents) return;

    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if (FOCUS_EVENTS.has(type) && isDocOrWin(this)) {
        if (S.recon) {
          S.eventsDropped.push({ type, stack: stackOf(), at: Date.now() });
          log(`[侦察] 拦截事件注册: ${type}\n${stackOf()}`);
        }
        return;
      }
      return native.addEventListener.call(this, type, listener, opts);
    };
    // 保持 toString 伪装，避免被检测
    EventTarget.prototype.addEventListener.toString = () => native.addEventListener.toString();

    // 吞掉 on* 属性赋值：window.onblur = fn / document.onvisibilitychange = fn
    for (const [target, prop] of [[window, 'onblur'], [window, 'onfocus'],
                                  [document, 'onvisibilitychange'],
                                  [window, 'onpagehide'], [window, 'onpageshow']]) {
      try {
        Object.defineProperty(target, prop, {
          get: () => null,
          set: () => { if (S.recon) S.eventsDropped.push({ type: prop, stack: stackOf(), at: Date.now() }); },
          configurable: true,
        });
      } catch {}
    }
    log('已拦截 visibilitychange / blur / pagehide 等前台事件注册');
  }

  function stackOf(skip = 2) {
    try {
      return (new Error().stack || '').split('\n').slice(skip, skip + 8).join('\n');
    } catch { return ''; }
  }

  // ============================================================
  //  5. M1 · 劫持 pause
  // ============================================================
  function installPauseHook() {
    if (!CONFIG.blockPause) return;

    HTMLMediaElement.prototype.pause = function () {
      if (S.recon) {
        S.pauseStacks.push({ at: Date.now(), src: this.currentTime, stack: stackOf() });
        if (S.pauseStacks.length <= 20) {
          log(`[侦察] pause() 调用 #${S.pauseStacks.length}  @${this.currentTime.toFixed(2)}s\n${stackOf()}`);
        }
      }

      const userIntent = S.userPaused || Date.now() < S.userIntentUntil;
      const ended = this.ended;
      const nothingToPause = this.currentTime === 0 && this.readyState < 2;

      if (userIntent || ended || nothingToPause) {
        return native.pause.call(this);
      }

      S.pauseBlocked++;
      if (reallyHidden()) S.pauseBlockedByVisibility++;

      // 被拦下之后，确保它真的还在播
      if (CONFIG.autoResume) queueMicrotask(() => safePlay(this));

      // 每 25 次打一条日志，避免刷屏
      if (S.pauseBlocked % 25 === 1) {
        log(`已拦截 pause() 第 ${S.pauseBlocked} 次（页面${reallyHidden() ? '确实' : '声称并未'}处于后台）`);
      }
    };

    // 某些页面直接调 HTMLVideoElement.prototype.pause，单独盖一层
    if (native.videoPause && HTMLVideoElement.prototype.pause !== HTMLMediaElement.prototype.pause) {
      HTMLVideoElement.prototype.pause = HTMLMediaElement.prototype.pause;
    }

    log('已劫持 pause()');
  }

  // 记录"用户主动想暂停"的意图：点击播放器控件、或按快捷键
  function installUserIntentDetector() {
    const CONTROLS = [
      '.vjs-play-control', '.vjs-big-play-button',
      '[class*="play-control"]', '[class*="playControl"]', '[class*="play-btn"]',
    ];
    native.addEventListener.call(document, 'click', (e) => {
      if (!e.isTrusted) return;
      const t = e.target;
      if (t && t.closest && CONTROLS.some((s) => t.closest(s))) {
        S.userIntentUntil = Date.now() + 1000;
      }
    }, true);

    native.addEventListener.call(document, 'keydown', (e) => {
      if (!e.isTrusted) return;
      // Ctrl+Alt+P 手动暂停/恢复（脚本自己的开关）
      if (e.ctrlKey && e.altKey && (e.key === 'p' || e.key === 'P')) {
        S.userPaused = !S.userPaused;
        S.userIntentUntil = Date.now() + 1000;
        const v = video();
        if (S.userPaused && v) native.pause.call(v);
        if (!S.userPaused && v) safePlay(v);
        log(S.userPaused ? '已切到「允许暂停」模式' : '已切回「禁止暂停」模式');
        renderPanel();
      }
      // Ctrl+Alt+D 侦察模式
      if (e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D')) {
        S.recon = !S.recon;
        log(S.recon ? '侦察模式已开启' : '侦察模式已关闭');
        renderPanel();
      }
      // Ctrl+Alt+E 导出侦察结果
      if (e.ctrlKey && e.altKey && (e.key === 'e' || e.key === 'E')) {
        dumpRecon(true);
      }
    }, true);
  }

  // ============================================================
  //  6. M1 · 自动恢复播放
  // ============================================================
  function video() { return document.querySelector('video'); }

  function safePlay(v) {
    if (!v || v.ended || S.userPaused) return Promise.resolve(false);
    if (!v.paused) return Promise.resolve(true);
    S.resumeAttempts++;
    const p = native.play.call(v);
    if (!p || !p.then) return Promise.resolve(true);
    return p.then(() => {
      S.resumeFails = 0;
      return true;
    }).catch((err) => {
      S.resumeFails++;
      if (S.resumeFails === CONFIG.resumeWarnAfter) {
        warn(`恢复播放连续失败 ${S.resumeFails} 次：${err && err.name}。` +
             `常见原因：① 视频被静音导致浏览器判定无声而暂停 ② 需要先点一次播放器取得用户手势` +
             ` ③ 页面本身有播放中断逻辑（用 Ctrl+Alt+D 开侦察模式看调用栈）`);
      }
      return false;
    });
  }

  function startResumeLoop() {
    if (!CONFIG.autoResume) return;
    native.setInterval.call(window, () => {
      if (S.userPaused || S.finished) return;
      const v = video();
      if (!v || v.ended) return;
      if (v.paused) safePlay(v);
      if (Math.abs(v.playbackRate - CONFIG.playbackRate) > 0.01) applyRate(v);
    }, CONFIG.resumeIntervalMs);
  }

  // ============================================================
  //  7. M2 · 防节流
  // ============================================================
  async function installThrottleGuards() {
    if (CONFIG.holdWebLock && navigator.locks) {
      try {
        // 持有一个永不放开的锁 -> Chrome 认为该页有活跃工作，豁免 intensive throttling
        navigator.locks.request('smartedu-autowatch-keepalive', () => new Promise(() => {}));
        log('已持有 Web Lock（豁免后台 intensive throttling）');
      } catch (e) { warn('Web Lock 失败:', e); }
    }

    if (CONFIG.keepAliveAudio) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.0001;
        osc.frequency.value = CONFIG.keepAliveFreq;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        const resume = () => ctx.state === 'suspended' && ctx.resume();
        native.addEventListener.call(document, 'click', resume, true);
        native.addEventListener.call(document, 'keydown', resume, true);
        resume();
        log('已启用 keep-alive 音频（让 Chrome 认为是正在播放音频的标签页）');
      } catch (e) { warn('keep-alive 音频失败:', e); }
    }
  }

  // ============================================================
  //  8. M3 · 页面适配（选择器全部可配，用多候选兜底）
  // ============================================================
  const SEL = {
    catalog: ['.tcourse-catalog', '.fish-collapse', '[class*="catalog"]', '[class*="Catalog"]'],
    item: ['.resource-item', '[class*="resource-item"]', '[class*="resourceItem"]'],
    itemActive: ['[class*="active"]', '[class*="Active"]', '[class*="playing"]'],
    // 实测真实标记（2026-09，数智素养提升）：
    //   未开始  <i class="iconfont icon_checkbox_linear" title="未开始">
    //   播放中  <div class="status-icon"><div class="index-module_running_*">…<svg class="coursePlayingIcon">
    // title 是语义字段，比 CSS Modules 哈希类名稳得多，所以放第一优先。
    itemDone: ['[title*="已完成"]', '[title*="已学完"]', '[title*="已学"]',
               '[class*="icon_checkbox_fill"]', '[class*="icon-checkbox-fill"]',
               '[class*="icon_checked"]', '[class*="completed"]', '[class*="finished"]'],
    itemPlaying: ['svg.coursePlayingIcon', '[class*="coursePlayingIcon"]',
                  '[class*="running"]', '.status-icon [class*="running"]'],
    groupHeader: ['.fish-collapse-header', '[class*="collapse-header"]', '[class*="collapseHeader"]'],
    playControl: ['.vjs-play-control', '.vjs-big-play-button', '[class*="play-control"]'],
    rateValue: ['.vjs-playback-rate-value'],
    modalConfirm: ['.fish-modal-confirm-btns .fish-btn', '[class*="modal-confirm"] .fish-btn',
                   '[class*="modalConfirm"] .fish-btn'],
    footerBtn: ['[class*="index-module_footer"] .fish-btn', '[class*="footer"] .fish-btn'],
    questionOption: ['.nqti-option', '[class*="nqti-option"]', '[class*="question"] [class*="option"]'],
  };

  function q1(sels, root) {
    root = root || document;
    for (const s of sels) {
      try {
        const el = root.querySelector(s);
        if (el) return el;
      } catch {}
    }
    return null;
  }
  function qAll(sels, root) {
    root = root || document;
    const out = [];
    for (const s of sels) {
      try { root.querySelectorAll(s).forEach((e) => { if (!out.includes(e)) out.push(e); }); } catch {}
    }
    return out;
  }

  /** 展开所有折叠的分组，这样能一次性拿到全部资源项 */
  function expandAllGroups() {
    qAll(SEL.groupHeader).forEach((h) => {
      const wrap = h.closest('[class*="collapse-item"]') || h.parentElement;
      const expanded = wrap && /active|expanded|open/i.test(wrap.className || '');
      if (!expanded) { try { h.click(); } catch {} }
    });
  }

  function collectItems() {
    const items = qAll(SEL.item);
    if (items.length) return items;
    return [];
  }

  function isDone(el) {
    for (const s of SEL.itemDone) {
      try { if (el.matches(s) || el.querySelector(s)) return true; } catch {}
    }
    return false;
  }

  /** 取条目标题（仅用于日志，截断避免刷屏） */
  function labelOf(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  }

  function currentIndex(items) {
    for (let i = 0; i < items.length; i++) {
      const cls = items[i].className || '';
      if (/active|playing|current/i.test(cls)) return i;
    }
    return -1;
  }

  function goNext() {
    const items = collectItems();
    if (!items.length) {
      warn('未识别到课程列表（选择器见 CONFIG/SEL）。请开侦察模式导出 DOM 结构。');
      return false;
    }
    const idx = currentIndex(items);
    for (let i = Math.max(idx + 1, 0); i < items.length; i++) {
      if (!isDone(items[i])) {
        log(`切换到第 ${i + 1}/${items.length} 节：${labelOf(items[i])}`);
        items[i].click();
        return true;
      }
    }
    if (idx >= items.length - 1 || items.every(isDone)) {
      S.finished = true;
      log('本页面所有资源已看完');
      renderPanel((`本页全部完成 · 拦截 pause ${S.pauseBlocked} 次`));
    } else {
      log('未找到下一个未完成项');
      // 回到列表顶部重新扫一遍（有些条目状态标记是异步刷新的）
      setTimeout(() => { S.finished = false; goNext(); }, 5000);
    }
    return false;
  }

  /**
   * 自动开场：页面加载完但还没有 <video> 时，点开第一个未完成的课件。
   * 没这一步就只能「打开课程页 → 干等」，永远不开始播。
   * 20s 窗口兜底：点完若 20s 内视频仍未出现，说明该条目有问题，允许再点一次；
   * 但只要视频已经在就立即退避，绝不跟播放中的页面抢控制权。
   */
  function autoStart() {
    if (S.finished || S.userPaused || !CONFIG.autoNext) return;
    if (video()) return;                       // 已经在播，别碰
    const items = collectItems();
    if (!items.length) return;
    const idx = items.findIndex((el) => !isDone(el));
    if (idx < 0) {
      S.finished = true;
      log('目录里已无未完成项');
      renderPanel(`本页全部完成 · 拦截 pause ${S.pauseBlocked} 次`);
      return;
    }
    if (S.__autoIdx === idx && Date.now() - S.__autoAt < 20_000) return;
    S.__autoIdx = idx;
    S.__autoAt = Date.now();
    log(`自动开场：第 ${idx + 1}/${items.length} 节 ${labelOf(items[idx])}`);
    try { items[idx].click(); } catch { /* 元素被重建则下轮再试 */ }
  }

  function applyRate(v) {
    try { v.playbackRate = CONFIG.playbackRate; } catch { return; }
    const rv = q1(SEL.rateValue);
    if (rv) rv.textContent = CONFIG.playbackRate + 'x';
  }

  function handleVideoEvents(v) {
    if (v.__smarteduBound) return;
    v.__smarteduBound = true;

    native.addEventListener.call(v, 'pause', () => {
      if (S.recon) log(`[侦察] 捕获 pause 事件 @${v.currentTime.toFixed(2)}s（未走 pause() 方法则说明是 autoplay/src 变更）`);
    });
    native.addEventListener.call(v, 'play', () => { applyRate(v); });
    native.addEventListener.call(v, 'ratechange', () => {
      if (Math.abs(v.playbackRate - CONFIG.playbackRate) > 0.01) setTimeout(() => applyRate(v), 30);
    });
    // 用「媒体时间前进量」取代「事件次数」。
    // 踩过的坑：timeupdate 每秒触发约 4 次（不是 1 次），按次数累加会把学时放大 4 倍，
    // 让 M4 学时核对完全失真。必须按 currentTime 的增量算。
    let lastT = v.currentTime;
    let lastTickAt = Date.now();
    native.addEventListener.call(v, 'seeking', () => { lastT = v.currentTime; lastTickAt = Date.now(); });
    native.addEventListener.call(v, 'timeupdate', () => {
      const now = Date.now();
      const dMedia = v.currentTime - lastT;
      const dWall = (now - lastTickAt) / 1000;
      lastT = v.currentTime;
      lastTickAt = now;
      if (S.userPaused || v.paused) return;
      // 只累计正向、非跳转的推进（dt<5 排除 seek / 切清晰度）
      if (dMedia > 0 && dMedia < 5) {
        S.watchedMediaSec += dMedia;
        S.watchedWallSec += Math.min(dWall, 5);
        S.localWatchedSec = Math.round(S.watchedMediaSec);
      }
    });
    native.addEventListener.call(v, 'ended', () => {
      S.activityEndedCount++;
      S.lastEndedAt = Date.now();
      log(`本节播放结束（本地累计 ${S.localWatchedSec}s，本节序号 ${S.activityEndedCount}）`);
      if (CONFIG.autoNext) setTimeout(() => { S.finished = false; goNext(); }, CONFIG.nextDelayMs);
    });
    applyRate(v);
  }

  /** 定期处理弹窗 + 自动下一节 + 绑定新出现的 video */
  function startPageLoop() {
    native.setInterval.call(window, () => {      // 弹窗
      const qOpt = q1(SEL.questionOption);
      if (qOpt && !CONFIG.autoAnswerQuestion) {
        // 只在第一次提示，避免刷屏
        if (!S.__qNotified) {
          S.__qNotified = true;
          warn('检测到答题弹窗 —— 默认不代答（答题多为计分项）。' +
               '需要自动选第一个选项请把 CONFIG.autoAnswerQuestion 改成 true。');
          renderPanel('⚠ 有答题弹窗，等待人工处理');
        }
      }
      if (CONFIG.autoAnswerQuestion && qOpt) { try { qOpt.click(); log('已自动选择答案'); } catch {} }

      if (CONFIG.autoDismissModal) {
        const btn = q1(SEL.modalConfirm);
        if (btn) { try { btn.click(); log('已关闭确认弹窗'); } catch {} }
      }

      // video 绑定
      const v = video();
      if (v && !v.__smarteduBound) {
        log('发现视频元素，开始接管');
        handleVideoEvents(v);
        // 计数器**不重置**：平台进度是按课程累计的，重置会让 M4 比值算错
      }

      // 学时核对：主动问一次平台侧进度
      pollPlatformProgress();

      // 没有任何视频在播时，自动点开第一个未完成课件（否则只会干等）
      autoStart();
      // 页码变化 -> 重置状态
      if (location.href !== S.__href) {
        S.__href = location.href;
        S.finished = false;
        S.__qNotified = false;
        S.__autoIdx = -1;
        setTimeout(expandAllGroups, 1500);
      }

      // 向宿主推送状态（Playwright / CDP 模式）；浏览器直用时 __SMARTEDU_ON_STATE__ 不存在，跳过
      if (typeof window.__SMARTEDU_ON_STATE__ === 'function') {
        try { window.__SMARTEDU_ON_STATE__(snapshot()); } catch { /* 宿主不可用则忽略 */ }
      }
    }, 2000);
  }

  // ============================================================
  //  9. M4 · 学时上报嗅探
  // ============================================================
  function interestingUrl(u) {
    return CONFIG.reportEndpointHint.test(String(u));
  }

  function recordReport(entry) {
    if (S.recon) {
      S.netLog.push({ kind: entry.kind, method: entry.method, url: entry.url, status: entry.status, at: entry.at });
      if (S.netLog.length > 500) S.netLog.shift();
    }
    S.reportLog.push(entry);
    S.lastReportAt = Date.now();
    if (S.reportLog.length > 200) S.reportLog.shift();

    // 从平台**自己的**上报请求体里学出 user_id / resource_id。
    // 不猜 localStorage 的键名（那些是埋点，会变），直接抄它自己要发的东西。
    const rb = entry.requestBody || '';
    if (rb) {
      const uid = (rb.match(/"user_id"\s*:\s*"?(\d{6,})"?/) || [])[1];
      const rid = (rb.match(/"resource_id"\s*:\s*"([0-9a-fA-F-]{16,})"/) || [])[1];
      if (uid) S.userId = uid;
      if (rid) S.resourceId = rid;
    }

    // ★ 这里**不**再顺手解析响应体里的 progress。
    // study_details.progress 是【状态枚举】，拿它当“已学时长”写进 platformWatchedSec
    // 就是那个「平台=2 恒定不变」的假心跳。权威读数走 pollPlatformProgress()。
    renderPanel();
  }

  /**
   * 把「已学习」折成「已认定」。
   *
   * 平台**不单独返回已认定** —— 它是截出来的：
   *     已认定 = min(已学习, max_period)        （max_period ≤ 0 视为不限）
   * 逐条对齐专题页 UI 验证过：数智素养 4.01/上限3 → 3.00；大力弘扬 2.28/上限2 → 2.00；合计 5.00。
   */
  function certOf(learned, cap) {
    if (typeof learned !== 'number') return 0;
    return cap > 0 ? Math.min(learned, cap) : learned;
  }

  /**
   * 专题【已认定】合计。
   * ★ 两个必须排掉的坑（实测响应里真实存在）：
   *   - 以 `-status` 结尾的是状态枚举，不是学时
   *   - 以 **trainId 本身** 为键的那条是专题级计数器（实测恒为 0），混进去会污染总和
   */
  function trainEarnedPeriod(map) {
    if (!map || typeof map !== 'object') return null;
    const caps = CONFIG.trainCaps || {};
    let sum = 0;
    for (const [k, v] of Object.entries(map)) {
      if (/-status$/.test(k) || k === CONFIG.trainId) continue;
      if (typeof v !== 'number') continue;
      sum += certOf(v, Number(caps[k]));
    }
    return Math.round(sum * 100) / 100;
  }

  /**
   * 免 uid 自举：引擎不能依赖宿主注入配置（油猴模式下压根没有宿主）。
   * 先把 user_id 问出来，才拼得出 periodApi。
   */
  async function ensureUserId() {
    if (S.userId) return S.userId;
    try {
      const r = await native.fetch.call(window, CONFIG.identityApi, {
        headers: { accept: 'application/json' },
      });
      if (!r.ok) return null;
      const j = JSON.parse(await r.text());
      const arr = Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : [];
      const uid = String(arr.map((x) => x && (x.user_id ?? x.userId)).find(Boolean) ?? '');
      if (/^\d{6,}$/.test(uid)) S.userId = uid;
    } catch { /* 未登录 / 接口变动时静默 */ }
    return S.userId;
  }

  /** 记录一个采样点（去抖：同值且间隔很短就不记） */
  function noteSample(value, key) {
    const last = S.progressSamples.at(-1);
    if (last && last.platform === value && Date.now() - last.at < 5000) return;
    S.progressSamples.push({
      at: Date.now(),
      wall: Math.round(S.watchedWallSec),
      media: Math.round(S.watchedMediaSec),
      platform: value,
      key,
    });
    if (S.progressSamples.length > 80) S.progressSamples.shift();
  }

  /**
   * 平台进度增速 ÷ 墙钟增速。这是整个方案的风险点：
   *   ≈倍速(2)  → 平台认可倍速，2x 能省一半真实时间
   *   ≈1        → 平台按真实时长计，2x 白挂（必须降回 1x）
   *   ≈0 或 null → 平台压根没在记 / 样本不够，问题不在倍速
   */
  function rateVerdict() {
    const s = S.progressSamples;
    if (s.length < 2) return null;
    const a = s[0];
    const b = s.at(-1);
    const dWall = (b.at - a.at) / 1000;
    const dPlat = b.platform - a.platform;
    if (dWall < 30 || dPlat <= 0) return null;
    return { wallSec: Math.round(dWall), platformDelta: dPlat, ratio: +(dPlat / dWall).toFixed(2) };
  }

  /**
   * 主动问一次**平台权威学时**（专题侧 courses_period）。
   *
   *   platform_period      本课已学习学时  → 宿主用它算「这门课还差多少」
   *   train_earned_period  专题已认定合计  → 宿主用它判「够 10 学时了没」
   *
   * ★ 必须用**绝对地址**：各微服务不在同一个 host 上，`/v1/...` 相对路径
   *   在 basic.smartedu.cn 上根本没反代，实测直接 403（旧版就是踩了这个坑）。
   * ★ 不要带 credentials：带 'include' 实测 CORS `Failed to fetch`，不带反而 200。
   */
  async function pollPlatformProgress() {
    if (!CONFIG.verifyRate || !CONFIG.trainId) return;
    if (Date.now() - S.lastPollAt < CONFIG.progressPollMs) return;
    S.lastPollAt = Date.now();
    const uid = await ensureUserId();
    if (!uid) {
      S.periodNote = '拿不到 user_id（可能未登录）';
      return;
    }
    try {
      const url = CONFIG.periodApi.replace('{uid}', uid).replace('{tid}', CONFIG.trainId);
      const r = await native.fetch.call(window, url, { headers: { accept: 'application/json' } });
      if (!r.ok) {
        S.periodNote = `HTTP ${r.status}`;
        return;
      }
      const map = JSON.parse(await r.text());
      if (!map || typeof map !== 'object') {
        S.periodNote = '响应不是对象';
        return;
      }
      S.periodMap = map;
      S.trainEarnedPeriod = trainEarnedPeriod(map);
      S.periodNote = 'ok';
      // 本课已学习学时：map 以 courseId 为键，而 S.resourceId 正是课程 id（从平台上报体里学的）
      const mine = S.resourceId ? map[S.resourceId] : null;
      if (typeof mine === 'number') {
        S.platformPeriod = mine;
        // 对外仍以「秒」暴露，并且真做换算 —— platform_watched_sec 这才名副其实，
        // 倍速校验（秒比秒）也还成立，不会像以前那样把状态枚举当秒数。
        S.platformWatchedSec = Math.round(mine * 3600);
        S.platformProgress = S.platformWatchedSec;
        noteSample(S.platformWatchedSec, 'courses_period');
      } else {
        S.periodNote = S.resourceId ? '本课不在 map 里（已学习=0）' : '还没学到 resourceId';
      }
      if (S.recon) {
        log(
          `[学时] 本课已学习=${S.platformPeriod} 学时｜专题已认定=${S.trainEarnedPeriod}｜` +
            `本地媒体=${Math.round(S.watchedMediaSec)}s 墙钟=${Math.round(S.watchedWallSec)}s`,
        );
      }
    } catch (e) {
      S.periodNote = '异常 ' + (e && e.message);
    }
  }

  function installNetworkSniffer() {
    if (!CONFIG.watchNetwork) return;

    // fetch
    if (native.fetch) {
      window.fetch = function (...args) {
        const url = (args[0] && args[0].url) || args[0];
        const started = Date.now();
        const p = native.fetch.apply(this, args);
        p.then((res) => {
          if (S.recon || interestingUrl(url)) {
            res.clone().text().then((t) => {
              recordReport({
                kind: 'fetch', url: String(url), status: res.status,
                ms: Date.now() - started, at: Date.now(),
                requestBody: typeof args[1]?.body === 'string' ? args[1].body.slice(0, 2000) : null,
                responseText: String(t).slice(0, 4000),
              });
            }).catch(() => {});
          }
        }).catch(() => {});
        return p;
      };
    }

    // XHR
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__smartedu = { method, url: String(url), at: Date.now() };
      return native.xhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const meta = this.__smartedu;
      if (meta) {
        meta.requestBody = typeof body === 'string' ? body.slice(0, 2000) : null;
        native.addEventListener.call(this, 'loadend', () => {
          if (S.recon || interestingUrl(meta.url)) {
            let text = '';
            try { text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '[binary]'; } catch {}
            recordReport({ kind: 'xhr', method: meta.method, url: meta.url, status: this.status,
                           ms: Date.now() - meta.at, at: meta.at,
                           requestBody: meta.requestBody, responseText: String(text).slice(0, 4000) });
          }
        });
      }
      return native.xhrSend.call(this, body);
    };

    log('已挂载网络嗅探');
  }

  // ============================================================
  //  10. 侦察模式
  // ============================================================
  function domSignature() {
    const out = { video: null, candidates: {}, counts: {} };
    const v = video();
    if (v) {
      out.video = {
        src: (v.currentSrc || v.src || '').slice(0, 300),
        duration: v.duration, currentTime: v.currentTime,
        paused: v.paused, muted: v.muted, playbackRate: v.playbackRate,
        readyState: v.readyState, ended: v.ended,
        sources: [...v.querySelectorAll('source')].map((s) => s.src.slice(0, 200)),
        parentChain: (() => {
          const chain = []; let el = v;
          for (let i = 0; i < 6 && el; i++) { chain.push(el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(/\s+/).slice(0, 3).join('.') : '')); el = el.parentElement; }
          return chain;
        })(),
      };
    }
    for (const [key, sels] of Object.entries(SEL)) {
      out.candidates[key] = {};
      for (const s of sels) {
        try { out.candidates[key][s] = document.querySelectorAll(s).length; } catch { out.candidates[key][s] = 'invalid'; }
      }
    }    // fish-design 组件类名普查（改版时用这个快速找回选择器）
    const fish = new Set();
    document.querySelectorAll('[class*="fish-"], [class*="index-module"]').forEach((el) => {
      String(el.className).split(/\s+/).forEach((c) => { if (c) fish.add(c); });
    });
    out.fishClasses = [...fish].slice(0, 200);

    const items = collectItems();
    out.items = items.map((el, i) => ({
      i, text: (el.innerText || '').trim().slice(0, 60),
      cls: String(el.className).slice(0, 160), done: isDone(el),
    }));
    return out;
  }

  function dumpRecon(copyToClipboard) {
    const payload = {
      exportedAt: new Date().toISOString(),
      href: location.href,
      ua: navigator.userAgent,
      reallyHidden: reallyHidden(),
      state: {
        pauseBlocked: S.pauseBlocked,
        pauseBlockedWhileHidden: S.pauseBlockedByVisibility,
        localWatchedSec: S.localWatchedSec,
        platformWatchedSec: S.platformWatchedSec,
        eventsDropped: S.eventsDropped.slice(0, 30),
      },
      pauseStacks: S.pauseStacks.slice(0, 15),
      reportLog: S.reportLog.slice(-60),
      allNetwork: S.recon ? S.netLog.slice(-200) : '(未开启侦察模式，仅记录疑似上报接口)',
      dom: domSignature(),
    };
    const json = JSON.stringify(payload, null, 2);
    window.__SMARTEDU_RECCE__ = json;
    console.log(TAG + ' === 侦察结果 ===');
    console.log(json);
    if (copyToClipboard) {
      const done = () => renderPanel('侦察结果已复制到剪贴板');
      if (navigator.clipboard) navigator.clipboard.writeText(json).then(done).catch(() => {});
      else done();
    }
    return json;
  }

  // ============================================================
  //  11. 面板
  // ============================================================
  let __panelTimer = null;
  let panel = null;
  function renderPanel(msgOverride) {
    if (CONFIG.noUI) return;
    if (window.top !== window.self) return; // 只在顶层窗口显示
    // 节流：上报接口可能很频繁，避免每来一条就重建 DOM
    if (__panelTimer && !msgOverride) return;
    __panelTimer = setTimeout(() => { __panelTimer = null; }, 500);
    const P = ensurePanel();
    if (!P) return;

    const v = video();
    const since = S.lastReportAt ? Math.round((Date.now() - S.lastReportAt) / 1000) + 's 前' : '无';

    const stateText = S.userPaused ? '允许暂停'
      : S.finished ? '本页已完成'
      : (v && !v.paused ? '播放中' : '等待播放');
    const stateColor = S.userPaused ? '#fbbf24' : S.finished ? '#34d399' : '#60a5fa';

    P.bStatus.textContent = stateText;
    P.bStatus.style.color = stateColor;

    const dur = v && Number.isFinite(v.duration) ? v.duration.toFixed(0) + 's' : '?';
    P.lProgress.textContent = '进度：' + (v ? v.currentTime.toFixed(0) + 's / ' + dur : '无视频') +
      '　倍速 ' + CONFIG.playbackRate + 'x';

    P.lWatch.textContent = '本地累计：' + S.localWatchedSec + 's　平台侧：' +
      (S.platformWatchedSec === null ? '未捕获' : S.platformWatchedSec);

    P.lCounters.textContent = '拦截 pause：' + S.pauseBlocked + ' 次　恢复尝试：' + S.resumeAttempts;

    P.lReport.textContent = '最近上报：' + since + '　后台(真实)：' + (reallyHidden() ? '是' : '否');

    P.bRecon.textContent = S.recon ? '开' : '关';
    P.bRecon.style.color = S.recon ? '#34d399' : '#9ca3af';

    P.pauseBtn.textContent = S.userPaused ? '恢复拦截' : '允许暂停';

    P.lMsg.textContent = msgOverride || '';
    P.lMsg.style.display = msgOverride ? 'block' : 'none';
  }

  /** 面板只构建一次，之后仅改 textContent（避免每次 innerHTML 重新解析 DOM） */
  function ensurePanel() {
    if (CONFIG.noUI) return null;
    if (window.top !== window.self) return null; // 只在顶层窗口显示
    if (panel) return panel;

    const root = document.createElement('div');
    root.id = '__smartedu_panel__';
    root.style.cssText = [
      'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
      'background:rgba(17,24,39,.92)', 'color:#e5e7eb', 'font:12px/1.6 Menlo,Consolas,monospace',
      'padding:10px 12px', 'border-radius:8px', 'box-shadow:0 6px 24px rgba(0,0,0,.35)',
      'max-width:290px', 'pointer-events:auto', 'user-select:text',
    ].join(';');
    root.addEventListener('dblclick', () => { root.remove(); panel = null; });

    const mk = (tag, css, text) => {
      const n = document.createElement(tag);
      if (css) n.style.cssText = css;
      if (text !== undefined) n.textContent = text;
      return n;
    };

    root.appendChild(mk('div', 'font-weight:700;margin-bottom:6px', '智慧教育平台 · 挂课助手 v0.1.0'));

    // 带高亮值的行
    const labelled = (label) => {
      const d = document.createElement('div');
      d.appendChild(document.createTextNode(label));
      const b = document.createElement('b');
      d.appendChild(b);
      root.appendChild(d);
      return { d, b };
    };

    const status = labelled('状态：');
    const progress = mk('div');
    const watch = mk('div');
    const counters = mk('div');
    const report = mk('div');
    const recon = labelled('侦察模式：');
    root.appendChild(progress); root.appendChild(watch);
    root.appendChild(counters); root.appendChild(report); root.appendChild(recon.d);

    const btnRow = mk('div', 'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap');
    const btn = (label, action) => {
      const b = mk('button', 'cursor:pointer', label);
      b.dataset.a = action;
      btnRow.appendChild(b);
      return b;
    };
    btn('-0.5x', 'rateDown');
    btn('+0.5x', 'rateUp');
    const pauseBtn = btn('允许暂停', 'pause');
    btn('侦察开关', 'recon');
    btn('导出结果', 'dump');
    btn('下一节', 'next');
    root.appendChild(btnRow);

    const msg = mk('div', 'margin-top:6px;color:#34d399;display:none');
    root.appendChild(msg);
    root.appendChild(mk('div', 'margin-top:6px;opacity:.55',
      'Ctrl+Alt+P 暂停开关 · Ctrl+Alt+D 侦察 · Ctrl+Alt+E 导出 · 双击关闭'));

    btnRow.addEventListener('click', (ev) => {
      const b = ev.target && ev.target.closest && ev.target.closest('button[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'rateDown') CONFIG.playbackRate = Math.max(0.5, CONFIG.playbackRate - 0.5);
      if (a === 'rateUp') CONFIG.playbackRate = Math.min(16, CONFIG.playbackRate + 0.5);
      if (a === 'pause') S.userPaused = !S.userPaused;
      if (a === 'recon') S.recon = !S.recon;
      if (a === 'dump') { dumpRecon(true); return; }
      if (a === 'next') { S.finished = false; goNext(); }
      const v = video();
      if (v) applyRate(v);
      renderPanel();
    });

    document.documentElement.appendChild(root);
    panel = { root, bStatus: status.b, lProgress: progress, lWatch: watch,
              lCounters: counters, lReport: report, bRecon: recon.b, pauseBtn, lMsg: msg };
    return panel;
  }

  // ============================================================
  //  12. 启动
  // ============================================================
  installVisibilitySpoof();     // 必须最早
  installEventBlocker();
  installPauseHook();
  installNetworkSniffer();      // 也要早于页面发请求

  function boot() {
    installUserIntentDetector();
    installThrottleGuards();
    startResumeLoop();
    startPageLoop();
    setTimeout(() => {
      expandAllGroups();
      renderPanel();
    }, 2500);
    log('挂课助手已启动。默认 2x，自动下一节；Ctrl+Alt+D 开侦察模式定位真实暂停源。');
  }

  if (document.readyState === 'loading') {
    native.addEventListener.call(document, 'DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
