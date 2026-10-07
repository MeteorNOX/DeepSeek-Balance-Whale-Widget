# Codex-v0.4(fixed)

For-Codex 修复发行版。发布标签精确为 `codex-v0.4.0(fixed)`；程序内部版本仍为 `0.4.1`，构建标识为 `auto-probe-fixed-20261005`。此前 `codex-v0.4.0` 发布保持不变。

这是 [MeteorNOX](https://github.com/MeteorNOX) 所有的 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 独立 For-Codex 适配线，由协作者 [Yang-huai406](https://github.com/Yang-huai406) 维护。保留 [1llysviel](https://github.com/1llysviel) 的 [macOS PR #128](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/128) 及已有署名、许可；不替代 DSH 主线 Latest。

## 本次 fixed 解决什么

- 多提供商与 profile/project 局部配置按表递归合并，未知 provider 明确报错；命名连接绑定来源、地址和认证，防止沿用另一服务的 URL/key。
- 已保存配置处于自动模式时，普通用户直接点击“重新检测接口”。可信协议直接使用；编辑过的草稿仍须保存，重新检测不会将显式协议切换为自动模式。完整候选显示币种、单位和范围假设，并提供“确认并使用”，不必先编辑 JSON。
- 确认接受绑定本次来源的一次性预览凭据，五分钟过期；更改来源、重新预览、关闭重开或迟到响应不能复用旧确认。预览不保存、不记账，也不顺带保存未提交的模型价格。
- 13 个来源注册项包含双请求账单、单位元数据与显式管理接口；不是 13 个品牌，不拿普通推理 key 盲探管理接口。有界探测、命中缓存、单位复核及限流退避减少无效请求。
- 正确区分 NewAPI 原始 quota、占位累计量与兼容账单不限额哨兵；不把巨额 key 哨兵当账户资金，不把未知变成 0。协议/单位/计数器变化重建基准，不猜测重算历史。
- 保留独立 GET/POST JSON、专用环境变量认证及自定义字段/单位映射。概览与默认气泡使用简短范围标题，完整解释保留在提示中。

旧版账户新增消耗去重、任务/token 提示、订阅窗口、角色音效、位置记忆、本地工坊和汇率继续保留。部分 issue 的修复范围及未完成项见 [状态表](docs/ISSUE-STATUS-FIXED.md)，不能全部标为解决。

## 使用与升级

安装包：`Codex-v0.4(fixed).zip`；源码包：`Codex-v0.4(fixed)-source.zip`。配套 SHA-256 与 JSON 清单用于核验成品，不包含 Electron 离线运行时。

Windows 需要支持插件注册的 Codex、Node.js 24+（含 npm）及首次下载 Electron 的网络。完整解压后运行 `安装插件.cmd`，保存本次私有回执，再在 API 设置中重新检测。已有暂停意图会保留。安装、成功检查、日常操作和高级示例见完整 [README](README.md)。

有候选却没有确认按钮，通常缺少单位或范围依据，应按服务商说明自定义，或选“不查询余额”。官方 OpenAI 普通 key 没有本插件已验证的余额接口；ChatGPT 订阅使用单独视图。自动检测不承诺覆盖任意服务商。

## 验证记录与边界

| 已验证的当前运行构建 | 结果 |
| --- | --- |
| 自动测试 | 482 项通过 |
| 独立隐私门禁 | 9 项通过 |
| 真实 Electron | 6 组流程、7 个布局样本、8 张截图，渲染错误 0 |

Electron 覆盖原生配额自动验证、普通候选直接确认并保存重载、独立认证 POST、连接方式/单位变化、迟到结果、切换删除和金额语义布局。使用隔离合成服务，不代表全部真实站点或所有设备实测。

本轮 ZIP 隐私清理、解压核验、文件范围及哈希以 `release-manifest.json`、`verification-report.json` 为准，成品通过隐私检查、完整性校验和中文空格路径安装预检。Mac 实机、其它硬件、多屏与长期稳定性仍需对应环境验证。

本地账本不是服务商完整流水，无法仅靠余额拆分并发消费、充值和退款；跨日未观测区间归再次观测日，历史错误口径不自动重算。见 [已知限制](docs/KNOWN-ISSUES-FIXED.md) 和 [fixed 自动检测说明](docs/AUTO-PROBE-FIXED.md)。

## 隐私与回滚

公开包排除个人配置、凭据、账本、会话、原始日志、截图录屏、私有回执、缓存及 Git 历史。每位接收者安装时生成自己的 `installation.json` 和 `recovery-scripts/rollback-package.ps1`；先用本次回执 `-Receipt ... -CheckOnly` 核对恢复目标，再执行回滚。前后可能都是 `0.4.1`，还须核对备份构建标识。

回滚恢复程序和启动配置，保留最新设置、素材和账本；旧程序可能不理解新连接，恢复后核对实际来源。不要使用别人的回执，也不要删除账本代替回滚。Mac 入口只安装桌面组件/LaunchAgent，不自动注册技能/MCP，见 [macOS 文档](docs/MACOS.md)。

## 发行标识

目标分支为 For-Codex，标签 **`codex-v0.4.0(fixed)`**，标题 **Codex-v0.4(fixed)**。本发行版设置 `makeLatest: false`，保留 DSH 主线 Latest 与旧发布。
