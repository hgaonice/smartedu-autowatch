/**
 * 登录账号缓存（每个站点一份）。
 *
 * ════════════════════════════════════════════════════════════════════════
 *  为什么需要它
 * ════════════════════════════════════════════════════════════════════════
 * 平台「每门课已学习学时」接口是**免鉴权**的（见 courses.mjs 的 pollTrainPeriods），
 * 但 URL 里必须带 userId：
 *
 *     https://elearning-train-api.ykt.eduyun.cn/v1/users/{uid}/trains/{tid}/courses_period/actions/list
 *
 * 而 userId 只能靠浏览器**监听平台自己发出的请求**才能拿到（纯 Node 拿不到 cookie）。
 * 所以：run.mjs 一旦拿到 userId 就落盘；之后 UI 想刷新进度，纯 Node 直接读，
 * 不必为刷新一个数字去开浏览器 —— 浏览器 profile 是独占资源，挂课时根本开不了第二个。
 *
 * 隐私：userId 是个人标识，文件落在 out/（已 gitignore，不入库、不随包分发）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR } from './engine.mjs';

const file = (siteId) => path.join(OUT_DIR, `account-${siteId}.json`);

/** @returns {{userId:string, trainId:string|null, savedAt:string}|null} */
export function readAccount(siteId) {
  try {
    const j = JSON.parse(fs.readFileSync(file(siteId), 'utf8'));
    return j && typeof j.userId === 'string' && j.userId ? j : null;
  } catch {
    return null;
  }
}

/** 落盘。拿到 userId 的任何地方都应该调它 —— 这是 UI 能显示账号的唯一来源。 */
export function saveAccount(siteId, { userId, trainId = null } = {}) {
  if (!userId) return false;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(
      file(siteId),
      JSON.stringify(
        { userId: String(userId), trainId, savedAt: new Date().toISOString() },
        null,
        2,
      ),
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/** 换账号前必须清掉，否则界面会拿旧 userId 读旧账号的进度。 */
export function clearAccount(siteId) {
  try {
    fs.unlinkSync(file(siteId));
    return true;
  } catch {
    return false;
  }
}

/** 脱敏展示：只留头 3 位和尾 3 位（userId 是个人标识，别整串显示在界面上） */
export function maskUserId(id) {
  const s = String(id || '');
  if (!s) return '';
  if (s.length <= 6) return `${s[0] || ''}***`;
  return `${s.slice(0, 3)}****${s.slice(-3)}`;
}
