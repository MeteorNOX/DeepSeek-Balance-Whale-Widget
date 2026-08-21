# 小鲸鱼余额挂件 · 独立 Windows 桌面版

> DeepSeek Balance Whale Widget · Standalone Windows Desktop Edition

一个基于 [Tauri v2](https://tauri.app) 的 Winds 桌面挂件：在屏幕右下角常驻一只 Q 版小鲸鱼，实时展示 DeepSeek 账户余额与今日已用，并支持本地记账。无需浏览器插件、无需任何中转服务。

A Windows desktop widget built with Tauri v2. It keeps a cute whale pinned to the bottom-right corner of your screen, showing your DeepSeekow account balance and today's usage in real time, with local usage tracking. No browser extension or third-party relay required.

***

## 功能特性 · Features

- **余额实时展示**：默认每 60 秒自动刷新，余额变化时带数字滚动动画。
- **今日已用记账**：通过余额差值自动记账，跨天自动归档。
- **气泡交互**：点击鲸鱼弹出气泡（余额 + 今日已用），可切换随机台词。
- **拖拽吸附**：按住拖动，松手后按四分之一区域自动吸附屏幕四边；左吸附自动镜像翻转。
- **按压反馈**：按住鲸鱼有按压回弹与音效。
- **汉堡菜单**：悬停右上角三点，可调大小、音效、音量、用量模式、打开配置。
- **系统托盘**：右键托盘图标可打开配置或退出程序。
- **开机自启**：写入当前用户启动项，登录 Windows 自动运行。
- **互动表情状态机**：生气（连续快速点击触发）、失落（长时间无操作触发）、害羞（长时间悬浮触发）三种互动表情自动切换。
- **检查更新**：在设置界面一键比对本地版本（`Cargo.toml`）与远端最新版本，并提示是否需要更新。
- **使用教程**：设置界面右上角「使用教程」入口，点击跳转 GitHub README。
- **首次引导**：首次启动未配置 API Key 时自动弹出设置界面。
- **Live balance**: auto-refreshes every 60s with a rolling-number animation.
- **Usage tracking**: computes today's usage from balance deltas, archived daily.
- **Bubble interaction**: click the whale for a bubble (balance + today's usage) with random lines.
- **Drag & snap**: drag to move, release to snap to screen edges by quarter zones; left snap mirrors horizontally.
- **Press feedback**: press the whale for a squishy rebound and sound.
- **Hamburger menu**: hover the top-right dots to adjust size, sound, volume, usage mode, and open settings.
- **System tray**: right-click the tray icon to open settings or quit.
- **Auto-start**: registers in the current user's startup items.
- **Interactive mood state machine**: three reactive expressions — angry (rapid clicks), disappointed (prolonged idle), and shy (prolonged hover).
- **Check for updates**: compare the local version (`Cargo.toml`) with the latest remote version from the settings screen.
- **Usage tutorial**: a "Tutorial" link in the settings screen opens the GitHub README.
- **First-run guide**: the settings window pops up automatically when no API key is configured.

***

## 环境要求 · Requirements

- Windows 10 / 11（自带 WebView2 运行时；缺失时程序会提示安装）
- [Node.js](https://nodejs.org)（开发/构建时）
- [Rust](https://www.rust-lang.org)（开发/构建时，`rust-version = "1.77"`）
- Windows 10 / 11 (WebView2 runtime is bundled with the OS; the app prompts to install it if missing)
- Node.js and Rust are only required when building from source.

***

## 安装与运行 · Install & Run

### 直接运行 · Ready-to-run

构建产物位于 `src-tauri/target/release/`：

| 文件                                       | 说明                 |
| ---------------------------------------- | ------------------ |
| `bundle/nsis/DSW小鲸鱼_1.0.0_x64-setup.exe` | 标准安装包（当前用户模式，免管理员） |
| `DS Desktop Whale.exe`                   | 便携版，免安装，双击即用       |

The release artifacts live under `src-tauri/target/release/`: the NSIS installer and a portable `DS Desktop Whale.exe`.

### 从源码构建 · Build from source

```bash
# 安装前端依赖
npm install

# 开发运行（启动挂件）
npm run dev

# 打包发布（生成 NSIS 安装包与便携版）
npm run build
```

***

## 首次配置 · First-run Setup

1. 首次启动时（未配置 API Key）会自动弹出「小鲸鱼设置」窗口。
2. 在 **基础配置 → DeepSeek API Key** 填入官方 API Key（形如 `sk-…`）。
3. 「请求地址」默认 `https://api.deepseek.com/anthropic`，一般无需修改。
4. 保存后挂件随即开始拉取余额。

> 随时可打开设置：右键系统托盘图标 → 打开配置，或在挂件汉堡菜单中点击「打开配置」。

1. On first launch (no API key configured) the settings window pops up automatically.
2. Fill in your official DeepSeek API key (`sk-…`) under **基础配置 → DeepSeek API Key**.
3. The default request URL is `https://api.deepseek.com/anthropic`; usually no change needed.
4. After saving, the widget starts fetching the balance.

***

## 数据存储 · Data Storage

所有配置与记账数据保存在当前用户目录，不经过任何第三方平台：

All config and usage data is stored locally in the user directory:

```
%APPDATA%\DS Desktop Whale\
├── config.json    # API Key / 请求地址 / 模型 / 挂件显示 / 开机自启
└── usage.json     # 小鲸鱼记账数据（含近 30 天历史归档）
```

API Key 仅保存在本机 `config.json`，程序直接请求 DeepSeek 官方接口。

The API key is stored only in the local `config.json`; the app talks to the DeepSeek API directly.

***

## 技术栈 · Tech Stack

- **架构**：Tauri v2（Rust 后端 + 系统 WebView2 前端）
- **前端**：纯 HTML / CSS / JS，无前端框架
- **后端**：Rust（`edition 2021`）
- **Architecture**: Tauri v2 (Rust backend + WebView2 frontend)
- **Frontend**: vanilla HTML / CSS / JS, no framework
- **Backend**: Rust (edition 2021)

***

## 项目结构 · Project Structure

```
DeepSeek-Balance-Whale-Widget-Desktop/
├── dist/                    # 前端静态资源（手写，无构建步骤）
│   ├── widget.html/.js/.css # 挂件窗口
│   ├── config.html/.js/.css # 配置窗口
│   └── assets/              # 音效、图片、SVG 图标
├── src-tauri/               # Rust 后端
│   ├── src/
│   │   ├── main.rs          # 程序入口
│   │   ├── lib.rs           # 窗口 / 托盘 / 命令注册
│   │   ├── config.rs        # 配置持久化
│   │   ├── balance.rs       # 余额 / 用量请求
│   │   ├── ledger.rs        # 记账数据
│   │   ├── autostart.rs     # 开机自启
│   │   ├── claude_config.rs # Claude 配置写入
│   │   ├── codex_config.rs  # Codex 配置写入
│   │   └── update.rs        # 检查更新 / 打开外链
│   ├── tauri.conf.json
│   ├── Cargo.toml
│   └── icons/
├── package.json
└── README.md
```

***

## 常见问题 · FAQ

- **挂件显示「未配置 DeepSeek API Key」**：打开设置填写 API Key 后自动恢复。
- **余额获取失败**：网络抖动会自动沿用最近一次成功值；可点击鲸鱼手动重试。
- **没有声音**：确认音量未调至 0；音效文件内置于程序，缺失时静默降级。
- **今日已用显示** **`--`**：记账模式需先完成一次余额观测（60 秒内自动完成）。
- **关闭挂件**：右键托盘图标 → 退出。

***

## 致谢 · Acknowledgments

本项目由原 DSH 插件 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 独立化改造而来，感谢原作者 [MeteorNOX](https://github.com/MeteorNOX) 的创意与实现。许可证请以原仓库为准。

This project is derived from the original DSH extension [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget). Thanks to [MeteorNOX](https://github.com/MeteorNOX) for the original idea and implementation. Please refer to the original repository for licensing.
