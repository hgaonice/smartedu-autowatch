# 智慧教育平台 挂课侦察记录

> 状态：Phase 0 进行中 — 离线可得信息已记录，登录态下信息待脚本回填

## 1. 已确认事实（无需登录即可验证）

### 1.1 平台性质
- `https://basic.smartedu.cn/` → 200，`<title>国家中小学智慧教育平台</title>`，首页 HTML 仅 6.4KB
- 仅一个外链脚本 `/JsBridge.js` → 典型 **SPA**（Vue + fish-design 组件库），路由与内容全靠 JS 渲染
- 组件库特征类名：`fish-collapse`、`fish-btn`、`fish-modal-confirm-btns`、`tcourse-catalog`
- 构建工具特征：`index-module_footer_wewZ2`、`index-module_box_blt8G`（CSS Modules 哈希后缀）→ **平台改版会改哈希，禁止把它们写进主逻辑**

### 1.2 视频播放器
**video.js**（不是自研播放器）。证据（来自公开脚本使用的选择器）：
```text
.vjs-playback-rate                   倍速按钮
.vjs-playback-rate-value             当前倍速文本
.vjs-playback-rate .vjs-menu-content 倍速菜单
.vjs-menu-button.vjs-menu-button-popup.vjs-control.vjs-button.vjs-resolution-button   清晰度
.vjs-hidden                          倍速菜单默认被隐藏
.vjs-play-control                    播放/暂停按钮
```
推论：
- 倍速可直接 `video.playbackRate = n`，同时最好同步 UI（`.vjs-playback-rate-value`），否则 UI 与实际不一致
- **平台隐藏了倍速菜单**（`vjs-hidden`）→ 平台不允许用户自行倍速，说明倍速确实是敏感操作

### 1.3 教师研修课程页 DOM（2023–2025 版，待验证是否仍适用）
```text
<URL>  /teacherTraining/courseDetail?courseId=<uuid>
目录   .fish-collapse.fish-collapse-icon-position-right.tcourse-catalog
分组   .fish-collapse-item            （组标题 .fish-collapse-header）
资源项 .resource-item
已完成 资源项内 .iconfont 的 class 含 icon_checkbox_fill
```
- 资源项可能不是视频（可能是 PDF）→ 该条目下 `document.querySelector('video')` 为 null，需跳过

### 1.4 弹窗 / 答题
```text
选项     .nqti-option
页脚按钮 .index-module_footer_wewZ2 .fish-btn
模态按钮 .fish-modal-confirm-btns .fish-btn
填空题   .index-module_box_blt8G   → 其内第 2 个 <input>（Vue 需 _valueTracker hack 才能触发更新）
```
- 说明**存在强制作答环节**，纯挂机不处理会卡住

### 1.5 课程列表接口
```text
https://s-file-1.ykt.cbern.com.cn/teach/api_static/trains/{季节码}/train_courses.json
```
- `{季节码}` 形如 `2025sqpx`（sq=暑期 px=培训），`2025sqpx` → 200，9 门课，14KB；`2026sqpx` → 200，仅 1 条占位数据（`title: 课程1`）→ **明显是未填充的测试数据**
- 无需登录即可访问（静态 CDN）
- 字段：`train_id`、`course_id`、`title`、`summary`、`total_period`(学时)、`period`、`resource_total_count`、`study_start_time`、`study_end_time`、`max_period`、`phase_id`、`business_type=t_course`
- 用途：Phase 3 自动遍历课程的入口（拿 `course_id` 拼详情页 URL）

### 1.6 网络环境
- 本机 curl 直连 `basic.smartedu.cn` 与 `s-file-1.ykt.cbern.com.cn` 均 200（0.2–0.9s）
- 与既有配置一致：该域名走 Clash 直连、已在系统代理绕过列表

## 2. 待脚本回填（Phase 0 剩余项）

| 项目 | 为什么必须实测 | 采集方式 |
|---|---|---|
| **暂停的真正触发源** | 决定反暂停要不要拦 `visibilitychange`、`blur`、还是播放器内部逻辑 | 重写 `HTMLMediaElement.prototype.pause` 打印 `new Error().stack` |
| 心跳 / 学时上报接口 | 学时核对的唯一依据 | 全量 hook `fetch` + `XMLHttpRequest` |
| 上报是否带签名/时间戳 | 决定能不能伪造（**结论预期：能看不能造**） | 比对 body 与 header |
| 上报频率 | 决定"多久没上报算异常"的告警阈值 | 记录时间序列 |
| 当前是否仍用 `.fish-collapse` / `.resource-item` | 2026 版可能已改 | DOM 结构 dump |
| 后台是否真的被节流 | 决定要不要 CDP 启动参数兜底 | 对比 `document.hasFocus()` 与上报是否中断 |
| 是否存在人脸 / 随机身份校验 | 若有则纯挂机不可行 | 观察 + 弹窗 dump |

## 3. 平台防御栈（推理链）

```text
第 1 层  document.visibilitychange  → 主动 video.pause()
第 2 层  window.blur / onblur       → 同上
第 3 层  Chrome 后台标签页节流       → rAF 停止、timer 限 1s、5 分钟后 intensive throttle
第 4 层  防挂机心跳 setInterval(1000) → 校验 currentTime 是否推进 / 事件 isTrusted
第 5 层  隐藏倍速菜单 + 强制作答     → 抬高自动化门槛
```
**只破第 1、2 层不够**，第 3、4 层才是"学时不更新"的根因。

---

## 4. 已实测回填（自动体检，无头）

> 由 `node src/probe.mjs` / `node tools/selftest.mjs` 实际跑出，非推断。

### 4.1 Widevine —— 无头可用性结论

**结论：无头可用。** 之前"无头不支持 Widevine"的判断是**错的**，根因与浏览器头部无关：

| 启动方式 | Widevine |
|---|---|
| `channel:'chrome'`（Playwright 默认带 `--disable-component-update`） | ❌ `NotSupportedError` |
| 同上 + `ignoreDefaultArgs:['--disable-component-update']` | ✅ `com.widevine.alpha` |
| 直接指定真 Chrome 路径（仍带该参数） | ❌ |
| 真 Chrome + 去掉该参数 | ✅ |

→ `--disable-component-update` 阻止了 CDM 组件下载。修复已内置到 `src/browser.mjs`。
首次 headless 启动会下载一次 CDM 组件（几十 MB），之后再启无需下载。

另：headless 下 Chrome 的 UA 为 `HeadlessChrome/153.0.0.0`（可识别指纹），
已用 `detectChromeVersion()` 探测到的真实版本号覆盖。

### 4.2 基础能力与指纹

| 项 | 结果 |
|---|---|
| H.264 解码 | ✅ |
| H.264 + AAC（MSE 组合，HLS 实际靠它） | ✅ |
| MPEG-TS 分片 | ✅ |
| `MediaSource.isTypeSupported('application/vnd.apple.mpegurl')` | ❌ —— **这是误报**，该 MIME 只是 Safari 原生 HLS 用的，Chrome 恒为 false；hls.js 是解成 fMP4/TS 再进 MSE，拿它判断"能否放 HLS"是错的 |
| `navigator.webdriver` | ✅ 已抹除（`undefined`） |
| UA 中 `Headless` 字样 | ✅ 已移除 |
| `window.chrome` | ✅ 存在 |
| `navigator.plugins` | ✅ 5 个 |
| `visibilityState` / `hidden` | 恒为 `visible` / `false` —— 无头下平台第 1 层检测**天然不触发** |

### 4.3 登录态判定的坑

初版 `loginState()` 用宽泛正则 `/token|user|login|auth|session|ticket|account/i` 匹配 localStorage 键名，
结果把平台的**埋点键**误报成登录信号：

```text
_X_STAT_EVENT_SESSION          ← "session" 命中
_X_STAT_EVENT_SESSION_LAST_USER ← "user" + "session" 命中
sajssdk_2015_cross_new_user     ← "user" 命中
```

→ 修正：**先排黑名单**（`^_X_STAT` / `sajssdk` / `^ND_UC_` / `^ai_assistant` / `_guest`），
**再要求强信号**（键名命中 `token|ticket|jwt|auth`，或值形如 JWT `eyJ...`）。
修正后对未登录的全新 profile 正确报告 ❌ 未登录。

> 注意 `ai_assistant_intro_play_guest_2026-09-23` 里的 `guest` 是个好的负向信号，已纳入黑名单。

### 4.4 引擎注入 —— 无头自检 15/15 通过

| 断言 | 结果 |
|---|---|
| `window.__SMARTEDU_CONFIG__` 注入 | ✅ |
| `window.__SMARTEDU_AUTOWATCH__` 挂载 | ✅ |
| `document.hidden === false` / `visibilityState === 'visible'` | ✅ |
| `visibilitychange` 监听注册被拦截（派发后未触发） | ✅ |
| `window.onblur = fn` 被吞掉（读回 `null`） | ✅ |
| **`pause()` 被真正拦截**（行为验证：shadow 实例属性逼其走拦截分支，`paused_blocked` +1） | ✅ |
| `noUI` 下不渲染浮层面板 | ✅ |
| `playbackRate` 宿主覆盖透传到引擎 `CONFIG` | ✅ |
| `snapshot()` 可调用（20 字段） | ✅ |
| `navigator.webdriver` / UA 指纹 | ✅ |
| `navigator.locks` 可用（Web Lock 豁免链） | ✅ |

### 4.5 课程列表静态接口 —— 实测通过

`https://s-file-1.ykt.cbern.com.cn/teach/api_static/trains/{seasonalCode}/train_courses.json`

- **免登录可读**，无需任何鉴权
- `2025sqpx` → **9 门**课程（原始数组长度就是 9；此前写的「10 门」是笔误）
- `2026sqpx` → **1 门占位课**（`767e1d3b-0033-48f3-ba8f-53c75f56d19d`，标题就叫"课程1"）
- 字段：`course_id`、`title`、`total_period`、`train_id`

### 4.6 【已解决】2026 暑期研修的列表入口 —— 是 `trainId`，不是 `seasonalCode`

2026 起不再用季节码，改用**专题 trainId**，接口路径一模一样：

```
https://s-file-1.ykt.cbern.com.cn/teach/api_static/trains/{trainId}/train_courses.json
```

- 2026 暑期教师研修（基础教育）trainId：`dc6d78f2-bad8-4d09-b8da-0d758803dbe4`
- → **11 门课，合计 199.38 学时**（免登录可读）
- `2026sqpx` 那条路仍然只有 1 门占位课，**废掉了**

**trainId 怎么反查**（换专题时用得上）：打开任一课程页，平台自己会请求
`/teach/s_course/v2/business_courses/{courseId}/course_relative_infos/zh-CN.json`，
响应里的 `context_id` 形如 `auxo-train:<trainId>`，冒号后面就是。

已封装为 `fetchTrainCourses(trainId)` + `node src/run.mjs --train <trainId>`。

> **`harvest()` 的递归陷阱**：课程对象内部嵌着 train/library 等容器节点，
> 无脑递归会把「专题自己」也当成一门课（2026 因此多出第 12 门假课）。
> 修法：一命中 `course_id` 就 `return`，不再往里钻。

## 5. 学时模型（定论，2026 专题 11 门课逐条验证）

### 5.1 换算公式

| 量 | 含义 |
|---|---|
| `period` | 课程**视频总秒数** |
| `total_period` | 课程**总学时** |
| `max_period` | 本课**最多能计入专题的学时**；`-1` = 不限 |

**核心等式：`total_period = period / 3600`** —— 即 **1 学时 = 3600 秒视频**。

验证：`124287 / 34.52 = 3600.0`、`208249 / 57.85 = 3599.8`、`86727 / 24.09 = 3600.0`，
11 门课全部吻合到小数点后两位。

> `period_conversion_ratio: 2700` **不是**视频→学时的换算率
> （否则 208249s 该是 77 学时，而它写的是 57.85）。别被这个名字骗了。

### 5.2 增速上限 —— 为什么 2x 完全合规

专题 JSON 里：

```json
"max_period": 10.0,            // 专题要求：10 个认定学时
"period_hour_limit": 3.0,      // ★ 每【真实小时】最多认定 3 学时
"period_limit": 8100,
"period_conversion_ratio": 2700,
```

`period_hour_limit: 3.0` 是防挂机的天花板：**平台结构上允许到 3x**。

| 倍速 | 实际速率 | 是否安全 |
|---|---|---|
| 1x | 1 学时/真实小时 | 远低于额度 |
| **2x** | **2 学时/真实小时** | **占额度 2/3，安全** ✅ |
| 3x | 3 学时/真实小时 | 正好顶格，任何抖动都会掉下去 |

且平台公告原文写明「**平台为教师提供多种播放速度**」，2x 是官方功能。

### 5.3 达成路径

**目标 = 10 认定学时 = 36000 秒视频**。按 `max_period` 从大到小取：

| 次序 | 课程 | 本课上限 | 需挂视频 |
|---|---|---|---|
| 1 | 数智素养提升 | 3 | 10800s |
| 2 | 大力弘扬教育家精神 | 2 | 7200s |
| 3 | 科学素养提升 | 1 | 3600s |
| 4 | 心理健康教育能力提升 | 1 | 3600s |
| 5 | 学校美育浸润行动 | 不限（按缺口封顶） | 10800s |

合计 36000s 视频 → **2x 下约 5 小时真实时间**。

> 为什么不能用「整门挂完」策略：专题合计 199.38 学时 = 718 小时视频，
> 2x 也要 359 小时。**必须夹住预算。**

`max_period = -1` 的课（如融合教育通识课程 21.28 学时）无单独上限，
取 `min(本课上限, 离目标还差多少)` 封顶，否则会把整门 10 小时全挂完。
实现在 `src/run.mjs` 的 `courseBudgetSec`。但**预算到点 ≠ 立刻切课** —— 见 §5.6。

### 5.4 上报节奏 —— 别拿 `progress` 当实时探针

| 接口 | 频率 |
|---|---|
| `/v1/spi/trains/{tid}/courses/{cid}/progress/actions/async` | `{"frequency":600}`（10 分钟） |
| `/v3/spi/trains/{tid}/t_course/action_rules` | `{"frequency":3600}`（1 小时） |

`study_details.progress` 是**已完成活动数**，不是秒数，而且**按窗口批量刷新**。
拿它跟本地秒数比是量纲错误 —— `verify-rate.mjs` 跑 620s 只跨一个窗口，
所以看到「平台没动」是正常的。`src/run.mjs` 里那条「学时未上报」告警
原阈值 120s 已改为 1800s（跨过一整个上报窗口才值得怀疑）。

**判完成的正确姿势**：目录 `.resource-item` 的 `title` 属性
（`未开始` / `播放中` / `已完成`）—— 见 `tools/verify-rate.mjs`。

### 5.5 实测过的接口清单（明文、无签名）

`POST /v1/study_details`、`POST /v1/spi/trains/{tid}/courses/{cid}/progress/actions/async_begin`、
`.../async`、`GET /v1/study_details/{courseId}/{userId}`、
`GET/PUT /v1/resource_learning_positions/{assetId}/{userId}`、
`GET /v3/spi/trains/{tid}/t_course/action_rules`、
`GET /proxy/record_config/v1/record_configs`、`POST /v1/data_collect/xstudy_web`。

用户侧：请求里会带**个人 userId** 与 **登录 token**。两者都是个人凭据 ——
已从本文档与代码中移除，不随仓库分发。要拿到你自己的：登录后跑 `node src/probe.mjs`，
它会打印平台 user_id；token 在浏览器 localStorage 里，程序自己会读，不需要你手抄。

**教训**：不要用页面内裸 `fetch` 打这些接口 —— 同一 URL 平台自己打 200，
直接 fetch 全 403（依赖非 cookie 的自定义鉴权头）。必须**被动读平台自己的流量**
（`page.on('response')`，`tools/diag-hours.mjs` 就是这么干的）。

### 5.6 切课点必须落在【活动边界】（否则该节可能白挂）

平台按**活动粒度**判定完成（`activity_progress` 的值 `2` = 完成），所以
「学时挂够就立刻换课」会把当前这一节切在中间 —— 该节是否计入学时不可控。

**做法**：预算到点后只置一个「待切换」标志，真正的切点等**本节播完**：

| 退出条件 | 信号来源 |
|---|---|
| 本节播完 | 引擎 `activity_ended_count` 自增（`video` 的 `ended` 事件计数器） |
| 整页资源全部完成 | `s.finished`（`goNext()` 找不到下一个未完成项） |
| 兜底超时 | `OVERWATCH_MAX_SEC` = 1800s；等活动边界超了就直接切，防卡死 |
| 引擎没这个字段 | 优雅降级为立即切（旧版油猴脚本也能跑） |

**实测**（`out/test-boundary.log`，预算 0.05 学时 = 180s）：

```text
[04:11:35] 结果：target_met｜本课约 0.09 学时｜累计 0.09/0.05 学时
[04:11:35] ⚠️  已挂 0.05 学时（达总目标），等本节播完再切（当前是第 1 节）
[04:11:35] ⚠️  本节已播完（活动边界），共挂 0.09 学时
[04:11:35] ⚠️  为等活动边界多挂了 0.04 学时（已计入总账）
```

状态行会显示 `⏳学时已够，等本节播完`。代价是最多多挂一节
（`数智素养提升` 357 活动 / 208249s，平均 583s/节 ≈ 0.16 学时），换来切点落在边界。

## 6. 真实课程页实测 —— 已全部验完

下列原本标注「待实测」的项，现已逐条有实测结论：

1. ✅ **真实 `<video>` 的 `error` 是否为 `null`** —— `diag-media.mjs` 实测 **无 DRM**，
   `media.error` 为空；媒体是 HLS + MPEG-TS 分片（`.m3u8`/`.ts`，1920x1080），
   URL 含 `-1920x1080-false-`（`false` = 未加密），hls.js 转封装 TS→fMP4 喂 MSE
2. ✅ **暂停的真正触发源** —— headless 下 `paused_blocked: 0`：平台一次都没尝试暂停。
   选 `headless` 本身就是绕过 `visibilitychange`/`blur` 的最强手段
3. ✅ **学时上报接口的 URL / 频率 / 请求体 / 是否带签名** —— 见 §5.4 / §5.5，**明文无签名**
4. ✅ **真实 DOM 类名** —— `.fish-collapse.tcourse-catalog`、`.resource-item` ×21、
   `.fish-collapse-header` ×7；完成标记看 `title` 属性而非哈希类名
5. ✅ **是否存在人脸 / 随机身份校验** —— 整轮实测（620s + 11 分钟）**零弹窗、零答题**，
   未出现任何人脸或身份校验。仅有的「弹窗」是引导提示，`autoDismissModal` 已处理

> **渲染竞态**：目录不是立刻出现的 —— `[8s] 0 条 → [16s] 21 条 → [25s] 21 条`。
> 一开始「选择器全不中」就是这个原因，不是选择器写错。跳课后至少等 6s 再读快照。

> **Widevine 假警报**：`requestMediaKeySystemAccess` 报 `NotSupportedError` 的真因
> 是 Playwright 默认传 `--disable-component-update` 挡住了 CDM 组件下载，
> **与有头/无头无关**。修法：`channel:'chrome'` +
> `ignoreDefaultArgs:['--disable-component-update']`。详见 §4.1。
