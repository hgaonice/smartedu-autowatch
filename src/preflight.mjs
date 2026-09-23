/**
 * 启动前预检 —— 把「环境不满足」翻译成非技术用户看得懂的中文。
 *
 * 为什么单独一层：这些东西失败时，下游报出来的错都是天书 ——
 *   · Node 太老    → `SyntaxError: Unexpected token '?'` / `fetch is not defined`
 *   · 没装 Chrome  → Playwright: "Executable doesn't exist at .../chrome.exe"
 *   · profile 占用 → Playwright: "Target page, context or browser has been closed"（exitCode=21）
 * 用户看到这些只会以为「软件坏了」。
 *
 * 这一层**不启动浏览器**（要几百 ms + 会跟正在跑的批次抢 profile）。
 * Widevine / 解码能力这类必须开浏览器才能验的，交给 `node src/probe.mjs`。
 */

import {
  chromeVersion,
  acquireProfileLock,
  releaseProfileLock,
  occupiedMessage,
  FriendlyError,
} from './browser.mjs';

/** 最低 Node 主版本。18 已 EOL，20 是当前 LTS 下限。 */
export const MIN_NODE_MAJOR = 20;

const NODE_DL = 'https://nodejs.org/zh-cn/download';
const CHROME_DL = 'https://www.google.cn/chrome/';

/** 只做检查，不改状态，可以直接在任何地方调用 */
export function checkEnvironment() {
  const errors = [];
  const notes = [];

  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    errors.push(
      `Node.js 版本太低：当前 v${process.versions.node}，需要 v${MIN_NODE_MAJOR} 或更高。\n` +
        `  到 ${NODE_DL} 下载 LTS 版安装（装完关掉这个窗口重开）。`,
    );
  } else {
    notes.push(`Node.js v${process.versions.node}`);
  }

  const cv = chromeVersion();
  if (!cv) {
    errors.push(
      '没找到 Google Chrome。\n' +
        `  本工具**复用系统已装的 Chrome**（不下载自带浏览器，省 150MB，也保证能播加密视频）。\n` +
        `  到 ${CHROME_DL} 安装即可。\n` +
        '  注意：Microsoft Edge 不行 —— 本工具指定用 Chrome 的内核与解密组件。',
    );
  } else {
    notes.push(`Google Chrome ${cv}`);
  }

  return { ok: errors.length === 0, errors, notes };
}

/**
 * 注册退出清理：正常结束 / Ctrl+C / 被杀 都会放锁。
 * ★ 由**抢锁的那一层自己**注册 —— 否则使用者忘了调 release 就会留残留锁。
 *   （已踩过：selftest 抢到锁后 launch 抛异常，锁留在了磁盘上）
 */
export function installLockCleanup() {
  let done = false;
  const drop = () => {
    if (done) return;
    done = true;
    releaseProfileLock();
  };
  process.on('exit', drop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      drop();
      process.exit(130);
    });
  }
}

/**
 * 预检 + 占用 profile 锁（原子：要么全过并持锁并登记好清理，要么全不过且不留锁）。
 *
 * @param {object} o
 * @param {string} [o.label]      写进锁文件的标注，便于事后查是谁占的
 * @param {boolean} [o.needLock]  纯检查类调用可传 false（不持锁，也不登记清理）
 * @returns {{ok: boolean, errors: string[], notes: string[]}}
 */
export function preflight({ label = 'run.mjs', needLock = true } = {}) {
  const env = checkEnvironment();
  if (!env.ok) return env;

  if (!needLock) return env;

  const lock = acquireProfileLock(undefined, { label });
  if (!lock.ok) {
    return {
      ok: false,
      notes: env.notes,
      errors: [occupiedMessage(lock.holder)],
    };
  }
  installLockCleanup(); // ★ 拿到锁以后必须登记，否则异常路径会漏
  if (lock.stale) {
    env.notes.push(
      `接管了一个残留锁（上个进程 PID ${lock.stale.pid} 已不存在，多半是崩了或被杀）`,
    );
  }
  return env;
}

/** 把预检结果打印成人话；ok=true 时打印一行环境摘要 */
export function reportPreflight({ ok, errors, notes }, { log = console.log, warn = console.warn } = {}) {
  if (ok) {
    log(`环境预检通过：${notes.join('｜')}`);
    return;
  }
  warn('=========================================================');
  warn('  环境不满足，没法开始 —— 按下面说的做即可：');
  warn('=========================================================');
  for (const [i, e] of errors.entries()) {
    warn(`\n${i + 1}) ${e}`);
  }
  console.warn('\n（这几项修好后重新运行即可；跑 `node src/probe.mjs` 可以更细致地体检。）\n');
}

export { releaseProfileLock, FriendlyError };

/**
 * 入口守卫：把「已经给人看过」的错误干净地打印出来，不让 Node 堆栈吓人。
 * 用法：`const ctx = await guard(() => launchContext({ headless }));`
 * 非 friendly 的错误原样抛，保留真实堆栈供排查。
 */
export async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.friendly) {
      console.error(`\n${e.message}\n`);
      process.exit(3);
    }
    throw e;
  }
}
