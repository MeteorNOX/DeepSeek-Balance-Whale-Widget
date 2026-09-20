# 来源、改编范围与许可（PROVENANCE）

本分支是 **MeteorNOX** 的 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) `For-Codex` Electron 基线的 macOS 独立桌面适配，当前 fork 地址为 [404404/DeepSeek-Balance-Whale-Widget](https://github.com/404404/DeepSeek-Balance-Whale-Widget)。本阶段采用的上游完整提交为 `8c13a627120a175f6c92b3aeb12c99d392416ac7`。

## 保留的上游能力

- `assets/whale-widget.js` 的角色、气泡 SVG、连续点击队列、随机语句与权重、模块编辑、图片/动图、音效、资源管理、吸附和翻转；
- `runtime/`、`lib/` 中的余额 provider、配置、账本、媒体校验和资源持久化；
- `desktop/ui/` 中的原有页面、透明度命中测试、菜单和弹窗式编辑器；
- Windows `follow-main`、C# 窗口 API 和 PowerShell supervisor，仍保留在 Windows 路径，不被 macOS 构建加载。

## 本分支新增

- `desktop/main.cjs` 模式选择器与 `desktop/standalone-main.cjs` macOS 独立宿主；
- 稳定的 `~/Library/Application Support/DeepSeek-Balance-Whale-Widget` 数据目录、单实例、菜单栏入口、窗口位置恢复和显示器断开夹紧；
- 受控 preload bridge，将真实屏幕坐标拖动、菜单/编辑器表面尺寸和透明鼠标穿透交给原生层；
- Unix socket 残留 pid 检查和用户私有权限；
- arm64 Electron App、图标、DMG、安装包校验和 GitHub Actions。

本阶段不实现 ChatGPT/Codex 订阅 Auth、不跟随 Codex 窗口，也不把旧 fork 的 Swift/WKWebView 状态系统混入 Electron；这些能力以后应通过独立 provider/宿主边界接入。

## 许可边界

| 范围 | 许可 |
|---|---|
| 仓库代码与宿主改造 | MIT，沿用上游署名，见 [`LICENSE`](LICENSE) |
| `assets/**` 图片、动图、音效 | 按上游实际说明随项目分发，不额外主张原创或超范围再许可 |
| `vendor/smol-toml/**` | BSD-3-Clause，见 `vendor/smol-toml/LICENSE` |
| Electron/Chromium | Electron 项目许可及其随包第三方声明；构建时由 npm 获取并打包 |

感谢 MeteorNOX 及所有上游贡献者。若素材权利有疑问，请以文件名和依据提交 issue，不要上传密钥、账本或私人配置。
