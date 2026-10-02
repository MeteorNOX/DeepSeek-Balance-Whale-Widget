# API 余额小鲸鱼 v0.3.0

**Codex v0.3.0 · For-Codex 分支**

> **维护范围：仅 macOS。** Windows 相关源码与安装脚本暂时保留，便于对照上游和减少合并冲突，但本分支不再构建、测试或维护 Windows 版本，也不保证其可用性。

仓库所有者为 [MeteorNOX](https://github.com/MeteorNOX)；本分支由协作者 Yang-huai406 维护，不涉及所有权变更。macOS 长期显示稳定性及真实订阅账号仍有待持续验证，见下方限制。

Codex 适配维护：[Yang-huai406](https://github.com/Yang-huai406)。上游及 macOS 贡献者见文末致谢。

用于 Codex 的 macOS 挂件：查看当前 API 余额、本机 token 和订阅额度快照；可跟随 Codex，也可独立留在桌面。

## 界面与兼容性

本包使用 B 版“概览 / 用量 / 设置”分页，完整保留原功能。参见 [功能对照与验证](docs/DASHBOARD-B.md)。同时包含静止闪动、拖动光标和桌面/跟随切换修复，菜单顶部可切换 API 余额 / Codex 订阅模式。详见 [问题原因、修复和使用方法](docs/FEEDBACK-FIX-0.3.md)。

## 本版新增

- **模式切换**：鲸鱼菜单或托盘 →「进入桌面 / 跟随 Codex」。独立桌面模式不依赖 Codex 窗口存活。
- **音效与手感**：三种按压/回弹手感，珍珠、水泡、风铃三套原创合成短音；按下、松开、完成等事件独立音量、试听与静音。保存才生效，取消或 Esc 放弃修改。
- **本地创意工坊**：导入/导出角色、气泡图、音频片段、音效组的 JSON 包，最大 24 MiB；新 ID 避免覆盖旧资源，校验失败回滚。包不包含接口配置、凭据、账本或聊天。
- **额度与用量**：订阅登录下显示可用的 5 小时/周额度快照、重置时间和过期状态；另列本机近 7 天及滚动 5 小时已观测 token。官方额度百分比不能转换为固定 token 总配额。
- **DeepSeek 峰谷**：仅直接连接 api.deepseek.com 时展示官方高峰/谷期与下次切换。其他 API 不展示峰谷内容；中转服务不套用官方计价规则。
- **显示恢复**：显式恢复显示、渲染器失败的有限恢复、缺失角色的本地占位图；窗口尺寸与原生坐标更新分离，避免旧坐标写回；普通前台切换不反复隐藏/显示。

## macOS 兼容来源——后续维护必须保留

原始 PR：[MeteorNOX/DeepSeek-Balance-Whale-Widget #128](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/128)，作者 [1llysviel](https://github.com/1llysviel)。保留窗口探针、LaunchAgent、macOS 透明浮窗、Unix socket、首次点击及 Cmd+Option+W；Windows 分支独立。不能用旧 0.2.4 整包覆盖 fixed 修复。具体来源和限制见 [实施与来源](docs/V0.3-PLAN-AND-PROVENANCE.md)。

## 安装

下载 `api-balance-whale-v0.3.0.zip` 并完整解压。附带 SHA-256 用于校验；源码和 GitHub 文档在 `api-balance-whale-v0.3.0-source.zip`。这不是预装运行时的离线 EXE，首次安装需联网下载 Electron。

需要包含 npm 的 Node.js 24+ 与支持插件功能的 Codex 桌面应用，桌面组件使用 Electron 44.3.0；不要从 ZIP 内直接运行安装脚本。

**Windows（遗留、不维护）**：下列脚本仅作为上游遗留代码保留，本分支不再验证、发布或提供 Windows 支持：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-package.ps1 -CheckOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-package.ps1
```

安装器检查本地插件市场，备份现有插件与数据，注册插件并启动跟随服务。未通过验证不报告安装成功。安装完成后新建 Codex 聊天以加载新版工具。此前主动暂停过挂件时，可主动打开后重试；命令行安装也可明确传入 `-Resume` 恢复启动。

**macOS**：使用独立的新版本目录，保留旧目录；运行 `安装 Mac 自动跟随.command`。需要 Xcode Command Line Tools 提供 Swift 编译器。安装前保存旧 LaunchAgent、配置与探针；详情见 [macOS 说明](docs/MACOS.md)。本 Windows 主机未验证 Mac 实机运行。

## 使用与验证

1. 正常打开 Codex，鲸鱼应出现。移动、缩放、最小化并恢复窗口，再切换其他应用，观察是否有跳位或消失。
2. 设置 → 声音与气泡 →「音效与手感」：选择手感、试听、把音量调到 0 并保存；重开面板确认。取消不应留下修改。
3. 设置 → 外观与位置 →「进入桌面」后最小化 Codex，挂件仍应显示；切回「跟随 Codex」恢复原行为。
4. 菜单顶部选择「Codex 订阅」，点击角色或「查看订阅额度 →」：API 登录下不应冒用旧订阅额度；订阅登录有新快照后才显示窗口。数据过期、未观测或扫描不完整有明确提示。
5. 工坊导出后导入，素材列表应新增条目，旧资源不被替换。导入后按按钮重新加载素材列表。
6. 失去显示时，托盘 →「恢复显示小鲸鱼」，或 Windows Ctrl+Alt+W / Mac Cmd+Option+W。退出挂件不会取消 Codex 正在进行的任务。

测试与限制见 [验证记录](docs/VERIFICATION-0.3.md)。

## 回滚

Windows 运行 `回滚本次安装.cmd`，或先检查再回滚：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\rollback-package.ps1 -CheckOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\rollback-package.ps1
```

回滚读取本次安装的私有回执，恢复旧代码及启动任务，保留最新设置、素材和账本；操作前还会保存当前状态。无有效回执时不会猜测备份位置。

macOS 运行 `回滚 Mac 更新.command`（如该平台包提供），或 `node scripts/rollback-macos.mjs`；保留旧版本目录，回滚读取安装回执恢复原 LaunchAgent、配置和探针。新装用户回退为停用自动跟随。跨平台回滚细节见脚本和来源文档。

## 数据与隐私

用户数据位于 `$CODEX_HOME/whale-widget`，默认 `~/.codex/whale-widget`；`WHALE_HOME` 可指定独立数据目录。接口和本机路径不自动展示在设置页，密钥不会进入界面或工坊包。诊断分享前仍需检查内容；`runtime.json` 含 IPC 令牌，不应公开。

金额保留原始精度，显示两位小数；观测余额差额不能冒充逐请求账单。取消仍记录已观测消耗，默认无成功音效或趣味失败文案；仅明确因高需求拥挤而失败时提示“挤不进去...”。汇率说明仍在“刷新汇率”旁的灰色感叹号按钮中。

订阅观察只读取本机用量与额度事件，无新增登录流程，不发送聊天。近 7 天 token 可能包含本机多个账号/提供商的记录，不用于计算当前订阅剩余额度。扫描有资源上限，超限标为不完整。

峰谷是显示提示，不修改账本。2026 年以外尚未核实节假日表时显示规则需更新。

## 已知限制

- Windows 代码仅为减少上游合并冲突而保留，已经退出本分支的维护和验证范围。
- Mac 脚本目前安装桌面组件和 LaunchAgent，不自动完成 Codex 插件市场的技能/MCP 注册；相关平台流程仍待实机补充验证。

- macOS Apple Silicon/Intel、Spaces、多屏、睡眠唤醒仍需实机验收。
- 订阅额度依赖本机会话是否提供快照；没有固定 token 总配额，不能显示准确“剩余 token”。
- 桌面模式是独立透明浮窗，不是壁纸层嵌入；未包含 CC Switch 模型路由。
- 本地工坊不等于在线市场。DSH 包的账号、网页注入和授权事件不直接移植。
- 旧版删除过的历史记录无法凭空恢复。发行包不包含作者个人数据或测试录像。

## 来源与许可

上游：[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)。代码沿用 MIT；原图片/动图/音效保留原分发条款，不将媒体重新许可为原创。参见 LICENSE、THIRD_PARTY_NOTICES.md 和 [实施与来源](docs/V0.3-PLAN-AND-PROVENANCE.md)。


## 发布材料

[本轮开发总结](docs/DEVELOPMENT_SUMMARY.md) · [用户验收清单](docs/USER_TEST_CHECKLIST.md) · [发布草稿](RELEASE_NOTES.md) · [GitHub 发布准备](docs/GITHUB_PUBLISHING.md)。本次发布目标为本仓库 For-Codex 分支，独立标签 `codex-v0.3.0-fixed`。
