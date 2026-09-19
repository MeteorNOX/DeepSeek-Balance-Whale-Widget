---
name: api-balance-whale
description: 显示跟随 Codex 窗口的小鲸鱼，查询当前 API 余额和已观测用量，管理角色、音效、气泡和自动跟随。适用于用户提到小鲸鱼、当前 API 余额或挂件用量时；普通编码任务不需要此技能。
---

使用 `whale_open` 显示本地透明挂件，使用 `whale_balance`、`whale_usage`、`whale_status` 查询余额、账本与状态。挂件随 Codex 桌面应用自动启停，菜单中包含设置、素材和账本。没有独立网页或网页地址；不要打开浏览器面板。`desktop` 参数仅为兼容旧调用，打开操作始终显示跟随窗口的挂件。

当前任务没有加载 MCP 工具时，插件根目录为本文件上两级。用 Node.js 24+ 运行 `scripts/control.mjs` 的 `open`、`balance --refresh`、`usage`、`status` 或 `stop`。自动跟随尚未安装时，按用户意图选择平台：Windows 运行 `scripts/install-follow.ps1`，注册当前用户的计划任务 `Codex API Balance Whale`；macOS 运行 `scripts/install-macos.mjs`，优先使用 Homebrew Node/npm，编译 `desktop/macos/window-probe.swift` 并注册用户级 LaunchAgent。不要直接从 Codex 启动长期监视进程，也不要恢复旧“启动”文件夹快捷方式。Windows 用 `scripts/uninstall-follow.ps1`，macOS 用 `scripts/uninstall-macos.mjs` 停用。读查询失败时先检查计划任务或 LaunchAgent 及跟随状态，不反复创建进程。

Windows 计划任务应通过 GUI 子系统的 `WhaleLauncher-…exe` 启动监视器，启动器位于挂件数据目录的 `native` 下。macOS LaunchAgent 由 `desktop/macos/supervisor.mjs` 驱动，窗口位置来自 `CGWindowList` 探针，Electron 使用独立 bundle 标识。安装脚本负责本机编译与迁移；不要把任务操作改回直接运行 PowerShell，也不要仅靠 `-WindowStyle Hidden` 或 `FreeConsole()` 判断空终端已经消失。验收需检查实际可见窗口。

安装/回滚涉及 ScheduledTasks 时使用系统 Windows PowerShell；新版安装脚本会从 PowerShell 7 隐藏转交到正确宿主。先注册并验证任务，再停止旧监视器；未核对任务存在、真实GUI进程父链与启动状态，不得报告安装成功。不要把本轮遇到的宿主兼容性错误直接归因于安全软件。

向用户显示的所有金额保留两位小数。接口原始数值保留精度供计算。峰谷、时段倒计时和时段倍率已经移除，不要重新建议开启它们。

余额口径与安全：

- `balanceScope=api-key-quota` 表示密钥额度；密钥不限额不能解释成账户无限余额。
- 今日与历史用量是同一密钥的观测记录，按账户和币种隔离。每轮 `shared-key-interval` 可包含并行调用；`configured-pricing-estimate` 是配置价格估算。保留记录中的范围说明。
- 失败、暂停/取消仍保留已观测消耗与token，气泡只显示中性扣费提示（0.2.0 起不再有单独的趣味文案），不播放正常成功结束音；自动重试期间抑制过时状态提示。缺少可靠金额时显示待记账/金额未知，pending 30秒后只转未知，不把后续扣费再分本轮，不能宣称失败、取消或暂未入账就是免费。
- 日汇总长期保留；旧版已删除的汇总无法凭空恢复。跨午夜或停机的观测差额归入再次观测日，不能拆成精确逐请求日期。明细最多8000条，页面最近500条；不要将明细估算加到同密钥日合计上。
- 不把 ChatGPT 订阅或 Codex 限流窗口当作 API 余额，也不宣称能读取 ChatGPT 订阅对话费用。
- 密钥只由本机服务从 Codex 配置或指定环境变量读取；不要要求用户把密钥贴到聊天，不读取或输出原始 config.toml/auth.json。`whale_status` 提供足够的非敏感配置。
- 项目配置更换API域名也不能自动沿用全局密钥，新目标须在挂件设置中明确指定专用 `keyEnv`。这项防护不代表已证实发生泄露。余额响应1MiB、FX响应64KiB均有流式上限和超时。

气泡显示期间使用固定内容快照；余额和用量刷新后，下次打开或切换内容才更新。随机语在每次进入时抽取。不要用余额刷新事件重建正在显示的泡泡。

菜单“显示币种”支持 USD/CNY。`state.currency` 是 API 原币种，`WhaleMoney` 管理唯一显示偏好与汇率；不要把 API 设置里的原币种当作显示开关。汇率来自 Frankfurter，报价日期等说明收在“刷新汇率”右侧的灰色 **!** 按钮里（点击展开，0.2.0 起不再常驻），旧缓存会标示离线状态。所有金额文字共用格式化与转换，预警/预算以原币种保存，未编辑就保存不得损失精度。切币只更新绑定的文字，不重建气泡或重抽随机语。

后台每日按北京时间00:15检查汇率，启动、唤醒/联网恢复时补查，常规缓存六小时。主动刷新绕过缓存但有15秒防连点，共享在途请求；明确区分报价日期、最近检查时间、离线状态，这些说明在“刷新汇率”右侧的灰色 **!** 按钮点击后显示。00:15不是Frankfurter保证发布新报价的时间，周末和节假日可能保持同一日期；汇率请求不得携带API凭据。

Windows 工具窗口标识用于避免透明挂件遮挡 Codex 的绘制；macOS 使用透明无边框 Electron 窗口、`floating` 层级和 `LSUIElement`。不要恢复每帧强制整窗刷新，也不要启用会吞掉首次点击的 `focusable:false`。翻转保留原版 300 毫秒 ease 动画；命中检测用当前动画矩阵，拖动/缩放/吸附用未压缩的布局尺寸。

Windows 窗口位置由独立事件线程管理，`nativeFollowing` 为真时不要让低频 IPC 再设置窗口位置。macOS 由 Swift 探针通过 `CGWindowList` 轮询并回传点坐标，Electron 更新位置和尺寸；macOS 不要调用 Windows 专用 `screen.screenToDipRect`。纯移动复用现有画面，不增加整窗刷新。会话扫描在 Worker 中进行；首条 `session_meta.id` 是文件真实身份，后续继承的父元数据不能覆盖它。主轮完成提示按匹配的轮次和稳定 ID 去重；子任务只记录用量，失败、取消和历史回放不发正常完成音。`root_turn_id` 用于把子任务用量归属到主轮；共享密钥区间扣费不能与子任务区间相加。

导入按真实格式、尺寸/帧数预算验证，不接受仅扩展名或data URL声明。初始角色解码失败回退内置鲸鱼；APNG/GIF命中覆盖后续帧，超预算使用限定到图片矩形的交互回退。用户外链通过 `whaleDesktop.openExternal`，只允许真实点击触发的HTTP(S)，不允许脚本、本地文件或含凭据URL。

素材总量256MiB、每库256项，角色单文件20MiB、气泡/保存音频8MiB；图片单边4096、总像素16777216，动图最多600帧且像素乘帧数最多128000000。已有素材不自动删除。保存失败须明确报错；损坏索引保留原件并提示备份恢复，不能用空默认值覆盖。

退出有总期限；渲染器不响应时使用主进程已有状态缓存，后台未完成记账通过 `turn-journal.json` 恢复。该日志只保存白名单任务/用量/价格/采样字段，不得保存整份配置、环境、URL凭据或聊天正文。

**本轮完整审计**说明是 `docs/COMPLETE-AUDIT.md`，专用回滚为 `scripts/rollback-complete-audit.ps1` / `回滚本次完整审计修复.cmd`。它根据本机回执核对hash并先建立完整检查点，保留最新数据、修好的GUI自动启动及日汇总不裁剪保护，并非逐字节全还原。旧版暂不继续处理pending journal，日志仍保留；调用回滚前必须有用户针对回滚的授权。不能以初始备份任务缺失为由删除已修复的自动启动任务。

此前跟随、结算提示与启动修复说明见 `docs/FOLLOW-ROUND-STARTUP.md`；其专用回滚为 `scripts/rollback-follow-round-startup.ps1` / `回滚本次跟随与结算修复.cmd`，不能用来撤销本轮完整审计。

此前界面与币种修复说明是 `docs/UI-CURRENCY-RESTART-VERIFY-ROLLBACK.md`，其专用回滚为 `scripts/rollback-ui-currency.ps1` / `回滚本次界面与币种修复.cmd`，不对应本轮完整审计。

更早渲染修复的重启、验证和回滚见 `docs/RENDER-RESTART-VERIFY-ROLLBACK.md`。对应 `scripts/rollback-render.ps1` / `回滚本次渲染修复.cmd`；旧 `rollback.ps1` 对应更早的整个迁移，均不对应本轮完整审计。

无终端启动修复的专用说明是 `docs/NO-CONSOLE-STARTUP.md`，回滚入口是 `scripts/rollback-console.ps1` / `回滚本次终端修复.cmd`。它保留此前渲染修复及最新用户数据，恢复修改前的任务定义。按照用户要求的回滚范围选用入口。
