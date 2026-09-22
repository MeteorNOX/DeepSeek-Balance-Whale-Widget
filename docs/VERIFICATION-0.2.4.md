# 0.2.4 验证报告

本文件记录 0.2.4 交付前实际执行过的验证，并明确列出**没有**执行的检查。**未执行的检查不会被写成通过**；下方每一项都注明执行方式、执行者与结论。

- 版本：`0.2.4`（Codex 插件清单为 `0.2.4+codex.20260922`）
- 基线：上游 `For-Codex` 分支合并 **PR #128**（macOS 支持）之后的 HEAD
- 执行平台：Windows 11 x64（0.2.0 基线的单元与回归测试）、macOS 26.6.1 arm64（PR #128 作者的 macOS 实机）
- 重要前提：**本文件不包含任何本轮 0.2.4 新跑的测试结果。** 下面第一节是 0.2.0 基线的结果，第二节是 PR #128 作者自述的 macOS 证据，两者都不是 0.2.4 全量回归。

## 一、单元与回归测试

```
node --test tests/*.test.mjs
```

- 结果：**141 项通过，0 失败**。
- 平台：Windows 侧。
- **范围声明：这 141 项是在 `0.2.0` 基线上跑的，`0.2.4` 未重跑。** 合并 PR #128 之后是否仍然全绿，**交由发布者在本机复跑确认**；在复跑之前，不应把这条结论当作 0.2.4 的通过证据。

## 二、macOS 侧验证（证据来自 PR #128 作者）

以下结论由 **PR #128 作者在其 macOS 26.6.1 arm64 实机**上执行，本仓库未独立复现：

- `node --check`：**11 个**改动的 `.js` / `.cjs` / `.mjs` 全部通过。
- `zsh -n`：**4 个** `.command` 脚本全部通过。
- `git diff --check`：通过（无空白/冲突残留）。
- **探针编译与签名**：`xcrun swiftc` 编译成功，并完成 ad-hoc 签名；一次性探针（`--once`）返回 `hostAlive` / `hostPid` / `visible` / `attached` 字段。
- `npm pack --dry-run`：发布包内容包含 **4 个 macOS `.command`** 与 `SECURITY.md`。
- `plutil -lint`：LaunchAgent plist 校验通过。
- `launchctl print`：服务显示 **running**，且 **last exit code 0**。
- `node scripts/control.mjs status`：返回 `ok` / `platform:darwin` / `followMode:macos-cgwindow-poll`。
- `runtime.json` 权限：**0600**。

## 三、0.2.0 阶段已执行并通过的项（原样保留）

以下条目摘自原 `docs/VERIFICATION-0.2.0.md`（该文件已随本次版本提升重命名为 `docs/VERIFICATION-0.2.4.md`），内容按原样保留。

> **这些结论对应 0.2.0 代码。** 0.2.4 未在本轮重新执行它们；PR #128 只新增 macOS 代码路径（并受 `process.platform` 判定隔离），但“未重跑”与“通过”是两件事，这里不做推断。

- 平台：Windows 11 x64、Node.js 24.21、Electron 44.3.0 / Chromium 152；验证在开发副本上执行，产物与仓库内文件逐字节一致（同一份文件复制而来）。
- **桌面端隔离测试**（`node scripts/smoke-desktop.mjs <输出目录>`）：覆盖本地协议与可见透明窗口、点击出气泡、拖动与位置持久化、菜单项完整、设置对话框、气泡编辑器、资源管理器、原生命中测试、宿主移动/缩放、渲染进程重启后位置保持等。其中“Windows 原生命中测试”在作者本机无法判定（真实 Codex 与浏览器窗口覆盖了测试夹具所在矩形），该用例现在会被识别为外部进程占用并记为 **SKIPPED**（写入 `native-hit.json` 与 `collision` 字段），不再伪装成通过；要在干净桌面上取得严格结论，需关闭 Codex 与浏览器后单独重跑。
- **退出压力**（`node tests/desktop-audit-smoke.mjs <输出目录>`）：**通过**。覆盖缺失角色素材回退到内置鲸鱼、APNG 两帧可见并可点击、边界按压走完缓冲动画后才弹泡、真实 Electron 输入点击自定义气泡链接只打开一个允许的 HTTP(S) 地址、**渲染器真的卡死时仍按期限保存状态并退出**。
- **原生窗口层**：`desktop/WindowApi.cs` 由 `Add-Type` 现场编译并调用 `Probe()`，在本机返回真实 Codex 窗口（可见、未最小化、DPI 144、返回 bounds），证明 `Attach` 前置校验（目标须存在、可见、未最小化、无主、非工具窗口）不会挡住正常挂接；`desktop/supervisor.ps1` 通过 PowerShell 解析器语法校验，并在真实运行中重新挂接成功（`follow-state.json` 的 `attached`、`nativeFollowing` 均为 `true`）。
- **界面行为**（`tests/fx-info-panel.test.mjs` 在 stub DOM 中运行真实源码片段）：灰色 **!** 按钮存在、`aria-label="汇率说明"`、初始 `aria-expanded="false"`；点击后说明面板展开并挂到 `document.body`；内容含报价、`最近成功获取`、`最近检查`；汇率刷新时打开的面板文字随之更新；再次关闭后从 `document.body` 摘除、`aria-expanded` 复位；原有 `#dshw-fx-refresh` 的 id、冷却禁用与提示文案保持不变。
- **发布包完整性**：解压往返条目数与 `SHA256SUMS.txt` 一致、逐文件校验 **0 处不匹配**；包内所有 `*.js` / `*.mjs` / `*.cjs` 通过 `node --check`；所有 `*.ps1` 通过 PowerShell 解析；从解压副本直接 `import runtime/paths.mjs` 成功（当时 `VERSION=0.2.0`）；隐私扫描包内文本 0 命中（用户名绝对路径、作者本机备份目录名、服务商专有名、本机审计标记与旧版本号）；版本一致性当时为 `.codex-plugin/plugin.json` = `0.2.0+codex.*`、`package.json` / `package-lock.json` = `0.2.0`、`runtime/paths.mjs` 的 `VERSION` = `0.2.0`（**本次已统一提升为 0.2.4，见 `docs/CHANGELOG-0.2.4.md`**）。
- **回滚演练**：`scripts/rollback-0.2.0.ps1` 先 `-CheckOnly` 核验 `backup-manifest.sha256`，再在副本上执行真实回滚：删除文件后运行回滚，**158/158 个文件按哈希恢复，0 缺失**；回滚脚本只覆盖插件目录，明确不触碰用户数据目录（用户账本、素材、设置）。

## 四、未验证 / 不承诺

- **Intel Mac 未验证**：macOS 证据只来自一台 Apple Silicon（arm64）机器。
- **macOS 13 / 14 / 15 未验证**：安装—升级—卸载矩阵没有在旧系统版本上做过。
- **Windows 侧的动态 smoke test 未在真机重跑**：0.2.4 的 Windows 行为没有重新执行桌面端隔离测试与退出压力测试，只有静态复核结论。
- **macOS 无自动化集成测试，也无故障注入**：supervisor / Electron / probe 被 `SIGKILL`、探针输出卡死、`launchctl bootout` 失败、socket 损坏、PID 复用等场景均无自动化覆盖。
- **多显示器 / Spaces 未回归**：多窗口主窗口选择、Codex 快速重启、多屏幕、Spaces 与全屏、长时间 CPU 占用都需要真实环境回归。
- 冷启动、断网、非 100% 缩放等场景未在本轮逐一覆盖。
- Windows 验证范围仍限 Microsoft Store Codex 安装布局，其他安装渠道仍未适配。
- 失败/取消轮次的金额仍可能包含同一密钥下的其它调用，不能当作服务商正式账单。
