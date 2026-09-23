/**
 * 引擎注入模块 —— 被 src/run.mjs 和 tools/selftest.mjs 共用。
 *
 * 为什么抽出来：油猴脚本和 Playwright 必须用**同一份引擎**，
 * 否则会出现「脚本修好了、程序没好」这种最恶心的问题。
 * 这里读的 userscript/smartedu-autowatch.user.js 就是油猴直接装的那个文件，
 * 一个字节都不改，只是换了个宿主注入。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const ENGINE_PATH = path.join(ROOT, 'userscript', 'smartedu-autowatch.user.js');
export const OUT_DIR = path.join(ROOT, 'out');

/** 宿主要覆盖的默认配置（对应引擎里的 CONFIG） */
export const HOST_DEFAULTS = {
  noUI: true,                 // 宿主自己出日志，不要页面浮层
  fakeVisibility: true,
  blockFocusEvents: true,
  blockPause: true,
  autoResume: true,
  holdWebLock: true,
  watchNetwork: true,
  autoDismissModal: true,
  autoAnswerQuestion: false,  // 答题是计分项，默认不代答
};

export function engineSource() {
  if (!fs.existsSync(ENGINE_PATH)) {
    throw new Error(`找不到引擎文件：${ENGINE_PATH}`);
  }
  return fs.readFileSync(ENGINE_PATH, 'utf8');
}

/**
 * 生成 init script。顺序很重要：先塞 __SMARTEDU_CONFIG__，再放引擎，
 * 因为引擎是 IIFE，在 document-start 同步读取配置。
 */
export function engineInitScript(overrides = {}) {
  const cfg = { ...HOST_DEFAULTS, ...overrides };
  return `window.__SMARTEDU_CONFIG__ = ${JSON.stringify(cfg)};\n${engineSource()}`;
}

/** 挂到 context 上 —— 每个新 document 创建前执行，等价于油猴 @run-at document-start */
export async function installEngine(context, overrides = {}) {
  await context.addInitScript({ content: engineInitScript(overrides) });
}
