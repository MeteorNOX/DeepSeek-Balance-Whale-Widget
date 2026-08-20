# DeepSeek 余额小鲸鱼挂件 —— 完整生成提示词

> 用途：在 DeepSeek Harness（DSH）的 Web 界面右下角常驻一个「小鲸鱼余额挂件」。
> 本提示词汇总了完整需求、架构、全部行为规格、视觉参数与踩坑结论，可直接交给 AI 复现或维护。
> 文中 `C:\Users\Meteor\.dsh\profiles\web\`、`D:\TestBox\deepseek\` 等为本机示例路径，迁移时请替换为你环境中的实际路径。

---

## 一、需求总览

实现一个 DSH Web 界面右下角的余额挂件：

- 背景图是一张**预先画好**的小鲸鱼 + 白色椭圆对话气泡的本地 PNG（1026×1026），**不要重新生成鲸鱼或气泡**，只做文字叠加。
- 气泡内叠加三行文字：`DeepSeek 余额` 标签 + 余额金额 + 提示语（如「点击刷新」）。
- 余额来自 DeepSeek 官方接口 `GET https://api.deepseek.com/user/balance`，取 `balance_infos[0].total_balance` 与 `currency`，请求头 `Authorization: Bearer <key>`，key 从 DSH 凭据服务读 `DEEPSEEK_API_KEY`。
- 支持：拖拽、四分之一区域吸附（上下左右四边）、左吸附时整体水平翻转（文字同步）、悬停显示的大小调节按钮（尺寸持久化）、按压 Q 弹效果、余额数字滚动动画、60 秒自动刷新 + 点击手动刷新，并且**每次打开界面自动启用（常驻自启）**。

## 二、架构（务必先读）

动态 Cordis 插件（`cordis_define`/`cordis_run`）的定义存在进程内存中，页面重载后需要重新 run，**无法**满足「每打开界面就自动启用」。因此采用**标准 DSH bundle 插件**（npm 包 + `dsh.bundle.patch`）挂进 Web 组合：

1. **插件包**：`dsh-whale-widget/package.json` 声明 `dsh.bundle.patch`，`lib/index.js` 为宿主插件入口（ESM，`export { name, inject, apply }`）。
2. **挂载声明**：包内 `cordis.patch.yml` 自动把 `dsh-whale-widget` 插入配置树；不再需要改用户 profile 的 `cordis.patch.yml`。
3. **安装/更新**：`dsh plugin --profile web add dsh-whale-widget`；本地开发用 `dsh plugin --profile web add link:.\dsh-whale-widget`。安装后重启 `dsh web`。
4. **宿主上下文**：宿主插件运行在宿主进程（非动态沙箱），可直接使用全局 `fetch`（可带自定义请求头）、`node:fs`、`AbortSignal.timeout` 等 Node API。
5. **生命周期**：把所有 `webServer.register` / `tapIndex` 返回的 disposer 收集进数组，挂到 `ctx.effect(() => () => { for (const d of disposers) try { d() } catch {} })`，HMR 重载时自动清理。

> 兼容提示：若环境中存在旧版动态插件占用同名路由，先 `cordis_stop`/`cordis_undefine` 释放，否则注册会因路径重复抛错。

## 三、Host 侧：webServer 路由

| 路由 | 方法 | 行为 |
|---|---|---|
| `/dsh-whale/image.png` | GET | 读取插件包内 `assets/DSniang02.png`（回退旧绝对路径，内存缓存字节），`Content-Type: image/png`、`Cache-Control: public, max-age=3600`；读取失败返回 404。 |
| `/dsh-whale/balance.json` | GET | 返回余额 JSON。**任何情况下都返回 200 + JSON**（`{ok:true,...}` 或 `{ok:false, code, error, transient?}`），绝不悬挂/空响应。 |
| `/dsh-whale/size.json` | GET / PUT | 尺寸持久化：GET 返回 `{scale}` 或 `{}`；PUT 读 body `{scale}` 写盘（主路径 `$DSH_HOME/.dshw-size.json`，回退 `$DSH_HOME/profiles/web/.dshw-size.json` 与旧绝对路径），带 CORS 头。 |
| `/dsh-whale/widget.js` | GET | 返回页面挂件源码（原生 JS），`Content-Type: application/javascript; charset=utf-8`、`Cache-Control: no-store`。 |
| `tapIndex` | — | 对每次 index.html 注入 `<script defer src="/dsh-whale/widget.js"></script>`（置于 `</body>` 前，且做幂等判断 `html.indexOf('/dsh-whale/widget.js') !== -1` 则跳过）。 |

### 余额拉取（Host）的健壮性要求

- 每次调用 `ctx.credentials.resolve('DEEPSEEK_API_KEY')`（返回 `{value, source}` 或 `undefined`），未配置返回 `{ok:false, code:'NO_KEY', error:'未配置 DEEPSEEK_API_KEY'}`。
- `fetch(BALANCE_URL, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) })`。
- **重试**：网络错误/超时/5xx 重试 1 次（间隔 500ms）；4xx 不重试。
- **瞬时失败回退**：网络错误/超时/5xx 且存在缓存时，返回最近一次成功值并标记 `stale: true`（挂件继续显示旧余额，不闪错误）；4xx（如鉴权失败）不回退、`console.error` 记录。
- 25 秒内存缓存 + 进行中请求去重（in-flight promise 复用）。

## 四、页面挂件（widget.js，原生 JS）

页面上下文（无沙箱），IIFE 包裹，首行幂等守卫 `if (window.__dshWhaleWidget) return; window.__dshWhaleWidget = true`。

### DOM 结构

```
div.dshwv-root（position:fixed，承载定位与翻转）
└─ div.dshwv-body（绝对定位铺满，承载按压 Q 弹缩放）
   ├─ img.dshwv-img（src=/dsh-whale/image.png）
   ├─ div.dshwv-size（右上角两个圆形按钮 − / +，仅 hover 显示）
   └─ div.dshwv-text（三行：label / amount / hint）
```

### 定位与吸附（关键：一律用 left/top 像素定位）

- **默认位置**：CSS `right:0; bottom:0`（紧贴右下角），挂载后读取 `getBoundingClientRect` 初始化 `state.left/top`。
- **四分之一吸附**（横、纵两轴独立判定，自由组合，互不打架）：
  - 中心 x < 视口宽/4 → 吸附左缘（left:0）；中心 x > 3×视口宽/4 → 吸附右缘（left:视口宽-宽）；
  - 中心 y < 视口高/4 → 吸附顶缘（top:0）；中心 y > 3×视口高/4 → 吸附底缘（top:视口高-高）；
  - 其余保持释放点坐标；角落组合（如右下角同时吸附右+底）。
- **为什么必须用 left/top 像素**：若右吸附切换成 `left:auto; right:0`，CSS 过渡无法在 `auto` 与数值间插值，右侧吸附会瞬间跳变（闪现）；统一 left/top 则两侧都平滑滑动。
- **锚点保持**：吸附信息（`state.h` = 'left'|'right'|null、`state.v` = 'top'|'bottom'|null + 偏移 hOff/vOff）存入状态；`settle()` 在**窗口 resize** 与**尺寸按钮调整**时按锚点重算 left/top，使已吸附的挂件保持贴边（窗口变高变宽、改尺寸都不脱锚）；未锚定轴仅做视口钳制。
- 拖拽用 pointer 事件 + `setPointerCapture`；位移平方 ≥ 9（即 >3px）判定为拖动，否则为点击（点击=手动刷新）；拖拽中位置 1:1 跟手（`transition:none`），松手后 `settle()` 带动画滑向吸附位。

### 左吸附水平翻转

- 吸附到左缘时，根元素加类 `dshwv-left` → `transform: scaleX(-1)` 整体镜像；其他状态保持原方向。
- 文字块同步反向镜像（`scaleX(-1)`）保持可读，并随父级镜像自动滑到镜像后的气泡位置（44.346% → 55.654%）。
- 动画：根元素 `transition: transform .3s ease`，文字块同参数（根与文字的缩放同步过渡，翻转全程文字净缩放为正、可读且连续滑动）。
- **拖拽时保持翻转形态**：拖拽过程中不清空吸附状态（保持镜像跟随拖动），松手后按落点判定——仍在左四分之一保持翻转，否则带动画翻回；拖拽中 resize 只钳制不重算锚点。

### 按压 Q 弹（玩偶效果）

- 在 `.dshwv-body` 上做缩放：按下（pointerdown）→ `transform: scaleY(0.88) scaleX(1.05)`；松手/取消（pointerup/cancel）→ 回弹 `scaleY(1) scaleX(1)`。
- `transform-origin: 50% 100%`（底边中心）——**按压时底部坐标不变**，顶部向下压缩、两侧微鼓。
- 过渡：`transition: transform .22s cubic-bezier(.34, 1.56, .64, 1)`（带过冲，产生 Q 弹回弹感）。
- 文字、图片、按钮都在 body 内，随按压同步缩放；与左吸附翻转分层（翻转在根、按压缩放子在 body），互不干扰；大小按钮 pointerdown 已 stopPropagation，不会触发按压。

### 大小调节按钮

- 位置：body 内 `top:4px; right:4px`，两个 20px 圆形按钮「−」「+」；CSS 默认 `opacity:0`，`.dshwv-root:hover .dshwv-size` 时 `opacity:1`。
- 行为：±0.1 步进调节 `--dshw-scale`（范围 0.6–1.4），立即生效并 `PUT /dsh-whale/size.json` 持久化；调整后调用 `settle()` 保持贴边。
- 加载时先 `GET /dsh-whale/size.json` 恢复上次尺寸。

### 余额刷新与状态机

- **自动刷新**：`setInterval(refresh, 60000)`；**手动刷新**：点击挂件。
- 手动刷新：请求期间提示语显示「加载中…」（金额保持显示）。
- 自动刷新：静默（保持当前余额与「点击刷新」提示），**仅当余额实际变化**时短暂显示「加载中…」（'changing' 状态，900ms）后落定。
- 客户端 fetch 带 25 秒 AbortController 超时，避免 busy 卡死。
- 状态显示：初始加载 → 金额 `…` + `加载中…`；正常 → 金额 + `点击刷新`；错误 → 保留最近余额 + 错误信息（截断 14 字符）或 `获取失败 · 点击重试`。

### 余额数字滚动动画

- 数值变化时（手动或自动、币种不变），金额从旧值平滑滚动到新值：`requestAnimationFrame` + ease-out 三次方，时长 **700ms**。
- 首次加载（无旧值）与币种变化时直接显示，不滚动；新刷新会先取消进行中的动画。

## 五、视觉与几何参数（精确值）

| 项 | 值 |
|---|---|
| 图片 | 1026×1026 PNG（本机 466,452 字节），气泡/鲸鱼已画好 |
| 气泡 | 白色椭圆，中心像素 (455,247)，长轴 710（水平）、纵轴 430（垂直），背景 #ffffff |
| 文字块定位 | `left: 44.346%`（455/1026）、`top: 25.5%`、`transform: translate(-50%,-50%)` |
| 文字颜色 | 标签/金额 `#536ba9`；提示语 `#9fb0d9`（变淡） |
| 字号联动 | `--dshw-u: calc(var(--dshw-base) / 1026)`；标签 `calc(var(--dshw-u) * 68)`（600）；金额 `calc(var(--dshw-u) * 119)`（800，行高 1.05）；提示 `calc(var(--dshw-u) * 54)` |
| 挂件基准尺寸 | `--dshw-base: clamp(96px, calc(min(196px, min(100vw,100vh) * 0.22) * var(--dshw-scale)), 292px)`；默认 scale=1（上限 196px ≈ 原始 280px 的 0.7 倍），随视口自动缩放 |
| 金额格式 | CNY → `¥ ` + toFixed(2)；其他 → `金额 币种` |
| 吸附阈值 | 各轴中心点所在 1/4 区（<1/4 或 >3/4） |
| 点击阈值 | 位移 < 3px（平方距离 < 9） |
| 翻转动画 | 0.3s ease（根 + 文字同步） |
| 按压 Q 弹 | scaleY(0.88) scaleX(1.05)，origin 50% 100%，0.22s cubic-bezier(.34,1.56,.64,1) |
| 数字动画 | 700ms ease-out 三次方（requestAnimationFrame） |
| 自动刷新 | 60s；变化提示 900ms |
| 尺寸持久化 | `$DSH_HOME/.dshw-size.json`（回退 `$DSH_HOME/profiles/web/`），scale 0.6–1.4 步进 0.1 |
| z-index | 9999，`position: fixed` |

## 六、关键技术结论（踩坑记录，供复用）

1. **动态插件无法自启**：定义在进程内存、页面重载需重 run；要常驻自启必须静态化挂进 profile 组合。
2. **profile 补丁热更新**：`cordis.patch.yml` 被 `watchUserPatches` 实时监视，改文件即生效、无需重启；失败的补丁会让「最后一个好树」继续运行（不崩）。
3. **热更新破缓存**：插件必须用 `.mjs` + `name: ./xxx.mjs?v=N`，每次改代码把 N +1；`.cjs` 的 require 缓存忽略查询串，实测无法热更。
4. **动态沙箱限制**（如果从动态插件起步）：Host 沙箱禁用 `fetch`（`ctx.web.fetch` 又不支持自定义请求头，需 `ctx.subprocess` + curl 带 Bearer 头）；Client 沙箱同样拦截 `fetch`（网络归 Host 半边，走 `harness.handle`/`host.call`）。静态宿主插件完全没有这些限制。
5. **webServer handler 抛错**：异步 handler 抛异常会被 dispatcher 捕获并回 400 空响应——客户端会表现为「请求失败」；务必让路由永远返回 JSON（try/catch 全包）。
6. **CSS 过渡不能对 auto 插值**：定位切换 `left:auto` 会瞬间跳变，一律用 left/top 像素。
7. **tapIndex 幂等**：注入脚本标签前先检查是否已存在，且 tap 的 disposer 挂 ctx.effect，避免 HMR 后重复注入。
8. 页面无 CSP meta，注入外部 `<script src>` 可用。

## 七、部署与验证

1. 将 `dsh-whale-widget` 作为本地包安装：`dsh plugin --profile web add link:.\dsh-whale-widget`（或发布后 `dsh plugin --profile web add dsh-whale-widget`），然后重启 `dsh web`。
2. 验证：`curl http://127.0.0.1:3080/dsh-whale/image.png`（200 image/png）、`/dsh-whale/balance.json`（200 JSON，含真实余额）、`/dsh-whale/size.json`（GET/PUT 读写回路）、`/dsh-whale/widget.js`（200 JS）、`curl http://127.0.0.1:3080/`（index 含 widget.js 脚本标签）。
3. 浏览器 **F5 刷新页面**后出现挂件（tapIndex 只影响之后加载的页面）。
4. 交互自测：拖拽 + 四边四分之一吸附（含角落组合）、左吸附镜像翻转（拖拽中保持镜像、松手带动画翻回）、hover 大小按钮 + 尺寸记忆、按压 Q 弹（底部坐标不变）、点击刷新、60s 自动刷新、余额变化时数字滚动。
