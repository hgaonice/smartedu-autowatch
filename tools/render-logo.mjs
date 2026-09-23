#!/usr/bin/env node
/**
 * 把 assets/logo.svg 渲染成位图资源。
 *
 * 为什么需要：GitHub 的 README 与社交预览（social preview）都吃 PNG 最稳 ——
 * SVG 虽然能渲染，但社交预览卡片只收 PNG/JPG。logo 本身是手写 SVG（矢量、可缩放、
 * 无外部依赖），位图只是它的产物，所以**改 logo 要改 SVG，再跑这个脚本重新生成**。
 *
 * 用法：
 *   node tools/render-logo.mjs
 *
 * 产物：
 *   assets/logo.png            512×512      README 页头 + 仓库头像
 *   assets/social-preview.png  1280×640     GitHub → Settings → Social preview
 *
 * 依赖：playwright-core（已是本项目依赖）+ 系统已装的 Chrome。
 *   用 channel:'chrome' 复用系统 Chrome，不下载额外浏览器；
 *   这里**不**用 launchPersistentContext —— 渲染与挂课无关，不该去碰挂课 profile
 *   （那是单例独占资源，挂着课时跑这个脚本会把它抢过来）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const SVG_FILE = path.join(ASSETS, 'logo.svg');

if (!fs.existsSync(SVG_FILE)) {
  console.error(`找不到 ${SVG_FILE}`);
  process.exit(1);
}
fs.mkdirSync(ASSETS, { recursive: true });

const svgRaw = fs.readFileSync(SVG_FILE, 'utf8');
/**
 * 内联到 HTML 时必须去掉根 <svg> 上写死的 width/height，否则它会撑破外层容器、不受 CSS 控制。
 *
 * ★ 只能改**根标签**：早先写成全局 replace(/\s(?:width|height)="\d+"/g) 时，
 *   把里面背景 <rect width="512" height="512"> 的宽高也一并剔掉了 ——
 *   结果底板尺寸归零、整张 logo 只剩白环，README 里就是一片白。
 */
const svgInline = svgRaw.replace(/<svg\b[^>]*>/, (tag) =>
  tag.replace(/\s(?:width|height)="[^"]*"/g, ''),
);

/** 把一个 HTML 字符串丢给无头 Chrome，按给定视口截一张 PNG。 */
async function shoot(browser, { html, width, height, dsf, out, transparent = false }) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: dsf,
  });
  await page.setContent(html, { waitUntil: 'load' });
  // 等字体落地，否则中文可能截到回退字体
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, omitBackground: transparent });
  await page.close();
  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`  ✅ ${path.relative(ROOT, out)}  ${width * dsf}×${height * dsf}px  ${kb} KB`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  console.log('渲染资源中…');

  // ── 1) logo.png：纯 logo，透明底 ──
  // 视口 256 + 2 倍密度 = 512×512：够 README/头像用，体积又远小于直接渲染 1024。
  await shoot(browser, {
    html: `<html><body style="margin:0;background:transparent">
      <style>svg{display:block;width:100%;height:100%}</style>
      ${svgInline}
    </body></html>`,
    width: 256,
    height: 256,
    dsf: 2,
    out: path.join(ASSETS, 'logo.png'),
    transparent: true,
  });

  // ── 2) social-preview.png：GitHub 社交预览卡片（1280×640，左右留安全边距）──
  await shoot(browser, {
    html: `<html><body style="margin:0">
      <style>svg{display:block;width:100%;height:100%}</style>
      <div style="width:1280px;height:640px;box-sizing:border-box;padding:0 92px;
                  background:linear-gradient(135deg,#0E1B3D 0%,#12306E 55%,#1B45C4 100%);
                  display:flex;align-items:center;gap:60px;
                  font-family:'Microsoft YaHei','PingFang SC',system-ui,sans-serif;color:#fff">
        <div style="flex:0 0 236px;width:236px;height:236px;
                    filter:drop-shadow(0 18px 34px rgba(0,0,0,.38))">${svgInline}</div>
        <div style="flex:1 1 auto">
          <div style="font-size:58px;font-weight:700;letter-spacing:1px;line-height:1.16">
            教师研修 · 自动挂课
          </div>
          <div style="font-size:28px;margin-top:22px;color:#B9CDFF;line-height:1.5">
            登录一次，之后一键挂完 —— 不用守着窗口
          </div>
          <div style="font-size:22px;margin-top:30px;color:#7FA0E8;
                      font-family:ui-monospace,Consolas,monospace">
            github.com/hgaonice/smartedu-autowatch
          </div>
        </div>
      </div>
    </body></html>`,
    width: 1280,
    height: 640,
    dsf: 1,
    out: path.join(ASSETS, 'social-preview.png'),
  });
} finally {
  await browser.close();
}
console.log('完成。');
