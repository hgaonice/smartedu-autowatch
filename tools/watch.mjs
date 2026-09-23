#!/usr/bin/env node
/**
 * 实时监控跑批日志。
 *
 *   node tools/watch.mjs                          # 默认自动选 out/ 下最新的一份日志，3 秒刷新
 *   node tools/watch.mjs --log out/xxx.log        # 指定日志（多个跑批时用这个）
 *   node tools/watch.mjs --interval 5000
 *   node tools/watch.mjs --once                   # 只打印一次（给脚本/复制用）
 *
 * 为什么要这个脚本：进度行是 `process.stdout.write('\r...')` 原地刷新的，
 * 全在一行里 —— 直接拿记事本/编辑器打开会看到一坨几万字符的文本。
 * 这里按 \r 和 \n 切开，还原成人能看的「当前状态 + 课程进度」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  // 取【最后】一次出现：这样 `npm run monitor -- --log out/xxx.log` 能盖掉
  // package.json 里可能写死的值（用 indexOf 的话先出现的反而赢，改不动）
  const i = argv.lastIndexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

// 默认【自动选最新的一份】日志。以前写死 out/run-10h.log，结果是：
// 起了新一轮跑批（写 out/run-continue.log）、监控却盯着上一轮的旧日志，
// 「当前进度」一直显示早就停掉的旧课程，很容易被误读成「还在挂那门课」。
function pickLog() {
  const explicit = arg('--log', null);
  if (explicit) return path.resolve(ROOT, explicit);
  const dir = path.join(ROOT, 'out');
  if (fs.existsSync(dir)) {
    const cands = fs
      .readdirSync(dir)
      .filter((f) => /^run.*\.log$/i.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        return { p, m: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.m - a.m);
    if (cands.length) return cands[0].p;
  }
  return path.join(dir, 'run-continue.log');
}

const LOG = pickLog();
const AUTO_PICKED = arg('--log', null) === null;
const INTERVAL = Number(arg('--interval', 3000));
const ONCE = argv.includes('--once');

/** 日志时间戳是 UTC，转成本地时间好对表 */
function local(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toTimeString().slice(0, 8);
}

/** 列出 out/ 下其它日志（按新→旧），用来在「这份已停」时指路 */
function otherLogs(exclude) {
  const dir = path.join(ROOT, 'out');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.log$/i.test(f))
    .map((f) => {
      const p = path.join(dir, f);
      return { mtime: fs.statSync(p).mtime, path: p };
    })
    .filter((o) => path.resolve(o.path) !== path.resolve(exclude))
    .map((o) => ({ ...o, fresh: Date.now() - o.mtime.getTime() < 30_000 }))
    .sort((a, b) => b.mtime - a.mtime);
}

function render() {
  if (!fs.existsSync(LOG)) return `找不到日志：${LOG}\n（跑批还没启动？或换个 --log 路径）`;

  const raw = fs.readFileSync(LOG, 'utf8');
  // 进度行是原地 \r 刷新的，偶发会和后面的日志行粘在一起（`…学时≈0.5[04:27:05] ⚠️`），
  // 所以除了 \r/\n，再按 `[HH:MM:SS]` 时间戳前面切一刀，保证每行独立。
  const lines = raw
    .split(/[\r\n]+/)
    .flatMap((l) => l.split(/(?=\[\d{2}:\d{2}:\d{2}\])/))
    .filter((l) => l.trim());
  const st = fs.statSync(LOG);

  const milestones = lines.filter((l) => /=====|结果：|全部完成|✅|⚠️|拉取|启动 Chrome|登录态/.test(l));
  const current = lines[lines.length - 1] || '(还没有输出)';

  const ageSec = Math.round((Date.now() - st.mtimeMs) / 1000);
  const fresh = ageSec < 30;
  const alive = fresh ? `✅ 正在写入（${ageSec}s 前）` : `⚠️ 已停 ${ageSec}s`;

  const out = [];
  out.push('='.repeat(72));
  out.push('  智慧教育平台 · 挂课监控');
  out.push('='.repeat(72));
  out.push(`  日志：${LOG}${AUTO_PICKED ? '  （自动选了最新的一份）' : ''}`);
  out.push(`  大小：${(st.size / 1024).toFixed(1)} KB   最后写入：${local(st.mtime)}   ${alive}`);
  out.push('');

  // ★ 日志过期就把话说到脸上："当前进度" 其实是死掉的旧跑批留下的最后一行，
  //   不标清楚就会被当成实时状态（实测就这么被误会过一次）。
  if (!fresh) {
    const others = otherLogs(LOG);
    out.push(`  ⚠️  这份日志已经 ${ageSec}s（${(ageSec / 60).toFixed(0)} 分钟）没更新了 ——`);
    out.push(`     下面这段是【早就停掉的旧跑批】最后留下的状态，不是当前进度。`);
    if (others.length) {
      out.push('     out/ 下还有这些日志（新 → 旧）：');
      for (const o of others.slice(0, 5)) {
        out.push(
          `        ${local(o.mtime)}  ${path.relative(ROOT, o.path)}${o.fresh ? '   ← 这份是活的' : ''}`,
        );
      }
      const live = others.find((o) => o.fresh);
      if (live) out.push(`     → node tools/watch.mjs --log ${path.relative(ROOT, live.path)}`);
    }
    out.push('');
  }
  out.push('  ── 当前进度 ──');
  out.push(`  ${current.trim()}`);
  out.push('');
  out.push(`  ── 关键节点（最近 ${Math.min(milestones.length, 14)} 条）──`);
  for (const l of milestones.slice(-14)) out.push(`  ${l.trim()}`);
  out.push('');
  out.push(`  提示：进度行里的「本地=」是本次跑批累计播放秒数，「学时≈」= 本地/3600`);
  out.push(`  Ctrl+C 退出监控 —— 注意退出监控【不会】停掉挂课进程。`);
  return out.join('\n');
}

if (ONCE) {
  console.log(render());
} else {
  process.stdout.write('\x1b[2J\x1b[H');
  setInterval(() => {
    process.stdout.write('\x1b[2J\x1b[H' + render() + '\n');
  }, INTERVAL);
  process.stdout.write('\x1b[2J\x1b[H' + render() + '\n');
}
