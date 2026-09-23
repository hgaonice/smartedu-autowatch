/**
 * 挖「权威学时」数字 —— 被动版。
 *
 * 教训：不要用裸 fetch 打平台接口。同样一个 URL，
 *   平台的 JS 打 → 200；我从页面上下文直接 fetch → 403。
 * 说明它依赖自定义鉴权头（不是 cookie）。所以只能被动读它自己的流量。
 *
 *   node tools/diag-hours.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { launchContext, reusePage, gotoWithRetry, loginState } from '../src/browser.mjs';
import { installEngine, OUT_DIR, ROOT } from '../src/engine.mjs';

const COURSE = '165d9433-5486-43e4-926e-3f33b92635e4';
const LIB = 'bb042e69-9a11-49a1-af22-0c3fab2e92b9';
const WAIT_S = Number(process.argv[2] || 45);

const ctx = await launchContext({ headless: true });
await installEngine(ctx, {});          // 用默认配置，让引擎接管目录 + 自动开场
const page = await reusePage(ctx);

// ---- 被动抓平台自己的所有 API 响应 ----
const captured = new Map();
const failures = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!/\/v1\/|\/v3\/|\/teach\/|\/proxy\/|\/studio\/|\/bdxcloud\/|\/zxx\//.test(u)) return;
  const key = u.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
  if (res.status() >= 400) {
    failures.push(`${res.status()} ${key}`);
    return;
  }
  if (captured.has(key)) return;
  try {
    const text = await res.text();
    captured.set(key, { url: u, status: res.status(), len: text.length, body: text.slice(0, 400_000) });
  } catch { /* 响应体已被消费 / 重定向，忽略 */ }
});

console.log('\n=== 学时权威数字（被动侦察）===\n');
await gotoWithRetry(
  page,
  `https://basic.smartedu.cn/teacherTraining/courseDetail?courseId=${COURSE}&libraryId=${LIB}`,
  { label: '课程页', timeout: 60_000 },
);

// 分阶段看渲染（已知有 6-8s 渲染竞态，别急着下结论）
let elapsed = 0;
for (const t of [8, 16, 25]) {
  await page.waitForTimeout((t - elapsed) * 1000);
  elapsed = t;
  const m = await page.evaluate(() => ({
    items: document.querySelectorAll('.resource-item').length,
    video: !!document.querySelector('video'),
    memErr: window.__SMARTEDU_AUTOWATCH__?.state ? null : 'no-engine',
  }));
  console.log(`  [${String(t).padStart(2)}s] 目录条目=${m.items}  video=${m.video}  引擎=${m.memErr ? '❌' : '✅'}`);
}

const ls = await loginState(page);
console.log(`\n登录态：${ls.loggedIn ? '✅ 已登录' : '❌ 未登录'}  ${ls.signals?.slice(0, 3).join(', ') || ''}`);

// 剩余时间继续挂着，让它多跑出点流量（自动开场会开始播）
const remain = Math.max(0, WAIT_S - 25);
if (remain > 0) {
  console.log(`\n再挂 ${remain}s 收集流量（引擎会自动开场播放）…`);
  await page.waitForTimeout(remain * 1000);
}

// ---- 挑出含进度/学时语义的响应 ----
console.log('\n\n============== 平台响应里与「进度 / 学时」相关的 ==============\n');
const KEYS = /progress|period|学时|study|learn|total_time|complete|finish|credit|score|duration/i;
let found = 0;
for (const [k, v] of captured) {
  if (!KEYS.test(v.body)) continue;
  found++;
  console.log(`── ${k}   [${v.status}]`);
  console.log('   ' + v.body.replace(/\s+/g, ' ').slice(0, 900) + '\n');
}
if (!found) console.log('  （没有匹配的响应体 —— 看下面的全部清单）');

console.log('\n============== 抓到的全部 API（含体积）==============\n');
for (const [k, v] of [...captured].sort()) {
  console.log(`  ${String(v.len ?? v.body.length).padStart(8)}B  ${k}`);
}
if (failures.length) {
  console.log('\n============== 平台自己都失败的请求（值得注意）==============\n');
  [...new Set(failures)].slice(0, 20).forEach((f) => console.log('  ' + f));
}

// ---- 目录完成态 ----
const marks = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.resource-item')];
  return {
    total: items.length,
    titles: items.map((el) => el.querySelector('[title]')?.getAttribute('title') || '?'),
    labels: items.map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 44)),
  };
});
console.log(`\n【目录】共 ${marks.total} 条，完成 ${marks.titles.filter((t) => /已完成/.test(t)).length} 条`);
marks.titles.slice(0, 25).forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. [${t.padEnd(4)}] ${marks.labels[i] || ''}`));

const dump = path.join(OUT_DIR, 'hours-recon.json');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(dump, JSON.stringify({ captured: Object.fromEntries(captured), failures, marks, login: ls }, null, 2));
console.log(`\n全量已写入 ${path.relative(ROOT, dump)}\n`);

await ctx.close();
