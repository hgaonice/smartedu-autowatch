/**
 * 浏览器启动层。
 *
 * 关键设计：用 playwright-core + channel:'chrome' 复用系统已装的 Chrome，
 * 不下载 Playwright 自带 Chromium（省 ~150MB，且版本与用户的 Chrome 一致）。
 *
 * 关于「无头能不能用」—— 已实测：**能**。
 *   - headless 下 document.visibilityState 恒为 'visible'，平台的前台检测天然不触发；
 *   - Widevine CDM 在 headless 下也可用，只需 ignoreDefaultArgs 放掉 --disable-component-update
 *     （见下方 launchContext 里的长注释）。
 *   所以默认走 headless，用 --headful 退回有头（--login 必须用有头，要手动输账号）。
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright-core';

/** 独立 profile —— 不复用日常 Chrome 的目录（运行中会被锁，且 Chrome≥136 禁止在其上开 CDP） */
export const PROFILE_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'smartedu-auto-profile',
);

/** 系统 Chrome 的可能安装根目录 */
function chromeRoots() {
  return [
    process.env['PROGRAMFILES'] ? path.join(process.env['PROGRAMFILES'], 'Google/Chrome/Application') : null,
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application') : null,
  ].filter(Boolean);
}

/** 某个安装根目录下的版本号目录，按第 3 段数字（Chrome 的 build 号）排序 */
function versionDirs(root) {
  try {
    return fs
      .readdirSync(root)
      .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) => a.split('.').map(Number)[2] - b.split('.').map(Number)[2]);
  } catch {
    return [];
  }
}

/**
 * 探测系统 Chrome 版本，用于伪造去掉 "Headless" 的 UA。
 * headless 模式下 Chrome 默认把 UA 写成 HeadlessChrome/153.0.0.0 —— 这是很好认的指纹。
 */
function detectChromeVersion() {
  for (const root of chromeRoots()) {
    const vers = versionDirs(root);
    if (vers.length) return vers[vers.length - 1];
  }
  return null;
}

/**
 * chrome.exe 的绝对路径（null = 没装）。
 * 给 `chrome --app=<url>` 外壳用 —— Playwright 的 channel:'chrome' 能自己找到 Chrome，
 * 但「把本地页面伪装成一个独立桌面窗口」必须自己拿到 exe 路径。
 *
 * 两种布局都要认（踩过：只认了旧的那种，于是在这台机器上直接返回 null，
 * 启动器误报「找不到 Chrome」）：
 *   现代（Chrome 13x+）：Application\chrome.exe           ← 真 exe，版本目录里只有 chrome.dll 等载荷
 *   旧版：            Application\<版本号>\chrome.exe
 */
export function chromeExe() {
  const candidates = [];
  for (const root of chromeRoots()) {
    // 现代布局优先：根下那份就是官方入口
    candidates.push(path.join(root, 'chrome.exe'));
    // 旧布局兜底
    const newest = versionDirs(root).pop();
    if (newest) candidates.push(path.join(root, newest, 'chrome.exe'));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const CHROME_VERSION = detectChromeVersion();
const REAL_UA = CHROME_VERSION
  ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${CHROME_VERSION} Safari/537.36`
  : null;

/** 系统 Chrome 版本（null = 没装）；预检用 */
export const chromeVersion = () => CHROME_VERSION;

/**
 * 「已经给人看过了」的错误。
 *
 * 这类错误的 message 本身就是给非技术用户看的中文指引，入口处应该**只打印 message**，
 * 不要附 Node 堆栈（`Node.js v24.14.0` + 文件行号会把小白吓跑，也会掩盖真正的信息）。
 */
export class FriendlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FriendlyError';
    this.friendly = true;
  }
}

// ----------------------------------------------------------------
// 单实例守卫（专用 profile 是独占资源）
// ----------------------------------------------------------------
// 实测：两个进程同时用同一个 user-data-dir 启动 Chrome，第二个会**立刻退出**
// （Playwright 只报 `exitCode=21` + “Target page, context or browser has been closed”），
// 看不出任何原因。而报错文本完全没提 profile 占用 —— 对非技术用户是天书。
//
// 所以：启动前先抢一个 advisory 锁，拿到人话提示，而不是 Playwright 原始堆栈。
// 锁文件放在 profile **旁边**（不能放 profile 里面：那是 Chrome 的地盘）。
// 并带 PID 存活检查 —— 进程被 kill -9 后残留的锁能自动接管，不会永久卡死。

const lockFile = (profileDir) => `${profileDir}.lock`;

/** 进程是否还活着（EPERM = 存在但无权限，也算活） */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** 读锁（不判断存活），没有/坏掉返回 null */
export function readProfileLock(profileDir = PROFILE_DIR) {
  try {
    const l = JSON.parse(fs.readFileSync(lockFile(profileDir), 'utf8'));
    return l && l.pid ? l : null;
  } catch {
    return null;
  }
}

/**
 * 抢锁。
 * @returns {{ok: true, path: string, stale?: object} | {ok: false, holder: object}}
 */
export function acquireProfileLock(profileDir = PROFILE_DIR, { label = 'run.mjs' } = {}) {
  const f = lockFile(profileDir);
  const held = readProfileLock(profileDir);
  let stale;
  if (held && pidAlive(held.pid)) return { ok: false, holder: held };
  if (held) stale = held; // 上一轮崩了留下的，直接接管
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(
    f,
    JSON.stringify({ pid: process.pid, label, since: new Date().toISOString() }, null, 2),
  );
  return { ok: true, path: f, stale };
}

/** 放锁。只放自己拿的那把 —— 别人的锁不动 */
export function releaseProfileLock(profileDir = PROFILE_DIR) {
  const held = readProfileLock(profileDir);
  if (!held || held.pid !== process.pid) return false;
  try {
    fs.unlinkSync(lockFile(profileDir));
    return true;
  } catch {
    return false;
  }
}

/** 给非技术用户看的「谁占着 profile」人话提示 */
export function occupiedMessage(holder) {
  const mins = holder?.since
    ? Math.round((Date.now() - new Date(holder.since).getTime()) / 60000)
    : null;
  // 注意：这层 advisory 锁只能看见**自己写的**锁文件。
  // 本功能上线前启动的老进程没有锁文件，Chrome 自己的单例锁也不在这里（Windows 上不在 profile 里落文件）。
  // 所以 holder 可能是 null —— 那时要坦白说“查不到具体是谁”，而不是乱报一个 PID。
  const who = holder
    ? `  占用者：PID ${holder.pid}（${holder.label || '未知'}）` +
      (mins != null ? `，已运行约 ${mins} 分钟` : '') +
      (holder.since ? `，开始于 ${holder.since}` : '')
    : '  查不到具体是谁占的 —— 可能是本功能加入前启动的批次，或别的程序在用这个 profile。';
  return [
    '浏览器专用 profile 正被占用，没法启动。',
    who,
    '',
    '  先确认有没有挂课进程在跑：',
    '    powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
      "Where-Object { $_.CommandLine -like '*run.mjs*' -and $_.Name -eq 'node.exe' } | " +
      'ForEach-Object { $_.ProcessId }"',
    '  要停掉它（<pid> 换成上面查到的）：',
    '    Stop-Process -Id <pid>',
    '  ⚠️ 别用 `taskkill /IM chrome.exe` —— 你自己的浏览器也叫 chrome.exe，会被一起杀掉。',
  ].join('\n');
}

/**
 * 彻底关掉后台节流。
 * 这是脚本方案做不到的部分：脚本只能在页面内自救，这些是浏览器进程级开关。
 * 对应平台的第 3 层防御（Chrome 后台标签页 throttle）。
 */
export const ANTI_THROTTLE_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  // CalculateNativeWinOcclusion：窗口被完全遮挡时 Chrome 会降低渲染优先级
  // IntensiveWakeUpThrottling：后台 5 分钟后 timer 降到 1 次/分钟
  // ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes：隐藏 iframe 的 timer 节流
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,' +
    'ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes,BackForwardCache',
  // 不需要用户手势即可播放（省掉「先点一次播放」）
  '--autoplay-policy=no-user-gesture-required',
  // 抹掉最显著的自动化标记
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
  '--disable-session-crashed-bubble',
  // 让媒体始终有能力解码（部分环境下缺 GPU 会拒绝解码 → 一直 readyState 0）
  '--use-fake-ui-for-media-stream',
  // 平台域名走直连。
  // 注意：这个参数会**整体替换**系统 WinINET 的 ProxyOverride，所以把 loopback 也写回去。
  // 为什么要显式加：Clash Verge 每次切换「系统代理」都会重写 ProxyOverride，
  // 若某次它把 *.smartedu.cn 从绕过列表里去掉，视频流量就会被送进代理 →
  // 代理节点的证书未必覆盖该域名 → ERR_CERT_COMMON_NAME_INVALID，
  // 而且这类错误能过 TLS 但会卡住媒体分片，比直接连不上更难查。
  '--proxy-bypass-list=*.smartedu.cn;*.cbern.com.cn;localhost;127.0.0.1;<local>',
];

/** 每个 document 创建前执行：补掉 navigator.webdriver */
export const STEALTH_INIT = `(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  } catch {}
  window.__SMARTEDU_STEALTH__ = true;
})();`;

/**
 * @param {object} o
 * @param {boolean} o.headless
 * @param {string} [o.profileDir]
 * @param {string[]} [o.extraArgs]
 * @param {number} [o.slowMo]
 * @param {boolean} [o.keepThrottled]  调试用：不关节流
 * @returns {Promise<import('playwright-core').BrowserContext>}
 */
export async function launchContext({
  headless = true,
  profileDir = PROFILE_DIR,
  extraArgs = [],
  slowMo = 0,
  keepThrottled = false,
} = {}) {
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    ...(keepThrottled ? [] : ANTI_THROTTLE_ARGS),
    ...extraArgs,
  ];

  const context = await chromium
    .launchPersistentContext(profileDir, {
      channel: 'chrome',            // 复用系统 Chrome，v153
      headless,
      args,
      slowMo,
      viewport: headless ? { width: 1440, height: 900 } : null,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      acceptDownloads: true,
      ignoreHTTPSErrors: false,

      // ★ 关键：Playwright 默认传 --disable-component-update，会阻止 Widevine CDM 组件下载，
      //   导致 requestMediaKeySystemAccess('com.widevine.alpha') 直接 NotSupportedError。
      //   去掉它之后，**headless 下 Widevine 也能正常协商**（已实测）。
      //   代价：headless 首次启动会下载一次 CDM 组件（几十 MB）。
      ignoreDefaultArgs: ['--disable-component-update'],

      // 去掉 UA 里的 "Headless" 指纹
      ...(headless && REAL_UA ? { userAgent: REAL_UA } : {}),
    })
    .catch((err) => {
      // 把「profile 被占用」这条最常见的失败翻译成人话。
      // Chrome 撞锁时立刻退出（exitCode=21），Playwright 只会甩一句
      // “Target page, context or browser has been closed”，完全看不出原因。
      const msg = String(err?.message || '');
      const looksOccupied =
        /exitCode=21|SingletonLock|process singleton|already running|profile.*in use/i.test(msg) ||
        /Target page, context or browser has been closed/i.test(msg);
      if (looksOccupied) {
        // 重要：别把“自己刚抢的锁”当成占用者——那会指向本进程，把自己报成犯人。
        // 真实占用者通常是没写锁的老进程，此时 holder 为 null，提示里会坦白说查不到。
        const held = readProfileLock(profileDir);
        const holder = held && held.pid !== process.pid ? held : null;
        throw new FriendlyError(`${occupiedMessage(holder)}\n\n  原始错误：${msg.split('\n')[0]}`);
      }
      throw new FriendlyError(
        `浏览器启动失败：${msg.split('\n')[0]}\n` +
          `  先跑 node src/probe.mjs 体检；若是首次运行且提示找不到 Chrome，` +
          `请先安装 Google Chrome（本工具复用系统 Chrome，不下载自带 Chromium）。`,
      );
    });

  await context.addInitScript(STEALTH_INIT);
  return context;
}

/** 复用同一个 tab（避免多开导致学时上报分裂），没有就新建 */
export async function reusePage(context) {
  const pages = context.pages();
  const existing = pages.find((p) => p.url().includes('smartedu.cn'));
  if (existing) return existing;
  return pages[0] ?? (await context.newPage());
}

/**
 * 判断是否已登录。
 * 坑：_X_STAT_EVENT_SESSION / sajssdk_* 这类埋点键含 "session""user"，
 * 用宽泛正则会误报为已登录，所以：先排黑名单，再要强信号（token/ticket/jwt，或值像 JWT）。
 *
 * ★ 导航竞态必须自己兜住：`page.evaluate` 在页面正在跳转时会抛
 *   「Execution context was destroyed」。登录过程中的轮询（run.mjs 的 while 循环）
 *   每 3s 读一次，正好会撞上用户扫码后平台跳转的那一两帧 —— 实测已因此把整个
 *   `--login` 打崩、浏览器被一起关掉，用户白登录一次。
 *   这里改成「读不到就重试几次，仍失败则返回 loggedIn=false + note」，
 *   让调用方继续轮询，而不是把异常抛到顶层。
 */
export async function loginState(page, { attempts = 4, retryDelayMs = 800 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await readLoginStateOnce(page);
    } catch (err) {
      const msg = String(err?.message || err);
      // 只对「上下文被销毁/页面正在导航」这类瞬时错误重试；其它错误照样抛
      const transient = /Execution context was destroyed|Cannot find context|Target closed|frame was detached|navigat/i.test(msg);
      if (!transient || i === attempts) {
        if (!transient) throw err;
        return {
          keys: [],
          cookieNames: [],
          signals: [],
          loggedIn: false,
          note: `页面正在导航，登录态本次读取失败（${msg.split('\n')[0]}）`,
        };
      }
      await page.waitForTimeout(retryDelayMs);
    }
  }
}

/** 单次读取登录态（不做重试，导航期间会抛异常） */
function readLoginStateOnce(page) {
  return page.evaluate(() => {
    // ★ 黑名单只排「埋点/设备类」键，**不能**用 `^ND_UC_` 一刀切：
    //   真实登录凭据键正是 `ND_UC_AUTH-<uuid>&ncet-xedu&token`，前缀同为 `ND_UC_`，
    //   用 `^ND_UC_` 会把它连真凭据一起误杀 → 已登录却判成未登录。
    //   实测踩到：该键被排除后 signals 为空，无头跑批直接 process.exit(2)「未登录」。
    //   所以这里只精确排除设备键 `ND_UC_DEVICE_ID`。
    const DENY = /^_X_STAT|sajssdk|^ND_UC_DEVICE_ID|^ai_assistant|_guest|^__utm|^Hm_|_ga$/i;
    const STRONG = /token|ticket|jwt|access_?key|user_?info|passport|auth/i;

    // ★★ 登录页会「凭空」造出一个假登录信号，必须排掉（实测 2026-09）：
    //   打开 auth.smartedu.cn/uias/login 后**什么都不做**，它就已经写好了
    //   `ND_UC_AUTH-<uuid>&ncet-xedu&token`（936B，是页面的临时缓存，不是真凭据）。
    //   而按名字匹配 `auth` 的正则会把它当成「已登录」→ 程序立刻关浏览器 →
    //   用户连账号都还没输，主站的登录态从未建立 → 换个账号永远失败。
    //   判据必须落在【主站】上的【用户绑定标记】，而不是登录页的缓存键。
    const onLoginPage = /(^|\.)auth\.smartedu\.cn$/i.test(location.host)
      || /\/uias\//.test(location.pathname);

    const keys = [];
    const strongHits = [];
    const userBound = [];
    let jwtLike = null;
    // 用户绑定标记：只有真正登录主站后平台才会写（登录页没有）。
    //   ① 固定的用户态键名；② 键名里嵌着 11~12 位 userId 的键（如
    //   `X-EUD-WEB-INCENTIVES-452654053800`、`personalCenter:MyCourses-452654053800`）。
    const USER_KEY = /^X-EDU-WEB-(USER|ROLE)$/i;
    const USER_ID_IN_KEY = /(?:^|[^0-9])\d{11,12}(?:[^0-9]|$)/;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        keys.push(k);
        if (DENY.test(k)) continue;
        const v = String(localStorage.getItem(k) ?? '');
        if (STRONG.test(k)) strongHits.push(k);
        if (USER_KEY.test(k) || USER_ID_IN_KEY.test(k)) userBound.push(k);
        if (!jwtLike && /^eyJ[A-Za-z0-9_-]{10,}\./.test(v.replace(/^"|"$/g, ''))) jwtLike = k;
      }
    } catch {}

    const cookieNames = document.cookie.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean);
    const cookieHits = cookieNames.filter((k) => !DENY.test(k) && STRONG.test(k));
    // cookie 里的用户态标记（真登录才有；登录页实测没有）
    const userCookie = cookieNames.filter((k) => USER_KEY.test(k));

    // 判定：必须有【用户绑定标记】（localStorage 或 cookie）才算已登录。
    //   只有泛化的 token 类键名（会被登录页伪造）而没有任何用户绑定标记时，
    //   **且当前就在登录页** → 判为未登录，继续等用户真正输完账号。
    const boundSignals = [...userBound, ...userCookie];
    const loggedIn = boundSignals.length > 0
      || (!onLoginPage && (strongHits.length > 0 || cookieHits.length > 0 || !!jwtLike));

    const signals = [...boundSignals, ...strongHits, ...cookieHits, ...(jwtLike ? [jwtLike + '(JWT)'] : [])];
    let note = '';
    if (!loggedIn) {
      note = onLoginPage
        ? '停在登录页（未完成登录）'
        : signals.length ? '仅命中非用户绑定的键，判定为未登录' : '未命中登录标记';
    }
    return {
      keys,
      cookieNames,
      signals,
      userBound: boundSignals,
      onLoginPage,
      host: location.host,
      loggedIn,
      note,
    };
  });
}

/**
 * 清掉专用 profile 里的平台登录态。
 *
 * 用途：切换账号。不清的话，浏览器一打开就带着旧账号，而登录流程一旦看到
 * 「已登录」就会收工关窗口 —— 用户看到的就是「窗口刚弹出就消失」，换不了号。
 * cookie 决定 UC_TOKEN，localStorage 里也存着 auth 键，只清一边仍可能被判为已登录。
 * 该 profile 只服务这一个站点，所以整体清空是安全的。
 *
 * ★★ 必须清【多个 origin】，不能只清 basic.smartedu.cn（实测踩到）：
 *   localStorage 是**按域名隔离**的。平台的登录态分散在两个域上 ——
 *     · basic.smartedu.cn   主站
 *     · auth.smartedu.cn    登录页（uias）
 *   而 `--switch-account` 原来只在主站上清了一次 localStorage，登录页那个域没清到。
 *   后果：换账号时点「登录」跳到 auth.smartedu.cn，登录页读到自己域里**残留的旧登录
 *   标记**，判定「已登录」→ 立刻把你弹回首页 —— 用户看到的就是「点登录又跳回首页」，
 *   完全没法换号。清 cookie 也救不了，因为残留的是 localStorage 而不是 cookie。
 *   所以这里逐个 origin 走一遍，把各自的 localStorage/sessionStorage 都清掉。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Page} page 需要已停在平台域名下（localStorage 按 origin 隔离）
 * @param {string[]} [origins] 需要清理的域（默认覆盖主站与登录页）
 */
export async function clearSiteSession(context, page, origins = DEFAULT_CLEAR_ORIGINS) {
  // 先清 cookie（HTTP 层，与 origin 无关，一次就够）
  await context.clearCookies();

  // 再逐个 origin 清 Web Storage —— localStorage/sessionStorage 按域名隔离，
  // 只清当前页所在域是不够的（这就是「换账号被弹回首页」的根因）。
  for (const origin of origins) {
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.evaluate(() => {
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}
      });
    } catch {
      // 某个域名打不开（网络抖动/页面被关）不该让整个切换账号失败；
      // cookie 已清，且下面的主站清理由调用方保证。
    }
  }
  // 兜底：调用方传进来的 page 当前所在域再清一次（origins 可能没覆盖到）
  try {
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    });
  } catch {
    // 页面可能已经关了；cookie 清掉也足够退出登录
  }
}

/** 平台登录态所在的 origin（Web Storage 按域隔离，切换账号必须逐个清） */
export const DEFAULT_CLEAR_ORIGINS = [
  'https://basic.smartedu.cn/',
  'https://auth.smartedu.cn/',
];

// ----------------------------------------------------------------
// 瞬时可恢复的网络错误
// ----------------------------------------------------------------
// 实测记录（2026-09）：`npm run login` 曾报
//   net::ERR_CERT_COMMON_NAME_INVALID at https://basic.smartedu.cn/
// 但同一域名、同一 profile 的无头运行正常；随后用 5 组对照实验
// （有头/无头 × 默认/绕过代理/不用代理）**全部成功**，复现不出来。
// 结论：这是 Clash 类代理在切节点/重载规则期间返回错误证书导致的**瞬时**故障。
//
// 为什么必须重试而不是让它报错退出：
//   登录时失败只烦一下，但挂在 4 小时课程的中途断一次，前面的学时可能白挂。
const TRANSIENT_NET = new RegExp(
  [
    'ERR_(CERT|CONNECTION|NETWORK|PROXY|TUNNEL|SSL|EMPTY_RESPONSE|HTTP2)',
    'ERR_(NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|TIMED_OUT|INTERNET_DISCONNECTED)',
    'Timeout \\d+ms exceeded',
    'NS_ERROR_',
  ].join('|'),
  'i',
);

export function isTransientNetError(err) {
  return TRANSIENT_NET.test(String((err && err.message) || err));
}

/**
 * 带指数退避的 page.goto。
 * 只对**瞬时**网络错误重试；404/域名不存在这类确定性错误立即抛出，不浪费你 4 次超时。
 */
export async function gotoWithRetry(page, url, { attempts = 4, baseDelayMs = 1200, label = '', ...gotoOpts } = {}) {
  const opts = { waitUntil: 'domcontentloaded', timeout: 45_000, ...gotoOpts };
  let lastErr;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await page.goto(url, opts);
    } catch (err) {
      lastErr = err;
      const msg = String(err.message).split('\n')[0];
      // 非瞬时错误、或已是最后一次 → 直接抛
      if (!isTransientNetError(err) || i === attempts) {
        if (i > 1) console.warn(`  ❌ 重试 ${i - 1} 次后仍失败：${msg}`);
        throw err;
      }
      const delay = baseDelayMs * 2 ** (i - 1);
      console.warn(`  ↻ ${label || '导航'}遇到瞬时网络错误（第 ${i}/${attempts} 次）：${msg}`);
      console.warn(`     ${delay}ms 后重试（多半是代理在切节点）…`);
      await page.waitForTimeout(delay);
    }
  }
  throw lastErr;
}
