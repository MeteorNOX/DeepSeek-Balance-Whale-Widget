# 0.2.4 变更说明（Codex 特化线）

- 版本：**0.2.4**（`.codex-plugin/plugin.json` 为 `0.2.4+codex.20260922`）
- 基线：上游 `For-Codex` 分支合并 **PR #128**（macOS 支持）之后的 HEAD
- 适用范围：Windows x64 + macOS + Codex 桌面应用；无独立网页、无本地网页端口
- 升级方式：覆盖插件目录后重启挂件；用户数据目录（Windows `%USERPROFILE%\.codex\whale-widget`，macOS `~/.codex/whale-widget`）不被覆盖
- 历史版本：0.2.0 基线的逐条说明见 [`docs/CHANGELOG-0.2.0.md`](CHANGELOG-0.2.0.md)

本版把上游 `For-Codex` 分支推进到合并 PR #128 之后的 HEAD：在保留 Windows 行为不变的前提下新增 macOS 支持，并统一版本号。

## 1. 本次新增：macOS 支持

### 1.1 窗口探针（`desktop/macos/window-probe.swift`）

用 Swift 直接向系统查询 Codex 桌面窗口，不使用“辅助功能”权限、不读取聊天内容：

- 进程定位：`proc_listpids` 枚举进程，再用 `proc_pidpath` 校验可执行文件路径，确保命中的是目标应用本体而不是同名或同 bundle 的其它进程。
- 窗口几何：用 `CGWindowList` 读取窗口信息，只取 **layer 0**（普通应用层）窗口的几何。
- 选择顺序：优先取**前台**的 Codex 窗口；无前台候选时取第一个合格窗口。
- 过滤：丢弃过小的窗口、不可见（`onscreen` 为假或 alpha 过低）的窗口，以及辅助层窗口（`layer != 0`）。
- 性能：PID 扫描结果**缓存 250 毫秒**，避免每次轮询都重新枚举进程。
- 可配置：默认 bundle id 为 `com.openai.codex`，可用环境变量 `WHALE_CODEX_BUNDLE_ID` 覆盖（支持逗号分隔的多个 id），以跟随其它兼容的桌面客户端。

### 1.2 常驻监督器（`desktop/macos/supervisor.mjs`）

Node 编写的 LaunchAgent 常驻进程，负责把探针结果转成挂件的启停决策：

- 解析探针输出的 JSON，并把 `hostAlive` / `hostPid` / `window` / `bounds` / `visible` / `attached` 等状态通过**本地 Unix socket** 回传给 Electron 宿主。
- **跟随语义**：Codex 最小化时隐藏挂件，恢复时重新显示；Codex 完全退出后 Electron 挂件退出，而 LaunchAgent 继续待命，等 Codex 再次打开。
- **退出语义**：收到 `SIGTERM` / `SIGINT` 时先向宿主发送 `hostAlive: false`，让挂件有机会干净退出；随后按升级顺序终止（先 `SIGTERM`，超时后再强杀）。
- **探针自愈**：探针异常退出后 **1.5 秒**重启；探针 **5 秒**无输出则强制重建，避免卡死的探针让跟随永久失效。
- **单实例**：用目录锁（`macos-supervisor.lock` + `owner.json`）配合 `sessionId` 防止重复实例；退出时只清理属于自己 session 的锁。
- **socket 清理**：启动时检查 stale socket 并在确认无人使用后清理，避免上次异常退出留下的 socket 让新实例启动失败。

### 1.3 Electron 浮窗（macOS）

- 使用独立 bundle id **`com.api-balance-whale.codex.desktop`**，避免与其它 Electron 应用共享“恢复窗口”状态。
- 以 **`LSUIElement`** 运行，不在 Dock 中显示图标。
- 窗口为 **transparent + `frame: false`** 的固定尺寸浮窗。
- 层级为 **`floating`**，并跨 Space / 全屏可见，切换桌面或进入全屏时挂件不会消失。
- 启用 **`acceptFirstMouse`**：挂件未获得焦点时第一次点击即可生效。
- 快捷键 **`Cmd+Option+W`** 显示 / 隐藏挂件（Windows 侧仍为 `Ctrl+Alt+W`）。

### 1.4 安装器（`scripts/install-macos.mjs`）

- Node/npm 优先使用 **`/opt/homebrew/bin/node`**（Apple Silicon）与 **`/usr/local/bin/node`**（Intel）。
- 将 **Electron 44.3.0** 安装到 `~/.codex/whale-widget/desktop-runtime`。
- 用 **`xcrun swiftc`** 在本机编译窗口探针，并对产物做 **ad-hoc codesign**（`codesign --force --sign -`）。
- 写入 `~/Library/LaunchAgents/com.api-balance-whale.codex.plist` 后，用 **`launchctl bootstrap`** 装载、**`launchctl kickstart`** 立即启动。
- **安装校验**：必须同时满足 **installId 匹配 + heartbeat 新鲜 + supervisor PID 存活 + `platform=darwin`** 才算安装成功；任一不满足都不会报告成功。

### 1.5 菜单命令

macOS 托盘新增「命令」子菜单，鲸鱼 `☰` 菜单新增命令区，两侧提供同一组命令：**刷新余额 / 查看用量记录 / 查看运行状态 / API 设置 / 停止当前挂件**。renderer 尚未 ready 时命令进入**去重队列**，界面加载完成后按序执行，不会重复触发或丢失。

### 1.6 Windows 侧隔离

本次改动刻意不改变 Windows 行为：

- PR 的 base 分支是 **`For-Codex`** 而非 `main`，没有把 macOS 改动混进上游主线。
- `*.cmd` / `*.ps1` / `*.cs` **未被修改**。
- 非 macOS 分支仍使用 `type: 'toolbar'` 窗口类型、`screen.screenToDipRect(...)` 计算几何、快捷键 `Control+Alt+W`。
- `runtime/process.mjs` 中的 macOS 逻辑受 **`process.platform === 'darwin'`** 保护。
- `runtime/bridge.mjs` 中的 Unix socket 清理受 **`process.platform !== 'win32'`** 保护，Windows 仍只使用命名管道。

## 2. 版本号

本版把版本号从 `0.2.0` 统一提升到 `0.2.4`，涉及五个文件：

| 文件 | 变更 |
|---|---|
| `package.json` | `"version": "0.2.4"` |
| `package-lock.json` | 两处 `"version"` 均为 `0.2.4` |
| `.codex-plugin/plugin.json` | `0.2.4+codex.20260922` |
| `runtime/paths.mjs` | `export const VERSION = '0.2.4'` |
| `desktop/main.cjs` | 启动标记 `revision: 'codex-0.2.4'` |

文档侧同步更新：`README.md`、`PROVENANCE.md`、`SECURITY.md`、`docs/RENDERING.md`、`docs/MACOS.md`、`docs/INSTALL-AND-ROLLBACK-0.2.4.md`、`docs/VERIFICATION-0.2.4.md`、`.github/ISSUE_TEMPLATE/*`。安装与验证文档由 `*-0.2.0.md` 重命名为 `*-0.2.4.md`，全部引用链接已同步。`docs/CHANGELOG-0.2.0.md` 与 `scripts/rollback-0.2.0.ps1` 作为历史文件名保持不变。

本次发布的标签为 **`codex-v0.2.4`**。

## 3. 已知限制（来自 PR 作者自述）

以下为 #128 作者自述的范围与缺口，**不要当作已验证**：

- macOS 侧验证只在 **macOS 26.6.1 arm64** 实机上做过。
- **干净的 Intel Mac** 未验证；**macOS 13 / 14 / 15** 的安装—升级—卸载矩阵未做。
- 仓库**暂无 macOS 集成测试与故障注入**：supervisor / Electron / probe 被 `SIGKILL`、探针输出卡死、`launchctl bootout` 失败、socket 损坏、PID 复用等场景都没有自动化覆盖。
- **多窗口主窗口选择、Codex 快速重启、多显示器、Spaces / 全屏、长时间 CPU 占用**需要在真实环境回归。
- Windows 隔离结论来自**静态复核与发布包 dry-run**，**未在真实 Windows 主机上做动态 smoke test**。

## 4. 验证

本版的验证证据、以及明确**未验证**的清单见 [`docs/VERIFICATION-0.2.4.md`](VERIFICATION-0.2.4.md)。0.2.0 阶段已执行的 141 项单元与回归测试对应的是 0.2.0 代码，0.2.4 未重跑，请发布者在本机复跑后再发布。

## 5. 回滚

见 [安装与回滚说明](INSTALL-AND-ROLLBACK-0.2.4.md)。简言之：用 `scripts/rollback-0.2.0.ps1 -Backup <备份目录>` 还原升级前的整目录备份，或手工复制回插件目录并重启挂件。用户数据目录不在覆盖范围内。

## 致谢

- **@1llysviel**（[PR #128](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/128)，macOS 适配：宿主识别、自动跟随、常驻恢复、Electron 浮窗、安装流程与菜单命令）—— <https://github.com/1llysviel>
- **@MeteorNOX**（上游项目与 `dsh-whale-widget` 主线的全部基础工作）—— <https://github.com/MeteorNOX>

历史贡献者：

- **@ztzpro**（#1 改造成标准 DSH 插件包）
- **@under-the-ocean**（#6 / #7 自动发布 npm 与 OIDC）
- **@21253soursweetlemon**（#16 / #18 gif 降级、锚点位置记忆）
- **@fangbm**（#15 / #19 / #31 / #33 / #46 多币种、消耗泡泡、周末谷价、币种感知账本、自动 Release）
- **@xiaolinnnnnnn**（#26 与 #130 Windows 桌面端重构）
- **@Yang-huai406**（充值记账修复方案与 0.3.1 合并）
- **@ELFsay**（#99 OpenCode Go 订阅额度与多窗口额度）

本分支 0.2.0 → 0.2.4 的合并与发布由 **@Yang-huai406** 维护。
