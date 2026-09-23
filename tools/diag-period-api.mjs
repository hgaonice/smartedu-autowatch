/**
 * 判定「引擎能否在页面里主动读到专题学时」。
 *
 * 背景：平台各微服务不在同一个 host 上，页面自己的请求能通是因为带了鉴权头。
 * 引擎要在播放中实时知道「平台认了多少学时」，只能自己去问，
 * 所以必须先确认：从页面上下文 fetch 这几个候选 URL，到底哪个能通。
 *
 * 候选：
 *   A. 绝对地址 elearning-train-api.ykt.eduyun.cn   （抓包看到的真实 host）
 *   B. 相对地址 /v1/users/... （万一 basic.smartedu.cn 有 /v1 反代）
 *
 * 用法：node tools/diag-period-api.mjs [userId] [等待秒数]
 *
 * userId 不再写死在代码里（那是个人身份信息，不能随仓库分发）。
 * 怎么拿：登录后跑 `node src/probe.mjs`，它会打印平台 user_id；
 * 也可以整个跳过 —— 这个脚本只是排查工具，日常挂课用不到。
 */

import fs from 'node:fs';
import path from 'node:path';
import { launchContext, reusePage, loginState, gotoWithRetry } from '../src/browser.mjs';
import { OUT_DIR, ROOT } from '../src/engine.mjs';

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const UID = argv[0] || process.env.SMARTEDU_UID || '';
const WAIT = Number(argv[1]) || 30;
const TRAIN = process.env.SMARTEDU_TRAIN || 'dc6d78f2-bad8-4d09-b8da-0d758803dbe4';

if (!UID) {
  console.error(
    '缺少 userId。\n' +
      '  用法：node tools/diag-period-api.mjs <userId> [等待秒数]\n' +
      '  userId 怎么拿：登录后跑 node src/probe.mjs，看它打印的「平台 user_id」。\n' +
      '  （这个脚本只是排查工具，日常挂课不需要它。）',
  );
  process.exit(2);
}

const PATH_ = `/v1/users/${UID}/trains/${TRAIN}/courses_period/actions/list`;

const context = await launchContext({ headless: true });
const page = await reusePage(context);

try {
  await gotoWithRetry(page, 'https://basic.smartedu.cn/', { label: '首页' });
  const ls = await loginState(page);
  console.log(`登录态：${ls.loggedIn ? '已登录 ✅' : '未登录 ❌'}（${ls.signals.slice(0, 4).join(', ')}）`);

  await gotoWithRetry(page, `https://basic.smartedu.cn/training/${TRAIN}`, {
    label: '专题页',
    timeout: 60_000,
  });
  await page.waitForTimeout(WAIT * 1000);

  const result = await page.evaluate(async (p) => {
    const candidates = [
      { name: 'A 绝对 host', url: `https://elearning-train-api.ykt.eduyun.cn${p}` },
      { name: 'B 相对路径', url: p },
    ];
    const out = [];
    for (const c of candidates) {
      const row = { name: c.name, url: c.url };
      for (const withCred of [false, true]) {
        try {
          const r = await fetch(c.url, {
            headers: { accept: 'application/json' },
            credentials: withCred ? 'include' : 'same-origin',
          });
          const text = await r.text();
          row[withCred ? 'cred' : 'plain'] = {
            status: r.status,
            len: text.length,
            head: text.slice(0, 160),
          };
        } catch (e) {
          row[withCred ? 'cred' : 'plain'] = { error: String(e && e.message) };
        }
      }
      out.push(row);
    }
    return out;
  }, PATH_);

  for (const r of result) {
    console.log(`\n--- ${r.name} ---`);
    console.log(`  ${r.url}`);
    console.log(`  plain : ${JSON.stringify(r.plain)}`);
    console.log(`  cred  : ${JSON.stringify(r.cred)}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, 'period-api-recon.json');
  fs.writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), login: ls, result }, null, 2), 'utf8');
  console.log(`\n写入 ${path.relative(ROOT, p)}`);
} finally {
  await context.close();
}
