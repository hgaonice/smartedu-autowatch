/**
 * 站点适配器 —— 国家中小学智慧教育平台 · 教师研修。
 *
 * ════════════════════════════════════════════════════════════════════════
 *  为什么要有「适配器」这一层
 * ════════════════════════════════════════════════════════════════════════
 * 目标是「加一种挂课 = 加一个文件，不动主流程」。一个挂课类型只需要回答 5 个问题：
 *
 *   ① 有哪些可挂的「专题/目标」？        listTargets()
 *   ② 某个专题里有哪些课？              listCourses(targetId)
 *   ③ 课程页 URL 怎么拼？               courseUrl(courseId)   ← 固定模板
 *   ④ 平台侧的学时真值怎么读？          pollProgress({...})
 *   ⑤ 怎么把「已学习」折算成「已认定」？  certify(courses, map)
 *
 * 使用者**永远不需要输入 URL** —— 模板写在这里，由程序自己拼。
 *
 * ════════════════════════════════════════════════════════════════════════
 *  本类型的两个固定 URL 形态
 * ════════════════════════════════════════════════════════════════════════
 *   专题页   https://basic.smartedu.cn/training/<trainId>
 *   课程页   https://basic.smartedu.cn/teacherTraining/courseIndex?courseId=<courseId>
 *
 * 两个都是 SPA 客户端路由（实测各返回 6544B 的同一个壳，HTTP 200），
 * 所以「拼对 URL」完全等价于「打开平台正确页面」。
 */

import {
  fetchTrainMeta,
  fetchTrainCourses,
  pollTrainPeriods,
  certifyCourses,
  parseTrainId,
  resolveTarget,
} from '../courses.mjs';

const BASE = 'https://basic.smartedu.cn';

/** 2026 年“暑期教师研修”专题（基础教育）—— 11 门课 / 199.38 学时 / 目标 10 认定学时 */
export const TRAIN_2026 = 'dc6d78f2-bad8-4d09-b8da-0d758803dbe4';
/** 2025 年“暑期教师研修”专题 —— 9 门课 / 目标 10 认定学时 */
export const TRAIN_2025 = '2025sqpx';

export const teacherTraining = {
  id: 'teacher-training',
  name: '国家中小学智慧教育平台 · 教师研修',
  hint: '暑期/寒期教师研修等专题',

  // ── 固定 URL 模板（使用者看不到，也不用输）────────────────────────────
  trainUrl: (trainId) => `${BASE}/training/${trainId}`,
  courseUrl: (courseId) => `${BASE}/teacherTraining/courseIndex?courseId=${courseId}`,

  /**
   * 内置专题目录。
   *
   * ★ 这里**只存 id**，名字/目标学时/截止时间全部由 listTargets() 从免登录接口现读。
   *   好处：不用手工维护文案（不会写错），新专题只要加一行 id。
   *   代价：每年新专题上线时，要往这里加一行（已内置 2026、2025 两期）。
   */
  catalog: [TRAIN_2026, TRAIN_2025],

  /**
   * ① 列出可选专题。给 UI 的下拉框用。
   *
   * 元数据走免登录的 `trains/{id}.json`，所以**不必登录**就能把列表画出来 ——
   * 对小白很重要：一打开就能看到「2026年“暑期教师研修”专题（基础教育）· 目标 10 学时 · 截止 9/30」，
   * 而不是先被要求登录。
   *
   * 单个专题拉失败（接口改名 / 该专题下架）不整体报错，只标成 unavailable ——
   * 否则一个坏条目会把整个界面拖黑。
   */
  async listTargets() {
    const out = [];
    for (const trainId of this.catalog) {
      try {
        const m = await fetchTrainMeta(trainId);
        out.push({ ...m, id: trainId, url: this.trainUrl(trainId), available: true });
      } catch (e) {
        out.push({
          id: trainId,
          trainId,
          title: null,
          maxPeriod: null,
          studyStart: null,
          studyEnd: null,
          courseIds: [],
          phaseTitles: [],
          url: this.trainUrl(trainId),
          available: false,
          error: String(e?.message || e),
        });
      }
    }
    // 能用的排前面；同学时下新的排前面（catalog 顺序即优先级）
    return out;
  },

  /** ② 某专题下的课程表 */
  async listCourses(trainId) {
    const { courses } = await fetchTrainCourses(trainId);
    return courses.map((c) => ({
      ...c,
      // ★ 一律用适配器的模板，杜绝别处再散落 URL 拼接
      url: this.courseUrl(c.courseId),
    }));
  },

  /** ④ 平台侧学时真值（纯 Node，不占浏览器，播放中可随时轮询） */
  async pollProgress({ trainId, userId, timeoutMs }) {
    return pollTrainPeriods(trainId, userId, { timeoutMs });
  },

  /** ⑤ 已学习 → 已认定（平台不直接给「已认定」，是 min(已学习, max_period) 截出来的） */
  certify(courses, map) {
    return certifyCourses(courses, map);
  },

  // ── 逃生口：允许直接吃 URL / 裸 id（CLI 与「手工添加专题」用；UI 主流程不依赖）──
  /** 从任意 URL 里认专题 id */
  parseTargetId: (input) => parseTrainId(input),
  /** 自动判「专题」还是「单课」 */
  resolve: (input) => resolveTarget(input),
};

export default teacherTraining;
