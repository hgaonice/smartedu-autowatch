/**
 * 诊断：确认实际启动的是哪个浏览器，以及 Widevine 为何不可用。
 * 一次性脚本，结论写进 README 后可删。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const REAL_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROBE = `(async () => {
  const out = {
    ua: navigator.userAgent,
    brands: (navigator.userAgentData && navigator.userAgentData.brands || []).map(b => b.brand + '/' + b.version),
    widevine: null, wvError: null,
  };
  try {
    const a = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
      initDataTypes: ['cenc'],
      videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
    }]);
    out.widevine = a.keySystem;
  } catch (e) { out.wvError = e.name + ': ' + e.message; }
  return out;
})()`;

const CASES = [
  ['A. channel:chrome（当前实现）', { channel: 'chrome' }],
  ['B. channel:chrome + 允许组件更新', { channel: 'chrome', ignoreDefaultArgs: ['--disable-component-update'] }],
  ['C. 直接指定真 Chrome 路径', { executablePath: REAL_CHROME }],
  ['D. 真 Chrome + 允许组件更新 + 不禁用特性', {
      executablePath: REAL_CHROME,
      ignoreDefaultArgs: ['--disable-component-update', '--disable-features=MediaRouter'],
    }],
];

for (const [name, launchOpts] of CASES) {
  const dir = path.join(os.tmpdir(), 'smartedu-probe-' + name.replace(/\W+/g, ''));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(dir, {
      ...launchOpts,
      headless: true,
      viewport: { width: 800, height: 600 },
    });
    const page = await ctx.newPage();
    await page.goto('https://basic.smartedu.cn/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const r = await page.evaluate(PROBE);
    const isReal = /Chrome\/15[0-9]/.test(r.ua) && !/HeadlessChrome/.test(r.ua);
    console.log(`\n${name}`);
    console.log(`  Widevine : ${r.widevine ? '✅ ' + r.widevine : '❌ ' + r.wvError}`);
    console.log(`  brands   : ${r.brands.join(', ') || '(无)'}`);
    console.log(`  UA       : ${r.ua.slice(0, 110)}`);
    console.log(`  组件目录 : ${fs.existsSync(path.join(dir, 'WidevineCdm')) ? '已生成 ✅' : '未生成'}`);
    void isReal;
  } catch (e) {
    console.log(`\n${name}`);
    console.log(`  启动失败 ❌ ${e.message.split('\n')[0]}`);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
