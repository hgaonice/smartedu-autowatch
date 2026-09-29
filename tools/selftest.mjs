/**
 * 自检 —— 无头下验证「引擎确实注入了、确实生效了」。
 *
 * 用公开页面就能跑，不需要登录。用于改完引擎后的回归验证。
 *
 *   node tools/selftest.mjs
 */

import { launchContext, reusePage } from '../src/browser.mjs';
import { installEngine } from '../src/engine.mjs';
import { preflight, reportPreflight, releaseProfileLock, guard } from '../src/preflight.mjs';

const TARGET = 'https://basic.smartedu.cn/';

const ASSERT = `(() => {
  const r = { pass: [], fail: [] };
  const ck = (cond, name, extra) => (cond ? r.pass : r.fail).push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));

  ck(true, 'window.__SMARTEDU_CONFIG__ 已注入', typeof window.__SMARTEDU_CONFIG__);

  const api = window.__SMARTEDU_AUTOWATCH__;
  ck(!!api, '引擎挂载 window.__SMARTEDU_AUTOWATCH__');

  // 1) 可见性伪造
  ck(document.hidden === false, 'document.hidden 恒为 false', document.hidden);
  ck(document.visibilityState === 'visible', 'document.visibilityState 恒为 visible', document.visibilityState);

  // 2) 事件拦截：注册 visibilitychange 应被吞掉
  let fired = false;
  document.addEventListener('visibilitychange', () => { fired = true; });
  document.dispatchEvent(new Event('visibilitychange'));
  ck(fired === false, 'visibilitychange 监听被拦截（派发后未触发）');

  // window.onblur 赋值应被忽略
  window.onblur = () => { fired = true; };
  ck(window.onblur === null, 'window.onblur 赋值被吞掉', window.onblur);

  // 3) pause 劫持 —— 行为验证，不只是看函数存不存在
  const v = document.createElement('video');
  document.body.appendChild(v);
  // 把实例属性 shadow 掉，骗过引擎的「无事可做」短路判断，逼它走拦截分支
  Object.defineProperty(v, 'currentTime', { get: () => 30, configurable: true });
  Object.defineProperty(v, 'readyState', { get: () => 4, configurable: true });
  Object.defineProperty(v, 'ended', { get: () => false, configurable: true });
  Object.defineProperty(v, 'paused', { get: () => true, configurable: true });
  const before = api.state.pauseBlocked;
  try { v.pause(); } catch (e) { r.fail.push('v.pause() 抛异常: ' + e.message); }
  ck(api.state.pauseBlocked === before + 1,
     'pause() 被真正拦截（pauseBlocked +1）', api.state.pauseBlocked - before);
  v.remove();

  // 4) 配置生效
  ck(window.__SMARTEDU_CONFIG__.noUI === true, 'noUI 生效（无头下不渲染浮层）', window.__SMARTEDU_CONFIG__.noUI);
  ck(window.__SMARTEDU_CONFIG__.playbackRate === 2, 'playbackRate 传入', window.__SMARTEDU_CONFIG__.playbackRate);
  ck(api && api.config.playbackRate === 2, '引擎 CONFIG 已接收宿主覆盖', api && api.config.playbackRate);
  ck(!document.getElementById('__smartedu_panel__'), 'noUI 下确实没有浮层面板');

  // 5) snapshot 可用
  let snap = null;
  try { snap = api.snapshot(); } catch (e) { r.fail.push('snapshot() 抛异常: ' + e.message); }
  ck(snap && typeof snap.fake_visibility === 'boolean', 'snapshot() 可调用', snap && Object.keys(snap).length + ' 个字段');
  // 6) 异常信号字段（宿主 run.mjs 靠它告警/放弃）
  ck(snap && typeof snap.question_modal === 'boolean', 'snapshot.question_modal 存在', snap && snap.question_modal);
  ck(snap && typeof snap.resource_skips === 'number', 'snapshot.resource_skips 存在', snap && snap.resource_skips);

  // 6) 真 Chrome 判定
  ck(navigator.webdriver === undefined, 'navigator.webdriver 已抹除', navigator.webdriver);
  ck(!/Headless/i.test(navigator.userAgent), 'UA 无 Headless 指纹', navigator.userAgent.slice(0, 90));

  // 7) 节流豁免钩子（Web Lock）
  ck(!!navigator.locks, 'navigator.locks 可用（Web Lock 豁免链）');

  return { ...r, state: snap };
})()`;

// 自检也要开浏览器，而专用 profile 是**独占资源**：有一批在跑时两个进程抢同一个
// user-data-dir，第二个 Chrome 会立刻退出（exitCode=21），以前这里就抛 Playwright
// 原始堆栈 —— 分不清是环境坏了、还是单纯的“已经有一批在跑”。先预检拿人话。
const pf = preflight({ label: 'selftest.mjs' });
reportPreflight(pf);
if (!pf.ok) {
  process.exit(3);
}

const ctx = await guard(() => launchContext({ headless: true }));
// resourceProbeMs 调小：下面要验证「非视频资源跳过」，默认 30s 等不起
await installEngine(ctx, { playbackRate: 2, autoNext: true, resourceProbeMs: 1200 });

const page = await reusePage(ctx);
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(4000);

const r = await page.evaluate(ASSERT);

// ── 行为验证：非视频资源跳过 + 答题弹窗回传给宿主 ──
await page.evaluate(() => {
  const cat = document.createElement('div');
  cat.className = 'tcourse-catalog';
  const pdf = document.createElement('div');
  pdf.className = 'resource-item';
  pdf.textContent = '资料：课程说明（PDF）';
  const vid = document.createElement('div');
  vid.className = 'resource-item';
  vid.textContent = '视频：第一课';
  vid.addEventListener('click', () => {
    if (!document.querySelector('video')) {
      const v = document.createElement('video');
      v.muted = true;
      document.body.appendChild(v);
    }
  });
  cat.append(pdf, vid);
  document.body.appendChild(cat);
  const q = document.createElement('div');
  q.className = 'nqti-option';
  q.textContent = 'A. 测试答题选项';
  document.body.appendChild(q);
});

let s2 = null;
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(1000);
  s2 = await page.evaluate(() => window.__SMARTEDU_AUTOWATCH__.snapshot());
  if (s2?.hasVideo && s2.resource_skips >= 1) {
    break;
  }
}
const ck = (cond, name) => (cond ? r.pass : r.fail).push(name);
ck(s2?.question_modal === true, '答题弹窗被识别并回传给宿主');
ck((s2?.question_text || '').includes('测试答题选项'), '答题弹窗文本回传');
ck(s2?.hasVideo === true, '非视频资源被跳过后成功播放视频');
ck(typeof s2?.resource_skips === 'number' && s2.resource_skips >= 1, '非视频资源跳过计数 +1');

console.log('\n=== 引擎自检（无头）===\n');
for (const p of r.pass) {
  console.log(`  ✅ ${p}`);
}
for (const f of r.fail) {
  console.log(`  ❌ ${f}`);
}
console.log(`\n通过 ${r.pass.length} / ${r.pass.length + r.fail.length}`);
console.log('\n实时快照:', JSON.stringify(r.state, null, 2));

await ctx.close();
releaseProfileLock();
process.exit(r.fail.length ? 1 : 0);
