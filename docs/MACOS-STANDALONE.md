# macOS 独立模式

## 架构

`desktop/main.cjs` 是模式选择器：

- macOS 或 `--standalone` → `desktop/standalone-main.cjs`；
- 其他情况 → `desktop/follow-main.cjs`，保留上游 Windows Codex 跟随路径。

独立宿主继续把 `assets/whale-widget.js` 作为唯一人偶/气泡/编辑器实现，通过 Electron 私有 `whale://widget` scheme 访问 `runtime/dispatcher.mjs` 提供的本地资源和 API。没有第二套点击队列、渲染器或设置存储。

独立模式不读取 `WHALE_INITIAL_HOST`，不要求 `--supervised`，不检查 `follow-config.json`，不使用 Windows 原生句柄、DPI 转换、`schtasks.exe` 或 Codex 心跳。可选的 Codex API 配置只影响余额 provider，不影响人偶启动。

## 窗口和输入

人偶使用透明、无边框、无阴影的非可调整 Electron 窗口。窗口原点和大小使用 Electron/macOS 屏幕 DIP；Retina scaleFactor 不在应用层重复换算。

上游脚本仍负责点击队列、按压/松开动画、气泡、角色命中测试和设置弹窗。独立宿主只提供几个受控 bridge 消息：

- `ready`、`interactive`、`keyboardFocus`：渲染就绪、设置页焦点和兼容输入状态；macOS standalone 不接受 renderer hover 消息来切换穿透；
- `hitRegion`、`surface`、`layoutReady`、`widgetSize`：renderer 报告有限的角色/气泡/菜单按钮矩形。主进程用全局屏幕 DIP 光标判断是否接收输入；按钮悬停不扩窗，只有实际打开菜单、弹窗或编辑面板才扩大窗口。`native-root-offset` 在扩展 surface 时把紧凑根节点放回原屏幕锚点，关闭后清零，不把扩展 frame 当作位置保存。
- `layoutRequest`、`nativeWidgetSize`：原生变更或拖动延迟尺寸请求后，renderer 清除“已发送”缓存并重新报告最新 DOM；不会形成 DOM→原生→DOM 的持续 resize 回环。
- `dragStart`、`dragMove`、`dragEnd`：原生层以 `screen.getCursorScreenPoint()` 读取真实屏幕坐标，renderer 也用同一屏幕坐标判断阈值；超过阈值后本次手势永久是拖动，松手不再触发点击。

独立模式下原生窗口是唯一的屏幕几何所有者：`window-state.json` 只恢复位置锚点，窗口宽高按 `.dshw-size.json` 的缩放重新计算（默认 1.5，对应约 375×375 DIP）。旧版 122×122 或 248×274 等尺寸会在启动时保留右下锚点并自动迁移，不需要删除偏好。网页端历史 `dshw-pos` 仍可保存在快照中，但独立模式不再应用它，避免把网页视口坐标重新套到原生窗口。

调整缩放时仅在 DOM 尺寸实际变化后更新原生窗口；MutationObserver/动画帧不会再持续发送尺寸协商消息。人偶关闭气泡时保持窗口底部锚点，打开设置时暂时扩大原生窗口，关闭后恢复当前人偶尺寸。

空白区域继续通过主进程根据屏幕命中区域调用 `setIgnoreMouseEvents(..., { forward: true })` 穿透；仅人偶、气泡、按钮和明确打开的编辑表面接收输入，不创建覆盖整个桌面的可点击层。菜单栏“恢复人偶位置”只恢复窗口位置/尺寸并重载渲染器，不触碰 API 配置、账本或用户素材。`--whale-interaction-test` 会把状态写入隔离数据目录，但只使用合成 Electron 输入；物理鼠标、透明窗口穿透、Spaces 和多显示器仍需 macOS 实机验收。

## 生命周期

应用使用 `requestSingleInstanceLock()`。重复启动只唤起已有窗口；隐藏与退出是不同动作。渲染器异常退出时，窗口先恢复鼠标穿透并有限重载；退出时限时保存 UI 状态、关闭本应用自己的 bridge、停止余额/会话服务和删除本实例的 runtime 文件。

默认数据目录：

```text
~/Library/Application Support/DeepSeek-Balance-Whale-Widget/
├── electron-profile/       # Electron 本地 profile
├── api-settings.json       # provider 设置，不含密钥
├── .dshw-size.json         # 角色/音效/尺寸等上游设置
├── .dshw-bubble.json       # 上游气泡配置
├── whale-roles/             # 用户角色素材
├── whale-audio/             # 用户音效素材
├── whale-bubble-imgs/       # 用户气泡图片
├── ui-state.json            # 上游 localStorage 快照
├── window-state.json        # 原生窗口几何
└── runtime.json / *.sock    # 本应用自己的本地 bridge
```

`WHALE_HOME` 或 `--whale-data` 可用于开发和测试隔离。Unix socket 路径由数据目录 hash 派生；启动时只在确认旧 pid 已退出或 runtime 文件无效时清理同名残留，socket 写入后设为用户私有权限。使用 `--whale-render-test` 启动实际打包 App 时，会在隔离数据目录写入脱敏的 DOM/原生几何诊断，供 CI 检查人偶完整可见、图片已加载及无外层滚动。

## 打包体积

Electron 的 arm64 Chromium 运行时是 DMG 体积的主要部分，不能在不改变桌面运行时的情况下大幅删减。打包脚本会排除仅用于开发/Windows/文档的文件和 README 展示图 `assets/DSH2.png`，但保留人偶、气泡图片、音效、编辑器脚本和运行时依赖；构建日志会同时报告 `.app` 与 `app.asar` 大小。用户素材仍写入 Application Support，不会被打包进 App。

## 当前边界

本阶段保留上游 API 余额和本机账本口径，但不声称 ChatGPT/Codex 订阅额度。网页 Auth、Codex 窗口跟随和需要辅助功能权限的能力不在此阶段；它们必须通过后续独立适配接入，不能通过演示数据或假登录状态填充。
