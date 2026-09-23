/**
 * 决定性实测：2x 倍速到底算不算学时？
 *
 * 做法：无头挂一段真实时间，读**平台自己**的进度接口，
 *       算「平台进度增量 ÷ 墙钟增量」。
 *         ≈2  → 平台认可倍速，2x 省一半时间
 *         ≈1  → 平台按真实时长计，2x 白挂
 *         ≈0  → 平台压根没在记，问题不在倍速
 *
 *   node tools/verify-rate.mjs [课程URL] [秒数=660]
 */

import fs from 'node:fs';
import path from 'node:path';
import { launchContext, reusePage, gotoWithRetry } from '../src/browser.mjs';
import { installEngine, OUT_DIR, ROOT } from '../src/engine.mjs';

const COURSE_URL =
  process.argv[2] ||
  'https://basic.smartedu.cn/teacherTraining/courseDetail?courseId=165d9433-5486-43e4-926e-3f33b92635e4&libraryId=bb042e69-9a11-49a1-af22-0c3fab2e92b9';
const SECONDS = Number(process.argv[3] || 660);
const RATE = 2;

const ctx = await launchContext({ headless: true });
await installEngine(ctx, { playbackRate: RATE, autoNext: true });
const page = await reusePage(ctx);

// ---- 抓平台自己的进度接口全量响应（字段发现）----
const apiBodies = new Map();
page.on('response', async (res) => {
  const u = res.url();
  if (!/\/v1\/study_details|\/progress\/actions|\/record_config|\/action_rules/.test(u)) return;
  const key = u.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
  if (apiBodies.has(key)) return;
  try {
    apiBodies.set(key, { url: u, status: res.status(), body: (await res.text()).slice(0, 2500) });
  } catch {}
});

console.log('\n=== 倍速 / 学时 决定性实测 ===');
console.log(`课程: ${COURSE_URL.slice(0, 100)}`);
console.log(`倍速: ${RATE}x   时长: ${SECONDS}s (${(SECONDS / 60).toFixed(1)} 分钟)\n`);

await gotoWithRetry(page, COURSE_URL, { label: '课程页', timeout: 60_000 });

const snap = () => page.evaluate(() => window.__SMARTEDU_AUTOWATCH__?.snapshot() ?? null);

/** 读目录里每个条目的 title 属性 —— 这是最可靠的完成状态来源 */
const marks = () =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll('.resource-item')];
    const titles = items.map((el) => {
      const t = el.querySelector('[title]');
      const c = el.querySelector('.status-icon');
      return t?.getAttribute('title') || (c?.textContent || '').trim().slice(0, 6) || '?';
    });
    return { total: items.length, done: titles.filter((t) => /已完成|已学完/.test(t)).length, titles };
  });

const t0 = Date.now();
const timeline = [];
let lastPrint = 0;
let firstTitles = null;

while ((Date.now() - t0) / 1000 < SECONDS) {
  const s = await snap();
  if (!s) {
    await page.waitForTimeout(4000);
    continue;
  }

  const wall = Math.round((Date.now() - t0) / 1000);
  const m = await marks();
  if (!firstTitles) firstTitles = m.titles;

  timeline.push({
    wall,
    media: s.watched_media_sec,
    mediaTime: s.currentTime,
    platform: s.platform_progress,
    verdict: s.rate_verdict,
    done: m.done,
    total: m.total,
    paused: s.paused,
    rate: s.playbackRate,
    blocked: s.paused_blocked,
  });

  if (wall - lastPrint >= 20) {
    lastPrint = wall;
    const v = s.rate_verdict;
    console.log(
      `[${String(wall).padStart(4)}s墙钟] 媒体累计=${String(s.watched_media_sec).padStart(5)}s` +
        ` 当前点=${String(Math.round(s.currentTime || 0)).padStart(4)}s` +
        ` 平台=${String(s.platform_progress ?? '?').padStart(5)}` +
        ` 完成=${m.done}/${m.total}` +
        ` 倍速=${s.playbackRate}` +
        `${s.paused ? ' ⏸' : ''}` +
        (v ? `  ★比值=${v.ratio} (平台+${v.platformDelta}/${v.wallSec}s墙钟)` : ''),
    );
  }

  if (m.total > 0 && m.done >= m.total) {
    console.log(`\n🎉 全部 ${m.total} 节已完成！`);
    break;
  }
  await page.waitForTimeout(5000);
}

// ---- 总结 ----
const last = timeline.at(-1) || {};
const first = timeline[0] || {};
const wallSpan = (last.wall || 0) - (first.wall || 0);
const mediaSpan = (last.media || 0) - (first.media || 0);
const platSpan = last.platform != null && first.platform != null ? last.platform - first.platform : null;

console.log('\n================ 结论 ================');
console.log(`墙钟走过      : ${wallSpan}s`);
console.log(`媒体时间推进  : ${mediaSpan}s   → 实际倍速 ${wallSpan ? (mediaSpan / wallSpan).toFixed(2) : '?'}x`);
console.log(`平台进度增量  : ${platSpan ?? '未捕获'}`);
console.log(`完成标记      : ${first.done} → ${last.done} / ${last.total || '?'}`);
console.log(`拦截 pause    : ${last.blocked}`);

if (platSpan != null && wallSpan > 60) {
  const ratio = platSpan / wallSpan;
  console.log(`\n★ 平台进度 ÷ 墙钟 = ${ratio.toFixed(2)}`);
  if (ratio >= 1.6) console.log('  ✅ 平台认可倍速 —— 2x 有效，学时按媒体进度计');
  else if (ratio >= 0.8) console.log('  ⚠️ 平台按真实时长计 —— 2x 拿不到额外学时，需降回 1x');
  else console.log('  ❌ 平台进度几乎不动 —— 问题不在倍速，另有上报阻塞');
} else {
  console.log('\n⚠️ 平台进度样本不足，无法判定 —— 需要更长实测或换课程');
}

console.log('\n【目录条目 title 实测值】');
console.log('  ' + (firstTitles || []).slice(0, 8).join(' | '));

console.log('\n【平台进度接口响应（字段发现）】');
if (!apiBodies.size) console.log('  (没抓到)');
for (const [k, v] of apiBodies) {
  console.log(`\n  ${k}   HTTP ${v.status}`);
  console.log('  ' + v.body.replace(/\s+/g, ' ').slice(0, 700));
}

const out = path.join(OUT_DIR, 'verify-rate.json');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(out, JSON.stringify({ course: COURSE_URL, rate: RATE, wallSpan, mediaSpan, platSpan, timeline, apiBodies: Object.fromEntries(apiBodies), firstTitles }, null, 2));
console.log(`\n明细已写入 ${path.relative(ROOT, out)}\n`);

await ctx.close();
