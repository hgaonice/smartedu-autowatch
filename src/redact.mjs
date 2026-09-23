/**
 * 日志脱敏 —— 平台凭据不允许出现在任何输出里。
 *
 * 为什么必须有：这些字符串会（a）写进 `out/*.log`，（b）实时显示在图形界面的
 * 日志面板里。而 `docs/handoff.md` 的反馈模板恰恰要求使用者「截个图发给我」——
 * 使用者一旦照做，他自己的 `UC_TOKEN` 和 12 位 `user_id` 就跟着截图一起发出去了。
 * 所以脱敏不能靠「记得别打印」，必须在【日志出口】统一兜住，让任何调用点都无法泄露。
 *
 * 设计取舍：保留可辨认的形状，别把诊断能力一起抹掉 ——
 *   `UC_TOKEN-<uuid>-ncet-xedu`  → `UC_TOKEN-****-ncet-xedu`
 *   12 位 userId（纯数字）       → `123****789`
 * 这样「token 有没有出现 / 是哪类账号」仍看得出来，但值本身不可用。
 *
 * ★★ 本文件里的示例一律用**占位符或假值**，绝不写真值。
 *     源码本身就是要发出去的东西，注释里的真凭据和代码里的真凭据一样是泄露；
 *     而自检脚本原先有一条「注释行一律跳过」，差点让它们直接发到公网（已修，
 *     见 tools/check-handoff.mjs 的 `strict`）。
 *
 * ★★ 重要教训：本模块只包住了 `log()`/`warn()`，而**裸 `console.log` 会绕过它**。
 *     实网跑批时正是因此漏了：`localStorage 键：…ND_UC_AUTH-<uuid>&ncet-xedu&token`
 *     直接打到界面与日志里（而 handoff.md 恰恰要求使用者截图发回）。
 *     所以两道防线都要：① 出口统一脱敏（本模块）；② 不打印压根没价值的高风险串
 *     （如 localStorage 键名 —— 它是登录态判据，但名字里就嵌着凭据）。
 *     新增日志时请用 `log()`/`warn()`，别用裸 `console.log`。
 */

/**
 * 平台登录 token（cookie 值）：`UC_TOKEN-<uuid>-ncet-xedu`。
 * ★ 字符集必须含普通字母：尾缀 `-ncet-xedu` 里的 n/c/e/t/x/d/u 不在 `[0-9a-f]` 里，
 *   若只写十六进制字符集，正则会在尾缀前就停住，`slice(-10)` 于是从 uuid 中间切 ——
 *   既脱不干净（残留 uuid 片段），形状也变形。
 */
const TOKEN_RE = /UC_TOKEN-[A-Za-z0-9-]{8,}/g;

/**
 * localStorage 里的登录凭据键：`ND_UC_AUTH-<uuid>&ncet-xedu&token`。
 * 它不以 `UC_TOKEN-` 开头，所以上面那条正则拦不住；而键名本身就把 uuid 写在里面了。
 */
const AUTH_RE = /UC_AUTH-[A-Za-z0-9-]{8,}/g;

/**
 * 平台 user_id：12 位纯数字（本平台实测）。
 * 下限取 11 位以免误伤时长/学时这类 5~6 位数，上限 12 位以免误伤 13 位毫秒时间戳。
 *
 * ★ 边界必须用「前后不是数字」而不是 `\b`：`\b` 在 `_` 与数字之间**不成立**
 *   （`_` 本身是词字符），于是 `aiAssistant_audio_<userId>` 这种键名里
 *   嵌着的 userId 会完整漏出。实网跑批已踩到。
 */
const UID_RE = /(?<!\d)\d{11,12}(?!\d)/g;

/**
 * 把字符串里的凭据替换成带星号的形状保留形式。
 * 非字符串原样返回（数字、null、undefined、对象引用都安全穿透，避免打日志时抛异常）。
 *
 * @param {unknown} input
 * @returns {unknown} 脱敏后的值（非字符串/非数字原样返回）
 */
export function redact(input) {
  if (typeof input === 'number') return input;
  if (typeof input !== 'string') return input;
  let s = input;
  s = s.replace(TOKEN_RE, (m) => `UC_TOKEN-****${m.slice(-10)}`); // 保留 '-ncet-xedu' 尾缀
  s = s.replace(AUTH_RE, 'UC_AUTH-****');
  s = s.replace(UID_RE, (m) => `${m.slice(0, 3)}****${m.slice(-3)}`);
  return s;
}

/**
 * 给 `console.log`/`console.warn` 这类可变参数函数用的版本：逐个参数脱敏。
 *
 * @param {unknown[]} args
 * @returns {unknown[]}
 */
export function redactArgs(args) {
  return args.map(redact);
}
