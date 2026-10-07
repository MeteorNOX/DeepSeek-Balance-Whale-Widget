# API 余额小鲸鱼 · Codex-v0.4(fixed)

跟随 Codex 显示 API 余额、密钥额度、已观测消费和本机 token；也可查看 Codex 订阅额度快照，或作为独立桌面挂件使用。支持角色、动图、气泡、音效、拖动缩放和本地素材工坊。

> **维护范围：仅 macOS。** Windows 相关源码与安装脚本暂时保留，便于对照上游和减少合并冲突，但本分支不再构建、测试或维护 Windows 版本，也不保证其可用性。

**For-Codex 修复发行版。** 运行构建已完成下文列出的测试；本次压缩包的隐私、解压和完整性结果以随包清单为准。

| 标识 | 当前值 |
| --- | --- |
| 对外名称 | `Codex-v0.4(fixed)` |
| 安装包 / 源码包 | `Codex-v0.4(fixed).zip` / `Codex-v0.4(fixed)-source.zip` |
| 内部程序及插件版本 | `0.4.1` |
| 构建标识 | `auto-probe-fixed-20261005` |
| 插件 ID | `api-balance-whale` |
| 发布标签 | `codex-v0.4.0(fixed)` |

用于 Codex 的 macOS 挂件：查看当前 API 余额、本机 token 和订阅额度快照；可跟随 Codex，也可独立留在桌面。

标签、对外名称与内部版本用途不同，不需要把内部版本改成带括号的字符串。此前 `codex-v0.4.0` 发布保留；本修复版属于独立 **For-Codex** 适配线，不替代 DSH 主线 Latest。

上游作者和仓库所有者：[MeteorNOX](https://github.com/MeteorNOX)。Codex 适配协作者：[Yang-huai406](https://github.com/Yang-huai406)。持续保留 [1llysviel](https://github.com/1llysviel) 的 [macOS PR #128](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/128) 实现与署名。

## 1. 安装前准备

- 支持插件的 Codex 桌面应用，以及支持 `plugin add` / `plugin list` 的 Codex CLI。安装器优先寻找桌面应用随附 CLI；旧 CLI 不支持插件时，需要更新 Codex 或指定正确路径。
- **Node.js 24 或更新版本，包含 npm。** 普通安装不需要 Python、开发测试工具或手动执行 `npm install`。
- 首次安装需要联网下载 Electron。ZIP 不包含 Electron 运行时，**不是离线 EXE**。
- Windows 使用系统自带的 `powershell.exe`，不要用 `pwsh` 执行本包 Windows 安装/回滚脚本。

打开终端检查：

```powershell
node --version
npm --version
```

Node 主版本应至少为 24。刚安装 Node 后请重新打开终端。不要为了余额显示修改 Codex 模型、API 地址或登录方式。

## 2. Windows 安装与成功检查

1. 完整解压 `Codex-v0.4(fixed).zip` 到固定目录，不要在 ZIP 内直接运行，也不要只复制一个脚本。
2. 保留旧版本及备份，双击解压目录里的 **`安装插件.cmd`**。
3. 等待安装完成。安装器检查依赖、备份旧代码和用户数据、安装桌面运行时、注册本地插件，并配置自动跟随任务。
4. 保存最后显示的 **Private rollback receipt** 路径。它指向此次安装的 `installation.json`，只保留在本机。
5. 打开 Codex；安装器应报告成功或监督器正在等待 Codex 窗口。需要聊天中加载新版技能/MCP 工具时，新建一个 Codex 聊天。
6. 打开鲸鱼菜单，进入 **设置 → API 设置**，按第 3 节检测接口，无需先填写高级 JSON。

需要包含 npm 的 Node.js 24+ 与支持插件功能的 Codex 桌面应用，桌面组件使用 Electron 44.3.0；不要从 ZIP 内直接运行安装脚本。

**Windows（遗留、不维护）**：下列脚本仅作为上游遗留代码保留，本分支不再验证、发布或提供 Windows 支持：

代码默认安装到当前用户的 `~/plugins/api-balance-whale`；个人插件市场只更新本插件条目。代码与用户数据分开存放。

希望先检查条件，在解压目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-package.ps1 -CheckOnly
```

找不到正确 CLI 时，可明确指定已有 CLI 文件；下面路径仅为占位示例：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-package.ps1 -CodexCli "C:\path\to\codex.exe" -CheckOnly
```

预检通过后，用同样参数去掉 `-CheckOnly` 执行安装。预检成功不等于安装完成。

启动后可在插件目录运行：

```powershell
node .\scripts\control.mjs status
```

核对 `version` 为 `0.4.1`、`buildRevision` 为 `auto-probe-fixed-20261005`，窗口启动后 `rendererReady` 为 `true`。安装器会核查插件已安装且启用；手动查看注册时，用安装器选中的 CLI 执行 `plugin list --json`。状态输出可能含本机路径，不要原样公开。

此前主动暂停过挂件时，安装保留暂停意图。可双击 **`启动桌面挂件.cmd`**，或执行 `node .\scripts\control.mjs open` 恢复。确实希望安装同时恢复时，安装脚本支持 `-Resume`。安装失败则保留错误和私有回执，按第 10 节核对恢复目标。

## 3. 第一次查看余额：默认自动检测

打开 API 设置，点击上方 **重新检测接口**。不需要先新建连接，也不需要知道余额 JSON 字段名。

| 检测结果 | 接下来怎么做 |
| --- | --- |
| 已识别并验证（`matched`） | 已有足够的字段、单位和范围依据。已保存配置处于自动模式时直接使用；若正在预览编辑过的草稿，仍需保存草稿后才生效。 |
| 候选（`candidate`），出现“确认并使用” | 阅读币种/单位假设及额度范围，对照服务商说明与页面。确认一致后点击按钮，保存本次协议并重载。 |
| 候选但没有确认按钮 | 例如原始 quota 缺少币种或单位元数据，不能只点确认把原始数值当钱；按第 6 节配置已知规则，或保留本地功能。 |
| 未找到（`not-found`） | 字段/类型不符合已实现协议，或服务商没有余额接口。不会当作 0，不会猜测私人接口。 |
| 鉴权失败（`auth`）或暂时失败（`retry`） | 核对密钥权限，或稍后重试。限流时遵守退避，反复点击不能绕过等待。 |

**普通兼容站示例：** 已有 Codex API 配置可正常使用时，保持“跟随 Codex 配置”，点击重新检测。原生 NewAPI 若提供可靠单位元数据，会自动把 raw quota 换成货币。兼容账单只有 `hard_limit_usd` 和 `total_usage` 时，可能显示“USD / 美分假设”候选；只有服务商实际采用这些单位时才确认。若实际使用人民币、原始 token 或其他倍率，请进入高级配置，不能盲目采用。

“预览当前接口”检查当前规则；“重新检测接口”清除识别缓存，但不会将已选的显式协议改为自动模式。需要自动探测时，先将协议选择为自动模式；预览中的修改仍须保存。自动模式下，重新检测会执行有界探测。预览会发出接口请求，但不保存草稿、不记账、不触发消费提醒。“确认并使用”才保存协议；一次性凭据绑定当前来源，五分钟过期。改变来源、再做预览或旧窗口迟到结果会使旧凭据失效，也不会顺带保存未提交的模型价格。

自动检测不保证每个中转站可用。“OpenAI-compatible”通常只说明推理请求兼容，不代表存在标准余额接口。官方 OpenAI 普通 API key 没有本插件已验证的余额查询入口，请使用官方账单页面。

## 4. 读取哪份配置，是否需要修改 Codex

通常无需改动 Codex。小鲸鱼只读取指定来源，把余额规则存到自己的数据目录：

1. `CODEX_HOME/config.toml`；未设置 `CODEX_HOME` 时使用 `~/.codex/config.toml`。
2. 若在小鲸鱼设置中填写“项目目录”，再读取该目录的 `.codex/config.toml`，按表递归合并。
3. 使用小鲸鱼明确选择的 profile，其次是运行进程中的 `CODEX_PROFILE`，再其次是文件中的 `profile`。选中的 provider 必须存在，找不到时不会退回另一服务商。
4. 从可信 provider 配置、环境变量引用或已有 API key 登录资料解析认证；ChatGPT OAuth 登录令牌不会冒充 API key。

这是**本插件当前读取范围**，并非复制 Codex 的所有配置层级。未读取到的 CLI 临时覆盖不会自动反映；“跟随”不保证等于当前聊天最终使用的连接。出现差异时，明确选择 profile/项目来源，或使用固定余额连接。

API 连接的“跟随/固定”与挂件窗口的“跟随 Codex/独立桌面”是两项设置。

| 连接方式 | 填写规则 |
| --- | --- |
| 跟随 Codex 配置 | 按 provider ID 与 profile 精确匹配命名连接；无 profile 时留空。未匹配时检测当前来源。只继承可信来源认证时可不覆盖地址。 |
| 固定连接 | 显示指定服务的余额，填写自己的 API 基准地址和专用认证，不继承其他 provider 的密钥。可只配置余额专用认证，不必另填推理 key。 |

例如 provider ID 为 `work`、profile 为 `office`，跟随连接就填写这两个原值；不要把服务商显示名称当 provider ID。专门监测另一个钱包时选固定连接。跟随连接显式填写地址时，域名与路径都要匹配；显式使用专用环境变量时也需绑定地址。

已有 URL、环境变量名和规则默认隐藏，点击 **载入规则**才展示，真实密钥不返回编辑器。旧设置中的空白表示“保留”，要清除须点击“恢复默认”再保存。项目文件不能自行授权把全局凭据发到新域名或租户路径。

## 5. 日常界面怎么用

点击角色显示气泡；打开角色旁的菜单按钮，可在顶部切换 **API 余额 / Codex 订阅**，下方分为 **概览 / 用量 / 设置**。

| 页面或操作 | 用法 |
| --- | --- |
| 概览 | 看当前连接、账户余额或密钥额度、今日已观测消耗和本轮状态；“刷新”主动更新。短标题区分账户、密钥和自定义金额，悬停可看完整说明。 |
| 用量 | API 模式看本地消费记录、历史账户、余额预警与每日预算；订阅模式看本机 token。只有有效可观测金额参与金额提醒。 |
| 设置 | 打开 API 设置管理检测/连接，调整角色、气泡、音效和显示；资源管理用于管理本地素材。 |
| 角色与气泡 | 选择角色或导入图片/动图；自定义气泡可组合文字、金额、图片等模块，素材在本机管理。 |
| 音效与手感 | 调整总音量、事件音量、音效组和按压/回弹手感。音量为 0 不播放；任务状态音与账户金额提示分开。 |
| 拖动与缩放 | 拖动角色；设置中调大小、吸附、翻转。位置会记忆，临时缩小窗口不会覆盖原位置意图。 |
| 独立桌面 | 使用显示模式或 `进入独立桌面.cmd`；恢复跟随可执行 `node .\scripts\control.mjs follow`。 |
| 本地工坊 | 从界面导入/导出角色、气泡图、音频与音效组 JSON 包。它是本地文件交换，不是在线市场；导出前检查私人内容。 |
| 汇率 | 切换 USD/CNY 显示，灰色感叹号按钮查看参考汇率、日期与缓存，必要时主动刷新。只改变显示，账本保留原币种。 |

汇率使用公开参考报价，支持缓存、北京时间每日 00:15 检查与唤醒补查，不是交易结算汇率。应先正确设置接口币种/单位，不能靠显示换算修复错误余额。DeepSeek 峰谷提示只用于符合有效规则的官方直连，不套用中转站。

不可见时从托盘选择 **恢复显示小鲸鱼**，或按 Windows `Ctrl+Alt+W` / Mac `Cmd+Option+W`。位置异常可执行 `node .\scripts\control.mjs reset-position`。Windows `Ctrl+Alt+Shift+F10` 可保存诊断现场，公开前须脱敏。退出挂件只停止观察，不取消 Codex 调用。

### API 金额、账户消费与订阅不是同一件事

- **账户可用余额**是账户资金；**密钥剩余额度**可能只是一个 key 的限额；**密钥不限额**不表示账户无限资金。
- **账户新增消耗**来自同一计量口径的有效样本，不要求模型价格；可能包含并行聊天、其他设备和延迟入账，不归属于单个对话。
- **本轮 token / 费用估算**来自本机记录及可选模型价格，不重复叠加到账户消费。失败或取消不等于免费。
- **Codex 订阅**显示 5 小时与周窗口的官方额度快照、重置时间和过期状态；没有快照时显示未观测。本机 token 不是订阅剩余额度，也不覆盖其它设备。

首个有效样本只建立基准；此后通常约每 60 秒采样，任务起止或主动刷新也会查询。换账户、协议、单位或计数器会重建基准，不把两种金额相减。提示实际呈现后才确认，重复刷新不会重报同一增量；关闭提示期间合并待显示增量。

本地账本不是完整流水：余额差分无法拆分同时发生的充值/退款与消费，回退不会冲减已累计正消费；跨日未观测区间归再次观测日。历史错误口径不靠猜测重算，以服务商账单为准。

## 6. 自动检测不适用时：配置示例

以下域名、字段和变量名均为占位示例，不能直接用于真实服务。通常在界面操作，无需手改数据文件。

### 示例 A：没有余额接口，只保留本地功能

1. 新建命名连接，选跟随模式，填写当前 provider ID/profile。
2. 余额接口选 **不查询余额**，保存。也可选固定连接并填自己的 API 地址；`none` 不需要为了余额再补密钥。
3. 显示“未提供余额接口”，保留本机 token、任务、已有历史和可选价格估算，不新增余额差分消费。

### 示例 B：独立 GET 钱包接口

假设文档说明 `GET https://billing.example.test/wallet` 返回：

```json
{"wallet":{"remaining":12.5,"spent":3.25}}
```

1. 在操作系统的当前用户环境变量中设置专用变量，例如 `WALLET_BALANCE_KEY`。**真实密钥值只在本机设置，小鲸鱼表单只填变量名。** 旧进程不会自动获得新变量；设置后重新启动挂件及启动它的进程，必要时重新登录系统。
2. 新建“我的钱包”，选固定连接，API 地址填服务自己的基准，例如 `https://api.example.test/v1`。
3. 接口选“自定义 JSON”，独立余额 URL 填上述钱包地址，请求方法 GET。
4. 鉴权选“Bearer 环境变量”，余额变量名填 `WALLET_BALANCE_KEY`；本例不用再填推理密钥。
5. 余额字段填 `wallet.remaining`，累计消耗字段填 `wallet.spent`，范围按文档选账户余额，币种 USD，两个系数均为 1。
6. 点击预览，与服务商页面对照；正确后勾选字段/币种/范围/单位确认，再保存。没有可靠累计消耗字段就留空，不捏造 0。

### 示例 C：POST、自定义认证头与参数

按示例 B 新建连接，把请求方法改为 POST，鉴权选“指定请求头与环境变量”，头名称例如 `api-key`，变量名例如 `WALLET_BALANCE_KEY`。高级规则只填写服务商要求的非敏感结构：

```json
{
  "headers": {"X-Client": "whale"},
  "envHeaders": {},
  "query": {"currency": "USD"},
  "envQuery": {},
  "body": {"wallet": "primary"},
  "unlimitedField": "",
  "unlimitedValue": true
}
```

GET 不能带 JSON 请求体。秘密参数使用 `envQuery` / `envHeaders` 把参数名映射到环境变量名，不把值写进 JSON；URL 不放查询参数或凭据。`unlimitedValue` 可明确为 `null`，但必须有该接口的不限额契约，例如相应 OpenRouter key 限额字段；不能把任意 null 都当不限额。

跨域余额请求须显式绑定专用 Bearer/请求头认证，不能继承原推理 key，也不能用额外环境参数绕过来源校验。只允许 HTTPS（本机回环可 HTTP）；拒绝重定向，请填最终接口。修改请求、认证、连接方式或单位后须重新预览确认。

### 单位与范围速查

| 协议/字段 | 正确理解 |
| --- | --- |
| NewAPI `data.object=token_usage` | `total_available` / `total_used` / `total_granted` 是原始 quota。自动模式须有可验证单位元数据，还检查安全整数及 granted=used+available。 |
| NewAPI `credit_summary` | `total_*` 同为原始 quota；`total_used=0` 是占位，不能作为累计消费计数器。 |
| 显式 NewAPI | 原始 quota 基础除数默认 500000，再乘各自系数；旧版 quota 设置可调整单位。无 object 的旧手选兼容 `total_*` 保留金额语义，不应套到原生对象上。 |
| 兼容账单 `billing` | subscription/usage 双请求；候选通常假设总额度 USD、`total_usage` 美分先除以 100，实际币种与账户/key 范围仍须核对。 |
| DeepSeek | 从明确币种的 `balance_infos` 取 `total_balance`，不能合并 CNY 与 USD。 |
| 自定义 JSON | 两字段分别乘对应系数。`account`=账户，`api-key-quota`=密钥额度，`custom`=需单独解释的自定义金额。 |

基础换算已做过时不要再除一次，例如 NewAPI 不要重复乘 `1/500000`，账单用量不要重复除以 100。填写币种代码不会执行汇率换算。

余额 URL 可为完整地址、同源绝对路径或相对路径，代理前缀要与实际部署一致。账单 URL 是**基准目录**，程序追加 subscription 和 usage，不要填某个最终 subscription 地址。高级结构见 [连接字段说明](docs/PROVIDER-CONNECTIONS-0.4.1.md)；该页记录早期模块，自动检测与 NewAPI 单位以本 README 和 [fixed 说明](docs/AUTO-PROBE-FIXED.md) 为准。

## 7. 自动检测覆盖范围

注册表有 **13 项来源记录，不是 13 个品牌，也不是每次全部请求**：

| 注册项 | 路径/作用 | 条件 |
| --- | --- | --- |
| 1 | `/api/usage/token/`，兼容无尾斜杠拼写 | OneAPI/NewAPI 原生配额，校验 raw quota 与单位。 |
| 2–3 | `/dashboard/billing/subscription` + `/dashboard/billing/usage` | 一组双请求账单。 |
| 4–5 | `/v1/dashboard/billing/subscription` + `/v1/dashboard/billing/usage` | 另一组路径拼写，不是另外两个品牌。 |
| 6 | `/api/status` | 匿名单位元数据，不是余额样本。 |
| 7 | `/api/user/self` | 需管理/控制台权限，只供显式专用配置，不盲试普通推理 key。 |
| 8 | OpenRouter `/api/v1/credits` | 账户 credits，需明确管理凭据。 |
| 9 | OpenRouter `/api/v1/key` | 当前 key 额度，不是账户总 credits。 |
| 10 | LiteLLM `/key/info` | 当前虚拟 key 预算窗口，窗口变化影响计量基准。 |
| 11–12 | SiliconFlow 中国/国际官方区域 `/v1/user/info` | 同一路径、两个地区，不跨区域转发 key。 |
| 13 | DeepSeek `/user/balance` | 带明确币种的原生余额。 |

只在已选择来源的同源候选路径内探测，保留代理前缀，不跟随响应重定向。默认单请求约 3 秒、整轮约 15 秒、最多 16 次 HTTP 请求，元数据与双请求均计数。命中计划最长缓存十分钟，单位元数据约六十秒复核；明确全部不匹配短暂缓存两分钟。临时网络、鉴权、限流和服务异常不缓存成永久不支持，重新检测也不能绕过限流退避。

来源、字段约束及管理权限见 [公开协议依据](docs/BALANCE-PROTOCOL-SOURCES.md)。支持合法自定义 HTTPS 域名，不等于能凭空推断余额接口、网页登录或私有账单。

## 8. 常见问题

| 现象 | 排查方法 |
| --- | --- |
| 一直金额口径待确认 | 重新检测；有“确认并使用”则核对假设后采用，无按钮通常缺单位/范围证据，需要文档支持的自定义规则。自动模式不是一律失效。 |
| 401/403、无权限 | 检查变量是否进入挂件进程、服务是否匹配、接口是否要求管理权限。推理可用不代表余额可用，不要把普通 key 当管理凭据试探。 |
| 429、网络失败、5xx | 等退避后重试并核对网络/服务状态；失败或未知金额不是 0。 |
| HTML 页面、字段未知、无接口 | 可能填了控制台网页而非 JSON API，或协议未支持。需要服务商接口说明；可选“不查询余额”继续本地功能。 |
| 接近一亿的巨额余额 | 部分 OneAPI/NewAPI/Veloera 用 100000000 表示不限额。fixed 不把哨兵减用量当账户资金；按协议判断，不把所有大数一律当不限额。 |
| 换 provider/profile 后 URL 或金额错误 | 核对来源与命名连接，清除或重绑旧手动覆盖。固定模式选正确连接，跟随模式精确匹配 ID/profile；不要用换币种掩盖倍率错误。 |
| 已有设置显示为空 | 私密规则默认隐藏，点击载入规则。旧字段留空保留，恢复默认才清除。 |
| 删除固定连接失败 | 先保存切到另一个连接或跟随模式，再删除旧连接。 |
| 没有消费气泡 | 首样本只建基准；核对金额有效、提示开关开启，并考虑采样/入账延迟。无需模型价格，但共享账户差额不能认定为每轮费用。 |
| 有订阅却没 API 余额 | 切换“Codex 订阅”；订阅与 API 账单独立。没有快照就等待可用记录，不把 OAuth 令牌填进 API key 字段。 |
| 挂件没出现/位置异常 | 检查 Codex 窗口、暂停状态、托盘恢复、快捷键及 reset-position；不要先删除全部数据。 |

## 9. 隐私与本地数据

数据默认在 `~/.codex/whale-widget`。`CODEX_HOME` 改变 Codex 根目录，`WHALE_HOME` 可单独指定鲸鱼数据目录；安装、启动、检查与回滚应使用同一数据位置。

余额设置保存 URL、协议和环境变量**引用**，不保存新粘贴的真实密钥；规则默认不回显。余额查询把认证发到明确配置的服务，自动探测不会发往任意域名。订阅/token 观察读取本机用量事件，不新增登录流程，也不发送聊天内容。本机 token 可能涵盖多个账号或提供商，扫描不完整时会说明。

公开包应排除用户配置、凭据、账本、会话、日志、截图录屏、回执、缓存、运行时下载和 Git 历史。`runtime.json` 含本地 IPC 令牌；`installation.json`、`package-installation.json` 与备份含私人路径或运行信息，均不应上传。截图与工坊包也须检查私人内容。

反馈只提供版本/构建、操作系统、步骤和脱敏错误类别，不要附整个数据目录、认证文件、环境变量值或原始接口响应。

## 10. 回滚：使用接收者此次安装的回执

**公开包没有维护者的私有回执，每位接收者安装时都会生成自己的回执与恢复脚本。** 多次安装后便捷入口指向最近一次；撤销特定安装时须明确使用对应回执，不能凭目录名猜。

找到安装器输出的 `installation.json` 与同一备份目录下的 `recovery-scripts/rollback-package.ps1`，先预检。下面路径仅为占位：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\backup\recovery-scripts\rollback-package.ps1" -Receipt "C:\path\to\backup\installation.json" -CheckOnly
```

核对安装时间、目标目录、数据目录和 `previousVersion`。**前后都可能为 0.4.1，还要核对备份 `plugin/package.json` 的 `codexBuild`**：之前可能是 `provider-connections-20261005`，当前为 `auto-probe-fixed-20261005`，实际以自己的备份为准。

恢复目标正确后，用完全相同的脚本与 `-Receipt` 参数去掉 `-CheckOnly` 执行。只撤销最近一次安装时，也可双击 `回滚本次安装.cmd`；如用交付目录脚本，先执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\rollback-package.ps1 -CheckOnly
```

回滚恢复旧代码和启动配置，保留回滚时最新设置、素材和账本；没有旧安装时撤回本次安装。旧程序可能不理解新连接，回滚后再核对实际来源。无有效回执时不会猜备份，不要删除账本或改写历史金额来回滚。

## 11. macOS 范围

保留 PR #128 的 Swift 窗口探针、LaunchAgent、透明浮窗与 Unix socket。本轮在 Windows x64 验证，**没有 Mac 实机验收**。

Mac 需 Codex、Node.js 24+、Xcode Command Line Tools。解压到新的固定目录并保留旧目录，运行 `安装 Mac 自动跟随.command`；丢失执行位时在该目录执行 `node scripts/install-macos.mjs`。它安装桌面组件和 LaunchAgent，**不自动完成插件市场技能/MCP 注册**。检查用 `node scripts/probe-macos.mjs` 与 `node scripts/control.mjs status`。

回滚运行 `回滚 Mac 更新.command` 或 `node scripts/rollback-macos.mjs`，使用对应 Mac 回执。暂停方式和操作详见 [macOS 文档](docs/MACOS.md)；Spaces、全屏、多屏、睡眠及长期运行仍需当地实测。

## 12. 修复范围、验证与来源

| 当前功能/修复 | 说明 |
| --- | --- |
| 配置与多提供商 | 递归合并、未知 provider 明确失败、独立余额认证和命名连接，减少 URL/key 跨来源混用。 |
| 自动检测与确认 | 可信协议直接生效，候选可确认，未知字段/单位不造金额；口径变化重建基准。 |
| 金额 UI | 区分账户、key、自定义、不限额、未确认和不支持；未知不转 0，短标题与金额留在椭圆内。 |
| 提示、输入和布局 | 保留账户消费去重、连击保护、位置记忆、气泡队列和显示恢复等 v0.4 修复。 |
| 部分修复/未完成 | #79 是共用拖动取消，不代表 Android 完成；#108 未实现共享台词池；#135 不代表 Mac 睡眠实测；#177 全局空白点击关闭未采用。 |

当前运行构建已通过 **482 项自动测试、9 项独立隐私门禁、真实 Electron 6 组流程、7 个布局样本和 8 张截图验证**，渲染错误为零。测试使用隔离合成服务，不代表全部站点、真实账号、Mac 或所有硬件实测，也不等于本轮最终 ZIP 已验收。成品范围、SHA-256、解压检查以随包 `release-manifest.json`、`verification-report.json` 为准。

- Windows 代码仅为减少上游合并冲突而保留，已经退出本分支的维护和验证范围。
- Mac 脚本目前安装桌面组件和 LaunchAgent，不自动完成 Codex 插件市场的技能/MCP 注册；相关平台流程仍待实机补充验证。

[开发历程](docs/DEVELOPMENT-FIXED.md) · [fixed 修复说明](docs/AUTO-PROBE-FIXED.md) · [功能与 issue 状态表](docs/ISSUE-STATUS-FIXED.md) · [已知限制](docs/KNOWN-ISSUES-FIXED.md) · [验收清单](docs/TEST-CHECKLIST-0.4.md) · [并行消费与连击](docs/PARALLEL-CONSUMPTION-AND-CLICKS.md)

早期专题中的构建号、测试数和发布状态只代表当时记录；当前以本 README、[fixed 发布说明](RELEASE_NOTES.md) 和本次成品清单为准。

代码与文档沿用 [MIT 许可](LICENSE)，原图片、动图和音效保持上游分发条款，不因代码许可扩大素材权利。见 [来源记录](PROVENANCE.md)、[第三方声明](THIRD_PARTY_NOTICES.md) 和 [发布准备](docs/GITHUB_PUBLISHING.md)。
