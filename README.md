# DSH 小鲸鱼余额挂件（DeepSeek Balance Whale Widget）

![DSH 小鲸鱼余额挂件](assets/DSH2.png)

DeepSeek Harness（DSH）Web 界面右下角的常驻余额挂件：小鲸鱼气泡图 + DeepSeek API 余额 + 今日已用 + 每轮对话消耗统计，每次打开界面自动启用。本项目是标准 DSH 插件包，可通过 `dsh plugin` 安装/卸载。

## 特性

- 🐋 **常驻自启**：随 DSH Web 界面每次打开自动出现（标准 DSH bundle 插件）
- 💰 **余额**：自动刷新（间隔按查询次数动态安排，默认基准 60 秒）+ 点击鲸鱼手动刷新；余额变化时数字**滚动动画**；瞬时网络抖动自动沿用最近余额不报错
- 🌐 **多中转站**：一个挂件同时支持 DeepSeek 官方 / New API / Sub2API 三类账户的归属、余额/已用与订阅配额展示（菜单「显示」下拉切换，见「多中转站配置」）
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

### 方式 A：本地安装（推荐，从当前仓库）

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

### 方式 B：发布到 npm 后安装

```powershell
dsh plugin --profile web add dsh-whale-widget
```

### 给 AI 的安装说明（用 dsh 辅助安装时，直接复制给 AI）

如果你希望让另一个 DSH / AI 助手帮你安装，把下面这段发给它即可：

```
请帮我安装插件 dsh-whale-widget，来源是 GitHub 仓库 MeteorNOX/DeepSeek-Balance-Whale-Widget。

步骤：
1. 确保 pnpm 可用（没有就先：npm install -g pnpm）
2. 在 Web profile 安装：
   dsh plugin --profile web add dsh-whale-widget
   如果要从本地仓库链接安装（例如本地克隆的仓库根目录），则用：
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

## 多中转站配置（DeepSeek 官方 / New API / Sub2API）

一个挂件可以同时展示多个账户的**归属 + 余额 + 已用/订阅配额**：DeepSeek 官方、New API（one-api 谱系）、Sub2API。打开汉堡菜单里的「显示」下拉，即可在「每个账户 ×（余额 | 已用配额）」之间切换（如「New API · 余额」「Sub2API · 已用配额」），默认显示「DeepSeek 官方 · 余额」。切换即时生效并持久化，不新增任何界面。

### ⚠️ New API：「使用额度」≠「用户余额」

- **使用额度（token 接口）**：`GET {origin}/api/usage/token/`（带普通 `sk-` API key）返回的是**该 token / 端口**的配额字段 `total_granted` / `total_used` / `total_available` / `unlimited_quota`——即「配额 / 已用额度」，**不是**用户账户的钱包余额。
- **用户余额（已实现）**：真正的用户余额走 `GET {origin}/api/user/self`，请求头为
  `Authorization: Bearer <系统访问令牌>` **+** `New-Api-User: <用户ID>`；响应 `data.quota` 即用户余额（配额整数 ÷ `quota_per_unit` = 网站额度，币种按站点 `quota_display_type`），`data.used_quota` 为已使用量。

### 配置 New API 用户余额（菜单 → 设置）

New API 账户在「余额」态下显示**用户余额**（未配置时显示 `--`，提示「未配置访问令牌 · 设置」）；「已用配额」态仍显示 token 的 `total_used`。

1. 打开挂件**汉堡菜单 → 设置**按钮；
2. 在「New API 用户余额」一栏用**下拉框选择站点**（多站点不再平铺，界面不臃肿），填入**用户 ID** 与**访问令牌**并保存：
   > 前往 中转站 个人设置 → 安全设置生成系统访问令牌；用户 ID 可在个人设置页顶部查看。
3. 保存后即时生效（余额缓存自动失效重拉）。

凭据只写入 **DSH 凭据服务**（`$DSH_HOME/.credentials.yaml` 的 `refs:`，默认引用名 `NEWAPI_USER_TOKEN` / `NEWAPI_USER_ID`），**绝不**写入 `.dshw-size.json`、localStorage 或回显给浏览器。多账户同站点需要不同用户 ID 时，可在 `providers` 项里给每个账户单独指定 `userToken` / `userId` 凭据名。

设置弹窗还提供：

- **实时·令牌（可选）**：获取教程折叠在「查看获取教程」里（不占界面）；下方输入框可直接把 `DEEPSEEK_PLATFORM_TOKEN` **保存到凭据服务**（无需手工编辑 `.credentials.yaml`）。
- **接口查询次数（自适应，只读）**：显示各站点本窗口「已用 / 上限 / 剩余」与是否已学习；**自动刷新间隔按查询次数自动安排**（每周期次数 × 窗口 ÷ 上限）。无需手动设置：收到站点 429 时按 `retry-after` 自动学习该站点的真实配额并收紧上限（学到的值持久化在 `$DSH_HOME/.dshw-ratelimit.json`）。

### 货币选择（菜单 → 货币）

气泡「余额」态的金额可自选显示符号，选项固定为 **自动 / CNY / USD**（**绝不虚构汇率换算**）：

- 自动：按账户自身币种显示（官方 = CNY 优先策略结果；New API = 站点 `quota_display_type`）；
- CNY / USD：仅切换显示符号（`¥ ` / `$ ` 前缀，金额数值不变，尾部不再跟币种代码）。

「已用配额」态不受货币选择影响。

### 配置位置

- **账户列表**：直接编辑 `.dshw-size.json`（`$DSH_HOME/.dshw-size.json`，即挂件尺寸记忆文件），新增 `providers` 数组。
- **API key**：仍在 DSH 凭据服务中配置（挂件只引用凭据名，key 本身**绝不**写入配置文件、localStorage 或返回给浏览器的任何 payload）。

每个 provider 项形如：

```json
{
  "providers": [
    { "type": "deepseek" },
    { "type": "newapi", "baseUrl": "https://api.你的站点.com" },
    { "type": "sub2api", "baseUrl": "https://sub.你的站点.com", "label": "公司 Sub2API" }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `type` | 中转站类型，唯一判定依据：`deepseek` / `newapi` / `sub2api` |
| `baseUrl` | 站点地址，`newapi` / `sub2api` **必填**（`deepseek` 不需要，官方地址内置） |
| `label` | 可选显示名，默认「DeepSeek 官方 / New API / Sub2API」 |
| `credential` | 可选凭据名，缺省按类型取 `DEEPSEEK_API_KEY` / `NEWAPI_API_KEY` / `SUB2API_API_KEY` |
| `userToken` | 仅 `newapi`：用户余额访问令牌的凭据名，缺省 `NEWAPI_USER_TOKEN` |
| `userId` | 仅 `newapi`：用户 ID 的凭据名，缺省 `NEWAPI_USER_ID` |

不配置 `providers` 字段时行为与旧版完全一致（等于只配一个官方 DeepSeek 账户）。同类型多账户自动编号（`newapi`、`newapi-1`…），在「显示」下拉里按编号区分。

### 菜单只保存「显示」选择

菜单下拉保存的是 `displayProvider`（如 `newapi` 表示余额态、`newapi:usage` 表示已用配额态），**不会**通过 UI 写回 key 相关配置——`providers` 一律手工编辑文件，避免 UI 持钥。

### 不限额度 key 讲真话

- **New API**：`unlimited_quota: true` 的 key，金额行只显示「已用」，**绝不显示** `total_available`（该字段此时从 0 递减、等于负的用量，是假余额）。
- **Sub2API**：存在 `subscription` 且 `remaining === -1`（-1 = 该周期未设限额，不是欠费）时不限额，金额行显示已用，提示行显示周期限额或「不限额度」；已用取不到时显示「已用：暂不可用/不限额度」。

### 已知坑位

- **New API 路径末尾斜杠必需**：余额端点 `GET {origin}/api/usage/token/` 的末尾 `/` 必须保留——去掉会 301 并丢认证头。挂件已内置，无需手动拼路径。
- **站点查询限流（自适应）**：起点 **15 次 / 5 分钟**（实测 api.hohai.eu.org：60 次 / 20 分钟，等效 15 次 / 5 分钟，超限 429 封禁约 20 分钟）。挂件内置按 origin 计数的上游查询 gate（每请求前计数，超限直接报 `rate-limited` 不发请求）+ 失败负缓存（429 按站点 `retry-after` 封禁时长跳过）+ **自适应学习**（收到 429 时用「retry-after 窗口内实际已发请求数」自动推算该站点的可用次数并收紧上限）+ **按查询次数自动安排的自动刷新间隔**（每周期次数 × 窗口 ÷ 当前上限，夹在 15 秒 ~ 5 分钟）。
- `baseUrl` 只接受 `http/https` 且不含用户名/密码成分的合法地址；跨 origin 重定向立即中止（防止 Authorization 头外泄）。
- 请求响应体读取上限 256 KB，超限按「响应过大」报错，不解析。
- `.dshw-size.json` 必须以 **UTF-8 无 BOM** 保存（插件用 `JSON.parse(fs.readFileSync(p,'utf8'))`，BOM 会导致解析失败回退到仅官方账户）。

### 常见错误码对照

气泡提示行会显示具体原因（截断 14 字符），完整错误码在 `balance.json` 的 `accounts[].error`：

| 错误码 | 含义 | 常见处理 |
| --- | --- | --- |
| `no-credential` | 未配置对应凭据 | 在 DSH 凭据服务中配置 `NEWAPI_API_KEY` / `SUB2API_API_KEY` |
| `http-401` / `http-403` | 站点需要普通 API key | 检查 key 是否有效、权限是否足够（普通 `sk-` key 即可，无需管理员） |
| `unreachable` | 网络失败 / 站点不可达 | 检查 `baseUrl` 与网络 |
| `timeout` | 请求超时（15 秒） | 站点过慢，稍后自动重试 |
| `rate-limited` | 本站点查询频率超限（自适应上限） | 等待窗口滚动，负缓存期内自动跳过；收到站点 429 会自动收紧该站上限 |
| `upstream-<message>` | 站点 200 但信封拒绝（New API `success:false`） | 查看 `message`，常见于无效 token |
| `invalid-response` / `shape` | 响应不是合法 JSON / 结构异常 | 站点升级或换型，其它账户不受影响 |
| `cross-origin-redirect` | 跨域重定向已中止 | 站点重定向异常，检查 `baseUrl` |
| `too-large` | 响应体超过 256 KB | 站点返回异常大响应 |

用户余额（`/api/user/self`）读取失败只降级余额行（提示行显示「访问令牌无效/被拒/查询频率超限」等），token 已用配额与其它账户不受影响。

单个中转站失败**不影响**官方余额与其它账户；瞬时网络类错误沿用上次数值并标注 `stale`。

## 验证

```powershell
dsh --profile web --dump-config | Select-String -Pattern "whale"

curl http://127.0.0.1:3080/dsh-whale/image.png
curl http://127.0.0.1:3080/dsh-whale/balance.json
curl http://127.0.0.1:3080/dsh-whale/size.json
curl http://127.0.0.1:3080/dsh-whale/last-turn.json
```

- `/dsh-whale/image.png` → 200 `image/png`
- `/dsh-whale/balance.json` → 200，含 `{"ok":true,"totalBalance":...,"currency":"CNY","todayUsage":...}`；多中转站时另含 `providers`（账户摘要）、`accounts`（各账户完整数据）、`displayProvider`（当前「显示」选择）
- `/dsh-whale/size.json` → GET 返回配置（含 `providers` 与 `displayProvider`）；PUT 写入
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
