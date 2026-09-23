#!/usr/bin/env node
/**
 * Web UI 后端回归测试 —— 不起浏览器。
 *
 *   node tools/test-web.mjs
 *
 * 为什么要它：这是小白唯一会接触的一层（点按钮、勾课、看日志）。它坏了，
 * 用户在界面上看到的就是白屏或英文报错，而我们在命令行怎么测都发现不了。
 *
 * 分两段：
 *   【A】buildRunArgs —— UI 表单 → 命令行参数的翻译。纯函数，不联网。
 *   【B】HTTP 接口     —— 真起一个服务在随机端口上打。/api/targets 与 /api/courses
 *   【C】chromeExe()   —— 桌面外壳用的 Chrome 路径探测（根级优先，非版本目录）
 *   【D】closeNote()   —— 退出码 → 界面文案（小白唯一会认真看的那句）
 *                        会真的去平台拉数据（免登录），所以这一段需要联网。
 *
 * 故意**不测** /api/start 的成功路径：那会 spawn 真的 run.mjs，进而抢 profile、
 * 开 Chrome —— 会和正在跑的长跑批次打架，让这个测试变得不确定。
 * 成功路径留给 selftest.mjs / 人工验收，这里只锁住「参数翻译」和「协议形状」。
 */
import { createServer, buildRunArgs, closeNote } from '../src/web/server.mjs';
import { teacherTraining as TT } from '../src/sites/index.mjs';
import { chromeExe, chromeVersion } from '../src/browser.mjs';
import fs from 'node:fs';
import path from 'node:path';

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

// ════════════════════════════════════════════════════════════
console.log('\n【A】buildRunArgs：UI 表单 → run.mjs 参数');
// ════════════════════════════════════════════════════════════

const full = buildRunArgs(
  { target: 'tid-1', targetHours: 10, rate: 2, courses: ['c1', 'c2', 'c3'], headful: true },
  TT,
);
ok('带上站点 id', full[0] === '--site' && full[1] === TT.id, JSON.stringify(full.slice(0, 2)));
ok('专题走 --train', full.includes('--train') && full[full.indexOf('--train') + 1] === 'tid-1');
ok('目标学时', full[full.indexOf('--target-hours') + 1] === '10');
ok('倍速', full[full.indexOf('--rate') + 1] === '2');
ok('勾选的课用逗号拼成一个 --only', full[full.indexOf('--only') + 1] === 'c1,c2,c3');
ok('显示浏览器窗口 → --headful', full.includes('--headful'));

const min = buildRunArgs({ target: 'tid-2' }, TT);
ok('只给专题时参数最小化', JSON.stringify(min) === JSON.stringify(['--site', TT.id, '--train', 'tid-2']), JSON.stringify(min));
ok('没传的开关一个都不塞（让 run.mjs 用自己的默认值）', !min.includes('--target-hours') && !min.includes('--rate') && !min.includes('--headful'));

// 这几个正是当初踩过的坑：0 和空值不能被当成「没填」或「填了 0」
ok('courses 为空数组 → 不传 --only（否则会过滤掉所有课）', !buildRunArgs({ target: 't', courses: [] }, TT).includes('--only'));
ok('courses 不是数组 → 不传 --only', !buildRunArgs({ target: 't', courses: 'c1' }, TT).includes('--only'));
ok('targetHours=0 → 不传（而不是传 0 把目标设成 0）', !buildRunArgs({ target: 't', targetHours: 0 }, TT).includes('--target-hours'));
ok('rate=0 → 不传', !buildRunArgs({ target: 't', rate: 0 }, TT).includes('--rate'));
ok('targetHours=0.5 这种小数照样传', buildRunArgs({ target: 't', targetHours: 0.5 }, TT).includes('--target-hours'));
ok('targetHours 是字符串 "10" 也能正确传', buildRunArgs({ target: 't', targetHours: '10' }, TT).includes('--target-hours'));

// ════════════════════════════════════════════════════════════
//  起服务（随机端口，避免和真实实例撞车）
// ════════════════════════════════════════════════════════════
const server = createServer();
await new Promise((res, rej) => {
  server.once('error', rej);
  server.listen(0, '127.0.0.1', res);
});
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`\n【B】HTTP 接口（${base}）`);

const get = async (p) => {
  const r = await fetch(base + p);
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json() : await r.text();
  return { status: r.status, body };
};
const post = async (p, obj) => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });
  return { status: r.status, body: await r.json() };
};

try {
  // ── 静态页面 ──
  const home = await get('/');
  ok('GET / 返回 HTML', home.status === 200 && /<html/i.test(home.body));
  ok('页面上有中文标题（不是白屏占位）', home.body.includes('教师研修'));
  ok('页面内联了脚本（无构建步骤、无外部依赖）', home.body.includes('</script>'));
  ok('页面不引用任何外部资源（离线可用）', !/src="http|href="http/.test(home.body));

  // ── 类型清单 ──
  const sites = await get('/api/sites');
  ok('GET /api/sites 200', sites.status === 200);
  ok('至少注册了一个挂课类型', Array.isArray(sites.body.sites) && sites.body.sites.length >= 1);
  ok('类型带 id/name/hint 三件套', sites.body.sites.every((s) => s.id && s.name && s.hint));
  ok('教师研修类型在列', sites.body.sites.some((s) => s.id === 'teacher-training'));

  // ── 专题列表（免登录）──
  const tg = await get('/api/targets?site=teacher-training');
  ok('GET /api/targets 200', tg.status === 200);
  const avail = (tg.body.targets || []).filter((t) => t.available);
  ok('有可用专题', avail.length >= 1, JSON.stringify(tg.body.targets?.map((t) => [t.id, t.available])));
  const t0 = avail[0];
  if (t0) {
    ok('专题带人类可读标题（从接口现读，不是写死的）', Boolean(t0.title) && t0.title.length > 3, String(t0.title));
    ok('专题带目标学时（UI 用它预填）', Number(t0.maxPeriod) > 0, String(t0.maxPeriod));
    ok('专题带课程 id 清单', Array.isArray(t0.courseIds) && t0.courseIds.length > 0);
    ok('专题带固定 URL（使用者不用输地址）', String(t0.url).startsWith('https://basic.smartedu.cn/training/'), String(t0.url));
  } else {
    ok('专题带人类可读标题', false, '没有可用专题，跳过后续');
  }

  // ── 课程列表 ──
  const cs = await get(`/api/courses?site=teacher-training&target=${encodeURIComponent(t0.id)}`);
  ok('GET /api/courses 200', cs.status === 200);
  ok('课程数 > 0', (cs.body.courses || []).length > 0, String(cs.body.courses?.length));
  ok('每门课都有 courseId 和 title', cs.body.courses.every((c) => c.courseId && c.title));
  ok(
    '每门课的 url 由适配器模板生成（不散落拼接）',
    cs.body.courses.every((c) => c.url === TT.courseUrl(c.courseId)),
    cs.body.courses[0]?.url,
  );
  ok('url 里没有 undefined/NaN', cs.body.courses.every((c) => !/undefined|NaN/.test(c.url)));
  ok('课程数与专题声明的 id 数一致', cs.body.courses.length === t0.courseIds.length, `${cs.body.courses.length} vs ${t0.courseIds.length}`);

  // ── 状态 ──
  const st = await get('/api/status');
  ok('GET /api/status 200', st.status === 200);
  ok('空闲时 running=false', st.body.running === false);
  ok('lines 是数组（前端启动时靠它恢复日志）', Array.isArray(st.body.lines));
  ok('seq 是数字（SSE 断线重连靠它去重）', typeof st.body.seq === 'number');

  // ── 错误处理：这些是小白真会踩到的 ──
  const noTarget = await post('/api/start', { site: 'teacher-training' });
  ok('POST /api/start 缺 target → 400 且说人话', noTarget.status === 400 && /target/.test(noTarget.body.error), JSON.stringify(noTarget.body));

  const idleStop = await post('/api/stop', {});
  ok('POST /api/stop 空闲时 → 明确说没在跑，而不是报错', idleStop.status === 200 && idleStop.body.stopped === false);

  const noTargetCourses = await get('/api/courses?site=teacher-training');
  ok('GET /api/courses 缺 target → 400', noTargetCourses.status === 400);

  const badSite = await get('/api/sites');
  ok('未知类型会给出「已支持哪些」的提示', badSite.status === 200); // /api/sites 本身不挑类型
  const badSite2 = await get('/api/targets?site=does-not-exist');
  ok('GET /api/targets 未知类型 → 报错里列出现有类型', badSite2.status === 500 && /已支持/.test(badSite2.body.error || ''), JSON.stringify(badSite2.body));

  const nope = await get('/api/nope');
  ok('未知路径 → 404 JSON', nope.status === 404 && /未知路径/.test(nope.body.error || ''));
} finally {
  await new Promise((r) => server.close(r));
}

// ════════════════════════════════════════════════════════════
// 【C】启动器路径探测（chrome --app 的入口）
// ════════════════════════════════════════════════════════════
// 这里锁的是一个真踩过的坑：曾经只认「Application/<版本号>/chrome.exe」这一种
// 旧布局，而现代 Chrome 把真 exe 直接放在 Application/ 下、版本目录里只有
// chrome.dll 等载荷 —— 结果 chromeExe() 返回 null，启动器误报「找不到 Chrome」。
console.log('\n【C】chromeExe()：桌面外壳用的 exe 路径');

const exe = chromeExe();
if (exe === null) {
  ok('本机装了 Chrome', false, '没装 → 启动器会给人话提示，这条跳过');
} else {
  ok('返回了绝对路径', path.isAbsolute(exe), exe);
  ok('文件名就是 chrome.exe', path.basename(exe).toLowerCase() === 'chrome.exe', exe);
  ok('文件真的存在（不是拼出来的假路径）', fs.existsSync(exe));
  ok('大小像个真 exe（不是 .sig 签名残留那种几十字节）', fs.statSync(exe).size > 100_000, `${fs.statSync(exe).size} bytes`);
  ok('路径落在 Google\\Chrome\\Application 下', /Google[\\/]Chrome[\\/]Application/i.test(exe), exe);
  ok('chromeVersion() 也能测出版本号（UA 伪造靠它）', Boolean(chromeVersion()), String(chromeVersion()));
}

console.log('\n【D】closeNote：退出码 → 界面上那句人话');
// ★ 为什么这个值得测：界面上除了日志区，用户唯一会认真看的就是这句。
//   若某个约定退出码没被翻成人话，小白就只看到一个数字 —— 而他还需要知道
//   「下一步该点哪里」。本会话真踩过：退出码 2（未登录）当时没人翻译，
//   界面上就只显示「挂课进程退出，代码 2」。
{
  const code2 = closeNote(2);
  ok('2（未登录）不是裸数字，而是给出下一步动作', /登录/.test(code2[0]) && !/代码 2/.test(code2[0]), code2[0]);
  ok('2 的文案点出了「先登录」按钮（小白要能照着做）', /先登录/.test(code2[0]), code2[0]);
  ok('2 的级别是 err（要显眼）', code2[1] === 'err', code2[1]);

  const code3 = closeNote(3);
  ok('3（预检失败）也有人话，且不出现裸数字', !/代码 3/.test(code3[0]), code3[0]);

  const code130 = closeNote(130);
  ok('130（被中止）翻成「已停止」', /停止/.test(code130[0]), code130[0]);

  const code0 = closeNote(0);
  ok('0 是正常结束，级别 ok', code0[1] === 'ok', code0[0]);

  const weird = closeNote(42);
  ok('未知退出码兑底：仍会显示码（不静默吞掉）', /42/.test(weird[0]), weird[0]);
  ok('未知退出码级别仍是 err', weird[1] === 'err', weird[1]);

  const undef = closeNote(undefined);
  ok('undefined（进程被杀）不抛异常', Array.isArray(undef) && typeof undef[0] === 'string', undef[0]);

  // 每个约定码都必须有专属文案 —— 掉回「代码 N」就是回归
  for (const c of [0, 2, 3, 130]) {
    ok(`约定退出码 ${c} 有专属人话（不是 「代码 ${c}」）`, !closeNote(c)[0].includes(`代码 ${c}`), closeNote(c)[0]);
  }
}

console.log(`\n通过 ${pass} / ${pass + fail}${fail ? `　❌ 失败 ${fail}` : ''}\n`);
process.exit(fail ? 1 : 0);