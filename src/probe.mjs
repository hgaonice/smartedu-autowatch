/**
 * 体检（probe）—— 在跑挂课之前先确认「无头方案到底能不能用」。
 *
 * 这是回答「能否用无头浏览器直接解决」的唯一可靠方式：
 * 不猜，直接问浏览器 Widevine 能不能协商出密钥系统。
 *
 * 用法：
 *   node src/probe.mjs                      # 无头体检
 *   node src/probe.mjs --headful            # 有头体检（对照组）
 *   node src/probe.mjs --url "<课程页>"     # 带真实课程页体检（能查出 video.error）
 */

import { launchContext, reusePage, loginState, gotoWithRetry } from './browser.mjs';
// 日志出口统一脱敏：详见 src/redact.mjs （体检输出常被粘进 bug 报告）
import { redact } from './redact.mjs';
import { installEngine } from './engine.mjs';
import { preflight, reportPreflight, releaseProfileLock, guard } from './preflight.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const headless = !has('headful');
const targetUrl = arg('url', 'https://basic.smartedu.cn/');

const WIDEVINE_PROBE = `(async () => {
  const out = { eme: !!navigator.requestMediaKeySystemAccess, widevine: null, error: null };
  if (!out.eme) return out;
  const config = [{
    initDataTypes: ['cenc'],
    videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
  }];
  try {
    const access = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', config);
    out.widevine = access.keySystem;
  } catch (e) {
    out.error = e.name + ': ' + e.message;
  }
  return out;
})()`;

const MEDIA_PROBE = `(() => ({
  isTypeSupportedH264: typeof MediaSource !== 'undefined'
    && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'),
  // MSE 最常见的组合：H.264 + AAC（hls.js 把 m3u8 解成 fMP4/TS 后交给 MSE，
  // 所以 "application/vnd.apple.mpegurl" 在 Chrome 恒为 false，那只是 Safari 原生 HLS 的 MIME，
  // 拿它判断能不能放 HLS 是错的）
  isTypeSupportedMseCombo: typeof MediaSource !== 'undefined'
    && MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001f,mp4a.40.2"'),
  isTypeSupportedTs: typeof MediaSource !== 'undefined'
    && MediaSource.isTypeSupported('video/mp2t; codecs="avc1.42E01E"'),
  webdriver: navigator.webdriver,
  visibilityState: document.visibilityState,
  hidden: document.hidden,
  hasChrome: typeof window.chrome === 'object',
  plugins: navigator.plugins.length,
  headlessInUA: /Headless/i.test(navigator.userAgent),
  brands: (navigator.userAgentData && navigator.userAgentData.brands || [])
    .map((b) => b.brand + '/' + b.version).join(', '),
}))()`;

const VIDEO_PROBE = `(() => {
  const v = document.querySelector('video');
  if (!v) return { hasVideo: false };
  return {
    hasVideo: true,
    src: (v.currentSrc || v.src || '').slice(0, 200),
    readyState: v.readyState,
    networkState: v.networkState,
    paused: v.paused,
    duration: v.duration,
    currentTime: v.currentTime,
    error: v.error ? { code: v.error.code, message: v.error.message } : null,
    engineInjected: !!window.__SMARTEDU_AUTOWATCH__,
  };
})()`;

const ok = (b) => (b ? '✅' : '❌');

async function main() {
  console.log(`\n=== 体检模式：${headless ? 'headless（无头）' : 'headful（有头）'} ===\n`);

  // 体检也要开浏览器，同样受 profile 独占限制 —— 先给一句人话，而不是等 Playwright 撞死
  const pf = preflight({ label: 'probe.mjs' });
  reportPreflight(pf, { log: console.log, warn: console.warn });
  if (!pf.ok) process.exit(3);

  const context = await guard(() => launchContext({ headless }));
  await installEngine(context, { playbackRate: 2 }); // 顺便验证引擎能否在无头下注入
  const page = await reusePage(context);

  try {
    await gotoWithRetry(page, targetUrl, { label: '目标页', timeout: 60_000 });
    await page.waitForTimeout(3000);

    const media = await page.evaluate(MEDIA_PROBE);
    console.log('【基础能力】');
    console.log(`  ${ok(media.isTypeSupportedH264)} H.264 解码`);
    console.log(`  ${ok(media.isTypeSupportedMseCombo)} H.264+AAC（MSE 常见组合，HLS 靠它放）`);
    console.log(`  ${ok(media.isTypeSupportedTs)} MPEG-TS 分片（部分 HLS 用）`);
    console.log(`  ${ok(media.webdriver === undefined)} navigator.webdriver 已抹除（当前=${media.webdriver}）`);
    console.log(`  ${ok(!media.headlessInUA)} UA 中无 "Headless" 字样（${media.headlessInUA ? '仍有 ❌ 指纹' : '已伪装'}）`);
    console.log(`  ${ok(media.hasChrome)} window.chrome 存在`);
    console.log(`  ${ok(media.plugins > 0)} navigator.plugins 非空（${media.plugins}）`);
    console.log(`  ℹ️  brands: ${media.brands}`);
    console.log(`  ℹ️  visibilityState=${media.visibilityState} hidden=${media.hidden}（无头下平台的前台检测天然不触发）`);

    const wv = await page.evaluate(WIDEVINE_PROBE);
    console.log('\n【Widevine DRM —— 决定无头能不能用的关键】');
    if (wv.widevine) {
      console.log(`  ✅ 可用（keySystem=${wv.widevine}）→ 加密视频能在无头下播放`);
      console.log('     ℹ️  依赖 ignoreDefaultArgs:["--disable-component-update"]（已内置）；' +
                  '首次启动会下载一次 CDM 组件');
    } else {
      console.log(`  ❌ 不可用（${wv.error ?? '未知'}）`);
      console.log('     → 若平台视频走 Widevine，会直接 MEDIA_ERR');
      console.log('     → 先确认没误删 ignoreDefaultArgs；仍失败则只能走 headful');
    }

    const ls = await loginState(page);
    console.log('\n【登录态】');
    console.log(`  ${ok(ls.loggedIn)} ${ls.loggedIn ? '已登录：' + ls.signals.slice(0, 5).map(redact).join(', ') : '未登录（' + ls.note + '）'}`);
    // ★ 键名里嵌着凭据（`ND_UC_AUTH-<uuid>&ncet-xedu&token`、`aiAssistant_audio_<user_id>`），
    //   所以逐个过一遍脱敏再打 —— 体检输出经常被贴进聊天窗口求助。
    console.log(`  ℹ️  localStorage 键：${ls.keys.slice(0, 12).map((k) => redact(k)).join(', ') || '（空）'}`);

    if (targetUrl.includes('courseDetail')) {
      await page.waitForTimeout(5000);
      const v = await page.evaluate(VIDEO_PROBE);
      console.log('\n【视频元素】');
      if (!v.hasVideo) {
        console.log('  ⚠️  页面上没找到 <video> —— 可能未登录、或课程页结构变了');
      } else {
        console.log(`  src: ${v.src || '(空)'}`);
        console.log(`  readyState=${v.readyState} networkState=${v.networkState} paused=${v.paused} duration=${v.duration}`);
        console.log(`  ${ok(!v.error)} media error: ${v.error ? JSON.stringify(v.error) : '无'}`);
        console.log(`  ${ok(v.engineInjected)} 挂课引擎已注入`);
      }
    }

    console.log('\n体检完成。\n');
  } finally {
    await context.close();
    releaseProfileLock();
  }
}

main().catch((e) => {
  console.error('体检失败：', e);
  process.exit(1);
});
