/**
 * 课程列表接口层。
 *
 * 两条路径，别混：
 *
 *  A. 季节码（2025 及以前）：免登录可读
 *     https://s-file-1.ykt.cbern.com.cn/teach/api_static/trains/{seasonalCode}/train_courses.json
 *     例：2025sqpx → 10 门
 *
 *  B. 专题 trainId（2026 起）：**这才是 2026 的正确入口**
 *     https://s-file-1.ykt.cbern.com.cn/teach/api_static/trains/{trainId}/train_courses.json
 *     例：2026 暑期教师研修 → 11 门，合计 199.38 学时
 *
 *  trainId 怎么来：打开任一课程页 → 平台自己请求
 *  /teach/s_course/v2/business_courses/{courseId}/course_relative_infos/zh-CN.json
 *  → 里头的 context_id 形如 "auxo-train:dc6d78f2-...". 冒号后面就是 trainId。
 *
 *  学时公式（对全部 11 门课逐条验证成立）：
 *      1 学时 = 3600 秒视频     即 total_period = period / 3600
 */

import { gotoWithRetry } from './browser.mjs';

const STATIC_BASE = 'https://s-file-1.ykt.cbern.com.cn/teach/api_static/trains';
const COURSE_DETAIL = 'https://basic.smartedu.cn/teacherTraining/courseDetail?courseId=';

/** 2026 暑期教师研修（基础教育）专题 —— 目标 10 认定学时就在这里 */
export const TRAIN_2026 = 'dc6d78f2-bad8-4d09-b8da-0d758803dbe4';

const HEADERS = {
  // 直接打这个 CDN 需要带 referer，否则可能 403
  referer: 'https://basic.smartedu.cn/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/153.0.0.0 Safari/537.36',
};

/** 递归挖出所有长得像课程的节点 —— 接口结构随季节变动，写死字段名会随时失效 */
function harvest(node, out = [], depth = 0) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    for (const x of node) harvest(x, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;

  const cid = node.course_id ?? node.courseId;
  const title = node.title ?? node.course_name ?? node.name;
  if (cid && typeof cid === 'string' && cid.length >= 16 && title) {
    if (!out.some((c) => c.courseId === cid)) {
      const period = node.period ?? node.total_period_raw ?? null;
      out.push({
        courseId: cid,
        title: String(title),
        season: node.seasonal_code ?? node.season ?? null,
        trainId: node.train_id ?? node.trainId ?? null,
        // period=视频秒数, totalPeriod=学时, maxPeriod=本课可计入专题的学时上限
        period: period == null ? null : Number(period),
        totalPeriod: node.total_period ?? node.totalPeriod ?? null,
        maxPeriod: node.max_period ?? node.maxPeriod ?? null,
        resourceCount: node.resource_total_count ?? null,
        url: COURSE_DETAIL + cid,
      });
    }
    // ★ 命中课程就不再往里钻：课程对象内部嵌着 train/library 等容器，
    //   继续递归会把「专题自己」也当成一门课（2026 专题因此多出 1 门）
    return out;
  }
  for (const v of Object.values(node)) harvest(v, out, depth + 1);
  return out;
}

async function pull(url, label) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`拉取${label}失败：HTTP ${res.status} ${url}`);
  const raw = await res.json();
  const courses = harvest(raw);
  if (!courses.length) {
    throw new Error(`解析出 0 门课程 —— 接口结构可能变了。原始响应长度 ${JSON.stringify(raw).length}`);
  }
  return { raw, courses };
}

/**
 * 专题元数据（免登录）——
 *   https://s-file-1.ykt.cbern.com.cn/teach/api_static/trains/{trainId}.json
 *
 * ★ 这是「零输入」能成立的关键：只要有一个 trainId，就能拿到
 *   · train.title            → 人类可读的专题名（“2026年‘暑期教师研修’专题（基础教育）”）
 *   · train.max_period       → **目标认定学时**（2026 专题 = 10）→ UI 可自动预填，不写死
 *   · train.study_end_time   → 截止时间 → UI 可提醒
 *   · train_course_ids       → 课程 id 清单（与 train_courses.json 的 11 门一致）
 *   · train_phase_list       → 阶段划分（如“学科教学能力提升”）
 *
 * 所以内置目录里只需存一个 trainId，名字/目标/截止都从接口现读 —— 不用手维护文案，
 * 且新专题只要加一行 id 就能用。
 *
 * @returns {Promise<{trainId: string, title: string, maxPeriod: number|null,
 *   studyStart: string|null, studyEnd: string|null, courseIds: string[],
 *   phaseTitles: string[]}>}
 */
export async function fetchTrainMeta(trainId) {
  const url = `${STATIC_BASE}/${encodeURIComponent(trainId)}.json`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`拉取专题元数据失败：HTTP ${res.status} ${url}`);
  const raw = await res.json();
  const t = raw?.train ?? {};
  const num = (v) => (v == null || v === '' ? null : Number(v));
  return {
    trainId,
    title: t.title || null,
    maxPeriod: num(t.max_period),
    studyStart: t.study_start_time || null,
    studyEnd: t.study_end_time || null,
    courseIds: Array.isArray(raw?.train_course_ids) ? raw.train_course_ids : [],
    phaseTitles: (Array.isArray(raw?.train_phase_list) ? raw.train_phase_list : [])
      .map((p) => p?.title)
      .filter(Boolean),
  };
}

/**
 * 季节码入口（2025 及更早）
 * @param {string} seasonalCode 例如 '2025sqpx'
 */
export async function fetchSeason(seasonalCode) {
  const url = `${STATIC_BASE}/${encodeURIComponent(seasonalCode)}/train_courses.json`;
  const { raw, courses } = await pull(url, `季节 ${seasonalCode}`);
  return { seasonalCode, raw, courses };
}

/**
 * 专题入口（2026 起，推荐）
 * @param {string} trainId 例如 TRAIN_2026
 */
export async function fetchTrainCourses(trainId) {
  const url = `${STATIC_BASE}/${encodeURIComponent(trainId)}/train_courses.json`;
  const { raw, courses } = await pull(url, `专题 ${trainId}`);
  // 有 maxPeriod 的排前面：这些是能真正计入专题学时的课
  courses.sort((a, b) => (Number(b.maxPeriod) || -99) - (Number(a.maxPeriod) || -99));
  return { trainId, raw, courses };
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/** 从任意 URL / 纯 courseId 里取出 courseId */
export function parseCourseId(input) {
  if (!input) return null;
  const m = String(input).match(new RegExp(`courseId=(${UUID_RE.source})`));
  if (m) return m[1];
  if (/^[0-9a-fA-F-]{16,}$/.test(String(input).trim())) return String(input).trim();
  return null;
}

/**
 * 从任意 URL / 纯 trainId 里取出专题 trainId。
 *
 * 能直接吃用户从浏览器地址栏复制的东西：
 *   https://basic.smartedu.cn/training/dc6d78f2-bad8-4d09-b8da-0d758803dbe4
 *   https://basic.smartedu.cn/training/dc6d78f2-…?activeTab=1&slug=xyz   （带参数、带锚点都行）
 *   以及裸 UUID
 */
export function parseTrainId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(new RegExp(`training/(${UUID_RE.source})`));
  if (m) return m[1];
  const bare = s.match(UUID_RE);
  return bare && s.length <= 64 ? bare[0] : null;
}

/**
 * 统一入口：用户粘贴什么都行，这里判出是「专题」还是「单课」。
 *
 * 判据优先看 URL 形状（最可靠）：
 *   …/training/<uuid>                  → train
 *   …?courseId=<uuid>（courseIndex / courseDetail 都一样） → course
 * 只给一个裸 UUID 时两者分不清，就拿专题接口探一下：
 *   拉得到课程列表就是专题，否则当课程。（专题接口对课程 id 会 404）
 *
 * @returns {Promise<{mode: 'train'|'course', id: string, count?: number}>}
 */
export async function resolveTarget(input) {
  const s = String(input ?? '');
  const trainId = parseTrainId(s);
  if (/training\//.test(s)) return { mode: 'train', id: trainId };
  const courseId = parseCourseId(s);
  if (/courseId=/.test(s)) return { mode: 'course', id: courseId };

  // 裸 UUID：先当专题试
  if (trainId) {
    try {
      const { courses } = await fetchTrainCourses(trainId);
      if (courses.length) return { mode: 'train', id: trainId, count: courses.length };
    } catch {
      /* 不是专题，当课程 */
    }
    return { mode: 'course', id: courseId || trainId };
  }
  return { mode: 'course', id: courseId };
}

/** 秒 → 学时 */
export const secToPeriod = (sec) => Math.round((sec / 3600) * 100) / 100;
/** 学时 → 秒 */
export const periodToSec = (period) => Math.round(Number(period) * 3600);

// ---------------------------------------------------------------------------
//  学时【权威读数】—— 专题侧
// ---------------------------------------------------------------------------

/**
 * 读专题侧「每门课已学习学时」——**被动抓平台自己的请求**。
 *
 * 为什么不裸 fetch：同一个 URL，平台的 JS 打 → 200，从页面上下文直接 fetch → 403。
 * 它依赖自定义鉴权头（不是 cookie），所以只能读它自己发出去的流量。
 *
 *   GET /v1/users/{uid}/trains/{trainId}/courses_period/actions/list
 *   → { "<courseId>": <已学习学时>, "<courseId>-status": 0, "<trainId>": 0, ... }
 *
 * ★ 平台**不单独返回「已认定」**，它是截出来的：
 *      已认定 = max_period > 0 ? min(已学习, max_period) : 已学习
 *   逐条对齐专题页 UI 验证通过：
 *      数智素养提升   已学习 4.01 / 上限 3  → 认定 3.00
 *      大力弘扬教育家精神 已学习 2.28 / 上限 2 → 认定 2.00
 *      合计 认定 5.00  ←→ 页面「已认定 5.00 / 10 学时」逐字节相符
 *
 * @returns {Promise<{userId: string, map: Record<string, number>} | null>}
 *          null = 没抓到（未登录 / 接口改名 / 超时）
 */
export async function fetchTrainPeriods(page, trainId, { timeoutMs = 60_000, url } = {}) {
  const re = new RegExp(`/v1/users/(\\d+)/trains/${trainId}/courses_period/actions/list`);
  let settle;
  const got = new Promise((resolve) => {
    settle = resolve;
  });
  const onResponse = async (res) => {
    const m = res.url().match(re);
    if (!m) return;
    try {
      settle({ userId: m[1], map: await res.json() });
    } catch {
      /* 非 JSON 响应，忽略 */
    }
  };
  page.on('response', onResponse);
  try {
    // URL 由调用方（站点适配器）给；给了就听它的，不再在接口层散落模板
    await gotoWithRetry(page, url || `https://basic.smartedu.cn/training/${trainId}`, {
      label: '专题页',
      timeout: 60_000,
    });
    return await Promise.race([
      got,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * 把「已学习」折算成「已认定」，并算专题合计。
 *
 * @param {Array}  courses fetchTrainCourses() 出来的课程表（要带 courseId / maxPeriod）
 * @param {object} map     fetchTrainPeriods() 出来的 {courseId: 已学习学时}
 */
export function certifyCourses(courses, map) {
  const rows = courses.map((c) => {
    const learned = Number(map?.[c.courseId] ?? 0);
    const cap = Number(c.maxPeriod);
    const certified = cap > 0 ? Math.min(learned, cap) : learned;
    return { ...c, learnedPeriod: learned, capPeriod: cap, certifiedPeriod: certified };
  });
  const sum = (key) => Math.round(rows.reduce((a, r) => a + r[key], 0) * 100) / 100;
  return { rows, learnedTotal: sum('learnedPeriod'), certifiedTotal: sum('certifiedPeriod') };
}

/**
 * 专题侧学时接口（★权威真值）。
 *
 * 返回形如：
 *   { "<courseId>": 已学习学时, "<courseId>-status": 枚举, "<trainId>": 0 }
 * 平台**不单独返回已认定** —— 已认定 = min(已学习, max_period)（对专题页 UI 逐条验证过）。
 *
 * ★ 三个硬条件，缺一不可（都是实测撞出来的）：
 *   1. 必须写**绝对地址**：各微服务不在同一个 host 上；`/v1/...` 相对路径在
 *      basic.smartedu.cn 上根本没反代，直接 403。
 *   2. 必须带 `referer`（不带也是 403）。
 *   3. 不要带 credentials —— 这个 GET 本身不需鉴权，纯 Node 直接就能读。
 */
export const PERIOD_API =
  'https://elearning-train-api.ykt.eduyun.cn/v1/users/{uid}/trains/{tid}/courses_period/actions/list';

/**
 * 纯 Node 读平台学时 —— 不碰浏览器，所以可以在播放中随时轮询，不会打断视频。
 * 返回 { ok: true, map } 或 { ok: false, error }。
 */
export async function pollTrainPeriods(trainId, userId, { timeoutMs = 15_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(PERIOD_API.replace('{uid}', userId).replace('{tid}', trainId), {
      headers: { accept: 'application/json', referer: 'https://basic.smartedu.cn/' },
      signal: ctl.signal,
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const map = await r.json();
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      return { ok: false, error: '响应不是对象' };
    }
    return { ok: true, map };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `超时 ${timeoutMs}ms` : String(e.message) };
  } finally {
    clearTimeout(timer);
  }
}

export { COURSE_DETAIL, STATIC_BASE };
