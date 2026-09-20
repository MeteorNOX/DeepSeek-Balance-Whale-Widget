# macOS 验证清单

## 本地开发者检查

```bash
npm install
npm test
npm run build:mac
npm run verify:mac
bash scripts/create-dmg.sh
bash scripts/smoke-mac-app.sh
```

`smoke-mac-app.sh` 启动 `dist/AI Balance Whale.app/Contents/MacOS/AI Balance Whale`，使用临时 `WHALE_HOME`，等待 `startup-timings.json` 出现 `imageAndInputReady` 和 `interactive`，并要求实际打包资源写出 `input-routing.json` 与 `interaction-test.json`。后者在同一进程内检查旧窗口迁移、悬停按钮不扩窗、缩放往返、菜单展开的根节点锚点和 `sendInputEvent` 经过 preload/DOM/原生处理链；证据明确标记 `syntheticInputOnly`，不能替代真实 macOS 物理鼠标和透明窗口穿透验收。它不会读取或修改开发者的 Codex 登录状态。

## 人工验收

在真实 macOS 14+ Apple Silicon 上：

1. 从 DMG 将 App 拖入 Applications 并双击；
2. 确认没有 Codex/Node 时仍出现内置角色；
3. 左键连续点击，确认上游气泡队列与按压动画；
4. 慢拖、快拖、拖出窗口后松开，确认原生窗口移动且普通点击不误触；
5. 缩放到最小、默认、最大，确认人偶完整可见；
6. 打开右键/菜单栏设置，确认原有弹窗可输入、滚动、保存；
7. 导入角色、音效、气泡图片后重启，确认 Application Support 中数据仍在；
8. 将窗口拖到副屏、拔除副屏并重新启动，确认位置夹紧到可见工作区；
9. 隐藏、重新显示和退出，确认隐藏不等于退出，退出后没有本应用残留 socket/进程。

真实 provider/API 余额需要使用用户自己的明确配置；本阶段不把 Codex 订阅 Auth 作为验收条件。

## CI 门禁

`macOS standalone CI` 使用 `macos-14`、Node 24 和 arm64 Electron，执行 JS 语法检查、几何/拖动阈值逻辑测试、App bundle 资源/版本/arm64/codesign 检查、DMG 只读挂载检查和实际打包 App smoke。smoke 产物同时保存启动、DOM 几何、命中区域、输入路由和交互步骤证据；其中合成输入与 OS 层鼠标穿透分别报告。Release workflow 对同一次 checkout 重复这些检查，然后才创建 Release。CI 没有真实密钥，也不会读取维护者本机凭据。

### 未能在当前环境完成的项目

Linux 工作区不能运行 AppKit、Electron macOS GUI、`sips`、`iconutil`、`hdiutil` 或 `codesign`；因此本地不宣称完成实机 GUI 验收。GitHub-hosted macOS runner 的结果必须在对应 Actions run 中核对，失败、跳过或无报告都不能作为发布通过。
