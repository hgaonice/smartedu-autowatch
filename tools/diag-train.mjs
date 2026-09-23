/**
 * 读【专题页】的权威学时 —— 被动抓包 + DOM 提取。
 *
 * 和 diag-hours.mjs 的区别：
 *   diag-hours  看单门课的 courseDetail 页（拿目录完成态 + study_details）
 *   diag-train  看专题 /training/<trainId> 页（拿 **每门课已认定学时**）
 *
 * 为什么要这个：run.mjs 的切课预算用的是「本地播放秒数」，重启就归零，
 * 于是会在平台已经认满的课上继续白挂。要改成「按平台已认定学时」驱动，
 * 就得先知道平台把这个数字放在哪个字段、哪个接口里。
 *
 *   node tools/diag-train.mjs                        # 默认 2026 暑期研修专题
 *   node tools/diag-train.mjs <trainId> [waitSec]
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchContext, reusePage, gotoWithRetry, loginState } from '../src/browser.mjs';
import { OUT_DIR, ROOT } from '../src/engine.mjs';

const TRAIN = process.argv[2] || 'dc6d78f2-bad8-4d09-b8da-0d758803dbe4';
const WAIT_S = Number(process.argv[3] || 40);
const URL = `https://basic.smartedu.cn/training/${TRAIN}`;

const ctx = await launchContext({ headless: true });
const page = await reusePage(ctx);

// ---- 被动抓平台自己的 API 响应（裸 fetch 会 403，只能读它自己的流量）----
const captured = new Map();
const failures = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!/\/v1\/|\/v3\/|\/teach\/|\/proxy\/|\/studio\/|\/bdxcloud\/|\/zxx\//.test(u)) return;
  const key = u.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
  if (res.status() >= 400) { failures.push(`${res.status()} ${key}`); return; }
  if (captured.has(key)) return;
  try {
    const text = await res.text();
    captured.set(key, { url: u, status: res.status(), len: text.length, body: text.slice(0, 400_000) });
  } catch { /* 响应体已被消费，忽略 */ }
});

console.log('\n=== 专题页权威学时侦察 ===');
console.log(`  ${URL}\n`);
await gotoWithRetry(page, URL, { label: '专题页', timeout: 60_000 });

// SPA 渲染竞态 —— 多等几轮再下结论
let elapsed = 0;
for (const t of [8, 16, 25]) {
  await page.waitForTimeout((t - elapsed) * 1000);
  elapsed = t;
  const m = await page.evaluate(() => ({
    href: location.href,
    links: document.querySelectorAll('a[href*="courseDetail"]').length,
    hasHourText: /学时/.test(document.body.innerText),
    textLen: document.body.innerText.length,
  }));
  console.log(`  [${String(t).padStart(2)}s] 课程链接=${m.links}  出现「学时」=${m.hasHourText ? '✅' : '❌'}  正文=${m.textLen}字`);
}

const ls = await loginState(page);
console.log(`\n登录态：${ls.loggedIn ? '✅ 已登录' : '❌ 未登录'}  ${ls.signals?.slice(0, 3).join(', ') || ''}`);

const remain = Math.max(0, WAIT_S - 25);
if (remain > 0) {
  console.log(`\n再等 ${remain}s 收集流量…`);
  await page.waitForTimeout(remain * 1000);
}

// ---- 1) 含「学时/进度」语义的响应体 ----
console.log('\n\n============== 响应体里带「学时 / 进度」的接口 ==============\n');
const KEYS = /学时|period|progress|study|learn|complete|finish|credit|total_time|duration/i;
let found = 0;
for (const [k, v] of captured) {
  if (!KEYS.test(v.body)) continue;
  found++;
  console.log(`── ${k}   [${v.status}]  ${v.len}B`);
  console.log('   ' + v.body.replace(/\s+/g, ' ').slice(0, 700) + '\n');
}
if (!found) console.log('  （没有匹配的 —— 见下面完整清单）');

// ---- 2) DOM 里每门课一行（标题 + 学时 + 状态）----
console.log('\n============== 页面上的课程行 ==============\n');
const rows = await page.evaluate(() => {
  const out = [];
  const seen = new Set();
  // 任何"看起来像课程卡片"的块：里面同时有课程标题和「学时」
  const blocks = [...document.querySelectorAll('div, li, article, section')];
  for (const el of blocks) {
    const t = (el.innerText || '').replace(/[ \t]+/g, ' ').trim();
    if (!t || t.length > 400 || !/学时/.test(t)) continue;
    if (!/版块|专题|研修|素养|教育|提升|培训|课程/.test(t)) continue;
    // 取最内层：子节点里没别人也满足条件就用它
    if ([...el.children].some((c) => /学时/.test(c.innerText || ''))) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    const a = el.querySelector('a[href*="courseDetail"]');
    out.push({ text: t.slice(0, 260), courseId: a?.href?.match(/courseId=([0-9a-f-]+)/)?.[1] || null });
  }
  return out;
});
if (rows.length) {
  rows.slice(0, 30).forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r.text.replace(/\n/g, ' | ')}\n      courseId=${r.courseId || '-'}`));
} else {
  console.log('  （没提取到结构化课程行 —— 下面是正文）');
}

// ---- 3) 正文兜底 ----
const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').trim());
console.log('\n\n============== 页面正文（前 2500 字）==============\n');
console.log(text.slice(0, 2500));

// ---- 4) 全部接口清单 ----
console.log('\n\n============== 抓到的全部接口 ==============\n');
for (const [k, v] of [...captured].sort()) console.log(`  ${String(v.len).padStart(8)}B  ${k}`);
if (failures.length) {
  console.log('\n============== 平台自己都失败的请求 ==============\n');
  [...new Set(failures)].slice(0, 20).forEach((f) => console.log('  ' + f));
}

const dump = path.join(OUT_DIR, `train-recon-${TRAIN.slice(0, 8)}.json`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(dump, JSON.stringify({ trainId: TRAIN, url: URL, captured: Object.fromEntries(captured), rows, failures, text, login: ls }, null, 2));
console.log(`\n全量已写入 ${path.relative(ROOT, dump)}\n`);

await ctx.close();
