/**
 * 站点注册表 —— 所有「挂课类型」都从这里暴露。
 *
 * ════════════════════════════════════════════════════════════════════════
 *  加一种新挂课类型怎么做
 * ════════════════════════════════════════════════════════════════════════
 *   1. 在 src/sites/ 下新建 xxx.mjs，默认导出一个适配器对象（照抄 teacher-training.mjs，实现 5 个能力）
 *   2. 在下面 import 进来，加进 SITES 数组
 *   3. 完事 —— 主流程、UI、CLI 都不用改（它们只认适配器接口，不认具体站点）
 *
 * 适配器接口（约定，见 teacher-training.mjs 顶部注释）：
 *   id            string    稳定标识，写进日志/报告用
 *   name          string    UI 显示名
 *   hint          string    一句话说明
 *   trainUrl(id)  string    专题页 URL（固定模板）
 *   courseUrl(id) string    课程页 URL（固定模板）
 *   listTargets() Promise<Array>          ① 有哪些可挂的专题
 *   listCourses(t) Promise<Array>         ② 专题里有哪些课
 *   pollProgress({...}) Promise<{ok,map}> ④ 平台学时真值
 *   certify(c, m)  object                 ⑤ 已学习 → 已认定
 */

import { teacherTraining } from './teacher-training.mjs';

/** ★ 全部已支持的类型。UI 的下拉/选择列表直接读这里。 */
export const SITES = [teacherTraining];

/** 默认类型。只有一个时就是它；将来多个则可用配置或上次选择来决定。 */
export const DEFAULT_SITE = teacherTraining;

/**
 * 按 id 取适配器。
 * @param {string} [id] 省略则返回默认
 * @throws {Error} 未知 id（列出现有 id，便于一眼看出拼错）
 */
export function getSite(id) {
  if (!id) return DEFAULT_SITE;
  const s = SITES.find((x) => x.id === id);
  if (!s) {
    throw new Error(`未知的挂课类型 "${id}"。已支持：${SITES.map((x) => x.id).join('、')}`);
  }
  return s;
}

export { teacherTraining };
