/**
 * 课程页深度诊断 —— 回答三个决定性问题：
 *   1. 平台视频到底走不走 DRM？（hook requestMediaKeySystemAccess，不靠猜）
 *   2. 媒体是通过什么协议取的？（拦截网络，看 m3u8 / mp4 / ts / m4s / 授权接口）
 *   3. 真实 DOM 结构是什么？（课程目录选择器是否还准）
 *
 *   node tools/diag-media.mjs ["<课程页URL>"]
 *
 * 默认用已登录的独立 profile，无头运行。
 */

import { launchContext, reusePage, gotoWithRetry } from '../src/browser.mjs';
import { installEngine } from '../src/engine.mjs';

const DEFAULT_URL =
  'https://basic.smartedu.cn/teacherTraining/courseDetail?courseId=165d9433-5486-43e4-926e-3f33b92635e4';
const URL_ = process.argv[2] || DEFAULT_URL;

const HEADFUL = process.argv.includes('--headful');

// ------------------------------------------------------------------
// 关键埋点：直接监听 EME 与 MSE 的真实调用
// ------------------------------------------------------------------
const INSTRUMENT = `(() => {
  window.__EME_CALLS__ = [];
  window.__MSE_MIMES__ = [];

  const origReq = navigator.requestMediaKeySystemAccess;
  if (typeof origReq === 'function') {
    navigator.requestMediaKeySystemAccess = function (keySystem, configs) {
      const rec = {
        keySystem,
        at: Date.now(),
        result: null,
        error: null,
        initDataTypes: (configs || []).map((c) => c.initDataType),
        video: (configs || []).flatMap((c) => (c.videoCapabilities || []).map((v) => v.contentType)),
        audio: (configs || []).flatMap((c) => (c.audioCapabilities || []).map((a) => a.contentType)),
      };
      window.__EME_CALLS__.push(rec);
      return origReq.call(navigator, keySystem, configs).then(
        (r) => { rec.result = 'granted'; return r; },
        (e) => { rec.error = e.name + ': ' + e.message; throw e; },
      );
    };
  }

  // MSE：hls.js / dash.js 都会走这里，mime 能反推协议
  try {
    const MS = window.MediaSource;
    if (MS) {
      const oAdd = MS.prototype.addSourceBuffer;
      MS.prototype.addSourceBuffer = function (mime) {
        window.__MSE_MIMES__.push(mime);
        return oAdd.call(this, mime);
      };
      const oOpen = MS.prototype.constructor; // keep ref
      void oOpen;
    }
  } catch {}

  // 记录 video 元素第一次拿到 src 的时刻
  window.__VIDEO_SRC_LOG__ = [];
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (desc && desc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      ...desc,
      set(v) {
        window.__VIDEO_SRC_LOG__.push({ at: Date.now(), src: String(v).slice(0, 300) });
        return desc.set.call(this, v);
      },
    });
  }
})();`;

// ------------------------------------------------------------------
const MEDIA_RE =
  /\.(m3u8|mp4|ts|m4s|mpd|m4a|aac|key|cmfv|cmfa)(\?|$)|mpegurl|widevine|license|drm|playauth|getplayinfo|playinfo/i;

const ctx = await launchContext({ headless: !HEADFUL });
await ctx.addInitScript({ content: INSTRUMENT });
await installEngine(ctx, { playbackRate: 2 });

const page = await reusePage(ctx);

// 子应用没挂载的最常见原因：它内部抛了异常。必须接住。
page.on('pageerror', (e) => {
  console.log(`  [页面JS异常] ${String(e.message).slice(0, 200)}`);
  const st = String(e.stack || '').split('\n').slice(0, 6);
  st.forEach((l) => console.log(`      ${l.trim().slice(0, 160)}`));
});
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/favicon|net::ERR_BLOCKED|Download the Vue|DevTools/i.test(t)) return;
  console.log(`  [console.error] ${t.slice(0, 200)}`);
});

const mediaReqs = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!MEDIA_RE.test(u)) return;
  let len = res.headers()['content-length'] ?? '?';
  mediaReqs.push({
    status: res.status(),
    type: res.headers()['content-type'] ?? '?',
    len,
    url: u.length > 160 ? u.slice(0, 160) + '…' : u,
  });
});
page.on('requestfailed', (req) => {
  if (MEDIA_RE.test(req.url())) {
    mediaReqs.push({ status: 'FAILED', type: '-', len: '-', url: req.url().slice(0, 160) });
  }
});

// 接口探针：不光看状态码，还要看**返回体**。
// HTTP 200 + 业务错误码（无权限/未报名/课程不存在）在这里很常见。
const apiErrors = [];
const apiLog = new Map();
page.on('response', async (res) => {
  const u = res.url();
  if (!/\/api|gateway|\/teach\/|cbern\.com\.cn/i.test(u)) return;
  const status = res.status();
  const path = u.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
  if (status >= 400) apiErrors.push({ status, url: u.slice(0, 150) });
  const interesting = /course|train|resource|lesson|catalog|detail|library/i.test(u);
  let body = '';
  if (interesting && status < 400) {
    try {
      body = (await res.text()).slice(0, 500).replace(/\s+/g, ' ');
    } catch {}
  }
  if (interesting || !apiLog.has(path)) apiLog.set(path, { status, body });
});

console.log(`\n=== 课程页深度诊断（${HEADFUL ? 'headful' : 'headless'}）===\n`);
console.log(`URL: ${URL_}\n`);

try {
  await gotoWithRetry(page, URL_, { label: '课程页', timeout: 60_000 });

  // 轮询等待渲染 —— 6s 可能根本不够
  const poll = [];
  for (let i = 0; i < 15; i++) {
    const s = await page.evaluate(() => ({
      items: document.querySelectorAll('.resource-item, [class*="resource-item"]').length,
      videos: document.querySelectorAll('video').length,
      textLen: (document.body.innerText || '').length,
      appKids: (document.querySelector('#app, #root, main') || document.body).children.length,
    }));
    poll.push(`${String(i * 2).padStart(2)}s  目录项=${s.items}  video=${s.videos}  正文=${s.textLen}字  主容器子节点=${s.appKids}`);
    if (s.items > 0 || s.videos > 0) break;
    await page.waitForTimeout(2000);
  }
  console.log('\n【渲染轮询】');
  poll.forEach((p) => console.log('  ' + p));

  // 直接看页面 —— 比任何选择器猜测都管用
  const shot = 'out/course-page.png';
  await page.screenshot({ path: shot, fullPage: false }).catch((e) => console.log(`  截图失败: ${e.message}`));
  console.log(`\n【截图】${shot}`);

  const visible = await page.evaluate(() => (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 400));
  console.log('\n【页面上看得见的文字】');
  console.log(visible.split('\n').slice(0, 20).map((l) => '  ' + l).join('\n') || '  (空)');

  const finalUrl = await page.evaluate(() => location.href);
  console.log('【路由】');
  console.log(`  请求: ${URL_}`);
  console.log(`  落地: ${finalUrl}`);
  if (finalUrl !== URL_ && !finalUrl.startsWith(URL_.slice(0, 60))) {
    console.log('  ⚠️  发生了跳转（可能被 SPA 重定向到别的路由/登录页）');
  }
  if (apiErrors.length) {
    console.log(`\n【接口错误】${apiErrors.length} 条`);
    [...new Map(apiErrors.map((e) => [e.status + e.url, e])).values()]
      .slice(0, 8)
      .forEach((e) => console.log(`  ❌ HTTP ${e.status}  ${e.url}`));
  } else {
    console.log(`\n【接口错误】无`);
  }

  // 课程相关接口的返回体 —— 决定性地回答「为什么没渲染」
  const interesting = [...apiLog.entries()].filter(([, v]) => v.body);
  if (interesting.length) {
    console.log(`\n【课程相关接口返回体】${interesting.length} 个`);
    interesting.slice(0, 6).forEach(([p, v]) => {
      console.log(`  [${v.status}] ${p}`);
      console.log(`      ${v.body}`);
    });
  } else {
    console.log('\n【课程相关接口返回体】无 —— 前端压根没请求课程数据（子应用未启动）');
  }

  // ---------- 1. DOM 结构 ----------
  const dom = await page.evaluate(() => {
    const SEL = {
      catalog: ['.tcourse-catalog', '.fish-collapse', '[class*="catalog"]', '[class*="Catalog"]'],
      item: ['.resource-item', '[class*="resource-item"]', '[class*="resourceItem"]'],
      itemDone: ['[class*="icon_checkbox_fill"]', '[class*="icon-checkbox-fill"]',
                 '[class*="icon_checked"]', '[class*="completed"]'],
      groupHeader: ['.fish-collapse-header', '[class*="collapse-header"]', '[class*="collapseHeader"]'],
    };
    const q = (s) => { try { return document.querySelectorAll(s); } catch { return []; } };
    const first = (sels) => { for (const s of sels) { const n = q(s); if (n.length) return { sel: s, n: n.length }; } return null; };

    // 全站类名普查：找和课程/目录相关的
    const freq = {};
    for (const el of document.querySelectorAll('[class]')) {
      for (const c of String(el.className).split(/\s+/)) {
        if (c && /course|resource|lesson|chapter|catalog|section|item|video/i.test(c)) {
          freq[c] = (freq[c] || 0) + 1;
        }
      }
    }
    const topClasses = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 18);

    const items = [...q('.resource-item, [class*="resource-item"]')];
    const sample = items.slice(0, 6).map((el) => ({
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50),
      cls: String(el.className).slice(0, 70),
      done: !!el.querySelector('[class*="icon_checkbox_fill"], [class*="checkbox-fill"], [class*="checked"]'),
    }));

    // 完成标记选择器没命中，得看真实标记。把首条的 HTML 挖出来。
    const sampleHtml = items.slice(0, 2).map((el) => el.outerHTML.replace(/\s+/g, ' ').slice(0, 900));

    return {
      title: document.title,
      hasCatalog: first(SEL.catalog),
      itemHit: first(SEL.item),
      groupHeaderHit: first(SEL.groupHeader),
      doneHit: first(SEL.itemDone),
      itemCount: items.length,
      sample,
      sampleHtml,
      topClasses,
      videoCount: document.querySelectorAll('video').length,
      iframes: [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 100)),
    };
  });

  console.log('【页面】');
  console.log(`  title: ${dom.title}`);
  console.log(`  <video> 数量: ${dom.videoCount}   iframe: ${dom.iframes.length}`);
  if (dom.iframes.length) dom.iframes.forEach((f) => console.log(`    iframe src: ${f}`));
  console.log('\n【课程目录选择器命中】');
  console.log(`  catalog   : ${dom.hasCatalog ? `${dom.hasCatalog.sel} × ${dom.hasCatalog.n}` : '❌ 全不中'}`);
  console.log(`  item      : ${dom.itemHit ? `${dom.itemHit.sel} × ${dom.itemHit.n}` : '❌ 全不中'}`);
  console.log(`  groupHeader: ${dom.groupHeaderHit ? `${dom.groupHeaderHit.sel} × ${dom.groupHeaderHit.n}` : '❌ 全不中'}`);
  console.log(`  完成标记  : ${dom.doneHit ? `${dom.doneHit.sel} × ${dom.doneHit.n}` : '❌ 全不中'}`);
  console.log('\n【实际类名普查（含 course/resource/lesson/catalog/item/video）】');
  dom.topClasses.forEach(([c, n]) => console.log(`  ${String(n).padStart(3)}  ${c}`));
  if (dom.sample.length) {
    console.log('\n【目录条目样本】');
    dom.sample.forEach((s, i) => console.log(`  ${i + 1}. [${s.done ? '✓已完成' : ' 未完成'}] ${s.text}`));
  }
  if (dom.sampleHtml.length) {
    console.log('\n【目录条目真实 HTML（用来修完成标记选择器）】');
    dom.sampleHtml.forEach((h, i) => console.log(`  --- 第${i + 1}条 ---\n  ${h}`));
  }

  // ---------- 2. 尝试点第一个课件 ----------
  let clicked = false;
  if (dom.itemCount > 0) {
    clicked = await page.evaluate(() => {
      const el = document.querySelector('.resource-item, [class*="resource-item"]');
      if (!el) return false;
      el.click();
      return true;
    });
    if (clicked) {
      console.log('\n【已点击第一个课件，等待播放器加载…】');
      await page.waitForTimeout(10_000);
    }
  }

  // ---------- 3. 媒体状态 ----------
  const media = await page.evaluate(() => {
    const v = document.querySelector('video');
    return {
      eme: window.__EME_CALLS__ || [],
      mse: [...new Set(window.__MSE_MIMES__ || [])],
      srcLog: (window.__VIDEO_SRC_LOG__ || []).slice(0, 8),
      video: v ? {
        src: (v.src || '').slice(0, 200),
        currentSrc: (v.currentSrc || '').slice(0, 200),
        readyState: v.readyState,
        networkState: v.networkState,
        paused: v.paused,
        duration: Number.isFinite(v.duration) ? +v.duration.toFixed(1) : String(v.duration),
        currentTime: +v.currentTime.toFixed(1),
        playbackRate: v.playbackRate,
        muted: v.muted,
        error: v.error ? { code: v.error.code, message: v.error.message } : null,
        buffered: v.buffered.length ? +v.buffered.end(v.buffered.length - 1).toFixed(1) : 0,
      } : null,
    };
  });

  console.log('\n【★ DRM / 协议 —— 决定性证据】');
  if (!media.eme.length) {
    console.log('  ✅ 平台**没有**调用 requestMediaKeySystemAccess');
    console.log('     → 不走 Widevine/EME，无头播放不存在 DRM 障碍');
  } else {
    console.log(`  ⚠️  平台调用了 EME ${media.eme.length} 次：`);
    media.eme.slice(0, 4).forEach((c) => {
      console.log(`     keySystem=${c.keySystem}  result=${c.result ?? 'pending'}  err=${c.error ?? '-'}`);
      if (c.video.length) console.log(`        video: ${c.video.slice(0, 3).join(' | ')}`);
    });
  }
  console.log(`  MSE addSourceBuffer mime: ${media.mse.length ? media.mse.join(', ') : '(未使用 MSE)'}`);

  if (media.srcLog.length) {
    console.log('\n【video.src 赋值历史】');
    media.srcLog.forEach((s, i) => console.log(`  ${i + 1}. ${s.src}`));
  }

  console.log('\n【video 元素状态】');
  if (!media.video) {
    console.log('  ❌ 仍然没有 <video> —— 可能需登录校验更久、或播放器在 iframe 里、或要点别的元素');
  } else {
    const v = media.video;
    console.log(`  src         : ${v.src || '(空)'}`);
    console.log(`  currentSrc  : ${v.currentSrc || '(空)'}`);
    console.log(`  readyState  : ${v.readyState}   networkState: ${v.networkState}`);
    console.log(`  paused      : ${v.paused}   duration: ${v.duration}   currentTime: ${v.currentTime}`);
    console.log(`  playbackRate: ${v.playbackRate}   muted: ${v.muted}   buffered: ${v.buffered}`);
    console.log(`  ★ media.error: ${v.error ? `code=${v.error.code} ${v.error.message || ''}` : '无 ✅'}`);
  }

  console.log(`\n【媒体网络请求】共 ${mediaReqs.length} 条`);
  const seen = new Set();
  mediaReqs.forEach((r) => {
    const k = r.url.replace(/[?&](t|token|sign|signature|auth)=[^&]*/g, '');
    if (seen.has(k)) return;
    seen.add(k);
    console.log(`  [${r.status}] ${r.type}  ${r.len}B`);
    console.log(`      ${r.url}`);
  });

  // 全部接口路径 —— 用来找「学时上报」到底打哪个接口（Phase 2 的关键）
  console.log(`\n【本次访问过的全部接口路径】`);
  [...apiLog.keys()].sort().forEach((p) => console.log(`  ${p}`));

  console.log('\n诊断完成。\n');
} finally {
  await ctx.close();
}
