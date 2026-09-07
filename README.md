# DSH 小鲸鱼余额挂件（DeepSeek Balance Whale Widget）

![DSH 小鲸鱼余额挂件](assets/DSH2.png)

DeepSeek Harness（DSH）Web 界面右下角的常驻余额挂件：小鲸鱼气泡图 + DeepSeek API 余额 + 今日已用 + 每轮对话消耗统计，每次打开界面自动启用。本项目是标准 DSH 插件包，可通过 `dsh plugin` 安装/卸载。

## 特性

- 🐋 **常驻自启**：随 DSH Web 界面每次打开自动出现（标准 DSH bundle 插件）
- 💰 **余额**：60 秒自动刷新 + 点击鲸鱼手动刷新；余额变化时数字**滚动动画**；瞬时网络抖动自动沿用最近余额不报错
- 📊 **今日已用**：两种模式任选（见下），显示今日消耗金额
  - **小鲸鱼记账（推荐，免令牌）**：不需要任何会话令牌，鲸鱼娘每次观测余额后用余额差值自动记账（`.dshw-usage.json`，跨天自动归零归档）
  - **实时·令牌**：填入平台会话令牌后直接调用平台用量接口，按**峰谷定价**（工作日高峰 9:00–12:00 与 14:00–18:00，其余空闲；2026-08-23 起周末全天按谷价）实时换算今日已用
- 💬 **每轮对话消耗统计**：监听本机会话事件，每轮对话结束后弹出本轮消耗金额（精确 usage，非估算）
  - 菜单可开关「每轮对话后自动显示消耗金额」；「自动关闭时间」可自定义秒数（填 0 表示不自动关闭）
  - 消耗金额泡泡显示期间，余额变动不弹普通泡泡
- 🖱️ **拖拽 + 四边四分之一吸附**（左/右/上/下，角落可组合）
- 🔄 左吸附时整体**水平镜像翻转**（文字同步反向、带动画）
- 🧸 **按压 Q 弹**玩偶效果（按压时底部坐标不变）
- 🎚️ **汉堡菜单**（悬停鲸鱼右上角出现）：大小滑块（0.6–2.5 倍）、音效切换（小黄鸭 / 音效1）、音量调节、用量模式、峰谷提示文案（默认 / 梁文峰谷 / !?强强?!）、气泡开关、每轮消耗开关与自动关闭时间
- 🔊 **音效**：按压/松手音效（可选包内 mp3，缺失时静默降级）
- 💬 **随机台词**：点击气泡切换随机台词段（加权随机，含峰谷提示/今日已用/gif 动图/卖萌吐槽），再点一次关闭；气泡总显示 5 秒自动收起
- 📐 随浏览器窗口自动缩放；文字位置/字号与图片联动

- **阿里 Token Plan 用量检测**（新增）：菜单「显示」切到 `阿里 Qwen·Token Plan`，气泡直接显示本周期已用 Credits、剩余、重置倒计时；周额度用到阈值（默认 70%）自动冒泡告警：告警不自动关（点一下才算确认），确认后按级别到点再提醒（1 小时 / 30 分钟 / 15 分钟），级别升档立即再弹；只要没回到安全线，鲸鱼右上角小红点常驻
- **估算口径与按量计费报表脚本一致**：同一份按量价目 × 100 Credits，`reasoning` 并入输出、`cacheRead+cacheWrite` 并入缓存；数字旁边始终标「估算」
- **只统计套餐**：按会话事件里的 provider 路由（`tokenplan`）归属，`bailian` 上的同名 `qwen3.8-flash` 不会串进套餐账
- **0 网络 0 密钥**：用量全部来自本机 `~/.dsh/dsh-usage/usage-ledger.json` + 挂件自己的实时事件账本，不需要百炼 API Key，也不需要控制台 Cookie
- **账户列表**：菜单「显示」下是两行账户（DeepSeek / Token Plan），每行直接给出「当前值 + 累计值」，点哪行气泡就显示哪行；不再有 20s 轮换
- **自适应气泡**：三行文字按泡泡白区宽度自动等比缩放（缩到 0.62 仍放不下就让提示行折行），套餐那些长读数不会顶出框外

## 目录结构

```text
dsh-whale-widget/
├── package.json          # DSH bundle 插件元数据
├── README.md             # 本文件
├── cordis.patch.yml      # 插件挂载声明
├── lib/
│   └── index.js          # 宿主侧插件本体
├── assets/
│   ├── DSH2.png          # README 顶部展示图
│   ├── DSniang1.png      # 小鲸鱼本体（cut-out，气泡由代码绘制）
│   ├── DSniang02.png     # 备用整图（兼容旧版手动安装路径）
│   ├── rua.gif           # 随机台词 gif（可选）
│   ├── Ya1.mp3 / Ya2.mp3 # 小黄鸭音效（可选）
│   └── D1.mp3 / D2.mp3   # 音效1（可选）
└── whale-widget-prompt.md # 完整规格/维护提示词
```

## 安装

### 方式 A：直接从 GitHub 安装（推荐）

无需本地克隆，一条命令安装：

```powershell
dsh plugin --profile web add github:MeteorNOX/DeepSeek-Balance-Whale-Widget
```

说明：

- 装完后插件会出现在 DSH 的**插件管理页面**里，之后可以直接在页面里更新，无需再手动执行命令
- 网络环境需要代理时，先设置代理环境变量再执行：
  ```powershell
  $env:http_proxy="http://<ip>:<port>"; $env:https_proxy="http://<ip>:<port>"; $env:all_proxy="socks5://<ip>:<port>"; dsh plugin --profile web add github:MeteorNOX/DeepSeek-Balance-Whale-Widget
  ```
- 安装完成后重启 `dsh web`，再 F5 刷新浏览器

### 方式 B：本地安装（从当前仓库）

在**仓库根目录**（`DeepSeek-Balance-Whale-Widget`，即 `package.json` 所在目录）执行：

```powershell
dsh plugin --profile web add link:.
```

说明：

- `dsh plugin` 会把参数转发给 pnpm，并在成功后自动把 `dsh-whale-widget` 加入 `dsh.profile.bundles`
- **`link:.` 表示链接当前目录**（仓库根目录本身就是插件包）。如果你复制了仓库到别处，用绝对路径：
  ```powershell
  dsh plugin --profile web add link:D:\你的路径\DeepSeek-Balance-Whale-Widget
  ```
- ⚠️ 不要用 `link:.\dsh-whale-widget`——仓库里**没有** `dsh-whale-widget/` 子目录，这样会安装成普通依赖而非插件，重启后挂件不出现
- 安装完成后重启 `dsh web`，再 F5 刷新浏览器
- **如果之后移动了源码目录**，必须重新执行一次 `dsh plugin --profile web add link:.<新路径>`。若提示已存在/冲突，先 `dsh plugin --profile web remove dsh-whale-widget` 再重新 add

### 方式 C：发布到 npm 后安装

```powershell
dsh plugin --profile web add dsh-whale-widget
```

### 给 AI 的安装说明（用 dsh 辅助安装时，直接复制给 AI）

如果你希望让另一个 DSH / AI 助手帮你安装，把下面这段发给它即可：

```
请帮我安装插件 dsh-whale-widget，来源是 GitHub 仓库 MeteorNOX/DeepSeek-Balance-Whale-Widget。

步骤：
1. 确保 pnpm 可用（没有就先：npm install -g pnpm）
2. 在 Web profile 安装（任选一种来源）：
   首选，直接从 GitHub 安装（无需本地克隆，装完可在插件管理页面里更新）：
     dsh plugin --profile web add github:MeteorNOX/DeepSeek-Balance-Whale-Widget
   或从本地仓库链接安装（例如本地克隆的仓库根目录）：
     dsh plugin --profile web add link:.<仓库绝对路径>
   （注意：仓库根目录就是插件包，不要写成 link:.\dsh-whale-widget 这种带子目录的路径）
3. 如果报 pnpm 阻止构建脚本（allowBuilds 相关），在 C:\Users\<用户名>\.dsh\profiles\web\pnpm-workspace.yaml 的 allowBuilds 下加对应的包 key，然后重跑
4. 重启 dsh web，然后 F5 刷新浏览器

安装后验证：
- dsh --profile web --dump-config 应该能看到 dsh-whale-widget 在 bundles 里
- curl http://127.0.0.1:3080/dsh-whale/balance.json 应返回 200 JSON（含 totalBalance）
- curl http://127.0.0.1:3080/dsh-whale/widget.js 应返回 200 JS

另外请检查 DSH 凭据里是否配置了 DEEPSEEK_API_KEY（没有就提示用户配置；DEEPSEEK_PLATFORM_TOKEN 可选，不配也能用默认的记账模式）。
```

### 关于令牌（安装后必读）

> **默认不需要任何令牌。** 安装后只需配置 `DEEPSEEK_API_KEY`（拉取余额必需），「今日已用」会自动使用默认的**小鲸鱼记账**模式（余额差值本地记账），开箱即用。
>
> 「实时·令牌」模式用到的 `DEEPSEEK_PLATFORM_TOKEN`（DeepSeek 平台网页会话令牌）是**可选的**，仅在你想要更精确的实时用量换算时才需要配置。获取方式见下方「用量模式使用教程」。

## 卸载

```powershell
dsh plugin --profile web remove dsh-whale-widget
```

## 从旧手动安装升级

如果你之前按旧方式手动安装过（复制 `whale-balance.mjs` + 改 `cordis.patch.yml`），先清理：

```powershell
$web = "$env:USERPROFILE\.dsh\profiles\web"

Remove-Item "$web\whale-balance.mjs" -ErrorAction SilentlyContinue
Remove-Item "$web\whale-balance.cjs" -ErrorAction SilentlyContinue
Remove-Item "$web\DSniang1.png" -ErrorAction SilentlyContinue
Remove-Item "$web\DSniang02.png" -ErrorAction SilentlyContinue
```

然后编辑 `$web\cordis.patch.yml`，删除这段旧补丁：

```yaml
- insert:
    - id: whale-balance-widget
      name: ./whale-balance.mjs?v=1
```

如果里面只有这段，直接改成：

```yaml
[]
```

清理后再执行上面的安装命令。

## 用量模式使用教程

### 必需的凭据

- **`DEEPSEEK_API_KEY`**（必需）：DeepSeek API 密钥，用于拉取余额（`api.deepseek.com/user/balance`）。在 DSH 凭据服务中配置即可（`dsh` 的凭据管理界面 / `.dsh/.credentials.yaml`）。

### 两种用量模式

挂件的「今日已用」有两种模式，在**菜单 → 用量**中选择：

**① 小鲸鱼记账（推荐，默认）—— 完全不需要额外配置**

鲸鱼娘自己用**余额差值**记账：每次观测到余额下降就把差值累加到当天用量，跨天自动归零归档（保留 30 天）；观测币种发生变化时只重置基准、不记差值（防止多币种账户切换污染账本）。只要配好了 `DEEPSEEK_API_KEY` 就能用，**开箱即用**。

- 账本文件：`$DSH_HOME/.dshw-usage.json`（自动生成）
- 优点：零配置、免令牌
- 说明：依赖「观测到的余额下降」累计，若 DSH 关闭期间有消耗会漏记；要精确请用令牌模式

**② 实时·令牌（可选）—— 需要 `DEEPSEEK_PLATFORM_TOKEN`**

鲸鱼娘直接调用 DeepSeek 平台用量接口，按**峰谷定价**实时换算今日已用，**精确到每小时的 token 用量**。

**令牌在哪获取：**
1. 浏览器打开并登录 **https://platform.deepseek.com**
2. 按 **F12** 打开开发者工具 → 切到 **Network（网络）** 标签
3. 在平台页面点击「用量」或刷新页面，找到名为 `usage/by_api_key/amount` 的请求
4. 点开该请求 → **Request Headers（请求标头）** → 复制 `Authorization` 的值（形如 `Bearer eyJ...` 的一长串）
5. 把整段值（含 `Bearer` 前缀或只要后面的 token 部分均可）配置为 DSH 凭据 `DEEPSEEK_PLATFORM_TOKEN`：
   ```powershell
   # 在 DSH 凭据服务中设置，例如编辑 $env:USERPROFILE\.dsh\.credentials.yaml
   # DEEPSEEK_PLATFORM_TOKEN: <你复制的令牌>
   ```
6. 重启 `dsh web`，在**菜单 → 用量**里选择「实时·令牌」

**说明：**
- ⚠️ **令牌非必需**：不配置时挂件自动使用默认的「小鲸鱼记账」模式，功能不受影响
- 该令牌是 DeepSeek **平台网页的会话令牌**（不是 `sk-` 开头的 API key），仅在登录平台网页时有效；重新登录后可能需要重新获取
- 接口不返回金额，只返回 token 分桶，挂件会按内置峰谷定价表换算成金额；定价表在 `lib/index.js` 顶部 `PRICING` 常量，DeepSeek 调价时可自行修改

### 每轮对话消耗（无需任何凭据）

「每轮对话消耗统计」直接监听 DSH 本机会话事件，按模型真实 usage 换算金额（与今日已用同一套峰谷定价表），**不需要** `DEEPSEEK_PLATFORM_TOKEN`。

## 阿里 Token Plan（Qwen）用量检测

### 为什么是「估算」

阿里云**没有**给 API Key 暴露任何套餐用量接口：`token-plan.cn-beijing.maas.aliyuncs.com` 下
`/v1/usage`、`/v1/quota`、`/v1/subscription` 全部被 chat 路由兜底成
`400 InvalidParameter "Required parameter \"model\" missing"`，一次 chat 调用的响应头里也只有耗时字段、
没有任何额度信息（2026-09-05 实测）。官方 `bl usage token-plan` 走的是控制台 **Cookie** 而不是 API Key，
所以挂件套用现有「填 Key 就能看余额」的路子是做不到的 —— 只能本地估。

估算公式（价目取阿里云百炼按量单价，`Credits = 人民币 × 100`；若你另有按量报表脚本，两边价目要一起改）：

```
Credits ≈ ( 非缓存输入×输入价 + (输出+推理)×输出价 + (cacheRead+cacheWrite)×缓存价 ) / 1e6 × 100
```

价目（元/百万 token）：`qwen3.8-flash 0.8/2.7/0.1`、`qwen3.8-max 12/36/1.5`、`qwen3.7-max 12/36/2.4`、
`qwen3.7-plus 2/8/0.4`、`qwen3.6-flash 2/8/0.2`、`qwen3.6-plus 2/8/0.4`、`glm-5.2 8/28/2`、
`deepseek-v4-flash 2/12/0.2`、`deepseek-v4-pro 9/27/0.9`；表里没有的模型退回 flash 价目并记进 `unknownModels`
（宁可估高也不漏计）。实际以阿里云控制台为准。

### 数据来源与优先级

| 来源 | 路径 | 说明 |
| --- | --- | --- |
| dsh-usage 账本 | `~/.dsh/dsh-usage/usage-ledger.json` | 首选：逐日逐模型逐 provider，跨重启，含子代理流量 |
| 挂件实时账本 | `~/.dsh/.dshw-qwen.json` | 事件流现算的兜底（`dsh-usage` 没装/没落盘时也能出数） |
| 周窗口起点 | 配置 `qwenWindowAnchor`（`YYYY-MM-DD`） | 可选锚点；不填则自动退到「账本首个有量日」 |

两个来源描述的是同一批调用，所以**按天取较大值合并，绝不相加**（`mergeDays`）。
payload 里的 `source` 会告诉你是 `ledger` / `live` / `ledger+live` / `none`。

### 显示与自适应

- 菜单「显示」下的账户列表：`DeepSeek` 行显示 `¥ 余额 · 今 ¥ 今日已用`，`Token Plan` 行显示
  `已用/上限 · 累计 N Cr`（累计含历史周期），点行即选中，选中态高亮并写回配置 `display`（`ds` / `qwen`）。
- 三行气泡（标题 66 / 金额 128 / 提示 56，单位都是 `--dshw-u = 底座宽度/1026`）写完会跑一次
  `fitBubbleText()`：取三行里最宽的 `scrollWidth` 与白区可用宽度的比值写进 `--dshw-fit` 缩放，
  比值低于 0.62 改让提示行折行。缩放挂在 `.dshwv-text` 的 transform 上，左吸附翻转的分支也一起带上了。
- 读数本身也按字号收敛过长度（金额行只放 `7250 Cr`、提示行 `剩 2750 · 4天12h后重置`），
  自适应只是兜底，不靠它硬塞。

### 周窗口与告警

- 套餐是「自首次调用起 7 天一个固定周期，Standard = 10,000 Credits，5 小时限流当前暂停、过期不结转」。
- 锚点优先取配置 `qwenWindowAnchor`，否则退到「账本里第一个有量的一天」，最后才是「现在」。返回值里 `anchorSource` 会说明用的哪种，`dayIndex`（第 N/7 天）与 `resetInMs` 都由它推出。
- 阈值默认 70%（菜单「套餐告警」可改）。达到即 `warn`，`≥max(90%, 阈值+20)` 升 `high`，100% 为 `exhausted`。
  **同一周期同一级别只自动冒一次泡**（`shouldAnnounce` 由服务端现算并记账，多标签页也只弹一次），
  级别升级或换新周期会再提醒；点一下气泡即可确认关闭。
- 套餐轮次的「上一轮对话消耗」泡泡改显示 `≈ x Cr`。
- `turn/end` 的失败信号分三类处理（`classifyFailure`），**429 永远不算触顶**：
  | 分类 | 判据 | 记成 | 显示 |
  |---|---|---|---|
  | `throttle` | 429 / `Throttling.*` / `#token-limit` / rate limit / 稍后重试 | `rateLimitedAt`（15min 过期） | 橙字「限流中 · 剩 N」，不弹告警、不挂红点 |
  | `freeQuota` | `free quota` / `use free tier only` | 忽略 | 与套餐无关 |
  | `cap` | `Insufficient Balance` / 额度用尽 / 402+quota | `quotaHitAt`（6h 过期） | 估算 `pct ≥ 85%` 才确认「已触顶 · 暂停」，否则只算「额度存疑」 |
  为什么要分：套餐网关在**每分钟 token 配额（TPM）**打满时回的是
  `429 Allocated quota exceeded ... #token-limit`（`type:"insufficient_quota"`），文案里带 quota/exhausted，
  只看关键词就会把它当成周额度用尽 —— 一次限流能让 68% 的用量长期显示「已触顶 · 暂停」，
  还会把 `alert.level` 从 ok 伪造成 warn。所以额度类信号必须由估算用量二次把关。

### 接口

`GET /dsh-whale/qwen.json`（本机免鉴权，30s 汇总缓存，配置变更即时失效）：

```json
{ "ok": true, "estimated": true, "source": "ledger", "cap": 10000,
  "used": 582.3, "remaining": 9417.7, "pct": 5.8, "dayIndex": 1, "daysLeft": 7,
  "resetInMs": 518400000, "anchorSource": "first-usage-day",
  "today": { "credits": 582.34, "tokens": 24630654, "calls": 355 },
  "series": [{ "date": "2026-09-05", "credits": 1434.5, "tokens": 60210000, "calls": 900, "future": false }],
  "byModel": [{ "model": "qwen3.8-flash", "credits": 582.3, "calls": 355 }],
  "unknownModels": [],
  "payg": { "windowCny": 5.82, "planPriceCny": 139, "roiPercent": 4.2 },
  "quotaHitAt": null,
  "quotaHitSuspectAt": null,
  "rateLimitedAt": null,
  "capConfirmPct": 85,
  "alert": { "level": "ok", "label": "", "pct": 5.8, "warnPct": 70, "shouldAnnounce": false } }
```

`series` 是**本计费周期的第 1..7 天**（左→右），不是「最近 7 个自然日」：窗口不从周一开始时
后者会和 `used`/`dayIndex` 错开，柱子合计对不上面板已用（自检里钉了一条 `used == Σseries`）。
没到的日子 `future: true` 且计 0。

无账本时返回 `{"ok": false, "error": "NO_DATA", ...}` 且 HTTP 仍是 200，前端显示
「暂无套餐用量记录」，不影响 DeepSeek 余额那一套。

## 验证

```powershell
dsh --profile web --dump-config | Select-String -Pattern "whale"

curl http://127.0.0.1:3080/dsh-whale/image.png
curl http://127.0.0.1:3080/dsh-whale/balance.json
curl http://127.0.0.1:3080/dsh-whale/size.json
curl http://127.0.0.1:3080/dsh-whale/last-turn.json
```

- `/dsh-whale/image.png` → 200 `image/png`
- `/dsh-whale/balance.json` → 200，含 `{"ok":true,"totalBalance":...,"currency":"CNY","todayUsage":...}`
- `/dsh-whale/size.json` → GET 返回配置；PUT 写入
- `/dsh-whale/last-turn.json` → 200，含最近一轮对话消耗 `{seq, turn, amount, tokens}`
- 浏览器 F5 后右下角出现挂件

## 常见问题

- **挂件不出现**：确认 `dsh plugin add` 成功；`dsh --profile web --dump-config` 里能看到 `dsh-whale-widget`；重启 `dsh web` 后 F5。
- **图片不显示**：确认 `assets/DSniang1.png` 在插件包内，且没有把旧文件放在 profile 里占用了同名路由。
- **余额报「未配置 DEEPSEEK_API_KEY」**：去 DSH 配置凭据。
- **今日已用显示 --**：记账模式下需要先跑一次余额观测（60 秒内自动完成）；令牌模式需要配置 `DEEPSEEK_PLATFORM_TOKEN`。
- **每轮消耗不显示**：确认菜单「每轮对话后自动显示消耗金额」已勾选；一轮对话必须完整结束（turn/end）才会结算。
- **没有声音**：确认 `assets/*.mp3` 在包内；若不想带音效文件，静默降级为无声音。
- **本地开发改了代码不生效**：使用 `link:` 安装时，修改源码后重启 `dsh web`（ESM 模块缓存）；如果用已发布版本，需要 `npm publish` 新版本后 `dsh plugin --profile web update dsh-whale-widget`。
- **自定义图片**：气泡由代码绘制（SVG），鲸鱼本体为 cut-out PNG，放在右下角 59.45%；换图需保证透明背景 cut-out，否则按 `whale-widget-prompt.md` 调整几何参数。

## 开发与维护

完整规格、视觉参数、架构结论和生成提示词见 `whale-widget-prompt.md`。修改文字位置、颜色、动画、吸附逻辑、台词组或定价表时参考该文件。

## 许可证

本项目基于 **MIT License** 开源，详见 [LICENSE](LICENSE)。
