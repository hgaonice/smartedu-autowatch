/**
 * 本地 Web UI 的后端。
 *
 * ════════════════════════════════════════════════════════════════════════
 *  设计取向
 * ════════════════════════════════════════════════════════════════════════
 * 目标用户是**完全不懂技术的人**，所以：
 *   · 零依赖（只用 node:http）——不引入构建步骤，也少一堆供应链风险
 *   · 只监听 127.0.0.1 ——不暴露到局域网
 *   · 不 spawn 第二个浏览器 ——挂课进程自己负责开 Chrome；这层只管 HTTP 与子进程
 *   · 前端是单个静态 HTML（内联 CSS/JS）——无构建、可直接改
 *
 * 这一层**不重复任何业务逻辑**：专题/课程/学时全部经 src/sites 适配器拿。
 *
 *   GET  /                     UI 页面
 *   GET  /api/sites            可选挂课类型
 *   GET  /api/targets?site=    可挂专题（免登录）
 *   GET  /api/courses?site=&target=  专题下的课程 + 各自已认定学时
 *   POST /api/start            开始挂课（spawn run.mjs）
 *   POST /api/stop             停掉挂课
 *   GET  /api/status           当前任务状态 + 日志快照
 *   GET  /api/log              SSE 实时日志流
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SITES, getSite } from '../sites/index.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const UI_FILE = path.join(DIR, 'ui.html');

/** 日志环形缓冲上限 —— UI 只要最近的，无限增长会吃内存 */
const MAX_LINES = 3000;

// ────────────────────────────────────────────────────────────
//  当前挂课任务（单实例：一次只跑一个，profile 是独占资源）
// ────────────────────────────────────────────────────────────
class Job {
  constructor() {
    this.proc = null;
    this.lines = []; // { seq, text, kind }
    this.seq = 0;
    this.startedAt = null;
    this.args = null;
    this.exitCode = null;
    this.subscribers = new Set(); // SSE
    this.buf = ''; // 跨 chunk 的行缓冲
  }

  get running() {
    return Boolean(this.proc) && this.exitCode === null;
  }

  push(text, kind = 'out') {
    const line = { seq: ++this.seq, text, kind };
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    const payload = `data: ${JSON.stringify(line)}\n\n`;
    for (const res of this.subscribers) {
      try {
        res.write(payload);
      } catch {
        this.subscribers.delete(res);
      }
    }
  }

  /**
   * 收子进程输出。
   * run.mjs 的进度行是 `\r` 原地刷新的（终端里覆盖同一行），这里必须把 `\r` 也当换行，
   * 否则 UI 里会看到一坨越来越长的字符串。
   */
  feed(chunk, kind) {
    this.buf += chunk;
    const parts = this.buf.split(/\r\n|\r|\n/);
    this.buf = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) this.push(p, kind);
  }

  /** 进程结束后把缓冲里最后那截没换行的也吐出来 */
  flush() {
    if (this.buf.trim()) this.push(this.buf.trim(), 'out');
    this.buf = '';
  }
}

const job = new Job();

/**
 * 把子进程的退出码翻成一句人话。
 *
 * ★ 界面上除了日志区，用户唯一会认真看的就是这句。所以每个「约定退出码」
 *   都必须翻成「他下一步该点哪里」—— 光显示数字等于没说，小白会直接卡死。
 *   2 = 未登录（src/run.mjs）；3 = 预检失败（src/preflight.mjs）。
 *
 * @returns {[string, 'ok'|'err']} [文案, 级别]
 */
export function closeNote(code) {
  if (code === 0) return ['✅ 挂课进程已正常结束', 'ok'];
  if (code === 2) {
    return ['🔑 还没登录 —— 请先点上方的「先登录（只需一次）」，登录完再点「开始挂课」', 'err'];
  }
  if (code === 3) return ['⚠️ 环境不满足，已退出（看上面的提示）', 'err'];
  if (code === 130) return ['⏹ 已停止', 'ok'];
  return [`⚠️ 挂课进程退出，代码 ${code}`, 'err'];
}

function startJob(args) {
  if (job.running) throw new Error('已经有一批在挂了，先停掉再开新的');
  if (!fs.existsSync(path.join(ROOT, 'src', 'run.mjs'))) {
    throw new Error(`找不到 src/run.mjs（工作目录 ${ROOT}）`);
  }
  job.lines = [];
  job.seq = 0;
  job.exitCode = null;
  job.buf = '';
  job.startedAt = new Date().toISOString();
  job.args = args;
  job.push(`$ node src/run.mjs ${args.join(' ')}`, 'cmd');

  const proc = spawn(process.execPath, [path.join(ROOT, 'src', 'run.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  job.proc = proc;
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (d) => job.feed(d, 'out'));
  proc.stderr.on('data', (d) => job.feed(d, 'err'));
  proc.on('error', (e) => job.push(`启动挂课进程失败：${e.message}`, 'err'));
  proc.on('close', (code) => {
    job.flush();
    job.exitCode = code ?? 0;
    job.proc = null;
    const [msg, kind] = closeNote(code);
    job.push(msg, kind);
  });
  return { pid: proc.pid };
}

function stopJob() {
  if (!job.running) return { stopped: false, reason: '当前没有在跑的任务' };
  const pid = job.proc.pid;
  job.push(`⏹ 正在停止（PID ${pid}）…`, 'cmd');
  // 先礼后兵：SIGTERM 让 run.mjs 的清理钩子释放 profile 锁；不行再强杀
  try {
    job.proc.kill('SIGTERM');
  } catch {}
  setTimeout(() => {
    if (job.running) {
      try {
        job.proc.kill('SIGKILL');
      } catch {}
    }
  }, 8000);
  return { stopped: true, pid };
}

// ────────────────────────────────────────────────────────────
//  HTTP 工具
// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
//  参数拼装（纯函数，单独抽出来就是为了能不起浏览器单测它）
// ────────────────────────────────────────────────────────────

/**
 * 把 UI 发来的表单翻成 run.mjs 的命令行参数。
 *
 * 原则是「不传多余的参数」：没填的就别传，让 run.mjs 用自己的默认值，
 * 避免 UI 与 CLI 的默认值各写一份、以后改一处忘了另一处。
 *
 * @param {object} b 请求体 { target, targetHours, rate, courses, headful }
 * @param {{id:string}} site 站点适配器
 * @returns {string[]}
 */
export function buildRunArgs(b, site) {
  const args = ['--site', site.id];
  if (b.target) args.push('--train', String(b.target));
  if (Number(b.targetHours) > 0) args.push('--target-hours', String(Number(b.targetHours)));
  if (Number(b.rate) > 0) args.push('--rate', String(Number(b.rate)));
  if (Array.isArray(b.courses) && b.courses.length) args.push('--only', b.courses.join(','));
  if (b.headful) args.push('--headful');
  return args;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s.trim()) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ────────────────────────────────────────────────────────────
//  路由
// ────────────────────────────────────────────────────────────
async function handle(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const html = fs.readFileSync(UI_FILE);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': html.length,
    });
    return res.end(html);
  }

  if (req.method === 'GET' && p === '/api/sites') {
    return json(res, 200, {
      sites: SITES.map((s) => ({ id: s.id, name: s.name, hint: s.hint })),
    });
  }

  if (req.method === 'GET' && p === '/api/targets') {
    const site = getSite(url.searchParams.get('site'));
    const targets = await site.listTargets();
    return json(res, 200, { site: site.id, targets });
  }

  if (req.method === 'GET' && p === '/api/courses') {
    const site = getSite(url.searchParams.get('site'));
    const trainId = url.searchParams.get('target');
    if (!trainId) return json(res, 400, { error: '缺少 target 参数' });
    const courses = await site.listCourses(trainId);
    return json(res, 200, { site: site.id, target: trainId, courses });
  }

  if (req.method === 'POST' && p === '/api/start') {
    if (job.running) return json(res, 409, { error: '已经有一批在挂了' });
    const b = await readBody(req);
    const site = getSite(b.site);

    // 「登录」是一种特殊任务：不开课，只把 Chrome 打开让人扫码，登录态存进 profile。
    if (b.login) {
      return json(res, 200, { ...startJob(['--site', site.id, '--login']), login: true });
    }

    if (!b.target) return json(res, 400, { error: '缺少 target（专题 id）' });

    const args = buildRunArgs(b, site);
    return json(res, 200, { ...startJob(args), args });
  }

  if (req.method === 'POST' && p === '/api/stop') {
    return json(res, 200, stopJob());
  }

  if (req.method === 'GET' && p === '/api/status') {
    return json(res, 200, {
      running: job.running,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      args: job.args,
      pid: job.proc?.pid ?? null,
      seq: job.seq,
      lines: job.lines.slice(-400),
    });
  }

  if (req.method === 'GET' && p === '/api/log') {
    // SSE：只推增量（after 之后的行），断线重连时补历史
    const after = Number(url.searchParams.get('after') ?? 0);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    for (const l of job.lines) if (l.seq > after) res.write(`data: ${JSON.stringify(l)}\n\n`);
    job.subscribers.add(res);
    const ka = setInterval(() => {
      try {
        res.write(': ka\n\n');
      } catch {}
    }, 15000);
    req.on('close', () => {
      clearInterval(ka);
      job.subscribers.delete(res);
    });
    return undefined;
  }

  return json(res, 404, { error: `未知路径 ${p}` });
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    Promise.resolve()
      .then(() => handle(req, res, url))
      .catch((e) => {
        if (res.headersSent) return res.end();
        json(res, 500, { error: String(e?.message || e) });
      });
  });
}

export { job, stopJob, ROOT };
