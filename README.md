# AI Balance Whale · macOS 独立桌面挂件

AI Balance Whale 是一只常驻 macOS 桌面的透明小鲸鱼挂件，保留上游 `For-Codex` Electron 版本的角色、气泡、连续点击、拖动吸附、翻转、音效、菜单、素材管理和余额编辑器。本分支面向 Apple Silicon macOS，应用可以独立启动，不需要 Codex、DSH、Node.js 或浏览器才能看见和操作人偶。

本分支基于上游 `MeteorNOX/DeepSeek-Balance-Whale-Widget` 的 `For-Codex` 基线 `8c13a627120a175f6c92b3aeb12c99d392416ac7`。仓库归属与发布链接使用本 fork：<https://github.com/404404/DeepSeek-Balance-Whale-Widget>。

## 当前阶段

第一阶段只做 Electron/macOS 独立桌面适配：

- DMG 安装后双击即可启动小鲸鱼；
- 人偶、气泡、连续点击、拖动、缩放、吸附、翻转、右键/菜单栏入口和上游弹窗编辑器继续由 `assets/whale-widget.js` 驱动；
- 余额功能保留上游 API 余额模式：账单接口、New API/One API、自定义 JSON、DeepSeek 等适配；没有配置时显示未知或不可查询，不伪造余额；
- 数据保存在 `~/Library/Application Support/DeepSeek-Balance-Whale-Widget`，不会写入 App Bundle 或 DMG；
- macOS 窗口位置和缩放由 Electron 原生层维护：窗口状态只恢复位置，尺寸按当前缩放计算，屏幕拖动使用系统真实屏幕坐标；旧版小窗口会自动迁移；
- 本阶段不实现 ChatGPT/Codex 订阅 Auth，也不跟随 Codex 窗口。它们是后续独立阶段，不能阻止人偶启动。

## 安装

从 GitHub Releases 下载 Apple Silicon DMG，将 `AI Balance Whale.app` 拖到 `Applications` 后双击。当前构建为 ad-hoc 签名，未经过 Apple Developer ID 公证；首次打开若被 macOS 拦截，请在 Finder 中右键 App 选择“打开”，不要全局关闭 Gatekeeper。

支持 macOS 14+、Apple Silicon arm64。DMG 内同时包含 `Applications` 快捷方式。

## 使用

启动后人偶会出现在当前主屏幕右下角：

- 左键点击：按当前上游点击队列显示/推进气泡；
- 按住并拖动：移动原生窗口，松开后保存位置；
- 人偶菜单按钮或右键：打开上游菜单和编辑器；
- 菜单栏图标：显示/隐藏、打开设置、恢复人偶位置、退出；
- 缩放、角色、音效、气泡内容、资源和账本继续使用上游设置与数据结构。

没有 Codex 或没有 API 配置时，人偶、菜单、随机语句、图片、音效和编辑器仍可使用；余额只显示“未配置/不可查询/未知”，不会把失败变成 0。

## 本地开发

需要 Node.js 24+ 仅用于开发和打包，安装后的 App 自带 Electron 运行时：

```bash
npm install
npm test
npm run desktop
```

`npm run desktop` 在 macOS 上启动独立模式；Windows 仍进入上游保留的跟随模式。开发模式的数据目录可用 `WHALE_HOME=/path/to/data` 或 `--whale-data=/path/to/data` 隔离。不要把真实密钥、账本或用户素材提交到仓库。

## 打包与验证

```bash
npm install
npm run build:mac
npm run verify:mac
bash scripts/create-dmg.sh
bash scripts/smoke-mac-app.sh
```

`build:mac` 使用固定 Electron 依赖生成 arm64 `.app`，从 `assets/DSniang1.png` 生成任务栏/App 图标，并执行 ad-hoc 签名。验证脚本检查 App 版本、arm64 主程序、asar 资源、代码签名完整性和 DMG 挂载内容；smoke 脚本会在隔离数据目录启动实际打包 App，复现旧版 248×274 窗口，并在同一次运行内验证悬停按钮不扩窗、0.6/1.6/2.5/1.0 缩放往返、打开菜单时人偶锚点、合成输入链和 DOM/原生窗口几何，再安全退出。smoke 的输入注入是打包 App 内的合成 Electron 事件，只作为桥接回归；它不会伪称已完成 macOS Accessibility/物理鼠标验收，后者需在真实 Mac 上人工复核。打包会排除不参与 standalone 运行的开发/Windows/文档冗余；Electron Chromium 本体仍是主要体积。

GitHub Actions：

- `macOS standalone CI` 在 `main`、`for-macdesktop` 的 push 和 PR 上构建、校验和启动打包 App；
- `macOS Release` 只响应 `macos-v*` 标签或手动 dispatch，严格检查版本/标签冲突、构建提交、DMG 内容和 SHA-256；
- Release job 才有 `contents: write`，PR/普通 CI 不使用签名 secrets，也不发布 npm 包。

更细的结构和验收记录见：

- [macOS 独立模式说明](docs/MACOS-STANDALONE.md)
- [上游迁移记录](docs/UPSTREAM-MIGRATION.md)
- [macOS 验证清单](docs/MACOS-VERIFICATION.md)
- [来源与许可](PROVENANCE.md)

## 数据与安全

应用只在本机 Application Support 目录保存设置、窗口状态、账本和导入素材。余额 provider 使用用户明确配置的接口和环境变量；密钥不写入普通设置、日志或构建产物。独立模式的 Unix socket 只用于本应用自己的本地控制，带随机 token 并限制为本机权限。

本阶段不读取浏览器 Cookie、不修改 Codex `auth.json`/`config.toml`，也不要求辅助功能、屏幕录制或完全磁盘访问权限。

## 来源与许可

代码与宿主改造沿用上游 MIT 许可和作者归属。`assets/` 中的角色、动图和音效按上游实际说明随项目分发，不额外主张为原创或授予超出原授权范围的再许可；第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。感谢 MeteorNOX 及上游贡献者。
