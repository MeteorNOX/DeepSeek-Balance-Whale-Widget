# API 余额小鲸鱼 · Codex 自动跟随版

> 本仓库分支 **For-Codex**：把 [DSH 网页版小鲸鱼](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（`dsh-whale-widget`）改造成 **Codex 桌面应用**的伴随挂件。
> ⚠️ 与主分支用途不同：**这是 Codex 桌面插件，不能用 `dsh plugin … add` 装进 DSH 网页**；反过来，主分支的 DSH 网页插件也不能在 Codex 里运行。

版本 **0.2.4**（Codex 特化线）。基于 MeteorNOX 的 **dsh-whale-widget 0.3.0-beta** 改编。打开 Codex 桌面应用后，小鲸鱼自动出现；跟随 Codex 窗口移动和缩放，最小化时隐藏，恢复时显示，完全退出 Codex 后关闭。

**本版没有独立网页、浏览器面板或本地网页端口。** 界面由透明辅助窗口承载，通过本地进程间通信读取数据。所有菜单、设置、素材和账本都在挂件中操作。它并未修改或注入 Codex 的安装文件。

**0.2.4 变更**：汇率说明改为刷新汇率右侧的灰色 **!** 按钮，点击才展开（不再常驻面板）；失败与暂停／取消只显示中性扣费提示，不再有单独的趣味文案；显示判定加入周期重断言，最小化、还原或窗口句柄变化后可自行恢复；服务商名称不再硬编码，界面与文档不含特定服务商痕迹。详见 [0.2.4 变更说明](docs/CHANGELOG-0.2.4.md)，0.2.0 基线的历史改动见 [docs/CHANGELOG-0.2.0.md](docs/CHANGELOG-0.2.0.md)。

**安装与回滚**：另一台电脑请照 [安装与回滚说明](docs/INSTALL-AND-ROLLBACK-0.2.4.md) 操作。计划任务使用 Windows GUI 启动器；安装必须验证任务和进程，失败不会假报成功。验证过程与已知限制见 [0.2.4 验证报告](docs/VERIFICATION-0.2.4.md)。

**运行平台**：Windows 10/11 x64 的 Microsoft Store 版 Codex 安装布局，或 Apple Silicon / Intel Mac；需要 Codex 桌面应用和 Node.js 24+。macOS 默认跟随 `com.openai.codex`（本机显示为 ChatGPT/Codex），可使用 `WHALE_CODEX_BUNDLE_ID` 覆盖。其他 Windows 安装渠道尚未适配。详细步骤见 [macOS 安装说明](docs/MACOS.md)。

**安全说明**：挂件只从本机 Codex 配置或指定环境变量读取密钥；本地解析配置但不会返回或记录原始 `config.toml` / `auth.json` 内容。密钥只会发送给用户配置的 API provider；挂件还会访问公开汇率接口，不发送聊天内容。

余额跟随 Codex 当前 API 配置；密钥留在本机，界面不读取密钥。ChatGPT 订阅额度不属于 API 余额。

## 使用

- 正常打开 Codex，等待小鲸鱼出现，无需发消息或打开网页。
- 点击鲸鱼：显示余额或切换气泡；按住拖动：移动位置并记忆；移到边缘：按原设置吸附、翻转。
- 鼠标移到鲸鱼上，点击 **☰**：选择角色、大小、音效、气泡、吸附、资源管理、API 设置和用量记录。
- **Windows：Ctrl+Alt+W；macOS：Cmd+Option+W**，也可使用系统托盘菜单：隐藏/显示。托盘和鲸鱼 `☰` 菜单中的“命令”区域可刷新余额、查看用量记录、查看运行状态或停止当前挂件。
- 新建 Codex 任务后可说“打开小鲸鱼”“查看当前 API 余额”。更新前已打开的任务可能仍持有旧版工具，需新建任务。

- 切到其它应用时小鲸鱼会自动隐藏，回到 Codex 立即恢复；用 `Cmd+Option+W` 或托盘菜单显式显示后不受此限制。

**金额统一显示两位小数**，包括余额、今日/历史用量、每轮费用和气泡。后台仍保留原始精度，小额消费不会因显示取整而丢失。音频裁剪时间和 token 整数计数不属于金额。

**界面与币种修复版**：工具窗口避免透明挂件被误判为遮挡 Codex；恢复原版 300 毫秒翻转，移动与按压分别合成。菜单支持美元/人民币显示换算，余额、预警和预算同步使用同一份带日期的汇率。显示中的气泡保留金额和随机语快照；后台刷新后，下次打开或切换内容才更新。慢图片准备期间保留旧画面。技术实现见 [渲染实现](docs/RENDERING.md)。

**失败、暂停／取消与汇率**：失败或暂停／取消仍保存可观测消耗，气泡显示中性的扣费提示，不播放成功结束音；关闭对应开关后不再弹出这类气泡。不能确认的金额显示待记账/金额未知，不把后续扣费再分配给本轮。汇率按北京时间每日 **00:15** 检查，菜单提供主动刷新，费率说明在刷新汇率右侧的 **!** 按钮里；15 秒防连点，说明含报价日期、最近成功获取与最近检查时间。周末或节假日报价可能不变，断网保留并标注旧缓存。

**素材与稳定性**：导入校验格式、尺寸和动画预算，坏角色启动时回退到内置鲸鱼；APNG 后续帧可点击。外链只接受用户点击的普通 HTTP/HTTPS 地址；退出有期限，未完成用量通过安全日志保留恢复线索。

**峰谷功能已移除**：无峰谷设置、状态文字、倒计时或时段倍率。升级时移除旧气泡中的峰谷模块，保留其他文本、顺序、样式、图片、音效和账本，并保留迁移前配置副本。

## 安装、停用与回滚

Windows 需要 Node.js 24+；先运行 `安装桌面组件.cmd`，再运行 `安装自动跟随.cmd`。macOS 直接双击 `安装 Mac 自动跟随.command`，它会优先使用 Homebrew 的 Node/npm，安装 Electron 44.3.0、编译窗口探针并注册当前用户的 LaunchAgent。组件安装需联网获取 Electron。逐条步骤、验证清单与回滚命令见 [安装与回滚说明](docs/INSTALL-AND-ROLLBACK-0.2.4.md) 和 [macOS 安装说明](docs/MACOS.md)。

Windows 使用任务计划服务，macOS 使用用户级 LaunchAgent。监视器均以当前用户普通权限运行，登录后后台待命，仅在识别到当前用户的 Codex 桌面应用时启动挂件；不会把 Codex 命令行或任务后台进程当成桌面应用。Codex 退出时只关闭挂件，监视器继续待命。无需管理员权限，不保存登录密码，不调整执行策略或安全软件设置。

监视器不保留命令窗口；正常重启只需退出 Codex。计划任务名为 **Codex API Balance Whale**；异常退出会尝试恢复。停用与回滚入口：

- `停用自动跟随.cmd`：停止监视器与挂件并移除开机启动项，保留设置、素材和账本。
- `停止挂件服务.cmd` / `启动桌面挂件.cmd`：仅停止或启动当前挂件进程。
- `scripts/rollback-0.2.0.ps1 -CheckOnly -Backup <备份目录>`：核验升级前备份；去掉 `-CheckOnly` 即覆盖回插件目录（挂件仍在运行时加 `-Force`，重启后生效）。

macOS 对应入口为 `安装 Mac 自动跟随.command`、`启动桌面挂件.command`、`停止挂件服务.command`、`停用自动跟随.command`；也可运行 `npm run install:mac`、`npm run uninstall:mac`。

发布压缩包不含作者本机的备份与密钥，另一台电脑请在做任何升级前自行备份插件目录。

## 余额与用量口径

- 兼容账单接口：余额为 `hard_limit_usd - total_usage / 100`。账单总用量按接口单位换算；换算参数可配置。
- New API/One API：返回密钥额度时明确标注，密钥不限额不会显示为账户无限余额。
- 其他服务：支持同域 JSON 接口、字段和单位配置；换域名必须指定对应服务的密钥环境变量，不会把旧服务密钥发往新域名。
- 项目级 `.codex/config.toml` 也不能自动改投全局密钥；新域名须在挂件设置中明确指定专用 `keyEnv`。余额/汇率响应分别限制为 1 MiB/64 KiB。
- 没有可验证的余额接口时显示不可查询，不虚构官方 OpenAI 余额接口或订阅余额。

今日/历史金额来自同密钥累计消耗或余额差值观测，不能充当服务商正式的逐请求账单。每轮金额区分“期间扣费”和“按配置价格估算”；并行调用或延迟入账可能影响期间扣费。没有金额及价格时仅记录 token。

日汇总长期保留；旧版已删除的汇总显示未知，无法凭空补回。停机、跨午夜的观测间隔归入再次观测日。明细最多保留 8000 条，页面提供最近 500 条，不能把页面条数当作全部历史。

## 数据与维护

Windows 本机源码通常位于 `%USERPROFILE%\plugins\api-balance-whale`，挂件数据默认位于 `%USERPROFILE%\.codex\whale-widget`。macOS 本机源码通常位于 `~/plugins/api-balance-whale`，挂件数据默认位于 `~/.codex/whale-widget`。设置 `CODEX_HOME` 或 `WHALE_HOME` 时使用对应目录；插件缓存更新不会覆盖用户素材与账本。

数据目录包含角色、气泡图片、音频、设置、账本、窗口状态和自动跟随配置。`api-settings.json` 只保存接口设置和密钥环境变量名称，不保存密钥。仅处理 Codex 的用量与任务状态，不上传聊天内容。

素材限制、保存失败和损坏索引的保护见 [0.2.4 变更说明](docs/CHANGELOG-0.2.4.md) 与 [渲染实现](docs/RENDERING.md)。新导入受真实格式、尺寸/帧数及总量预算约束；已有素材不因超过新限制而被自动删除。

```powershell
node --test tests/*.test.mjs
node scripts/smoke-desktop.mjs <测试输出目录>
node tests/desktop-audit-smoke.mjs <独立专项测试输出目录>
node scripts/control.mjs status
```

上面三条测试命令需要完整源码树（含 `tests/` 与已安装的 Electron 桌面组件）；发布压缩包只包含运行所需文件，因此请在源码目录里执行。

macOS 可用以下命令检查窗口探针、监督器与余额链路：

```bash
npm run probe:mac
node scripts/control.mjs status
node scripts/control.mjs balance
```

## 仓库结构

```
.codex-plugin/plugin.json   Codex 插件清单（名称、版本、技能入口）
.mcp.json                   MCP 服务声明（无独立网页，仅本地管道）
package.json                包信息与快捷脚本
assets/                     whale-widget.js（挂件前端 bundle）+ 角色/气泡/音效素材
desktop/                    Electron 主进程、预加载、监督器、原生窗口跟随（C#）、页面脚本
desktop/macos/              macOS 窗口探针（Swift）与 LaunchAgent 监督器
runtime/                    余额与用量服务：配置解析、provider、账本、汇率、会话监视、MCP、IPC
lib/                        素材校验、资源库、widget 宿主
scripts/                    安装/启动/停止/卸载/回滚与启动器编译
skills/                     Codex 技能说明（会话内调用 whale_* 工具）
docs/                       变更说明、验证报告、安装与回滚、迁移记录、渲染实现、原版说明
vendor/smol-toml            内置 TOML 解析（BSD-3-Clause）
```

## 给维护者：本分支包含什么

**包含（可直接运行）**：`.codex-plugin/`、`assets/`、`desktop/`、`runtime/`、`lib/`、`scripts/`、`skills/`、`vendor/`、`docs/`、`LICENSE`、`PROVENANCE.md`、`THIRD_PARTY_NOTICES.md`、`package.json`、`.mcp.json`，以及 Windows `.cmd` 和 macOS `.command` 便捷入口。

**不包含**（有意排除）：

- `node_modules/`、`tests/`、`web/`、`qa-output/` 等开发与构建产物；
- 依赖作者本机备份的旧回滚脚本、历史调试文档与含本机时间戳的 `*-VALIDATION.json`——它们描述的是作者本机的升级过程，对其他人没有意义；
- 任何密钥、账号数据、用户账本：这些只存在于使用者本机的 `~/.codex/whale-widget`，仓库里没有也不需要。

## 来源与致谢

本分支改编自 **MeteorNOX** 的 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（`dsh-whale-widget`），沿用其 MIT 许可与角色/气泡/音效素材；改造范围与许可边界见 [PROVENANCE.md](PROVENANCE.md) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，原版文档备份在 [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md)。

### 0.2.4 致谢

- **[@1llysviel](https://github.com/1llysviel)**：macOS 适配（[PR #128](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/128)）——窗口探针、自动跟随与常驻恢复、Electron 浮窗、安装/卸载流程与菜单命令。
- **[@MeteorNOX](https://github.com/MeteorNOX)**：上游项目与 `dsh-whale-widget` 主线的全部基础工作。

历史贡献者名单见 [`docs/CHANGELOG-0.2.4.md`](docs/CHANGELOG-0.2.4.md)。

## 反馈与安全

- **提问 / 报 Bug**：用仓库的 [issue 模板](.github/ISSUE_TEMPLATE/)（"问题反馈"里已列出需要附上的诊断文件，多数情况不需要贴日志正文）。
- **安全漏洞**：**不要开公开 issue**，请按 [SECURITY.md](SECURITY.md) 走 GitHub 私密漏洞报告或邮件；那里也写清了本插件的安全边界（哪些算漏洞、哪些是已知设计）。
- 报告里请勿包含真实 API 密钥、`auth.json`、`config.toml` 原文或完整账本。
