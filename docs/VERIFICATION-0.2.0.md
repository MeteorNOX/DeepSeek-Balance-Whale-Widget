# 0.2.0 验证报告

本文件记录 0.2.0 交付前实际执行过的验证。**未执行的检查不会被写成通过**；下方每一项都注明执行方式与结论。

- 版本：`0.2.0`（Codex 插件清单为 `0.2.0+codex.<日期>`）
- 平台：Windows 11 x64、Node.js 24.21、Electron 44.3.0 / Chromium 152
- 说明：验证在开发副本上执行，产物与仓库内文件逐字节一致（同一份文件复制而来）

## 一、单元与回归测试

```
node --test tests/*.test.mjs
```

- 结果：**141 项通过，0 失败**（含新增：失败/暂停取消只显示中性标签、汇率说明面板行为）。
- 覆盖：余额换算与账本、失败/取消记账恢复、素材校验（PNG/APNG/GIF/WAV/尺寸/帧数/配额）、原子写入与 ENOSPC、安全（凭据不外泄、路径穿越、符号链接）、本地 IPC 鉴权、传输与路由、回合提示去重、桌面审计身份校验。

## 二、桌面端隔离测试（Electron 真机渲染）

```
node scripts/smoke-desktop.mjs <输出目录>
```

- 覆盖：本地协议与可见透明窗口、点击出气泡、拖动与位置持久化、菜单项完整、设置对话框、气泡编辑器、资源管理器、原生命中测试、宿主移动/缩放、渲染进程重启后位置保持等。
- **已知环境限制**：其中“Windows 原生命中测试”在作者本机无法判定——桌面上真实运行的 Codex（窗口句柄在 `%USERPROFILE%\.codex\whale-widget\follow-state.json` 中）与浏览器窗口覆盖了测试夹具所在屏幕矩形，夹具的 launcher 命中的是它们而非夹具窗口。该用例现在会把这种情况识别为外部进程占用并记为 **SKIPPED**（写入 `native-hit.json` 与 `collision` 字段），不再伪装成通过；要在干净桌面上取得严格结论，需关闭 Codex 与浏览器后单独重跑。

```
node tests/desktop-audit-smoke.mjs <输出目录>
```

- 结果：**通过**。覆盖：缺失角色素材回退到内置鲸鱼、APNG 两帧可见并可点击、边界按压走完缓冲动画后才弹泡、真实 Electron 输入点击自定义气泡链接只打开一个允许的 HTTP(S) 地址、**渲染器真的卡死时仍按期限保存状态并退出**。

## 三、原生窗口层

- `desktop/WindowApi.cs` 由 `Add-Type` 现场编译并调用 `Probe()`：在本机返回真实 Codex 窗口（可见、未最小化、DPI 144、返回 bounds），证明 0.2.0 新增的 `Attach` 前置校验（目标须存在、可见、未最小化、无主、非工具窗口）不会挡住正常挂接。
- `desktop/supervisor.ps1` 通过 PowerShell 解析器校验（语法），并在真实运行中重新挂接成功：`follow-state.json` 的 `attached`、`nativeFollowing` 均为 `true`。

## 四、界面行为（不依赖窗口焦点）

`tests/fx-info-panel.test.mjs` 在 stub DOM 中运行真实源码片段：

- 灰色 **!** 按钮存在、`aria-label="汇率说明"`、初始 `aria-expanded="false"`；
- 点击后说明面板展开、挂到 `document.body`（避免菜单滚动裁剪）、内容含报价、`最近成功获取`、`最近检查`；
- 汇率刷新时若面板处于打开状态，文字随之更新；
- 再次关闭后从 `document.body` 摘除、`aria-expanded` 复位；
- 原有 `#dshw-fx-refresh` 刷新按钮的 id、冷却禁用与提示文案保持不变。

## 五、发布包完整性

对交付压缩包执行：

- 解压往返：条目数与 `SHA256SUMS.txt` 一致，逐文件校验 **0 处不匹配**；
- 包内所有 `*.js` / `*.mjs` / `*.cjs` 通过 `node --check`；所有 `*.ps1` 通过 PowerShell 解析；
- 从解压副本直接 `import runtime/paths.mjs` 成功，`VERSION=0.2.0`、`DATA_HOME=%USERPROFILE%\.codex\whale-widget`；
- 隐私扫描（包内文本 0 命中）：用户名绝对路径、作者本机备份目录名、服务商专有名、作者本机审计标记与旧版本号；
- 版本一致性：`.codex-plugin/plugin.json` = `0.2.0+codex.*`、`package.json` / `package-lock.json` = `0.2.0`、`runtime/paths.mjs` 的 `VERSION` = `0.2.0`。

## 六、回滚演练

- `scripts/rollback-0.2.0.ps1` 先 `-CheckOnly` 核验 `backup-manifest.sha256`，再在副本上执行真实回滚：删除文件后运行回滚，**158/158 个文件按哈希恢复，0 缺失**。
- 回滚脚本只覆盖插件目录，明确不触碰 `%USERPROFILE%\.codex\whale-widget`（用户账本、素材、设置）。

## 七、未验证 / 不承诺

- 冷启动、断网、多显示器、非 100% 缩放等场景未在本轮逐一覆盖。
- 未在干净桌面（无其他应用占用屏幕）上重跑原生命中测试与焦点相关用例。
- Windows 验证范围仍限 Microsoft Store Codex 安装布局；macOS 初始适配与验证步骤见 `docs/MACOS.md`，其他安装渠道仍未适配。
- 失败/取消轮次的金额仍可能包含同一密钥下的其它调用，不能当作服务商正式账单。
