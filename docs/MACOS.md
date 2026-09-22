# macOS 安装与验证

适用于 Apple Silicon 和 Intel Mac。挂件跟随 Codex 桌面应用（`com.openai.codex`，应用包显示为 ChatGPT/Codex），不会跟随 Codex CLI 或该应用的后台工具进程。

## 前置条件

- macOS 13 或更新版本。
- Codex 桌面应用已安装。
- Homebrew 安装的 Node.js 24+ 与 npm。Apple Silicon 使用 `/opt/homebrew`，Intel 使用 `/usr/local`。
- 首次安装需要联网下载 Electron 44.3.0。Xcode Command Line Tools 用于编译无权限窗口探针；若 `xcrun swiftc` 不可用，先运行 `xcode-select --install`。

## 安装

在项目目录双击 `安装 Mac 自动跟随.command`，或运行：

```bash
npm run install:mac
```

安装器会：

1. 优先使用 Homebrew 的 Node/npm 安装 Electron 到 `~/.codex/whale-widget/desktop-runtime`。
2. 编译 `desktop/macos/window-probe.swift` 到 `~/.codex/whale-widget/native/whale-window-probe`。
3. 给 Electron 使用独立的 `com.api-balance-whale.codex.desktop` 标识，避免与其他 Electron 应用共享“恢复窗口”状态。
4. 写入并启动 `~/Library/LaunchAgents/com.api-balance-whale.codex.plist`。

安装完成后打开 Codex。只有检测到 Codex 窗口时才会启动挂件；Codex 最小化时挂件隐藏，恢复时重新显示，完全退出 Codex 后挂件关闭，LaunchAgent 继续待命。

## 日常操作

- `启动桌面挂件.command`：当前 Codex 已打开时显示挂件。
- `停止挂件服务.command`：停止当前挂件，不停止自动跟随。
- `停用自动跟随.command`：停止并移除 LaunchAgent，保留设置、素材和账本。
- `Cmd+Option+W`：显示/隐藏挂件。

数据位于 `~/.codex/whale-widget`。源码安装在项目目录时，LaunchAgent 会直接引用该项目；如果移动目录，请重新运行安装器。

## 前台可见性

挂件是独立的置顶透明窗口，不是 Codex 的子窗口：Codex 窗口被别的应用盖住时它依然「在屏上」，所以可见性还要看前台应用。

- Codex（或挂件自己，例如你正在点她）在前台时显示；
- Codex 窗口被其它应用遮挡 90% 以上时隐藏；
- 前台应用位于另一块屏幕时不隐藏 —— Codex 开在副屏、你在主屏用别的应用时她照常待着；
- `Cmd+Option+W` 与托盘「显示 / 隐藏」是显式操作，切到别的应用也不会立刻收回，回到 Codex 后交还自动判定。

窗口探针从 `CGWindowList` 取前台应用、其最上层窗口矩形，以及 Codex 窗口被遮挡的采样比例，一并回传给 Electron 判定。探针主循环用 `RunLoop` 驱动：`NSWorkspace.frontmostApplication` 只在该进程的 run loop 派发通知时刷新，用 `Thread.sleep` 会把它冻结在探针启动那一刻的值。

## 验证

```bash
"$HOME/.codex/whale-widget/native/whale-window-probe" --once --bundle-id com.openai.codex
node scripts/control.mjs status
node scripts/control.mjs balance
```

前台可见性同样可以用 `node scripts/control.mjs status` 核对：切到别的应用后 `visible` 应变假、`frontmostBundleId` 变为该应用，切回 Codex 立即恢复。相关字段还有 `hostIsFrontmost`、`hostCoverage`（遮挡比例）与 `appActive`（挂件自己是否在前台）。

关键诊断文件：

- `follow-state.json`：应包含 `hostAlive: true`、`visible: true`、`attached: true`。
- `supervisor-state.json`：LaunchAgent 监督器的心跳和 Electron 子进程 PID。
- `macos-supervisor.log` 与 `macos-launchagent-error.log`：监督器、窗口探针和 Electron 输出。
- `desktop-error.json`：主进程异常；成功加载界面后会自动清除旧文件。

## 自定义宿主应用

默认只识别 `com.openai.codex`。需要跟随其他兼容的桌面客户端时，在安装前设置逗号分隔的 bundle ID：

```bash
WHALE_CODEX_BUNDLE_ID="com.openai.codex,com.example.codex-client" npm run install:mac
```

窗口探针使用 `CGWindowList` 读取窗口位置和可见性，不读取聊天内容，也不需要“辅助功能”权限。
