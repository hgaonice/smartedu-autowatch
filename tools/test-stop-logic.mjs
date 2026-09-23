#!/usr/bin/env node
/**
 * `decideStop` 的离线回归测试 —— 「学时够了之后什么时候真正切课」。
 *
 *   node tools/test-stop-logic.mjs
 *
 * 为什么需要它：这个状态机已经**错过两次**，而两次的代价都不小 ——
 *   1) `out/report-2026-…-05-45-23.json`：为等活动边界白挂 0.07 学时（可接受）；
 *   2) `out/run-10h.log`：断点续播让预算在【切进第 2 节 57s 后】才达成，旧逻辑于是
 *      白等第 2 节整节 10158s（≈2.8 小时），而平台早已「已学习 3.08 ≥ 上限 1」。
 *
 * 全部帧数据都取自真实日志（out/run-10h.log、out/report-*.json），不是编的：
 *   科学素养提升：第 1 节 duration=8326s，平台续播点 4783s，预算 3600s，max_period=1；
 *   心理健康教育能力提升：第 1 节 duration=5811s，预算 3600s。
 *
 * 不启动浏览器（src/run.mjs 的 main() 有 entry 守卫，import 不会起跑）。
 */
import { decideStop, stallRecovered } from '../src/run.mjs';
import { redact, redactArgs } from '../src/redact.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? ` —— ${extra}` : ''}`);
  }
};

/** 造一节视频的逐帧快照（默认 3s 一帧、倍速 2 → 每帧媒体时间 +6s） */
function sectionFrames({
  duration,
  startMedia = 0,
  gainedAtStart,
  endedCount,
  platformPeriod,
  stepMedia = 6,
}) {
  const out = [];
  for (let m = startMedia + stepMedia; m < duration; m += stepMedia) {
    out.push({
      watched_media_sec: gainedAtStart + (m - startMedia),
      duration,
      currentTime: m,
      activity_ended_count: endedCount,
      platform_period: platformPeriod,
      finished: false,
    });
  }
  // 收尾帧：正好播到底（remainMedia 归 null 的那一刻）
  out.push({
    watched_media_sec: gainedAtStart + (duration - startMedia),
    duration,
    currentTime: duration,
    activity_ended_count: endedCount,
    platform_period: platformPeriod,
    finished: false,
  });
  return out;
}

/** 逐帧喂给 decideStop，返回停在第几帧 */
function run(frames, budget) {
  let st = {
    pendingStop: null,
    endedAtBudget: null,
    overshootFrom: null,
    gainedAtActivityStart: 0,
    lastEndedCount: null,
    overshootCap: null,
  };
  const notes = [];
  for (let i = 0; i < frames.length; i++) {
    const d = decideStop(st, frames[i], budget);
    st = d.state;
    if (d.onSet) notes.push(d.onSet);
    if (d.action === 'stop') {
      if (d.note) notes.push(d.note);
      return { stopIndex: i, notes, outcome: st.pendingStop, atFrame: frames[i] };
    }
  }
  return { stopIndex: -1, notes, outcome: st.pendingStop, atFrame: null };
}

const BUDGET = (over = {}) => ({
  courseBudgetSec: 3600,
  globalBudgetSec: Infinity,
  globalEarnedSec: 0,
  platformTargetPeriod: 1,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n【1】真实事故复现：科学素养提升 —— 续播点让预算落在第 2 节开头');
// 第 1 节 8326s，续播点 4783s → 本节最多只能再给 3543s < 预算 3600s
const kxSec1 = sectionFrames({
  duration: 8326,
  startMedia: 4783,
  gainedAtStart: 0,
  endedCount: 0,
  platformPeriod: 0,
});
const kxSec2 = sectionFrames({
  duration: 10158,
  startMedia: 0,
  gainedAtStart: 8326 - 4783, // 3543
  endedCount: 1,
  platformPeriod: 0, // 先假设平台读数还没刷新 → 走「本节刚开头」分支
});
const kx = run([...kxSec1, ...kxSec2], BUDGET());
ok('第 1 节播完时还在继续（3543s < 预算 3600s）', kxSec1.at(-1).watched_media_sec === 3543);
ok('在第 2 节开头就切了（未白等整节 10158s）', kx.stopIndex >= kxSec1.length && kx.stopIndex <= kxSec1.length + 25, `stopIndex=${kx.stopIndex}, 第1节帧数=${kxSec1.length}`);
ok(
  '第 2 节只挂了 ≤120s 就切（旧逻辑要 ≥10158s）',
  kx.atFrame.watched_media_sec - 3543 <= 120,
  `第2节实际挂了 ${kx.atFrame.watched_media_sec - 3543}s`,
);
ok('备注指明是「本节开头」而直接切', kx.notes.some((n) => n.includes('本节开头')), JSON.stringify(kx.notes));
const savedSec = 10158 - (kx.atFrame.watched_media_sec - 3543);
ok(`单课省下 ≈${Math.round(savedSec / 60)} 分钟白挂`, savedSec > 10_000);

console.log('\n【2】同一场景，但平台读数已刷新到 3.08（≥ 上限 1）→ 走 platform_met');
const kx2 = run([...kxSec1, ...sectionFrames({ duration: 10158, startMedia: 0, gainedAtStart: 3543, endedCount: 1, platformPeriod: 3.08 })], BUDGET());
ok('平台一说到位就切，不等活动边界', kx2.outcome === 'platform_met');
ok('备注说明「认定已到位，放弃本节不影响」', kx2.notes.some((n) => n.includes('认定已到位')), JSON.stringify(kx2.notes));

console.log('\n【3】正常路径不能退化：心理健康教育能力提升（第 1 节 5811s，预算 3600s）');
const xlSec1 = sectionFrames({ duration: 5811, gainedAtStart: 0, endedCount: 0, platformPeriod: 0 });
const xlSec2 = sectionFrames({ duration: 4000, gainedAtStart: 5811, endedCount: 1, platformPeriod: 1 });
const xl = run([...xlSec1, ...xlSec2], BUDGET());
ok('预算在第 1 节内达成（3600s）后没有立刻切', xl.stopIndex >= 600, `stopIndex=${xl.stopIndex}`);
ok('切点落第 1 节末尾 / 活动边界，而不是半途', xl.stopIndex === xlSec1.length - 1, `stopIndex=${xl.stopIndex}, 第1节末帧=${xlSec1.length - 1}`);
ok('不再出现「等活动边界已超时」的误切（旧 overshootCap 会在剩 411s 时切走）', !xl.notes.some((n) => n.includes('超时')), JSON.stringify(xl.notes));
ok('把本节 5811s 全挂完才走（≈1.61 学时，预算 1 学时）', xl.atFrame.watched_media_sec === 5811);
ok('备注说的是「本节已播到底」或「本节已播完（活动边界）」', xl.notes.some((n) => /本节已播到底|本节已播完/.test(n)), JSON.stringify(xl.notes));

console.log('\n【4】tiny 预算（全局缺口只剩 0.02 学时 = 72s）—— 本节开头达成即切');
const tiny = run(sectionFrames({ duration: 5811, gainedAtStart: 0, endedCount: 0, platformPeriod: 0 }), BUDGET({ courseBudgetSec: 72, globalBudgetSec: 72, platformTargetPeriod: null }));
ok('72s 预算在第 1 节开头就切，不白挂整节', tiny.stopIndex <= 20, `stopIndex=${tiny.stopIndex}`);
ok('浪费 ≤120s', tiny.atFrame.watched_media_sec <= 120, `${tiny.atFrame.watched_media_sec}s`);

console.log('\n【5】降级：旧版引擎没有 activity_ended_count → 立即切，不拖死跑批');
const legacy = run(
  sectionFrames({ duration: 9000, gainedAtStart: 0, endedCount: 0, platformPeriod: 0 }).map((f) => {
    const rest = { ...f };
    delete rest.activity_ended_count; // 模拟旧版引擎：整个字段不存在
    return rest;
  }),
  BUDGET({ platformTargetPeriod: null }),
);
ok('旧版引擎下立即切换（预算达成那一帧就切，不白挂）', legacy.stopIndex === 599, `stopIndex=${legacy.stopIndex}`);
ok('备注说明是旧版引擎的优雅降级', legacy.notes.some((n) => n.includes('旧版引擎')), JSON.stringify(legacy.notes));

console.log('\n【6】平台已到上限（进课就是 certMet）→ 一帧都不挂');
const atCap = run(
  [{ watched_media_sec: 0, duration: 5811, currentTime: 6, activity_ended_count: 0, platform_period: 3.08, finished: false }],
  BUDGET(),
);
ok('第一帧就切', atCap.stopIndex === 0);
ok('outcome=platform_met', atCap.outcome === 'platform_met');

console.log('\n【7】全局目标用 platformTargetPeriod=null 时不误触发 certMet');
const noCert = run(sectionFrames({ duration: 5811, gainedAtStart: 0, endedCount: 0, platformPeriod: 99 }), BUDGET({ platformTargetPeriod: null }));
ok('platform_period=99 但目标为 null → 不因 certMet 早切（靠本地 3600s 判）', noCert.atFrame.watched_media_sec >= 3600, `${noCert.atFrame.watched_media_sec}s`);

console.log('\n【8】--min-section-sec 可调：预算在【本节第 200s】达成');
// 第 1 节正好给 3600s（不够 3800s 预算）→ 预算在第 2 节第 198s 达成
const s1 = sectionFrames({ duration: 3600, gainedAtStart: 0, endedCount: 0, platformPeriod: 0 });
const s2 = sectionFrames({ duration: 10158, gainedAtStart: 3600, endedCount: 1, platformPeriod: 0 });
const B3800 = BUDGET({ courseBudgetSec: 3800, platformTargetPeriod: null });
const d120 = run([...s1, ...s2], B3800); // 默认 120 → 200 > 120 → 等边界
const d300 = run([...s1, ...s2], { ...B3800, minSectionSec: 300 }); // 调大到 300 → 200 ≤ 300 → 立即切
ok('默认 120：200s > 120s，老老实实等本节播完（行为不变）', d120.stopIndex > 1000, `stopIndex=${d120.stopIndex}`);
ok('默认 120：备注是「本节已播到底」', d120.notes.some((n) => n.includes('本节已播到底')), JSON.stringify(d120.notes));
ok('调成 300：同一场景变成立即切，不等 10158s', d300.stopIndex <= s1.length + 40, `stopIndex=${d300.stopIndex}`);
ok('调成 300：省下 ≈165 分钟', s1.length + Math.round(10158 / 6) - d300.stopIndex > 1500);

console.log('\n【9】--min-section-sec 0 = 关掉该规则，退回「一律等本节播完」');
const d0 = run([...kxSec1, ...kxSec2], { ...BUDGET(), minSectionSec: 0 });
ok('规则关掉后不再在节开头切走', d0.stopIndex > kxSec1.length + 100, `stopIndex=${d0.stopIndex}`);
ok('但 overshootCap 仍兜底，不会永久卡死', d0.stopIndex > 0 && d0.notes.some((n) => /本节已播到底|已超时/.test(n)), JSON.stringify(d0.notes));

console.log('\n【10】stallRecovered()——自愈配额什么时候才能归零（错了就是无限 reload）');
// 背景：旧代码在「currentTime 变了」这一帧就把 stallReloads 归零。
// 但 reload 之后 currentTime 会从 null/0 重新开始，那一帧必然「变了」，
// 于是每轮 reload 都把配额清零 → MAX_STALL_RELOADS 形同虚设 → 卡死的课无限 reload。
// 现在要求必须越过卡住点 STALL_RECOVER_SEC(30s) 以上才算恢复。
ok('没卡过（null）→ 算恢复，不限制', stallRecovered(null, 100) === true);
ok('没卡过（undefined）→ 算恢复', stallRecovered(undefined, 100) === true);
ok('刚 reload 回 0s（卡在 500s）→ **不算恢复**（旧代码就在这里错的）', stallRecovered(500, 0) === false);
ok('回到卡住点本身（500s）→ 不算恢复', stallRecovered(500, 500) === false);
ok('只越过 29s → 不够，不算恢复', stallRecovered(500, 529) === false);
ok('恰好越过 30s → 边界上不算（要求严格大于）', stallRecovered(500, 530) === false);
ok('越过 31s → 算恢复，配额可归零', stallRecovered(500, 531) === true);
ok('退回卡住点之前（400s）→ 不算恢复', stallRecovered(500, 400) === false);
ok('读不到 currentTime（null）→ 不算恢复，不白白放过', stallRecovered(500, null) === false);
ok('从 0 卡住、reload 后仍在 0 → 不算恢复（防死循环的关键场景）', stallRecovered(0, 0) === false);
ok('从 0 卡住、真的播到 31s → 算恢复', stallRecovered(0, 31) === true);

console.log('\n【11】redact()——凭据不进日志/界面截图（交接文档里就是让人截图反馈的）');
// 下面几个常量是**合成测试值**（全 0/重复数字），不是真凭据。
// 但它们「长得像凭据」，tools/check-handoff.mjs 分不出来，所以带行内豁免标记；
// 该脚本会在报告里公开「豁免了几行、哪几个文件」，所以豁免不会被静默滥用。
const TOKEN = 'UC_TOKEN-00000000-1111-2222-3333-444444444444-ncet-xedu'; // check-handoff:allow
const UID = '111222333444'; // check-handoff:allow
const UID11 = '11122233344'; // check-handoff:allow
const TS13 = '1758591234567'; // check-handoff:allow
ok('token 被脱敏，且不再包含原 uuid 任何一段', !redact(`登录态正常（${TOKEN}）`).includes('2222-3333'), redact(`登录态正常（${TOKEN}）`));
ok('token 保留前缀与 -ncet-xedu 尾缀（仍能辨认类型）', redact(TOKEN) === 'UC_TOKEN-****-ncet-xedu', redact(TOKEN));
ok('12 位 user_id 被脱敏', redact(`平台 user_id = ${UID}`) === '平台 user_id = 111****444', redact(`平台 user_id = ${UID}`));
ok('11 位数字也脱敏（覆盖老账号）', redact(UID11) === '111****344', redact(UID11));
ok('5~6 位时长/学时不受影响（8326s / 10158s）', redact('已 8326s / 10158s') === '已 8326s / 10158s');
ok('13 位毫秒时间戳不受影响（不在 11~12 位区间）', redact(`t=${TS13}`) === `t=${TS13}`);
ok('一句话里 token 与 uid 同时出现 → 两个都脱敏', (() => { const r = redact(`${TOKEN} uid=${UID}`); return !r.includes('2222') && !r.includes('333444'); })());
ok('非字符串安全穿透（数字/null/undefined 不抛异常）', redact(42) === 42 && redact(null) === null && redact(undefined) === undefined);
ok('redactArgs 逐个参数脱敏（log(...a) 用）', (() => { const a = redactArgs([TOKEN, 42, null]); return a[0] === 'UC_TOKEN-****-ncet-xedu' && a[1] === 42 && a[2] === null; })());
ok('真实跑批的 "登录态正常（…）" 行不再含 uuid', (() => { const line = `登录态正常（${TOKEN}）`; const out = redactArgs([line])[0]; return out === '登录态正常（UC_TOKEN-****-ncet-xedu）'; })());

// ── 【11-b】实网真泄过的那两种形态（补丁日期：见 git 历史）──
// 上一次漏的根因是「脱敏只包了 log()/warn()，裸 console.log 绕过它」，
// 因此下面这两条不仅测正则可否命中，还固定了「那行日志已不再打印键名」这个结论。
const AUTH_KEY = `ND_UC_AUTH-00000000-1111-2222-3333-444444444444&ncet-xedu&token`; // check-handoff:allow
ok(
  'UC_AUTH-<uuid> 形态被脱敏（ND_UC_AUTH 那种 localStorage 键名）',
  (() => {
    const r = redact(AUTH_KEY);
    return !r.includes('00000000') && !r.includes('4444') && r.includes('UC_AUTH-****');
  })(),
  redact(AUTH_KEY),
);
ok(
  '嵌在标识符里的 user_id 也脱敏（旧版 \\b 在 `_` 与数字间不成立，会完整漏出）',
  (() => {
    const r = redact(`aiAssistant_audio_${UID}`);
    return !r.includes(UID) && r.includes('111****444');
  })(),
  redact(`aiAssistant_audio_${UID}`),
);
ok(
  '`_` 前缀 + 11 位数字同样脱敏',
  !redact(`foo_${UID11}`).includes(UID11),
  redact(`foo_${UID11}`),
);
ok(
  '真 13 位数字（如毫秒时间戳）不被误伤 —— 否则日志里的时间戳会被打码',
  redact(`t=${TS13}`) === `t=${TS13}` && redact(`x${UID}5y`) === `x${UID}5y`,
  `${redact(`t=${TS13}`)} / ${redact(`x${UID}5y`)}`,
);
ok(
  '嵌在标识符里的 12 位数字仍会脱敏（宁可多脱，不能漏）',
  !redact(`x${UID}y`).includes(UID),
  redact(`x${UID}y`),
);
ok(
  '一整行真实形态的 localStorage 键名列表 → 一个凭据字段都不剩',
  (() => {
    const line = `  localStorage 键：aiAssistant_audio_${UID}, ${AUTH_KEY}, ND_UC_DEVICE_ID, _X_STAT`;
    const r = redact(line);
    return !r.includes(UID) && !r.includes('00000000-1111') && r.includes('ND_UC_DEVICE_ID');
  })(),
  redact(`  localStorage 键：aiAssistant_audio_${UID}, ${AUTH_KEY}, ND_UC_DEVICE_ID, _X_STAT`),
);

console.log(`\n通过 ${pass} / ${pass + fail}${fail ? `　❌ 失败 ${fail}` : ''}\n`);
process.exit(fail ? 1 : 0);
