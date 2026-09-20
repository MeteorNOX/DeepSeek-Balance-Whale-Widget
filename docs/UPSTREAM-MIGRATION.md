# For-Codex → for-macdesktop 迁移记录

## 基线

- 上游仓库：`MeteorNOX/DeepSeek-Balance-Whale-Widget`
- 上游分支：`For-Codex`
- 实际采用基线：`8c13a627120a175f6c92b3aeb12c99d392416ac7`
- 本 fork：`404404/DeepSeek-Balance-Whale-Widget`
- 本阶段分支：`for-macdesktop`

创建分支前重新读取了上游远程引用；没有从 fork 的 Swift/WKWebView 版本复制主进程、设置或前端状态。

## 保留

- `assets/whale-widget.js`：角色、气泡 SVG、点击队列、随机语句、权重、模块编辑、图片/动图、音效、资源管理、吸附和翻转；
- `runtime/`、`lib/`：余额 provider、配置、账本、媒体校验、资源持久化和本地 dispatcher；
- `desktop/ui/`：原有 widget 页面、渲染器、透明度命中测试、输入辅助和上游弹窗；
- Windows `follow-main`、C# 窗口 API、PowerShell supervisor：保留在 Windows 路径，不在 macOS 构建执行。

## 新增

- `desktop/standalone-main.cjs`：macOS 独立生命周期、稳定 Application Support 数据目录、单实例、菜单栏、窗口位置恢复、显示器断开夹紧、透明窗口和应用退出清理；
- `desktop/main.cjs`：按平台选择独立或 Windows 跟随宿主；
- `preload` 受控消息：原生屏幕拖动、窗口尺寸/表面协商，避免复制点击队列；
- `runtime/bridge.mjs`：Unix socket 残留 pid 核验与权限收紧；
- `scripts/build-mac.sh`、`make-mac-icon.sh`、`verify-mac-app.sh`、`create-dmg.sh`、`smoke-mac-app.sh`；
- `.github/workflows/macos-ci.yml` 和 `.github/workflows/macos-release.yml`。

## 有意不迁移

本阶段不把旧 fork Swift App 的 Auth、订阅额度、统一设置页或 Codex 窗口跟随代码混进 Electron；不添加假的 Codex 登录状态，也不以 CI fixture 代替真实 provider 验证。后续阶段可以以 provider interface 和 `standalone-main.cjs` 的生命周期为接入点。
