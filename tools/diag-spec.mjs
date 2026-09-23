/**
 * 拿两样东西（都必须在页面上下文里做）：
 *   1. 专题规则 spec_rule.json —— 学时要求在这里
 *   2. 长时间播放，抓「学时上报」接口（Phase 2 的核心未知）
 *
 *   node tools/diag-spec.mjs [秒数，默认200]
 */

import { launchContext, reusePage, gotoWithRetry } from '../src/browser.mjs';
import { installEngine } from '../src/engine.mjs';

const SECONDS = Number(process.argv[2] || 200);
const COURSE_URL =
  'https://basic.smartedu.cn/teacherTraining/courseDetail?courseId=165d9433-5486-43e4-926e-3f33b92635e4&libraryId=bb042e69-9a11-49a1-af22-0c3fab2e92b9';

const ctx = await launchContext({ headless: true });
await installEngine(ctx, { playbackRate: 2 });
const page = await reusePage(ctx);

// 上报类接口的嫌疑名单
const REPORT_RE = /progress|study|record|learn|period|heartbeat|ping|duration|watch|play_?log|report|trace|beacon|stats?\b/i;
const hits = new Map();
page.on('request', (req) => {
  const u = req.url();
  if (!REPORT_RE.test(u)) return;
  if (/\.(js|css|png|jpg|svg|woff2?|ico)(\?|$)/i.test(u)) return;
  const path = u.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
  const key = path + '|' + req.method();
  const rec = hits.get(key) || { n: 0, method: req.method(), path, sample: '', postData: null };
  rec.n++;
  if (!rec.sample && u.includes('?')) rec.sample = u.slice(u.indexOf('?'), u.indexOf('?') + 160);
  if (!rec.postData && req.method() === 'POST') {
    try {
      rec.postData = String(req.postData() || '').slice(0, 300);
    } catch {}
  }
  hits.set(key, rec);
});

console.log('\n=== 专题规则 + 学时上报侦察 ===\n');
await gotoWithRetry(page, COURSE_URL, { label: '课程页', timeout: 60_000 });
await page.waitForTimeout(10_000);

// ---- 1. spec_rule.json（必须在页面上下文里 fetch）----
const spec = await page.evaluate(async () => {
  const trainId = 'dc6d78f2-bad8-4d09-b8da-0d758803dbe4';
  const out = {};
  for (const name of ['spec_rule', 'train']) {
    const url =
      name === 'spec_rule'
        ? `/studio/api_static/trains/${trainId}/spec_rule.json`
        : `/teach/api_static/trains/${trainId}.json`;
    try {
      const r = await fetch(url);
      out[name] = { status: r.status, body: (await r.text()).slice(0, 1500) };
    } catch (e) {
      out[name] = { status: 'ERR', body: String(e.message) };
    }
  }
  return out;
});

console.log('【专题规则 spec_rule.json】');
console.log(`  HTTP ${spec.spec_rule.status}`);
console.log('  ' + spec.spec_rule.body.replace(/\s+/g, ' ').slice(0, 900));

// ---- 2. 播一会儿，等上报 ----
console.log(`\n【挂着播 ${SECONDS}s，等学时上报…】`);
await page.evaluate(() => {
  const it = document.querySelector('.resource-item');
  if (it) it.click();
});
await page.waitForTimeout(8000);

for (let i = 0; i < Math.ceil(SECONDS / 20); i++) {
  const s = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { t: Math.round(v.currentTime), r: v.playbackRate, p: v.paused, rs: v.readyState } : null;
  });
  if (!s) break;
  process.stdout.write(`  [${String(i * 20).padStart(3)}s] 播放到 ${s.t}s  倍速${s.r}  ${s.p ? '已暂停!' : '播放中'}  readyState=${s.rs}\n`);
  await page.waitForTimeout(20_000);
}

const snap = await page.evaluate(() => {
  const a = window.__SMARTEDU_AUTOWATCH__;
  if (!a) return null;
  const s = a.snapshot ? a.snapshot() : a;
  return { keys: Object.keys(s), snap: s };
});
console.log('\n【引擎内部状态】');
if (snap) {
  console.log('  字段: ' + snap.keys.join(', '));
  console.log('  ' + JSON.stringify(snap.snap).slice(0, 700));
} else {
  console.log('  (取不到)');
}

console.log('\n【★ 上报类接口命中】');
if (!hits.size) {
  console.log('  ❌ 没有命中任何上报类接口 —— 学时上报可能不是定时 API，');
  console.log('     而是挂在 video 事件上（timeupdate/ended），或走 sendBeacon。');
} else {
  [...hits.values()].sort((a, b) => b.n - a.n).forEach((h) => {
    console.log(`  ${String(h.n).padStart(3)}×  ${h.method}  ${h.path}`);
    if (h.sample) console.log(`         query: ${h.sample}`);
    if (h.postData) console.log(`         body : ${h.postData}`);
  });
}

console.log('\n完成。\n');
await ctx.close();
