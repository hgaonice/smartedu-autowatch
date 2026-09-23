/**
 * 挂课主程序（Playwright + 复用系统 Chrome）。
 *
 * 与油猴脚本的关系：**共用同一份引擎**。
 * 本文件把 userscript/smartedu-autowatch.user.js 的内容通过 context.addInitScript()
 * 注入到每个 document 的 document-start，等价于油猴的 @run-at document-start。
 * 区别只在两点：
 *   1. 宿主是 Node，可以跨页面编排（自动遍历整季课程）
 *   2. 启动参数是浏览器进程级的，能真正关掉后台节流（脚本方案只能在页面内自救）
 *
 * 用法：
 *   node src/run.mjs --login                       只开浏览器，手动登录一次
 *   node src/run.mjs --train <trainId>             ★推荐：按专题挂，自动凑够学时
 *   node src/run.mjs --train <trainId> --target-hours 10
 *   node src/run.mjs --url "<课程详情页URL>"        挂单个课程（页内自动下一节）
 *   node src/run.mjs --season 2025sqpx             按季节码遍历（2025 及以前）
 *
 * 学时模型（对 2026 专题全部 11 门课验证成立）：
 *   1 学时 = 3600 秒视频；platform 的 max_period 是「本课最多计入专题的学时」
 *   2026 暑期教师研修要拿 10 个认定学时，平台允许 3 学时/真实小时（即最高 3x）
 *   → --train 模式下每门课只挂到 max_period 就换下一门，凑够 --target-hours 即停
 *
 * 通用开关：
 *   --headless          无头运行（已是默认，实测 Widevine 可用）
 *   --headful           退回有头
 *   --rate 2            倍速，默认 2
 *   --target-hours 10   目标学时，默认 10
 *   --no-next           不自动下一节（只挂当前这一节）
 *   --max-courses 3     限制本次最多挂几门课（试跑用）
 *   --dry-run           只列出将要挂的课程，不启动浏览器
 *   --keep-throttled    不关后台节流（对照实验用）
 *   --per-course-min 0   单门课硬超时（分钟）；0=按学时预算自适应（默认）
 *   --min-section-sec 120  预算在本节开头这么短的时间内达成时，不等本节播完直接切（秒）；
 *                        默认 120，0 = 关掉该规则（退回「一律等本节播完」）
 *
 * ★ 学时预算现在是【平台驱动】的：
 *   起跑先读专题侧 courses_period 拿到「已学习学时」，已认定 = min(已学习, max_period)，
 *   据此跳过已认满的课、并算出每门课还差多少。每门课收工后再读一次，
 *   用平台真值（而不是本地秒数）推进总账 —— 重启长跑也不会重复挂或过挂。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchContext, reusePage, loginState, gotoWithRetry } from './browser.mjs';
import {
  fetchSeason,
  fetchTrainPeriods,
  periodToSec,
  secToPeriod,
} from './courses.mjs';
import { getSite, SITES } from './sites/index.mjs';
import { installEngine, ENGINE_PATH, OUT_DIR, ROOT } from './engine.mjs';
import { preflight, reportPreflight } from './preflight.mjs';
// 日志出口统一脱敏：详见 src/redact.mjs （token / user_id 不得进日志与界面截图）
import { redactArgs } from './redact.mjs';

// ---------- CLI ----------
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
function arg(n, dflt = null) {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/**
 * 读一个非负数字参数，缺省/非法就回落默认值。
 * 不用 `Number(arg(x, d)) || d` —— 那样 `--x 0` 会被当成 falsy 而失效，
 * 而下面几个开关都靠 0 表示「关掉」这条规则。
 */
function numArg(n, dflt) {
  const raw = arg(n, null);
  if (raw === null || raw === true) return dflt;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

/**
 * 预算在【本节开头】这么短的时间内达成时，不再等本节播完，直接切（秒）。
 * 实测教训：`科学素养提升` 因断点续播（本节 8326s 只能再给 3543s）导致 3600s 预算
 * 在**切进第 2 节 57s 后**才达成，旧逻辑于是白等第 2 节整整 10158s（≈2.8 小时）。
 * 低于该阈值直接切。用 `--min-section-sec` 调，0 = 关掉（退回旧行为）。
 */
const MIN_SECTION_WATCH_SEC = 120;

/**
 * 视频 currentTime 连续多久不动就判定「卡住」，reload 页面自愈。
 *
 * 为什么必须有：旧版在 watchCourse 里算了 stallSince 却什么都不做（空壳分支），
 * 一旦卡住就一直干等到 deadline 报 timeout —— 无人值守挂一夜时这是最贵的一个 bug。
 * reload 是安全的：平台自己存播放位置，实测重启不从头。
 */
const STALL_RELOAD_SEC = 180;
/** 单节课内最多自愈几次；超过就放弃并报警，避免 reload 死循环把 deadline 耗光 */
const MAX_STALL_RELOADS = 3;
/**
 * reload 后必须真的越过卡住点这么远，才算「恢复了」、才允许把自愈配额归零。
 *
 * 为什么不能只看「currentTime 变了」：reload 之后 currentTime 会从 null/0 重新开始，
 * 那一帧必然「变了」，配额就被立即清零 —— MAX_STALL_RELOADS 形同虚设，
 * 卡死的课会被无限 reload（每轮 180s × 8s 间隔），一直 reload 到 deadline。
 */
const STALL_RECOVER_SEC = 30;

/**
 * reload 之后是否算「真的恢复」—— 决定自愈配额能不能归零。
 * 抽成纯函数只为一件事：这条判断错一次就是无限 reload，必须能单测。
 *
 * @param {number|null|undefined} stuckAt 上次卡住时的 currentTime（没卡过则 null/undefined）
 * @param {number|null} currentTime 当前 currentTime
 * @returns {boolean} true = 已越过卡住点 STALL_RECOVER_SEC 以上，或压根没卡过
 */
export function stallRecovered(stuckAt, currentTime) {
  if (stuckAt === null || stuckAt === undefined) return true; // 没卡过 → 无配额限制
  if (typeof currentTime !== 'number') return false; // 读不到进度 → 不算恢复
  return currentTime > stuckAt + STALL_RECOVER_SEC;
}

const OPTS = {
  login: has('login'),
  // 挂课类型（站点适配器 id）。只有一个时不用传；将来多个类型时由 UI/配置决定。
  site: arg('site'),
  list: has('list'),
  // 无头已是默认（实测 Widevine 可用，见 src/browser.mjs 的 ignoreDefaultArgs 注释）
  // --headful 退回有头；--login 必须有头（要手动输账号）
  headless: !has('headful') && !has('login'),
  dryRun: has('dry-run'),
  autoNext: !has('no-next'),
  keepThrottled: has('keep-throttled'),
  url: arg('url'),
  course: arg('course'), // --url 的别名，语义更清楚；两者等价
  season: arg('season'),
  train: arg('train'),
  targetHours: Number(arg('target-hours', 10)) || 10,
  rate: Number(arg('rate', 2)) || 2,
  maxCourses: Number(arg('max-courses', 0)) || 0,
  perCourseMin: Number(arg('per-course-min', 0)) || 0,
  // 0 = 关掉「本节刚开头就切」这条规则（退回一律等本节播完）
  minSectionSec: numArg('min-section-sec', MIN_SECTION_WATCH_SEC),
  // 只挂勾选的课（逗号分隔 courseId）；Web UI 的「展开勾选」用它
  only: arg('only'),
};

// 站点适配器（URL 模板、专题目录、列表来源、学时接口全在里面）
const site = getSite(OPTS.site);

// ---------- 输出 ----------
const t0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...redactArgs(a));
const warn = (...a) => console.warn(`[${stamp()}] ⚠️ `, ...redactArgs(a));

const report = {
  startedAt: new Date().toISOString(),
  options: OPTS,
  courses: [],
  problems: [],
};

let lastStatusLen = 0;
function status(text) {
  const pad = Math.max(0, lastStatusLen - text.length);
  process.stdout.write(`\r${text}${' '.repeat(pad)}`);
  lastStatusLen = text.length;
}

function saveReport() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  report.finishedAt = new Date().toISOString();
  report.elapsedSec = Math.round((Date.now() - t0) / 1000);
  fs.writeFileSync(p, JSON.stringify(report, null, 2), 'utf8');
  return p;
}

// ---------- 页面状态读取 ----------
async function readState(page) {
  try {
    return await page.evaluate(() => {
      const api = window.__SMARTEDU_AUTOWATCH__;
      if (!api) return { engineMissing: true };
      return api.snapshot();
    });
  } catch {
    // 页面正在导航时 evaluate 会抛，属于正常情况
    return null;
  }
}

/** 挂够学时后，最多再等多久（秒）让本节播完；超了就直接切，免得卡死 */
const OVERWATCH_MAX_SEC = 1800;

/**
 * 预算若是在【本节开头】这么短的时间内达成的，就不值得为「活动边界」再等一整节。
 *
 * 依据：平台只在【整节活动看完】时记已学习学时，所以本节已挂的秒数 ≈ 切换要放弃的秒数。
 * 实测教训：`科学素养提升` 因断点续播（本节 8326s 只能再给 3543s）导致 3600s 预算
 * 在**切进第 2 节 57s 后**才达成，旧逻辑于是白等第 2 节整整 10158s（≈2.8 小时）。
 * 低于该阈值直接切（阈值由 `--min-section-sec` 控制，默认 MIN_SECTION_WATCH_SEC）。
 */

/**
 * 「学时够了之后，什么时候真正切课」的纯决策函数。
 *
 * 从 watchCourse 里抽出来是为了可回归测试 —— 这个状态机已经错过两次：
 *   1) `out/report-2026-…-05-45-23.json`：为等活动边界白挂 0.07 学时；
 *   2) `out/run-10h.log`：断点续播让预算在【切进下一节 57s 后】才达成，旧逻辑于是
 *      白等第 2 节整节 10158s（≈2.8 小时），而平台早已「已学习 3.08 ≥ 上限 1」。
 * 回归用例见 tools/test-stop-logic.mjs。
 *
 * 平台记账规则（实测，见 docs/recce.md §5.6）：只在【整节活动看完】时把时长计入
 * 「已学习学时」。所以「等边界」本身是为了不白挂本节；但本节基本没挂、或平台已经
 * 说到位时，再等就是纯浪费。
 *
 * @param {object} st 跨帧可变状态 {pendingStop, endedAtBudget, overshootFrom, gainedAtActivityStart, lastEndedCount}
 * @param {object} s  引擎快照（readState 返回值）
 * @param {object} b  {courseBudgetSec, globalBudgetSec, globalEarnedSec, platformTargetPeriod, minSectionSec}
 * @returns {{state:object, endedCount:number|null, gained:number, remainMedia:number|null,
 *            action:'continue'|'stop', note:string|null, onSet:string|null}}
 */
export function decideStop(st, s, b) {
  const gained = s.watched_media_sec || 0;
  // 「本节刚开头就切」的阈值：调用方不传就用自己的默认值（纯函数自包含，测试好写）
  const minSectionSec = b.minSectionSec ?? MIN_SECTION_WATCH_SEC;
  const endedCount = typeof s.activity_ended_count === 'number' ? s.activity_ended_count : null;
  // 本节还剩多少【媒体秒】没播完。平台按【整节看完】计学时，
  // 所以这个数字才决定「还要等多久才能切」—— 见下面的 overshootCap。
  const remainMedia =
    typeof s.duration === 'number' && typeof s.currentTime === 'number' && s.duration > s.currentTime
      ? s.duration - s.currentTime
      : null;
  const state = { ...st };

  // 跨过活动边界 → 本节起点重算（「本节已挂多久」= gained - gainedAtActivityStart）
  if (endedCount !== null && (state.lastEndedCount === null || endedCount > state.lastEndedCount)) {
    state.gainedAtActivityStart = gained;
    state.lastEndedCount = endedCount;
  }

  // ---- 学时预算：挂够了【不立刻切】，先裁定切点 ----
  // 三个触发条件，任一个成立就算「够了」：
  //   1) 本地媒体秒数到本课预算（max_period 限制 / 全局缺口）
  //   2) 本地+已认定 到全局目标
  //   3) ★平台已学习学时到位 —— 最权威，平台说够了就是够了
  let onSet = null;
  const certMet =
    b.platformTargetPeriod !== null &&
    typeof s.platform_period === 'number' &&
    s.platform_period >= b.platformTargetPeriod;
  if (
    !state.pendingStop &&
    (gained >= b.courseBudgetSec || b.globalEarnedSec + gained >= b.globalBudgetSec || certMet)
  ) {
    const atTarget = certMet || b.globalEarnedSec + gained >= b.globalBudgetSec;
    state.pendingStop = certMet ? 'platform_met' : atTarget ? 'target_met' : 'course_budget_met';
    state.endedAtBudget = endedCount;
    state.overshootFrom = gained;
    // ★ 等待上限必须在这里【一次性算好】，不能每帧用 remainMedia 重算。
    // remainMedia 随播放递减，`overshoot >= remainMedia + 300` 于是退化成
    // 「走过剩余时长的一半」：实测第 1 节 5811s。预算 3600s 达成时剩 2211s，
    // 旧写法在 overshoot=1800（还剩 411s）时就强行切走 —— 而平台只把「整节看完」
    // 的时长计入已学习学时，中途切走 = 这一整节彻底白挂。
    // 固定成「达成那一刻的剩余时长 + 300s 余量」才是字面意思：等到本节播完。
    state.overshootCap = remainMedia === null ? OVERWATCH_MAX_SEC : remainMedia + 300;
    onSet =
      `${
        certMet
          ? `平台已学习学时到 ${s.platform_period}`
          : `已挂 ${secToPeriod(gained)} 学时（${atTarget ? '达总目标' : '达本课上限'}）`
      }，预算达成（当前是第 ${(endedCount ?? 0) + 1} 节，接着裁定切点）`;
  }

  const out = (action, note) => ({
    state,
    endedCount,
    gained,
    remainMedia,
    action,
    note,
    onSet,
  });
  if (!state.pendingStop) return out('continue', null);

  const overshoot = gained - state.overshootFrom;
  const watchedThisSection = gained - state.gainedAtActivityStart;

  // ① 平台自己说已学习学时到位了 —— 认定已完成，本节剩下的秒数记不记都无所谓，直接切。
  //    旧逻辑把这跟别的条件一样丢去「等本节播完」，于是「刚切进下一节才达成上限」时
  //    要白等一整节（实测：科学素养提升切进第 2 节 57s 后达成上限 → 白等 10158s）。
  if (state.pendingStop === 'platform_met') {
    return out(
      'stop',
      `平台已学习学时到 ${s.platform_period}（本课认定已到位），不等本节播完，直接切` +
        `（本节只挂了 ${Math.round(watchedThisSection)}s，放弃不影响认定）`,
    );
  }

  // ② 预算是在【本节刚开头】达成的 —— 本节几乎没挂，等一整节播完等于白等。
  //    断点续播最容易踩这里：本节能提供的秒数 < 还有多少预算，于是预算在下一节开头才到。
  //    minSectionSec=0 时关掉这条规则（退回「一律等本节播完」）。
  if (minSectionSec > 0 && watchedThisSection <= minSectionSec) {
    return out(
      'stop',
      `预算刚在本节开头达成（本节只挂了 ${Math.round(watchedThisSection)}s ≤ ` +
        `${minSectionSec}s），不等活动边界，直接切`,
    );
  }

  if (state.endedAtBudget === null) {
    // 旧版引擎没这个字段 —— 退回立即切换，不把整个跑批拖死
    return out('stop', '引擎未提供 activity_ended_count（旧版引擎），只能立即切换');
  }
  if ((endedCount ?? 0) > state.endedAtBudget) {
    return out('stop', `本节已播完（活动边界），共挂 ${secToPeriod(gained)} 学时`);
  }
  if (s.finished) {
    return out('stop', `页面已全部完成，共挂 ${secToPeriod(gained)} 学时`);
  }
  // 本节其实已经播到底了（currentTime 追平 duration，于是 remainMedia 归 null）。
  // 不单列的话会落到下面的「超时强行切」分支，报告里就会出现自相矛盾的备注。
  if (
    remainMedia === null &&
    typeof s.currentTime === 'number' &&
    typeof s.duration === 'number' &&
    s.duration > 0 &&
    s.currentTime >= s.duration - 1
  ) {
    return out('stop', `本节已播到底（${Math.round(s.duration)}s），共挂 ${secToPeriod(gained)} 学时`);
  }
  // ★ 上限见上面 state.overshootCap 的注释：它是「挂够那一刻」定下的常量。
  // 只有真正的异常才走到这里（本节迟迟不结束 / remainMedia 未知）。
  const overshootCap = state.overshootCap ?? OVERWATCH_MAX_SEC;
  if (overshoot >= overshootCap) {
    return out(
      'stop',
      `等活动边界已超时（多挂了 ${secToPeriod(overshoot)} 学时，本节还剩 ` +
        `${remainMedia === null ? '?' : Math.round(remainMedia)}s 未播完），强行切换`,
    );
  }
  return out('continue', null);
}

/** 单门课：等它自动播完，期间持续监测「学时是否真的在涨」+ 预算到了先等本节播完再切 */
async function watchCourse(page, course, deadline, budget = {}) {
  const courseBudgetSec = budget.courseBudgetSec ?? Infinity;
  const globalBudgetSec = budget.globalBudgetSec ?? Infinity;
  const globalEarnedSec = budget.globalEarnedSec ?? 0;
  // 平台侧目标：本课「已学习学时」到这个数就算认定到位。
  // 比本地秒数权威 —— 已认定 = min(已学习, max_period)，本地多挂平台也不会再涨。
  const platformTargetPeriod = budget.platformTargetPeriod ?? null;
  const rec = {
    courseId: course.courseId,
    title: course.title,
    url: course.url,
    startedAt: new Date().toISOString(),
    engineInjected: false,
    videoSeen: false,
    maxLocalWatchedSec: 0,
    maxPlatformWatchedSec: null,
    maxPlatformPeriod: null,
    periodNote: '',
    localGrewSec: 0,
    platformGrewSec: 0,
    pauseBlocked: 0,
    resumeFails: 0,
    mediaError: null,
    finished: false,
    outcome: 'unknown',
    notes: [],
  };

  let lastLocal = 0;
  let lastPlatform = null;
  let noVideoSince = Date.now();
  let stallSince = null;
  let stallAt = null;          // currentTime 开始不动的时刻（暂停时清空，不算卡住）
  let stallStuckAt = null;     // 卡住那一刻的 currentTime（判「真恢复」用，见 stallRecovered）
  let stallReloads = 0;        // 本节已自愈次数（**真恢复后**才归零，不是一变化就归零）
  let warnedStall = false;
  let warnedStallHard = false; // 自愈配额用尽后的「放弃」只喊一次
  let warnedNoVideo = false;
  // 「等本节播完」状态机：学时挂够 ≠ 立刻切课
  let pendingStop = null;      // 'course_budget_met' | 'target_met' | 'platform_met'
  let endedAtBudget = null;    // 挂够那一刻的 activity_ended_count
  let overshootFrom = null;    // 挂够那一刻的累计秒数
  let gainedAtActivityStart = 0; // 进入【当前这一节】那一刻的累计秒数（用于判断「本节挂了多久」）
  let lastEndedCount = null;     // 上一帧看到的 activity_ended_count（检测跨活动边界）
  let overshootCap = null;       // 挂够那一刻定下的等待上限（见 decideStop 里的注释）

  while (Date.now() < deadline) {
    const s = await readState(page);

    if (!s) { await page.waitForTimeout(3000); continue; }

    if (s.engineMissing) {
      if (!rec.engineInjected) {
        rec.notes.push('引擎未注入 —— addInitScript 可能因页面在同进程复用而未重跑');
      }
      await page.waitForTimeout(3000);
      continue;
    }
    rec.engineInjected = true;

    if (s.mediaError) {
      rec.mediaError = s.mediaError;
      rec.outcome = 'media_error';
      rec.notes.push(
        `视频解码失败 code=${s.mediaError.code}。无头模式下 code=4 通常是 Widevine DRM 缺失。`,
      );
      break;
    }

    if (s.hasVideo) {
      rec.videoSeen = true;
      noVideoSince = Date.now();
    } else if (Date.now() - noVideoSince > 60_000 && !warnedNoVideo) {
      warnedNoVideo = true;
      warn(`已 60s 未找到视频 —— 最可能是【还没登录】，或页面结构变了（课程：${course.title}）`);
      warn('  用界面：点「先登录（只需一次）」；用命令行：npm run login。');
      rec.notes.push('60s 内未出现 video 元素');
    }

    rec.pauseBlocked = s.paused_blocked;
    rec.resumeFails = s.resume_fails;
    rec.maxLocalWatchedSec = Math.max(rec.maxLocalWatchedSec, s.local_watched_sec || 0);
    if (typeof s.platform_period === 'number') {
      rec.maxPlatformPeriod = Math.max(rec.maxPlatformPeriod ?? 0, s.platform_period);
    }
    if (s.period_note) rec.periodNote = s.period_note;

    // ---- 切课时机裁定（纯函数，回归测试见 tools/test-stop-logic.mjs）----
    const d = decideStop(
      { pendingStop, endedAtBudget, overshootFrom, gainedAtActivityStart, lastEndedCount, overshootCap },
      s,
      { courseBudgetSec, globalBudgetSec, globalEarnedSec, platformTargetPeriod },
    );
    pendingStop = d.state.pendingStop;
    endedAtBudget = d.state.endedAtBudget;
    overshootFrom = d.state.overshootFrom;
    gainedAtActivityStart = d.state.gainedAtActivityStart;
    lastEndedCount = d.state.lastEndedCount;
    overshootCap = d.state.overshootCap;
    const endedCount = d.endedCount;
    if (d.onSet) rec.notes.push(d.onSet);

    if (s.platform_watched_sec !== null && s.platform_watched_sec !== undefined) {
      if (lastPlatform !== null && s.platform_watched_sec > lastPlatform) {
        rec.platformGrewSec += s.platform_watched_sec - lastPlatform;
      }
      lastPlatform = s.platform_watched_sec;
      rec.maxPlatformWatchedSec = s.platform_watched_sec;
    }

    if (s.local_watched_sec > lastLocal) {
      rec.localGrewSec += s.local_watched_sec - lastLocal;
      lastLocal = s.local_watched_sec;
    }

    // platform_watched_sec 现在是「平台已学习学时 × 3600」的真秒数（以前它是
    // study_details.progress = 【状态枚举】，量纲就是错的，所以老报警全是假的）。
    // ★ 已实测的记账规则：平台【按整节活动】计已学习学时 —— 一节没播完，挂再多也是 0。
    // 所以「本地涨了而平台没动」在【本节活动播完之前】是正常现象，不该报警；
    // 只有【已经过至少一次活动边界】之后平台仍纹丝不动，才是真异常。
    //
    // ★ 门控：必须【已经跨过至少一次活动边界】才报警。旧版只看 1800s，实测在
    //   「一节 8326s 的视频刚挂了 1801s」时 100% 误报（out/run-10h.log 里那条就是）。
    //   引擎没提供 activity_ended_count 时无从判断，退回旧行为以保证仍能发现真异常。
    const platformStuck =
      rec.localGrewSec > 1800 &&
      rec.maxPlatformWatchedSec !== null &&
      rec.platformGrewSec === 0 &&
      (endedCount === null || endedCount > 0);
    if (platformStuck && !warnedStall) {
      warnedStall = true;
      warn(
        `本地已累计 ${rec.localGrewSec}s、已跨过 ${endedCount ?? '?'} 次活动边界，` +
          `平台已学习学时却始终停在 ${rec.maxPlatformPeriod}（period_note=${rec.periodNote || 'n/a'}）。` +
          `先看日志里的「平台学时」行与 out/report-*.json。`,
      );
      rec.notes.push('本地学时跨过 1800s 且已过活动边界，平台已学习学时仍未增长');
    }

    // ---- 停滞自愈：currentTime 长时间不动 → reload 续播 ----
    // 旧版这里是空壳（算了 stallSince 什么都不做），卡住就干等到 deadline 报 timeout。
    // 卡住的常见来源：网络抖动、解码器卡死、平台侧把播放器挂起。
    if (s.paused || s.currentTime === null) {
      stallAt = null; // 暂停中本来就不推进，不算卡住
      stallSince = s.currentTime;
    } else if (s.currentTime !== stallSince) {
      stallSince = s.currentTime;
      stallAt = null;
      // ★ 配额只在「真的往前走了」之后才恢复 —— 不能一看到 currentTime 变了就归零，
      //   否则 reload 后必定归零（currentTime 从 null/0 重新开始，必然「变了」）。
      if (stallRecovered(stallStuckAt, s.currentTime)) {
        stallReloads = 0;
        stallStuckAt = null;
      }
    } else {
      stallAt ??= Date.now();
      const stuckSec = Math.round((Date.now() - stallAt) / 1000);
      if (stuckSec >= STALL_RELOAD_SEC) {
        if (stallReloads >= MAX_STALL_RELOADS) {
          if (!warnedStallHard) {
            warnedStallHard = true;
            const msg =
              `视频已卡在 ${s.currentTime}s 不动 ${stuckSec}s，自愈 ${stallReloads} 次仍未恢复 —— ` +
              `放弃本课，换下一门（继续挂下去也计不到学时）。本地=${s.local_watched_sec}s`;
            warn(msg);
            rec.notes.push(msg);
            // ★ 真的放弃，而不是只喊一句然后干等到 deadline
            //   （旧版只喊不停，一门卡死的课能白占几小时，后面几门全被拖死）。
            //   若预算其实已达成、只是在等本节播完，保留那个 outcome 更有用。
            rec.outcome = pendingStop || 'stalled';
            break;
          }
        } else {
          stallReloads += 1;
          stallStuckAt = s.currentTime; // 记下卡住位置：下次要越过它才算恢复
          warn(
            `视频卡在 ${s.currentTime}s 不动 ${stuckSec}s → 第 ${stallReloads}/${MAX_STALL_RELOADS} 次 reload 续播`,
          );
          rec.notes.push(`停滞 ${stuckSec}s（currentTime=${s.currentTime}s）→ reload #${stallReloads}`);
          stallAt = null;
          stallSince = null;
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
          } catch (e) {
            rec.notes.push(`reload 失败：${e.message}`);
          }
          // 重新注入/重跑引擎由 addInitScript 负责，这里留一点时间给播放器起来
          await page.waitForTimeout(8000);
          continue;
        }
      }
    }
    if (s.paused && s.resume_attempts > 20 && s.resume_fails > 5) {
      rec.notes.push('反复恢复播放失败 —— 见 resume_fails');
    }

    const mm = String(Math.floor((s.currentTime || 0) / 60)).padStart(2, '0');
    const ss = String(Math.floor((s.currentTime || 0) % 60)).padStart(2, '0');
    const dur = s.duration ? Math.round(s.duration) : '?';
    const gained = d.gained;
    const remainMedia = d.remainMedia;
    let waitNote = '';
    if (pendingStop) {
      waitNote =
        remainMedia === null
          ? ' ⏳学时已够，等本节播完'
          : ` ⏳学时已够，等本节播完(剩${Math.round(remainMedia)}s)`;
    }
    status(
      `  ${course.title.slice(0, 22).padEnd(22)} ${mm}:${ss}/${dur}s` +
        ` 倍速=${s.playbackRate ?? '-'}` +
        ` ${s.paused ? '⏸暂停中' : '▶播放'}` +
        ` 拦截pause=${s.paused_blocked}` +
        ` 本地=${s.local_watched_sec}s` +
        ` 平台=${s.platform_period ?? '未捕获'}学时` +
        ` 学时≈${secToPeriod(gained)}` +
        `${s.finished ? ' 本页完成' : ''}` +
        waitNote,
    );

    // ---- 预算达成 → 执行切点裁定（全部逻辑在 decideStop 里，这里只落结论）----
    if (d.action === 'stop') {
      rec.outcome = pendingStop;
      if (d.note) rec.notes.push(d.note);
      break;
    }

    if (s.finished) {
      rec.finished = true;
      rec.outcome = 'finished';
      break;
    }

    await page.waitForTimeout(3000);
  }

  status('');
  rec.mediaGainedSec = rec.maxLocalWatchedSec;
  rec.periodGained = secToPeriod(rec.maxLocalWatchedSec);
  if (rec.outcome === 'unknown') {
    // 超时退出时若已在「等边界」，别把 pendingStop 丢掉
    rec.outcome = pendingStop || (rec.finished ? 'finished' : 'timeout');
    if (rec.outcome === 'timeout') {
      rec.notes.push('本课超时（未走完预算）—— 见 deadline/adaptiveMs');
    }
  }
  // 仅为等活动边界多挂的量做个备注（有才记，避免噪声）
  if (
    (rec.outcome === 'course_budget_met' || rec.outcome === 'target_met') &&
    overshootFrom !== null
  ) {
    const over = rec.maxLocalWatchedSec - overshootFrom;
    if (over > 0) rec.notes.push(`为等活动边界多挂了 ${secToPeriod(over)} 学时（已计入总账）`);
  }
  rec.endedAt = new Date().toISOString();
  return rec;
}

// ---------- 主流程 ----------
async function main() {
  if (!fs.existsSync(ENGINE_PATH)) {
    throw new Error(`找不到引擎文件：${ENGINE_PATH}`);
  }

  // 1) 组装目标列表
  //
  //   用户可以直接把浏览器地址栏里的链接粘进来 —— 两种形状都认：
  //     专题：https://basic.smartedu.cn/training/<trainId>
  //     单课：https://basic.smartedu.cn/teacherTraining/courseIndex?courseId=<id>
  //           （courseDetail?courseId= 同样认；train 列表页给的就是后者）
  //   --train 显式走专题，--course/--url 自动识别（专题链接也认）。
  let targets = [];
  let resolvedTrainId = null; // 平台驱动学时核对要用；单课/季节模式下为 null
  const singleInput = OPTS.course ?? OPTS.url;

  if (OPTS.list) {
    // 列出可挂专题 —— 全走免登录接口，不碰浏览器。这就是「零输入」的入口。
    console.log(`\n可挂类型：${SITES.map((s) => s.id).join('、')}（当前：${site.id} · ${site.name}）\n`);
    const list = await site.listTargets();
    for (const t of list) {
      if (!t.available) {
        console.log(`  ✗ ${t.id}\n      拉取失败：${t.error}`);
        continue;
      }
      const end = t.studyEnd ? `截止 ${String(t.studyEnd).slice(0, 10)}` : '无截止';
      console.log(`  ✓ ${t.title || t.id}`);
      console.log(`      ${t.id}`);
      console.log(
        `      ${t.courseIds.length} 门课｜目标 ${t.maxPeriod ?? '?'} 学时｜${end}` +
          (t.phaseTitles.length ? `｜阶段：${t.phaseTitles.join(' / ')}` : ''),
      );
    }
    console.log('\n用法：node src/run.mjs --train <上表中的 id>\n');
    return;
  }

  if (OPTS.train && OPTS.train !== true) {
    const id = site.parseTargetId(OPTS.train);
    if (!id) {
      throw new Error(
        `--train 无法解析出专题 id："${OPTS.train}"\n` +
          `  应形如 ${site.trainUrl('<trainId>')} 或直接给 trainId\n` +
          `  看可用清单：node src/run.mjs --list`,
      );
    }
    resolvedTrainId = id;
    log(`拉取专题课程列表：${id}`);
    targets = await site.listCourses(id);
    const allPeriod = targets.reduce((a, c) => a + (Number(c.totalPeriod) || 0), 0);
    log(`共 ${targets.length} 门课程，合计 ${allPeriod.toFixed(2)} 学时`);
  } else if (singleInput) {
    const t = await site.resolve(singleInput);
    if (!t.id) {
      throw new Error(
        `无法从 "${singleInput}" 解析出专题/课程 id\n` +
          `  支持：…/training/<trainId>、…?courseId=<courseId>、或裸 id\n` +
          `  看可用清单：node src/run.mjs --list`,
      );
    }
    if (t.mode === 'train') {
      resolvedTrainId = t.id;
      log(`识别为专题：${t.id}`);
      targets = await site.listCourses(t.id);
      const allPeriod = targets.reduce((a, c) => a + (Number(c.totalPeriod) || 0), 0);
      log(`共 ${targets.length} 门课程，合计 ${allPeriod.toFixed(2)} 学时`);
    } else {
      log(`识别为单个课程：${t.id}`);
      targets = [
        { courseId: t.id, title: `courseId=${t.id.slice(0, 8)}…`, url: site.courseUrl(t.id) },
      ];
    }
  } else if (OPTS.season && OPTS.season !== true) {
    log(`拉取季节课程列表：${OPTS.season}`);
    const { courses } = await fetchSeason(OPTS.season);
    targets = courses;
    log(`共 ${courses.length} 门课程`);
  } else if (!OPTS.login) {
    console.log(`
用法：
  node src/run.mjs --list                         ★列出可挂专题（免登录，不碰浏览器）
  node src/run.mjs --login                        只开浏览器，手动登录一次
  node src/run.mjs --train <专题链接或id>          ★按专题挂，自动凑够学时
  node src/run.mjs --course <课程链接或id>         挂单个课程（页内自动下一节）
  node src/run.mjs --train <…> --dry-run          只看会挂哪些课、各计多少学时
  node src/run.mjs --season 2025sqpx              按季节码遍历（2025 及以前，旧入口）

挂课类型（--site，默认 ${site.id}）：
${SITES.map((s) => `  ${s.id.padEnd(18)} ${s.name}  —— ${s.hint}`).join('\n')}

链接直接粘也认（两个入口都可以）：
  ${site.trainUrl('<trainId>')}
  ${site.courseUrl('<courseId>')}

2026 暑期教师研修（基础教育）专题：
  ${site.catalog[0]}

先跑 node src/probe.mjs 体检。
`);
    return;
  }

  if (OPTS.maxCourses > 0) targets = targets.slice(0, OPTS.maxCourses);

  // 只挂勾选的课（保持站点给的顺序，不按用户勾选顺序 —— 顺序影响凑学时的效率）
  if (typeof OPTS.only === 'string' && OPTS.only.trim()) {
    const want = new Set(
      OPTS.only
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const before = targets.length;
    targets = targets.filter((c) => want.has(c.courseId));
    if (!targets.length) {
      throw new Error(`--only 过滤后一门课都不剩（给了 ${want.size} 个 id，原列表 ${before} 门）`);
    }
    log(`按勾选过滤：${before} 门 → ${targets.length} 门`);
  }

  // 引擎需要 max_period 才能把「已学习」截成「已认定」（已认定 = min(已学习, max_period)）
  const trainCaps = Object.fromEntries(targets.map((c) => [c.courseId, Number(c.maxPeriod)]));

  if (targets.length) {
    log(`本次目标 ${targets.length} 门课程：`);
    for (const [i, c] of targets.entries()) {
      console.log(`  ${String(i + 1).padStart(2)}. ${c.title}  (${c.courseId})`);
    }
  }
  log(
    `参数：倍速 ${OPTS.rate}x｜目标 ${OPTS.targetHours} 学时｜最多 ${OPTS.maxCourses || '不限'} 门｜` +
      `切课阈值 --min-section-sec=${OPTS.minSectionSec}s` +
      (OPTS.minSectionSec ? '' : '（已关闭，一律等本节播完）'),
  );
  if (OPTS.dryRun) return;

  // 1.5) 环境预检 + 抢 profile 锁（不启动浏览器，几百 ms）
  //      专用 profile 是**独占资源**：两个进程同时用同一 user-data-dir，
  //      第二个 Chrome 会立刻退出（exitCode=21），Playwright 只报一句看不懂的
  //      “Target page, context or browser has been closed”。故先抢锁拿到人话提示。
  const pf = preflight({ label: `run.mjs ${process.argv.slice(2).join(' ')}`.slice(0, 120) });
  reportPreflight(pf, { log, warn });
  if (!pf.ok) {
    report.problems.push(...pf.errors);
    process.exit(3);
  }

  // 2) 启动浏览器
  log(`启动 Chrome（${OPTS.headless ? 'headless 无头' : 'headful 有头'}）…`);
  const context = await launchContext({
    headless: OPTS.headless,
    keepThrottled: OPTS.keepThrottled,
  });
  await installEngine(context, {
    playbackRate: OPTS.rate,
    autoNext: OPTS.autoNext,
    // 专题驱动学时核对所需；单课/季节模式下为 null，引擎会自己跳过轮询
    trainId: resolvedTrainId,
    trainCaps,
  });

  const page = await reusePage(context);

  // 3) 登录 / 校验登录态
  if (OPTS.login) {
    await gotoWithRetry(page, 'https://basic.smartedu.cn/', { label: '登录页' });

    // 两种使用场景：
    //   · 终端里跑 → 等按 Enter（传统行为，兼容现有习惯）
    //   · 被 Web UI 拉起 → stdin 不是 TTY，按 Enter 永远等不到。改成轮询登录态。
    //     UI 里不能要求用户“回到终端按键”。
    const interactive = Boolean(process.stdin.isTTY);
    if (interactive) {
      log('打开登录页，请手动完成登录。登录完成后回到终端按 Enter 继续（浏览器会自动关闭）。');
      await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once('data', resolve);
      });
    } else {
      log('请在弹出的浏览器窗口里完成登录 —— 登录成功后会自己继续，不用回来按键。');
      const deadline = Date.now() + 10 * 60 * 1000;
      let lastNudge = 0;
      let ls = await loginState(page);
      while (!ls.loggedIn && Date.now() < deadline) {
        await page.waitForTimeout(3000);
        if (Date.now() - lastNudge > 60_000) {
          lastNudge = Date.now();
          const left = Math.max(0, Math.round((deadline - Date.now()) / 60000));
          log(`还没检测到登录…… 请扫码/输入账号密码（最长再等 ${left} 分钟）`);
        }
        ls = await loginState(page);
      }
      if (!ls.loggedIn) {
        warn('等满 10 分钟仍未登录，先关闭。重新打开再试即可。');
        await context.close();
        process.exit(1);
      }
    }

    const ls = await loginState(page);
    log(`登录态：${ls.loggedIn ? '已登录 ✅' : '未检测到登录信号 ❌'}（${ls.signals.slice(0, 5).join(', ')}）`);
    // ★ 这里曾经把 localStorage 键名全列出来。看着像“诊断信息”，但键名本身就把凭据写在
    //   里面了（`ND_UC_AUTH-<uuid>&ncet-xedu&token`、`aiAssistant_audio_<user_id>`），
    //   而它是裸 `console.log`、绕过了 log()/warn() 的脱敏出口 —— 实测真泄到了界面与日志。
    //   上一行的 signals 已经足以表达「登录判据命中了什么」，键名列表纯属冗余，故删除。
    await context.close();
    return;
  }

  await gotoWithRetry(page, 'https://basic.smartedu.cn/', { label: '首页' });
  const ls0 = await loginState(page);
  if (!ls0.loggedIn) {
    // 受众有两类，所以两种入口都写出来：用界面的小白看不懂 `npm run login`，
    // 用命令行的 power user 也未必知道界面上有个按钮。
    warn('未检测到登录信号 —— 需要先登录一次（独立 profile 只需一次）。');
    warn('  用界面：点「先登录（只需一次）」按钮。用命令行：npm run login。');
    if (OPTS.headless) {
      warn('无头模式下无法弹出登录窗口 —— 请先用上面任一方式登录一次再重跑。');
      await context.close();
      process.exit(2);
    }
  } else {
    log(`登录态正常（${ls0.signals.slice(0, 3).join(', ')}）`);
  }

  // 3.5) ★平台驱动：先把平台权威学时基线读出来
  //      平台不单独返回「已认定」，它是截出来的：已认定 = min(已学习, max_period)
  //      （对专题页 UI 逐条验证过：数智素养 4.01/上限3 → 3.00；大力弘扬 2.28/上限2 → 2.00）
  const trainId = resolvedTrainId;
  let platformUserId = null;
  let periodRows = null;
  let platformSec = 0; // 平台权威「已认定」秒数
  let baselineSec = 0; // 起跑时的平台值
  let localGainedSec = 0; // 本轮本地媒体累计秒数

  /**
   * 最优学时估计 —— 取「平台权威值」与「起跑基线 + 本轮本地」的较大者。
   *
   * 为什么不直接用平台值：平台是【批量记账】的（progress/actions/async frequency=600s、
   * action_rules frequency=3600s）。实测连挂两节活动、平台仍纹丝不动（还是 2.28+4.01），
   * 会滞后一整个上报窗口。只用平台值 → 「剩余缺口」永远不缩小
   * → 最后一门 max_period=-1 的课会被过挂几个小时。
   * 取 max 则两头都占：平台不掉队时不虚高，本地已挂的也不会被平台滞后抹掉。
   */
  const estimateSec = () => Math.max(platformSec, baselineSec + localGainedSec);

  /** 重读平台真值；只有拿到 userId 后才能纯 Node 轮询（该接口实测免鉴权） */
  async function refreshPlatform(tag) {
    if (!trainId || !platformUserId) return null;
    const r = await site.pollProgress({ trainId, userId: platformUserId });
    if (!r.ok) {
      warn(`平台学时读取失败（${tag}）：${r.error}`);
      report.problems.push({ kind: 'period_poll_failed', tag, error: r.error });
      return null;
    }
    const cert = site.certify(targets, r.map);
    periodRows = cert;
    platformSec = periodToSec(cert.certifiedTotal);
    log(
      `平台学时（${tag}）：已学习 ${cert.learnedTotal} 学时｜` +
        `已认定 ${cert.certifiedTotal}/${OPTS.targetHours} 学时` +
        `（${((cert.certifiedTotal / OPTS.targetHours) * 100).toFixed(0)}%）`,
    );
    return cert;
  }

  if (trainId) {
    const boot = await fetchTrainPeriods(page, trainId, { url: site.trainUrl(trainId) });
    if (boot) {
      platformUserId = boot.userId;
      log(`平台 user_id = ${platformUserId}`);
      const cert = site.certify(targets, boot.map);
      periodRows = cert;
      platformSec = periodToSec(cert.certifiedTotal);
      baselineSec = platformSec;
      log(
        `起跑基线：已学习 ${cert.learnedTotal} 学时｜` +
          `已认定 ${cert.certifiedTotal}/${OPTS.targetHours} 学时`,
      );
      for (const r of cert.rows) {
        const full = r.capPeriod > 0 && r.certifiedPeriod >= r.capPeriod;
        log(
          `    ${full ? '✅已认满' : '        '} ${r.title.slice(0, 22).padEnd(22)}` +
            ` 已学习 ${r.learnedPeriod} / 上限 ${r.capPeriod > 0 ? r.capPeriod : '不限'}`,
        );
      }
    } else {
      warn('拿不到平台学时基线 —— 本轮回退到纯本地学时预算（不跳过任何课）');
      report.problems.push({ kind: 'period_baseline_missing' });
    }
  }

  // 4) 逐门挂（平台驱动预算：到点就停，不会把 199 学时全挂完）
  const targetSec = periodToSec(OPTS.targetHours);
  for (const [i, course] of targets.entries()) {
    if (estimateSec() >= targetSec) {
      log(`\n✅ 平台已认定 ${secToPeriod(estimateSec())} 学时 ≥ 目标 ${OPTS.targetHours} 学时，停止。`);
      break;
    }

    const maxP = Number(course.maxPeriod);
    const row = periodRows?.rows.find((r) => r.courseId === course.courseId);
    const learned = row ? row.learnedPeriod : 0;

    // 已认满的课直接跳过 —— 再挂平台也不会多认一学时
    if (maxP > 0 && learned >= maxP) {
      log(`\n----- [${i + 1}/${targets.length}] ${course.title} 已学习 ${learned} ≥ 上限 ${maxP}，已认满，跳过`);
      continue;
    }

    // 本课预算 = min(本课还差多少学时, 全局还差多少学时)
    // max_period = -1 的课无单独上限（如「融合教育通识课程」21 学时），
    // 不夹一下就会把整门 10 小时全挂完 —— 用全局缺口封顶才不会超挂。
    const remainingSec = Math.max(0, targetSec - estimateSec());
    const courseNeedSec = maxP > 0 ? periodToSec(Math.max(0, maxP - learned)) : Infinity;
    const courseBudgetSec = Math.min(courseNeedSec, remainingSec);
    log(`\n===== [${i + 1}/${targets.length}] ${course.title} =====`);
    log(
      `  本课上限 ${maxP > 0 ? maxP + ' 学时' : '不限'}` +
        `（已学习 ${learned}）` +
        `｜本次预算 ${secToPeriod(courseBudgetSec)} 学时` +
        `（整门 ${course.totalPeriod} 学时，只取所需）` +
        `｜已认定估算 ${secToPeriod(estimateSec())}/${OPTS.targetHours} 学时`,
    );
    // 超时自适配：预算秒数 ÷ 倍速 + 80% 余量（网卡、缓冲、切节空档都要算）
    // --per-course-min 只在显式给了值时才当硬上限用
    const adaptiveMs = Math.round((courseBudgetSec / OPTS.rate) * 1000 * 1.8) + 120_000;
    const hardCapMs = OPTS.perCourseMin > 0 ? OPTS.perCourseMin * 60_000 : Infinity;
    const deadline = Date.now() + Math.min(adaptiveMs, hardCapMs);

    try {
      await gotoWithRetry(page, course.url, { label: '课程页', timeout: 60_000 });
    } catch (e) {
      warn(`打开失败：${e.message}`);
      report.problems.push({ courseId: course.courseId, kind: 'goto_failed', error: e.message });
      continue;
    }

    // 等 SPA 把播放器和目录挂上来
    await page.waitForTimeout(6000);

    const rec = await watchCourse(page, course, deadline, {
      courseBudgetSec,
      globalBudgetSec: targetSec,
      globalEarnedSec: estimateSec(),
      // max_period 有上限 → 挂到上限即认定到位；无上限 → 挂到「已学习 + 本次预算」
      platformTargetPeriod: maxP > 0 ? maxP : learned + secToPeriod(courseBudgetSec),
      minSectionSec: OPTS.minSectionSec,
    });
    rec.learnedPeriodBefore = learned;

    // ★ 收工：本地累计先进总账，再重读平台权威值校正
    const beforePlatform = platformSec;
    localGainedSec += rec.mediaGainedSec || 0;
    await refreshPlatform(`第 ${i + 1} 门收工`);
    rec.platformGainedPeriod = secToPeriod(Math.max(0, platformSec - beforePlatform));
    rec.estimatedSecAfter = estimateSec();

    report.courses.push(rec);
    report.earnedPeriod = secToPeriod(estimateSec());
    log(
      `结果：${rec.outcome}｜本地挂 ${rec.periodGained} 学时｜` +
        `平台侧 +${rec.platformGainedPeriod} 学时（批量记账，会滞后）｜` +
        `累计估算 ${secToPeriod(estimateSec())}/${OPTS.targetHours} 学时` +
        `｜拦截 pause ${rec.pauseBlocked} 次`,
    );
    for (const n of rec.notes) warn(n);

    // 每门课存一次，避免中途崩溃丢数据
    const p = saveReport();
    log(`报告已写入 ${path.relative(ROOT, p)}`);
  }

  // 收尾再读一次平台真值，让总结用的是权威数字
  const fin = await refreshPlatform('收尾');
  log(
    `\n全部完成。平台已认定 ${secToPeriod(platformSec)} 学时` +
      `（自起跑 ${secToPeriod(baselineSec)} →现已涨 ${secToPeriod(Math.max(0, platformSec - baselineSec))}）｜` +
      `本地挂 ${secToPeriod(localGainedSec)}｜累计估算 ${secToPeriod(estimateSec())}` +
      `（本次目标 ${OPTS.targetHours} 学时）` +
      `${fin ? '' : '——收尾读取失败，用的是上一轮读数'}`,
  );
  await context.close();
}

// Ctrl+C 也要保住报告
process.on('SIGINT', () => {
  console.log('\n收到中断，保存报告…');
  try {
    const p = saveReport();
    console.log(`报告已写入 ${p}`);
  } catch (e) {
    console.error('保存报告失败：', e);
  }
  process.exit(130);
});

// 只有【直接运行本文件】才起跑 —— 这样 tools/test-stop-logic.mjs 能 import 上面的
// 纯函数 decideStop 做回归测试，而不会顺带拉起 Chrome。
const isEntry =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((e) => {
    if (e?.friendly) {
      // 预检/占用类错误已经是给人看的中文了，不要再糊一屏 Node 堆栈
      console.error(`\n${e.message}\n`);
      process.exit(3);
    }
    console.error('运行失败：', e);
    try {
      const p = saveReport();
      console.error(`已保存部分报告：${p}`);
    } catch {}
    process.exit(1);
  });
}
