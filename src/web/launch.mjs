/**
 * 桌面外壳 —— 起本地服务，再用 `chrome --app=` 把它开成一个**没有地址栏的独立窗口**。
 *
 * ════════════════════════════════════════════════════════════════════════
 *  为什么是 `chrome --app` 而不是 Tauri / Electron
 * ════════════════════════════════════════════════════════════════════════
 *   · 挂课**必须**用真实 Chrome（Widevine DRM + 播放事件上报 + 平台的前台检测），
 *     所以用户机器上一定已经有 Chrome —— 不必再塞一个 WebView 运行时。
 *   · `--app=` 是 Chrome 自带能力：开出来的窗口没有地址栏/标签栏，视觉上就是个桌面应用。
 *   · 于是「桌面应用」的成本 = 0 个新依赖、0 字节额外体积。Tauri/Electron 在这里
 *     只会多出几十 MB 且解决不了任何本项目的实际问题。
 *
 * ════════════════════════════════════════════════════════════════════════
 *  两个 user-data-dir，别搞混
 * ════════════════════════════════════════════════════════════════════════
 *   · smartedu-auto-profile      ← 挂课用（登录态、Widevine CDM）。**单例**，run.mjs 独占。
 *   · smartedu-autowatch-ui       ← 这个界面窗口用（下面 UI_PROFILE）。
 *   两者必须分开：挂课进程正占着前者，外壳再去抢就会 exitCode=21 崩掉。
 */

import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from './server.mjs';
import { chromeExe, chromeVersion } from '../browser.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.SMARTEDU_UI_PORT || 8477);

/** 界面窗口自己的 profile —— 绝不能用挂课那个 */
const UI_PROFILE = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'smartedu-autowatch-ui',
);

/**
 * 探活：端口上是不是**我们自己的**另一个实例。
 * 只看端口占用会把别的软件误判成本程序，所以要真的问一下 /api/status 的返回形状。
 */
async function existingInstance() {
  try {
    const ctl = AbortSignal.timeout(1500);
    const r = await fetch(`http://${HOST}:${PORT}/api/status`, { signal: ctl });
    if (!r.ok) return false;
    const j = await r.json();
    return typeof j.running === 'boolean' && Array.isArray(j.lines);
  } catch {
    return false;
  }
}

function openWindow(url) {
  const exe = chromeExe();
  if (!exe) {
    console.error(
      `找不到 Google Chrome，无法打开界面窗口。\n` +
        `  请先安装 Chrome：https://www.google.cn/chrome/\n` +
        `  装好后重新运行即可。（也可以直接在浏览器里打开 ${url}）`,
    );
    return null;
  }
  const child = spawn(
    exe,
    [
      `--app=${url}`,
      `--user-data-dir=${UI_PROFILE}`,
      '--window-size=1020,900',
      '--no-first-run',
      '--no-default-browser-check',
      // 关掉「Chrome 正受到自动测试软件控制」那类提示条带来的干扰
      '--disable-features=Translate,OptimizationHints',
    ],
    { detached: false, stdio: 'ignore', windowsHide: false },
  );
  child.on('error', (e) => console.error(`打开窗口失败：${e.message}`));
  return child;
}

async function main() {
  console.log(`Google Chrome ${chromeVersion() || '(未检测到)'}`);

  // ── 已经有实例在跑？直接把窗口叫到前面，不重复起服务 ──
  if (await existingInstance()) {
    const url = `http://${HOST}:${PORT}/`;
    console.log(`界面已在运行，正在打开窗口：${url}`);
    openWindow(url);
    return;
  }

  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  }).catch((e) => {
    if (e.code === 'EADDRINUSE') {
      throw new Error(
        `端口 ${PORT} 被占用了，但不是本程序的服务。\n` +
          `  换一个端口：set SMARTEDU_UI_PORT=8478 && node src/web/launch.mjs`,
      );
    }
    throw e;
  });

  const url = `http://${HOST}:${PORT}/`;
  console.log(`界面地址：${url}`);
  console.log('');
  console.log('  ★ 请让这个黑色窗口开着（可以最小化）。关掉它，挂课就会停。');
  console.log('  ★ 挂课是在浏览器窗口里操作：那个窗口关掉不影响挂课。');
  console.log('    重新运行本程序会接回同一个任务。');

  // ── 状态从 server.mjs 的 job 单例里读，这里只管「窗口关了要不要退」──
  const { job } = await import('./server.mjs');

  const win = openWindow(url);

  const shutdown = () => {
    // 关窗时如果还在挂课，服务继续活着（挂课不能因为关个窗口就断），
    // 但没人看着了，所以只提示、不退出。
    if (job.running) {
      console.log(`\n窗口已关闭，但挂课仍在进行（PID ${job.proc?.pid ?? '-'}）。`);
      console.log(`  重新运行本程序即可接回界面。要停掉挂课：再打开界面点「停止」。`);
      return;
    }
    console.log('\n窗口已关闭，退出。');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };

  if (win) {
    win.on('close', shutdown);
  } else {
    console.log('未打开窗口。按 Ctrl+C 退出。');
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(`\n启动失败：${e.message}\n`);
  process.exit(1);
});
