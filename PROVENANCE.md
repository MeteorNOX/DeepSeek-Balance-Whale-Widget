# 来源、改编范围与许可（PROVENANCE）

本目录是 **MeteorNOX** 的 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（包名 `dsh-whale-widget`）在 **For-Codex** 分支上的改造版本：把原本住在 DSH Web 界面右下角的挂件，改造成跟随 **Codex 桌面应用**窗口的伴随挂件（包名 `api-balance-whale`，Codex 插件名同为 `api-balance-whale`）。

## 一、上游与本分支的关系

| | 上游主分支 | 本分支 For-Codex |
|---|---|---|
| 运行位置 | DSH（DeepSeek Harness）Web 界面 | Codex 桌面应用（Windows x64 / macOS） |
| 安装方式 | `dsh plugin --profile web add …` | 解压为插件目录 + 注册 Windows 计划任务或 macOS LaunchAgent（见 `docs/INSTALL-AND-ROLLBACK-0.2.0.md`、`docs/MACOS.md`） |
| 界面宿主 | DSH 页面内的 cordis bundle | 透明 Electron 工具窗口 + 自绘菜单 |
| 与 Codex 的关系 | 仅把 Codex 当数据来源 | 自身即 Codex 插件，读取本机 Codex 配置与会话用量 |
| 数据目录 | `%USERPROFILE%\.dsh\…` | `~/.codex/whale-widget`（Windows 为 `%USERPROFILE%\.codex\whale-widget`） |

两者**互不兼容**：本分支不能用 `dsh plugin add` 装进 DSH 页面；上游包也不能在 Codex 里运行。若你只想在 DSH 网页里用小鲸鱼，请装上游主分支。

## 二、保留自上游的部分

- 角色与素材：`assets/DSniang1.png`、`assets/DSniang02.png`、`assets/DSH2.png`、`assets/*.gif`、`assets/*.mp3`（按上游 `PROVENANCE` 说明，这些美术素材由维护者提供，随插件 as-is 分发）。
- 挂件前端的大部分交互与视觉实现：`assets/whale-widget.js` 中的气泡渲染、菜单、角色/音效/素材管理、拖动吸附与翻转等。

## 三、本分支的改造（0.2.0）

- **宿主改造**：新增 `desktop/`（Electron 主进程、透明工具窗口、预加载、页面脚本、原生窗口跟随 `WindowApi.cs`、无窗口启动器 `WhaleLauncher.cs`、`supervisor.ps1`）与 `runtime/`（配置解析、余额 provider、账本、汇率、会话监视、MCP 工具、本地命名管道 IPC）。没有独立网页，也没有任何本地网页端口。
- **余额与用量**：支持兼容账单接口、New API/One API、自定义 JSON 接口与 DeepSeek；账本按账户与币种隔离；金额统一两位小数；失败/暂停轮次仍保留已观测消耗。
- **汇率显示**：USD/CNY 显示换算，报价说明收在“刷新汇率”右侧的灰色 **!** 按钮中，按北京时间每日 00:15 检查。
- **0.2.0 的界面与稳定性改动**：汇率说明改为点击展开；失败／暂停取消只显示中性扣费提示；显示判定加入周期重断言与还原事件重断言，窗口句柄变化后可自行恢复；移除硬编码的服务商名称与文档中的本机路径痕迹。
- **上游已移除项**：峰谷/时段定价相关模块（上游 0.3.x 起也已移除），保留迁移兼容。

详细逐条说明见 [`docs/CHANGELOG-0.2.0.md`](docs/CHANGELOG-0.2.0.md)。

## 四、许可边界

| 范围 | 许可 |
|---|---|
| 代码（`desktop/`、`runtime/`、`lib/`、`scripts/`、`.codex-plugin/`、`skills/`、文档） | **MIT**（见 [`LICENSE`](LICENSE)，沿用上游署名） |
| `assets/**`（图片 / 动图 / 音效） | **不在 MIT 覆盖范围**：随插件 as-is 分发，仅用于运行本挂件；不授予再许可，也不声明为原创作品 |
| `vendor/smol-toml/**` | **BSD-3-Clause**，Cynthia Rey 及贡献者，见 `vendor/smol-toml/LICENSE` |
| Electron | **MIT**（含 Chromium 与第三方声明），由可选安装脚本单独下载，不随本仓库分发 |

完整第三方清单见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)；上游原版说明备份在 [`docs/UPSTREAM-README.md`](docs/UPSTREAM-README.md)。

## 五、权利主张与致谢

- 本项目的一切改动都建立在上游作者 **MeteorNOX** 的工作之上，特此致谢。
- 若你认为 `assets/` 中有素材侵犯了你的权利，请在本仓库开 issue 说明**文件名**与**依据**，我们会在核实后立即替换或移除，不附加其它条件；也欢迎直接提供可自由再分发的替代素材。
- 使用者需自行确保其配置的第三方 API 服务条款允许本挂件读取余额接口；本挂件不代任何服务商作出承诺。
