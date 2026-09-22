# 0.2.0 变更说明（Codex 特化线）

- 版本：**0.2.0**（`.codex-plugin/plugin.json` 为 `0.2.0+codex.20260917`）
- 基线：0.4.0 + 完整审计修复（Codex 自动跟随版）
- 适用范围：Windows x64 + Codex 桌面应用；无独立网页、无本地网页端口
- 升级方式：覆盖插件目录后重启挂件；用户数据目录（`%USERPROFILE%\.codex\whale-widget`）不被覆盖

本版把 Codex 特化线重新起算为 0.2.0，并处理四项界面与稳定性问题。

## 1. 汇率说明改为点开的灰色「!」

- “参考汇率｜刷新汇率”行现在最左侧是灰底圆形 **!** 按钮（`#dshw-fx-info`，`aria-label="汇率说明"`）。
- 点击才展开说明面板（`#dshw-fx-info-panel`），内容与原常驻文字一致：报价、`Frankfurter` 说明与日期、`最近成功获取`、`最近检查（北京时间）`、`每天 00:15 检查；休市日可能沿用上个交易日`，以及“离线缓存”“新汇率已就绪”“错误信息”等条件行。
- 关闭方式：再次点击、点击面板外、按 `Esc`、窗口尺寸变化、菜单滚动或关闭菜单。
- 说明文字仍随汇率刷新实时更新；面板做视口翻转，贴近窗口底部时改为向上展开。
- 旧元素 `#dshw-currency-note` 保留在 DOM 中但隐藏，避免既有自动化脚本失效。
- 涉及：`assets/whale-widget.js`（面板构造、样式、白名单）、`desktop/ui/input.js`（点击命中白名单）。

## 2. 失败／暂停取消不再使用趣味文案

- `desktop/ui/turn-notice.js` 删除两组卖萌短语，改为中性标签：
  - 失败：`上一轮期间 API 扣费（未成功）:`
  - 暂停／取消：`上一轮期间 API 扣费（已暂停）:`
- 仍然显示已观测金额／`待记账`／`金额未知`，仍然不播放成功结束音；记账与账本口径不变。
- 菜单开关保留，文案改为“失败后显示扣费”“暂停／取消后显示扣费”（关闭即不再弹出这类气泡）。
- 恢复趣味文案只需重新填写 `turn-notice.js` 中的标签表。

## 3. 显示判定自愈（最小化／还原、窗口句柄变化）

原先只在收到 IPC 状态时求值一次 `rendererReady && visible && attached`，且序号守卫会整条丢弃乱序消息，任何一次丢失都无法修复。

- `desktop/main.cjs`：新增每秒重断言（`assertVisibility`），并在窗口 `show` / `restore` 事件上立即重断言。
- `desktop/main.cjs`：序号变旧只视为“几何数据过期”，仍刷新生命周期与可见性，不再整条丢弃。
- `desktop/main.cjs`：新增 `render-process-gone` 处理，渲染进程崩溃后重载页面并写 `renderer-gone.json`，不再永久停留隐藏状态。
- `desktop/supervisor.ps1`：探测到空窗口（最小化、短暂 cloaked 或句柄切换）时沿用上次已验证的窗口句柄，保持 owner 绑定，最小化时仍照常隐藏。
- `desktop/WindowApi.cs`：`Attach` 只允许绑定“仍然存在、可见、未最小化、无主、非工具窗口”的 Codex 顶层窗口，避免把覆盖窗口永久绑到对话框或已销毁句柄。

## 4. 去除服务商痕迹

- `runtime/config.mjs`：删除按域名硬编码的显示名，改为 `provider.name || id || host`。
- `desktop/ui/widget.html`：选项与提示文字改为通用表述（“兼容账单接口（常见第三方中转）”等）。
- `.codex-plugin/plugin.json`：关键词移除服务商词；版本统一为 0.2.0。
- `README.md`、`docs/*.md`：个人路径、备份目录与时间戳改为 `%USERPROFILE%` 等通用写法；删除四份含本机时间戳与备份路径的 `*-VALIDATION.json`。
- `node_modules/.package-lock.json`、`runtime/paths.mjs`、`runtime/providers.mjs`（User-Agent）、`package.json`、`package-lock.json`：版本号统一为 0.2.0。

## 验证

- 单元与回归：`node --test tests/*.test.mjs`（140 项，覆盖记账、素材、安全、传输、回合提示、桌面审计身份校验等）。
- 隔离 Electron 全量 UI：`node scripts/smoke-desktop.mjs <输出目录>`（跟随、拖动、菜单、设置、气泡、币种、审计 UI、宿主遮挡）。
- 退出压力：`node tests/desktop-audit-smoke.mjs <输出目录>`（渲染器无响应时仍按期限退出并保存状态）。
- 真机：最小化还原、另存为对话框后鲸鱼应回到原位；菜单里 **!** 按钮可展开说明；失败/取消只出现中性扣费气泡。

## 回滚

见 [安装与回滚说明](INSTALL-AND-ROLLBACK-0.2.4.md)。简言之：用 `scripts/rollback-0.2.0.ps1 -Backup <备份目录>` 还原升级前的整目录备份，或手工复制回插件目录并重启挂件。用户数据目录不在覆盖范围内。
