# DeepSeek 余额小鲸鱼挂件 —— 完整生成提示词

> 用途：在 DeepSeek Harness（DSH）的 Web 界面右下角常驻一个「小鲸鱼余额挂件」。
> 本提示词汇总了完整需求、架构、全部行为规格、视觉参数与踩坑结论，可直接交给 AI 复现或维护。
> 文中 `C:\Users\Meteor\.dsh\profiles\web\`、`D:\TestBox\deepseek\` 等为本机示例路径，迁移时请替换为你环境中的实际路径。
> 当前版本：v0.2.5（含今日已用双模式、峰谷定价、随机台词、音效、汉堡菜单与每轮对话消耗统计）。

---

## 一、需求总览

实现一个 DSH Web 界面右下角的余额挂件：

- 小鲸鱼 cut-out 本体（`assets/DSniang1.png`）+ **代码绘制的白色对话气泡**（SVG 椭圆 + 尾巴），气泡内叠加三行文字。
- 余额来自 DeepSeek 官方接口 `GET https://api.deepseek.com/user/balance`，取 `balance_infos[0].total_balance` 与 `currency`，请求头 `Authorization: Bearer <key>`，key 从 DSH 凭据服务读 `DEEPSEEK_API_KEY`。
- **今日已用**双模式（菜单可选）：
  - 小鲸鱼记账（默认，免令牌）：观测余额差值自动记账，持久化到 `.dshw-usage.json`，跨天归零归档。
  - 实时·令牌：读 `DEEPSEEK_PLATFORM_TOKEN`，调平台用量接口按峰谷定价换算。
- **每轮对话消耗统计**：宿主插件监听 `session/event`，捕获 `assistant/message` 的真实 usage（input/cache/output/reasoning tokens），按 `turn` 聚合；`turn/end` 时结算本轮金额（复用峰谷定价表）写入 `/dsh-whale/last-turn.json`（seq 递增）。前端每秒轮询，出现新 seq 且「每轮对话后自动显示消耗金额」开启时弹出消耗金额泡泡（居中两行：A 样式「上一轮对话消耗:」+ 红色 B 样式「¥X.XX」）；自动关闭时间可设秒数（0=不自动关闭）；消耗泡泡显示期间余额变动不弹普通泡泡。
- 支持：拖拽、四分之一区域吸附（上下左右四边）、左吸附整体水平翻转（文字同步）、汉堡菜单（大小/音效/音量/用量模式/峰谷文案/气泡开关/每轮消耗开关与自动关闭时间）、按压 Q 弹 + 音效、余额数字滚动动画、60 秒自动刷新 + 点击手动刷新、随机台词气泡（点击切换/关闭）、**每次打开界面自动启用（常驻自启）**。

## 二、架构（务必先读）

动态 Cordis 插件（`cordis_define`/`cordis_run`）的定义存在进程内存中，页面重载后需要重新 run，**无法**满足「每打开界面就自动启用」。因此采用**标准 DSH bundle 插件**（npm 包 + `dsh.bundle.patch`）挂进 Web 组合：

1. **插件包**：`dsh-whale-widget/package.json` 声明 `dsh.bundle.patch`，`lib/index.js` 为宿主插件入口（ESM）。
2. **导出形式**：`const name = 'dsh-whale-widget'; const inject = ['webServer', 'credentials']; function apply(ctx) {...}; export { name, inject, apply }`（具名导出，与 `package.json` 的 `name` 一致）。
3. **挂载声明**：包内 `cordis.patch.yml` 用 `name: dsh-whale-widget` 把插件插入配置树——**不要**用 `name: ./xxx.mjs?v=N` 形式（那是手动复制到 profile 时的热更写法，发布给他人会因路径不存在而破坏启动）。
4. **安装/更新**：`dsh plugin --profile web add dsh-whale-widget`；本地开发用 `dsh plugin --profile web add link:.<本目录>`。安装后重启 `dsh web`。
5. **可迁移路径**：`lib/index.js` 顶部用 `fileURLToPath(import.meta.url)` 推得 `PACKAGE_ROOT`，图片/音效优先 `path.join(PACKAGE_ROOT, 'assets', ...)`；尺寸/账本写 `$DSH_HOME`（`process.env.DSH_HOME || ~/.dsh`）下。本机旧绝对路径仅作 fallback，方便旧手动安装平滑升级。
6. **宿主上下文**：宿主插件运行在宿主进程（非动态沙箱），可直接使用全局 `fetch`（可带自定义请求头）、`node:fs`、`AbortSignal.timeout` 等 Node API。
7. **生命周期**：把所有 `webServer.register` / `tapIndex` 返回的 disposer 收集进数组，挂到 `ctx.effect(() => () => { for (const d of disposers) try { d() } catch {} })`，HMR 重载时自动清理。

> 兼容提示：若环境中存在旧版动态插件占用同名路由，先 `cordis_stop`/`cordis_undefine` 释放，否则注册会因路径重复抛错。

## 三、Host 侧：webServer 路由

| 路由 | 方法 | 行为 |
|---|---|---|
| `/dsh-whale/image.png` | GET | 读取插件包内 `assets/DSniang1.png`（回退本机旧绝对路径，内存缓存字节），`Content-Type: image/png`、`Cache-Control: no-store`；读取失败返回 404。 |
| `/dsh-whale/balance.json` | GET | 返回余额 JSON：`{ok:true, totalBalance, currency, updatedAt, todayUsage, isPeak, usageMode}` 或 `{ok:false, code, error, transient?}`。**任何情况下都返回 200 + JSON**，绝不悬挂/空响应。 |
| `/dsh-whale/last-turn.json` | GET | 返回最近一轮已完成的对话消耗：`{ok, seq, turn, amount, tokens, ts}`；无记录时 `turn:null`。`seq` 每次结算 +1，前端据此判断「新的一轮」。 |
| `/dsh-whale/rua.gif` | GET | 读取插件包内 `assets/rua.gif`（回退本机旧绝对路径，内存缓存），`Content-Type: image/gif`、`Cache-Control: no-store`。 |
| `/dsh-whale/size.json` | GET / PUT | 挂件配置持久化：GET 返回 `{scale, sound, vol, soundSet, usageMode, peakMode, bubbleOn, turnCostOn, turnCostCloseMs}`；PUT 读 body 写盘（优先 `$DSH_HOME/.dshw-size.json`，回退 `$DSH_HOME/profiles/web/` 与本机旧路径），带 CORS 头。`usageMode` 变化时清除余额缓存。 |
| `/dsh-whale/sound/press.mp3` | GET | 按 `?set=duck|fx1` 返回对应按压音效（`Ya1.mp3` / `D1.mp3`），每请求读盘、`no-store`。 |
| `/dsh-whale/sound/release.mp3` | GET | 同上，松手音效（`Ya2.mp3` / `D2.mp3`）。 |
| `/dsh-whale/widget.js` | GET | 返回页面挂件源码（原生 JS），`Content-Type: application/javascript; charset=utf-8`、`Cache-Control: no-store`。 |
| `tapIndex` | — | 对每次 index.html 注入 `<script defer src="/dsh-whale/widget.js"></script>`（置于 `</body>` 前，幂等判断 `html.indexOf('/dsh-whale/widget.js') !== -1` 则跳过）。 |

### 余额拉取（Host）的健壮性要求

- `fetch(BALANCE_URL, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) })`。
- **重试**：网络错误/超时/5xx 重试 1 次（间隔 500ms）；4xx 不重试。
- **瞬时失败回退**：网络错误/超时/5xx 且存在缓存时，返回最近一次成功值并标记 `stale: true`（挂件继续显示旧余额，不闪错误）；4xx 不回退、`console.error` 记录。
- 25 秒内存缓存 + 进行中请求去重（in-flight promise 复用）。

### 今日已用（两种模式）

**小鲸鱼记账（默认，usageMode='ledger'）**：
- 每次拿到余额后，把 `totalBalance` 观测记入 `.dshw-usage.json`：`{ date, lastBalance, todayUsage, history }`。
- 同一天内：若余额比上次观测**下降**，差值累加到 `todayUsage`；余额上升（充值）不扣减，只更新 `lastBalance`。
- 跨天：`todayUsage` 归档进 `history`（保留最近 30 天），当日归零，`lastBalance` 取当前余额。
- 该模式不需要 `DEEPSEEK_PLATFORM_TOKEN`，只依赖 `DEEPSEEK_API_KEY` 拉余额。

**实时·令牌（usageMode='token'）**：
- 读 `DEEPSEEK_PLATFORM_TOKEN`（平台会话令牌，非 API key），请求 `https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=<本地零点>&end=<+86400>&tz=28800`，头 `Authorization: Bearer <token>`，15 秒超时。
- 响应结构：`data.biz_data.series[]`，每项 `{model, buckets:[{time, usage:{RESPONSE_TOKEN, PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN}}]}`。**注意：接口不返回金额，只有 token 数**。
- **峰谷定价换算**：按每个小时桶的整点（北京时间 UTC+8）判定空闲/高峰，套用 `PRICING` 表（每百万 token 单价）求和：
  - 高峰时段：每日 9:00–12:00 与 14:00–18:00。
  - 单价（空闲 / 高峰）：缓存命中输入 0.05 / 0.10 元；缓存未命中输入 1.5 / 3.0 元；输出 4.5 / 9.0 元。
  - 定价表在 `lib/index.js` 顶部 `PEAK_HOURS` / `BASE_PRICE` / `PRICING` 常量，DeepSeek 调价时改这里。
- 无令牌或令牌失效时自动回落记账模式（`usageMode` 仍标记为 'ledger'）。

### 每轮对话消耗（Host，会话事件监听）

- 宿主插件 `ctx.on('session/event', ...)` 监听所有会话的追加事件流（Cordis 全局监听可收到，scope 默认向上传播）。
- 捕获 `type === 'assistant/message'` 且带 `data.usage` 的事件：`usage = { inputTokens, cacheReadTokens, outputTokens, reasoningTokens }`（模型返回的真实 token 计数，非估算）。
- 按 `data.turn` 聚合：同一 turn 的多步（step）usage 累加；成本换算复用峰谷定价表：`cacheRead→p.hit[off]`、`input→p.miss[off]`、`output+reasoning→p.out[off]`（off = 当前是否高峰）。
- `type === 'turn/end'` 时结算本轮：写 `lastTurn = { turn, amount, tokens, ts }`，`lastTurnSeq++`。
- 前端 `/dsh-whale/last-turn.json` 每秒轮询：首次拿到数据只对齐 seq（不弹旧轮次），此后 `seq` 变大即「新的一轮」→ 弹消耗金额泡泡。
- 消耗金额泡泡显示期间：`render()` / `animateAmount()` 均被 `costBubbleActive` 保护跳过（余额渲染/滚动不覆盖金额行）；余额变动也不弹普通泡泡（`showBubble()` 内 `if (costBubbleActive) return`）。
- 关闭方式：点击泡泡确认关闭，或按 `turnCostCloseMs`（秒×1000）自动关闭；填 0 表示不自动关闭。

## 四、页面挂件（widget.js，原生 JS）

页面上下文（无沙箱），IIFE 包裹，首行幂等守卫 `if (window.__dshWhaleWidget) return; window.__dshWhaleWidget = true`。

### DOM 结构

```
div.dshwv-root（position:fixed，承载定位与翻转）
├─ div.dshwv-body（绝对定位铺满，承载按压 Q 弹缩放）
│  ├─ img.dshwv-img（src=/dsh-whale/image.png，cut-out 鲸鱼，右下角 59.45%）
│  └─ div.dshwv-bubble（SVG 气泡：大椭圆 + 尾巴 + 两个小气泡，z-index:1）
│     ├─ img.dshwv-gif（随机台词 gif，默认隐藏）
│     └─ div.dshwv-text（三行：label / amount / hint，绝对定位居中）
├─ button.dshwv-menu-btn（右上角三点，悬停显示）
└─ div.dshwv-menu（汉堡菜单：大小/音效/音量/用量/峰谷/气泡开关 + 分割线 + 每轮消耗开关/自动关闭时间）
```

- 菜单挂在 `document.body` 下（`position:fixed`），打开时定位到按钮上方（右侧贴按钮右上角，左吸附镜像时贴左上角）。
- 气泡 SVG 几何（1026×700 画布）：大椭圆中心 (454,247) rx373 ry232（bbox x81..827 / y15..479）；尾巴半椭圆连接 (301,465)-(413,484) 中心 (356,472) 倾 10°；小气泡1 (352,561) rx37.5 ry26；小气泡2 (442,646) rx24.5 ry18；描边 `#203170` 宽 18，`stroke-linejoin:round`。三个图形元素分别带 class `dshwv-bshape / dshwv-b1 / dshwv-b2`，`transform-box:fill-box`。

### 定位与吸附（关键：一律用 left/top 像素定位）

- **默认位置**：右下角（读取 `getBoundingClientRect` 初始化 `state.left/top`）。
- **四分之一吸附**（横、纵两轴独立判定，自由组合，互不打架）：中心 x < 视口宽/4 → 吸附左缘；中心 x > 3×视口宽/4 → 吸附右缘；中心 y < 视口高/4 → 吸附顶缘；中心 y > 3×视口高/4 → 吸附底缘；其余保持释放点坐标。
- **为什么必须用 left/top 像素**：若右吸附切换成 `left:auto; right:0`，CSS 过渡无法在 `auto` 与数值间插值，右侧吸附会瞬间跳变（闪现）。
- **锚点保持**：吸附信息（`state.h/v` + 偏移）存入状态；`settle()` 在窗口 resize 与尺寸调整时按锚点重算，已吸附的挂件保持贴边；未锚定轴仅做视口钳制。
- **角落固定缩放**：调整大小时以鲸鱼所在角为固定点（未翻转=右下角，翻转=左下角），保证鲸鱼不"乱跑"。
- 拖拽用 pointer 事件 + `setPointerCapture`；位移平方 ≥ 9（>3px）判定拖动，否则为点击（点击鲸鱼=打开气泡+刷新）；拖拽中 `transition:none` 1:1 跟手，松手后 `settle()` 带动画滑向吸附位。

### 左吸附水平翻转

- 吸附到左缘时根元素加类 `dshwv-left` → `transform: scaleX(-1)` 整体镜像。
- 文字块同步反向镜像（`scaleX(-1)`）保持可读；数字/金额内容不变（镜像后仍可读）。
- 拖拽中保持翻转形态，松手后按落点判定是否保持。
- **关键**：文字块过渡必须**按属性拆分**——`transition: opacity .16s ease .36s, transform .3s ease`，否则开态延迟会拖累 transform 导致翻转文字滞后闪烁。

### 按压 Q 弹（玩偶效果）

- `.dshwv-body` 上做缩放：pointerdown → `scaleY(0.88) scaleX(1.05)`；pointerup/cancel → 回弹 `scaleY(1) scaleX(1)`。
- `transform-origin: 50% 100%`（底边中心）——按压时底部坐标不变。
- 过渡 `transform .22s cubic-bezier(.34,1.56,.64,1)`（带过冲回弹）。
- 音效：按下播放 press（若按住超时长按，则 release 在松手时播放；短按则 release 与 press 末尾重叠 100ms——用时长计算控制，避免同文件重复播放抢断）。

### 汉堡菜单

- 悬停鲸鱼显示右上角三点按钮；点击开/关菜单。
- 行1 大小：range 0.6–2.5（step 0.1）+ number 1–20（线性映射 1→0.6，20→2.5，默认 1.5=10）；滑块拖动期间给根元素 `transition:none`（CSS 过渡在 JS 块之后才求值，否则滑块会以错误中心缩放抖动）。
- 行2 音效：select `小黄鸭`(duck, Ya1/Ya2) / `音效1`(fx1, D1/D2)。
- 行3 音量：range 0–1；音量 0 时自动关声音。
- 行4 用量：select `小鲸鱼记账 (推荐)`(ledger) / `实时·令牌 (用法：去问dsh)`(token)。
- 所有设置 PUT `/dsh-whale/size.json` 持久化；打开页面时 GET 恢复。
- 菜单 `color-scheme:light`，保证暗色主题下可读。

### 余额刷新与状态机

- **自动刷新**：`setInterval(refresh, 60000)`；**手动刷新**：点击鲸鱼（同时打开气泡）。
- 请求期间提示行显示「加载中…」（金额保持显示）；数据到达后**淡出淡入**切换到「今日已用 …」。
- 自动刷新：静默，**仅当余额实际变化**时弹气泡 + 数字滚动（700ms ease-out 三次方）+ 300ms 后开始滚动；900ms 后落定。
- 客户端 fetch 带 25 秒 AbortController 超时。
- 状态显示：初始加载 → 金额 `…` + `加载中…`；正常 → 金额 + `今日已用 ¥X`；错误 → 保留最近余额 + 错误信息。

### 随机台词气泡（点击切换/关闭）

- 点击鲸鱼 → 气泡弹出显示正常内容（余额 + 今日已用），总时长 **5 秒**自动收起。
- **首次点击气泡** → 淡出淡入切换到随机台词段；**再次点击** → 关闭（切换不延长总时长）。
- 台词六组按权重随机（`pickRandomLines` 加权抽样）：
  1. 权重 20：三行（A 样式「当前时间段为:」/ B 样式峰谷「空闲时段」绿 或「高峰时段」红（P 档字号，比金额 B 略小）/ C 样式「今日已用 ¥X」）
  2. 权重 7：居中 B「好模型... ↓」/「好女孩...↓」
  3. 权重 7：居中 A 六句随机（不知道用户有什么用…/我也要挣钱吗/我去吃饭啦/压力一只蓝色大肥鱼/DeepSleep/用户彻底怒了），**自动换行**（`.dshwv-wrap`，max-width 560u）
  4. 权重 3：居中 A 三句随机（大烧货/token 自由/便宜货），**自动换行**
  5. 权重 1：三行「这个」(A) /「凶」(B) /「是什么意思呀...」(A)
  6. 权重 1：居中 B「哦鲸鲸... 」
- 样式档：A=label（66u 600）、B=amount（128u 800）、P=period（104u 800）、C=hint（56u 灰 #9fb0d9）；`--dshw-u = var(--dshw-base)/1026`。
- 随机段切换用**淡出淡入**（内联 opacity 过渡 190ms 出 / 220ms 入），与开合动画分离。

## 五、视觉与几何参数（精确值）

| 项 | 值 |
|---|---|
| 鲸鱼本体图 | `assets/DSniang1.png` 610×610 cut-out，右下角 `right:0;bottom:0;width:59.45%` |
| 气泡画布 | 代码内 SVG，viewBox 0 0 1026 700，几何见上文 |
| 气泡描边 | `#203170`，宽 18，圆角连接 |
| 文字块定位 | `left:44.25%; top:38%; transform:translate(-50%,-50%)`，`text-align:center`，`color:#536ba9` |
| 字号联动 | `--dshw-u: calc(var(--dshw-base) / 1026)`；A=66/600、B=128/800（行高 1.05）、P=104/800、C=56/#9fb0d9 |
| 金额格式 | CNY → `¥ ` + toFixed(2)；其他 → `金额 币种` |
| 挂件基准尺寸 | `--dshw-base: clamp(122px, calc(min(250px, min(100vw,100vh)*0.28) * var(--dshw-scale)), 625px)`；scale 0.6–2.5（菜单 1–20） |
| 吸附阈值 | 各轴中心点所在 1/4 区（<1/4 或 >3/4） |
| 点击阈值 | 位移 < 3px（平方距离 < 9） |
| 翻转动画 | 0.3s ease（根 + 文字同步，文字按属性拆分过渡） |
| 按压 Q 弹 | scaleY(0.88) scaleX(1.05)，origin 50% 100%，0.22s cubic-bezier(.34,1.56,.64,1) |
| 数字动画 | 700ms ease-out 三次方（requestAnimationFrame） |
| 自动刷新 | 60s；变化提示 900ms；气泡 5s 自动收起 |
| 配置持久化 | `$DSH_HOME/.dshw-size.json`（回退 profile 下）；账本 `$DSH_HOME/.dshw-usage.json` |
| 峰值判定 | 北京时间：高峰 9–12 与 14–18 点 |
| 音效 | press=Ya1/D1、release=Ya2/D2；按请求读盘，no-store |
| z-index | 9999，`position: fixed`；菜单 10000 |

## 六、关键技术结论（踩坑记录，供复用）

1. **动态插件无法自启**：定义在进程内存、页面重载需重 run；要常驻自启必须静态化挂进 profile 组合。
2. **发布包 patch 不用 `?v=`**：`cordis.patch.yml` 写 `name: dsh-whale-widget`（bundle 插件名）；`?v=N` 只用于手动复制到 profile 的本机热更（`.mjs` ESM 缓存需查询串破缓存），发布给他人会因路径不存在破坏启动。
3. **profile 补丁热更新**：本机开发时 `cordis.patch.yml` 被 `watchUserPatches` 实时监视，改文件即生效、无需重启。
4. **热更新破缓存**：本机插件必须用 `.mjs` + `name: ./xxx.mjs?v=N`，每次改代码 N+1；`.cjs` 的 require 缓存忽略查询串，实测无法热更。
5. **webServer handler 抛错**：异步 handler 抛异常会被 dispatcher 捕获并回 400 空响应；务必让路由永远返回 JSON（try/catch 全包）。
6. **CSS 过渡不能对 auto 插值**：定位切换一律用 left/top 像素。
7. **过渡延迟会传染所有属性**：需要"文字出现延迟但翻转立即"时必须用按属性拆分写法 `transition:opacity .16s ease .36s,transform .3s ease`。
8. **滑块抖动**：CSS 过渡在 JS 块之后求值，拖动滑块全程保持 `transition:none`。
9. **平台 usage 接口无金额**：只返回 token 分桶，必须自行按峰谷定价换算；接口不认 API key，要平台会话令牌（`DEEPSEEK_PLATFORM_TOKEN`）。
10. **记账模式误差说明**：靠"观测到的余额下降"累计，DSH 关闭期间的消耗会漏记（从下次观测的新基准开始）；精确数字只有令牌模式能给。
11. **tapIndex 幂等**：注入脚本标签前先检查是否已存在，disposer 挂 ctx.effect，避免 HMR 后重复注入。
12. **音效缓存**：音频文件每次请求读盘 + no-store，避免更换 mp3 后浏览器缓存旧字节。

## 七、部署与验证

1. 将 `dsh-whale-widget` 作为本地包安装：`dsh plugin --profile web add link:.<本目录>`（或发布后 `dsh plugin --profile web add dsh-whale-widget`），然后重启 `dsh web`。
2. 验证：`curl http://127.0.0.1:3080/dsh-whale/image.png`（200 image/png）、`/dsh-whale/balance.json`（200 JSON，含真实余额与 todayUsage）、`/dsh-whale/size.json`（GET/PUT 读写回路）、`/dsh-whale/widget.js`（200 JS）、`/dsh-whale/sound/press.mp3?set=duck`（200 audio/mpeg）、`curl http://127.0.0.1:3080/`（index 含 widget.js 脚本标签）。
3. 浏览器 **F5 刷新页面**后出现挂件。
4. 交互自测：拖拽 + 四边四分之一吸附（含角落组合）、左吸附镜像翻转、菜单（大小/音效/音量/用量）、按压 Q 弹 + 音效、点击鲸鱼弹气泡 → 首次点击切台词 → 再点关闭、5 秒自动收起、60s 自动刷新、余额变化数字滚动、记账模式跨天归档。
