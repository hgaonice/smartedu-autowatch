#!/usr/bin/env node
/**
 * 交接前凭据自检 —— 把工具发给别人之前跑一下。
 *
 *   node tools/check-handoff.mjs
 *   node tools/check-handoff.mjs <目录>     # 扫别处（比如打包出来的那份）
 *
 * 为什么要有这个脚本（而不是文档里写一条 grep）：
 *   在文档里写「请 grep 这个串」，文档本身就含那个串，于是每次自检都命中自己，
 *   要么误报、要么逼人把警告当噪音忽略。所以把模式集中放在脚本里，并排除自身。
 *
 * 检查五类：
 *   1. 平台登录 token（UC_TOKEN- / UC_AUTH-）与长 hex/数字串
 *   2. 11 位以上的连续数字（平台 userId 是 12 位）
 *   3. 常见凭据字段后被赋值的长串（token= / cookie: / authorization:）
 *   4. 本不该出现在交付包里的路径（out/、node_modules/、profile 目录）
 *   5. 批处理文件行尾 —— 磁盘上的与**提交进仓库的 blob** 都查（两回事，见下）
 *
 * 退出码：0 = 干净；1 = 有发现（此时不要发包）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(SELF), '..'));

/**
 * 扫不出东西来的目录，直接跳过。
 *
 * ⚠️ 注意：跳过这些目录＝不对它们下「干净」的结论。out/ 里就**确实有凭据**。
 * 所以下面还会单独把「存在但不该随包发出」的目录列出来 —— 否则本脚本会给出
 * 一个危险的假安全感（「✅ 干净」然后人被把整个文件夹压了）。
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.cache']);

/** 存在就不该随包发出的目录（相对 ROOT 名） */
const DO_NOT_SHIP_DIRS = ['out', 'node_modules', '.chrome-profile'];

/** 交付包里不该有的东西（不是「秘密」，而是「不该发」） */
const SKIP_NAME_RE = [
  /^out$/,
  /-profile$/,
  /^\.chrome-profile$/,
  /\.lock$/,
  /\.log$/,
];

/**
 * 敏感模式。每条都带一个「这算不算真凭据」的说明，方便人判断。
 * 注意这些模式**只存在于本文件**，文档里不再复述它们 —— 否则自检会命中文档自身。
 *
 * `strict: true` = **不走 `looksLikeProse()` 的宽松豁免**。
 *
 * ★★ 这个开关是踩了坑才加的：原先所有模式一视同仁，而 `looksLikeProse()` 里有一条
 *    「以 `*`、`/`、`#` 开头的行一律跳过」—— 于是写在 `* ` 开头的块注释里的**真凭据**
 *    全部漏过。本项目的 `src/redact.mjs` 正是拿真 token / 真 userId 当示例写进注释，
 *    自检却报「✅ 没有发现个人凭据」，发布到公网前差点就这么出去了。
 *    注释里的凭据和代码里的凭据一样是泄露 —— 源码本身就是要发出去的东西。
 *
 *    为什么只给平台凭据开 strict：`UC_TOKEN-` / `UC_AUTH-` 是带平台特征的定长字面量，
 *    不存在「无意中写出来」的可能，误报率极低；而 `\d{11,}`、hex、字段名那几条一旦
 *    也 strict，文档与注释里的示例会成片报警（人就会把警告当噪音，反而真出事时看不见）。
 *    合成示例仍有逃生口：加 `check-handoff:allow`，且报告会公开豁免行数。
 */
const PATTERNS = [
  {
    // 字符集要含普通字母：尾缀 `-ncet-xedu` 里的 n/t/x/u 不在 [0-9a-f] 里，
    // 只写十六进制会在尾缀前停住（与 src/redact.mjs 的 TOKEN_RE 保持一致）
    re: /UC_TOKEN-[A-Za-z0-9-]{8,}/gi,
    what: '平台登录 token',
    why: '这是账号凭证，拿到就等于登录了你的账号',
    strict: true,
  },
  {
    // `ND_UC_AUTH-<uuid>&ncet-xedu&token`：不以 UC_TOKEN- 开头，上一条拦不住，
    // 而键名本身就把 uuid 写在里面。此前这里压根没有这条规则，是个真空洞。
    re: /UC_AUTH-[A-Za-z0-9-]{8,}/gi,
    what: 'localStorage 里的登录凭据键',
    why: '键名里嵌着 uuid，等价于 token；截图/日志里出现同样是泄露',
    strict: true,
  },
  {
    re: /\b\d{11,}\b/g,
    what: '长数字串（疑似平台 userId）',
    why: '平台 userId 是 12 位数字，属个人身份信息',
  },
  {
    re: /\b[0-9a-f]{32,}\b/gi,
    what: '长 hex 串（疑似 token/密钥）',
    why: '常见于鉴权 token、会话 id',
  },
  {
    re: /(?:token|authorization|cookie|password|passwd|secret|apikey|api_key)\s*[:=]\s*["']?([A-Za-z0-9._\-]{16,})/gi,
    what: '凭据字段被赋了长串',
    why: '字段名 + 长值，基本可以确定是凭据',
  },
];

/** 判定某一行是不是「说明性文本」而非真凭据 —— 降低误报 */
function looksLikeProse(line) {
  // 文档里的示例、占位符
  return (
    /<[^>]+>/.test(line) || // <userId> 这种占位符
    /…|\.\.\./.test(line) || // 省略号
    /例如|示例|比如|placeholder|示例值/.test(line) ||
    /^\s*[*/#]/.test(line) // 注释行
  );
}

/**
 * 行内豁免标记：只给**合成测试值**用。
 *
 * 为什么需要它：测试脱敏功能本身就必须写「长得像凭据」的字符串，而本脚本
 * 无法分辨真值与合成的。若不允许豁免，就只能把测试值写成拼接字符串，可读性极差、
 * 而且下次有人还是会把真值写回去。
 *
 * 豁免是**显式且可审计**的：报告里会单独列出「哪几个文件用了豁免、共几行」——
 * 不会静默隐藏，所以真正漏发凭据时能一眼看出来。
 */
const ALLOW_MARK = 'check-handoff:allow';

/** 用了豁免标记的行数，以及分散在哪些文件里（审计用） */
let allowedLines = 0;
const allowedFiles = new Set();

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (SKIP_NAME_RE.some((r) => r.test(e.name))) continue;
      yield* walk(full);
    } else if (e.isFile()) {
      // 排除自身 —— 按【文件名】而非路径：扫一个副本目录（打包出来的那份）时，
      // 那份副本的绝对路径与本文件的 SELF 不同，只比 SELF 会把它扫进来，
      // 而它注释里就写着豁免标记，会把「豁免了几行」这个披露数字报大、失真。
      if (e.name === path.basename(SELF)) continue;
      if (SKIP_NAME_RE.some((r) => r.test(e.name))) continue;
      yield full;
    }
  }
}

/** 不跳过任何子目录的遍历 —— 专用于统计「不该随包发出」的目录有多大 */
function* walk2(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk2(full);
    else if (e.isFile()) yield full;
  }
}

const findings = [];
let scanned = 0;
let skippedBig = 0;

/**
 * ★ .bat / .cmd 必须用 CRLF 行尾 —— 单列一条，因为它不属「凭据」而属「能不能跑」。
 *
 * 为什么值得专设：`cmd.exe` 是按**字节偏移**读批处理文件的，且期望 CRLF。若把 .bat
 * 存成 LF-only，cmd 会读错位、把半行当命令 —— 症状是满屏「'xxx' 不是内部或外部命令」，
 * 而且**连 `chcp 65001 >nul` 里的 `nul` 都会被拆坏**。
 *
 * 这类错误极其阴险：编辑器里看文件完全正常、`node --check` 也不管 .bat，只在**真双击**
 * 时才暴。而 start.bat 正是使用者唯一会碰的东西 —— 它坏了 = 整个工具不可用。
 * （本项目真踩过，见 docs/handoff.md 的排查记录。）
 */
function checkBatchLineEndings(root) {
  const bad = [];
  for (const file of walk2(root)) {
    if (!/\.(bat|cmd)$/i.test(file)) continue;
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    const s = buf.toString('latin1');
    const crlf = (s.match(/\r\n/g) || []).length;
    const lf = (s.match(/\n/g) || []).length;
    if (lf > 0 && crlf < lf) bad.push({ rel: path.relative(root, file), crlf, lf });
  }
  return bad;
}

/**
 * 检查**提交进仓库的 blob** 的行尾，而不只是磁盘上的文件。
 *
 * ★ 为什么需要这一层 —— 正是踩过才加的：
 *   `.gitattributes` 里写 `*.bat text eol=crlf` 时，磁盘上的 start.bat 是 CRLF，
 *   于是上面那个工作区检查**通过**、报告「可以发包」；但 `text` 会先把 CRLF
 *   **归一成 LF 存进 blob**，`eol=crlf` 只在【检出】那一刻还原。后果：
 *     · git clone       → 拿到 CRLF（侥幸对）
 *     · raw.githubusercontent.com / 网页「复制原文」 → 拿到 **LF**（start.bat 直接不能用）
 *   工作区绿、仓库红，是两回事。修法是把批处理声明为 `-text`（不做归一化）。
 *
 * 用 `git show :<path>` 读**索引版本** —— 那才是下一次 commit/push 真正会发出去的东西。
 * 不在 git 仓库里（比如扫一个解压出来的交付包）就静默跳过，不是错误。
 */
function checkBatchBlobs(root) {
  const gitq = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

  let tracked;
  try {
    if (gitq(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return null;
    tracked = gitq(['ls-files']).split('\n').filter((f) => /\.(bat|cmd)$/i.test(f));
  } catch {
    return null; // 不是 git 仓库 / 没有 git —— 跳过，不下结论
  }

  const bad = [];
  for (const rel of tracked) {
    let blob;
    try {
      blob = execFileSync('git', ['show', `:${rel}`], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    const s = blob.toString('latin1');
    const crlf = (s.match(/\r\n/g) || []).length;
    const lf = (s.match(/\n/g) || []).length;
    if (lf > 0 && crlf < lf) bad.push({ rel, crlf, lf });
  }
  return bad;
}

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  let text;
  try {
    const st = fs.statSync(file);
    if (st.size > 2_000_000) {
      skippedBig++;
      continue;
    }
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  // 二进制文件跳过（含 NUL 字节）
  if (text.includes('\u0000')) continue;
  scanned++;

  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    // 显式豁免（只该是合成测试值）—— 统计下来在报告里公开，不静默隐藏
    if (line.includes(ALLOW_MARK)) {
      allowedLines++;
      allowedFiles.add(rel);
      continue;
    }
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      const m = p.re.exec(line);
      if (!m) continue;
      if (!p.strict && looksLikeProse(line)) continue;
      findings.push({
        rel,
        line: i + 1,
        what: p.what,
        why: p.why,
        // 只显示前后各几个字符，绝不打印命中值本身 —— 免得自检把凭据又打到终端/日志里
        excerpt: line.trim().slice(0, 70) + (line.trim().length > 70 ? '…' : ''),
      });
    }
  }
}

// ── 报告 ──
console.log(`\n扫描目录：${ROOT}`);
console.log(`已扫 ${scanned} 个文本文件${skippedBig ? `（跳过 ${skippedBig} 个 >2MB 的）` : ''}\n`);

// 公开豁免情况 —— 免得豁免标记变成静默的后门
if (allowedLines) {
  console.log(
    `ℹ️  已按「${ALLOW_MARK}」豁免 ${allowedLines} 行（${[...allowedFiles].join('、')}）`,
  );
  console.log('    这些行未参与扫描。若你不清楚它们是什么，请手动看一眼。\n');
}

// 先提醒「不该随包发出」的目录 —— 它们里的内容没被扫，不能当成干净
const shipWarnings = [];
for (const name of DO_NOT_SHIP_DIRS) {
  const full = path.join(ROOT, name);
  if (!fs.existsSync(full)) continue;
  let size = 0;
  let count = 0;
  for (const f of walk2(full)) {
    count++;
    try {
      size += fs.statSync(f).size;
    } catch {
      /* 忽略 */
    }
  }
  shipWarnings.push({ name, count, mb: (size / 1024 / 1024).toFixed(1) });
}

if (shipWarnings.length) {
  console.log('⚠️  下列目录**存在，但绝对不能随包发出**（本次未扫它们，不要当成已检查）：\n');
  for (const w of shipWarnings) {
    const extra =
      w.name === 'out'
        ? '　← 里面有运行日志/探测结果，含个人 userId 与登录 token'
        : w.name === 'node_modules'
          ? '　← 体积大，对方首次运行会自己装'
          : '　← 含登录 cookie，等于你的账号';
    console.log(`     ${w.name}/  （${w.count} 个文件，${w.mb} MB）${extra}`);
  }
  console.log('\n     打包时请按白名单复制（见 docs/handoff.md 第一节）。\n');
}

// ── 行尾检查（.bat 存成 LF 会让工具整个不可用）──
// 分两层：磁盘上的文件（交付包是按文件夹复制的） + 提交进仓库的 blob（GitHub 上那份）。
const batchBad = checkBatchLineEndings(ROOT);
if (batchBad.length) {
  console.log('🔴 批处理文件行尾不是 CRLF —— 这会让它**根本无法运行**，必须先修：\n');
  for (const b of batchBad) {
    console.log(`  ${b.rel}  （CRLF ${b.crlf} 行 / LF ${b.lf} 行）`);
  }
  console.log('\n     cmd.exe 按字节偏移读 .bat 且期望 CRLF；LF-only 会读错位、把半行当命令。');
  console.log('     修：把文件转成 CRLF（每个换行前补 \\r），别只改编辑器设置就算。\n');
}

const blobBad = checkBatchBlobs(ROOT) || [];
if (blobBad.length) {
  console.log('🔴 **提交进仓库的**批处理 blob 行尾是 LF（磁盘上却是 CRLF，所以上一项检查看不出来）：\n');
  for (const b of blobBad) {
    console.log(`  ${b.rel}  （blob 里 CRLF ${b.crlf} 行 / LF ${b.lf} 行）`);
  }
  console.log('\n     从 GitHub 网页「复制原文」或 raw 链接拿到的就是这份 —— 同样是坏的。');
  console.log('     原因多半是 .gitattributes 把批处理写成了 `text eol=crlf`：');
  console.log('       `text` 会先归一成 LF 存进 blob，`eol=crlf` 只在检出时还原。');
  console.log('     修：改成 `*.bat -text` / `*.cmd -text`，然后 `git add --renormalize .`。\n');
}

const eolBad = batchBad.length + blobBad.length;

if (!findings.length) {
  console.log('✅ 源码里没有发现个人凭据。');
  if (eolBad) {
    console.log('   ❌ 但上面的批处理行尾问题必须先修 —— 修完再发。\n');
  } else if (shipWarnings.length) {
    console.log('   （但上面那几个目录仍需排除，别用「压缩整个文件夹」。）\n');
  } else {
    console.log('   可以发包。\n');
  }
  process.exit(eolBad ? 1 : 0);
}

console.log(`🔴 发现 ${findings.length} 处可疑内容 —— 先处理掉再发：\n`);
for (const f of findings) {
  console.log(`  ${f.rel}:${f.line}`);
  console.log(`    类型：${f.what}`);
  console.log(`    为何要紧：${f.why}`);
  console.log(`    上下文：${f.excerpt}`);
  console.log('');
}
console.log('提醒：如果命中落在 out/ 或日志里 —— 那目录本身就不该随包发出，删掉即可。\n');
process.exit(1);
