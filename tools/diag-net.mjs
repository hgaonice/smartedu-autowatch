/**
 * 联网对照实验 —— 查清「有头报 ERR_CERT_COMMON_NAME_INVALID、无头却成功」。
 *
 * 会打印每种模式下 Chrome 的真实命令行（从 chrome://version 读），
 * 以及导航到目标域名的结果，用来定位代理/证书问题到底出在哪一层。
 *
 *   node tools/diag-net.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const TARGET = 'https://basic.smartedu.cn/';

const CASES = [
  ['1. headful 默认（复现用户报错）', { headless: false }, []],
  ['2. headful + 显式绕过代理', { headless: false }, ['--proxy-bypass-list=*.smartedu.cn;*.cbern.com.cn;<local>']],
  ['3. headful + 完全不用代理', { headless: false }, ['--no-proxy-server']],
  ['4. headless 默认（用户说成功）', { headless: true }, []],
  ['5. headless + 完全不用代理', { headless: true }, ['--no-proxy-server']],
];

for (const [name, opts, extraArgs] of CASES) {
  const dir = path.join(os.tmpdir(), 'smartedu-net-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\n=== ${name} ===`);

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(dir, {
      channel: 'chrome',
      ...opts,
      args: extraArgs,
      ignoreDefaultArgs: ['--disable-component-update'],
      viewport: opts.headless ? { width: 1000, height: 700 } : null,
      locale: 'zh-CN',
    });

    const page = await ctx.newPage();

    // 从 chrome://version 读真实命令行 —— 这是唯一能看到 Playwright 实际传了什么的办法
    try {
      await page.goto('chrome://version', { timeout: 15_000 });
      const cmdline = await page.evaluate(() => {
        const el = document.querySelector('#command_line');
        return el ? el.textContent.trim() : '(读不到)';
      });
      const proxyFlags = cmdline.split(/\s+/).filter((a) => /proxy|Proxy/.test(a));
      console.log(`  代理相关参数: ${proxyFlags.length ? proxyFlags.join(' ') : '(无)'}`);
      console.log(`  是否带 --no-proxy-server: ${/--no-proxy-server/.test(cmdline) ? '是' : '否'}`);
    } catch (e) {
      console.log(`  chrome://version 读取失败: ${e.message.split('\n')[0]}`);
    }

    // 真正的目标导航
    try {
      const resp = await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      console.log(`  ✅ 导航成功  HTTP ${resp ? resp.status() : '?'}`);
      const info = await page.evaluate(() => ({ href: location.href, title: document.title.slice(0, 40) }));
      console.log(`  落地: ${info.href}  title="${info.title}"`);
    } catch (e) {
      console.log(`  ❌ 导航失败  ${e.message.split('\n')[0]}`);
    }
  } catch (e) {
    console.log(`  启动/异常 ❌ ${e.message.split('\n')[0]}`);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
