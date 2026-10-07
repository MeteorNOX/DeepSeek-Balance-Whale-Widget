# 来源、改编范围与许可

本分支将 MeteorNOX 的 dsh-whale-widget 0.3.0-beta 从 DSH Web 挂件适配为 Codex 桌面伴随挂件，插件名称为 api-balance-whale。

## 本次范围和协作关系

- 当前交付：**api-balance-whale v0.4.0 For-Codex 发布版**，标签 `codex-v0.4.0`。包内插件清单、运行时和包版本均为 0.4.0。Windows 已进行回归验证；macOS 保留兼容代码，仍需实机验证。没有独立网页，不修改或注入 Codex 安装文件。
- 仓库所属账号及上游作者：[@MeteorNOX](https://github.com/MeteorNOX)。
- Codex 适配协作者：[@Yang-huai406](https://github.com/Yang-huai406)，不代表仓库所有权变更。
- 历史 0.2.4/macOS 成果见 [原始提交](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/tree/8de181abf5593247f32d57995567dd9f4063e049)。历史归档名称 `archive/for-codex-0.2.4` 仅用于来源追溯，不是当前发布版的安装入口；v0.3 系列整合了 PR #128 的兼容路径。
- 感谢 [@1llysviel](https://github.com/1llysviel) 的 [macOS PR #128](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/128)。本次不会把其工作改称为新原创。

## 保留与改造

保留原框架的角色、图片、动图、音效和主要交互。适配层提供 Electron 透明工具窗口、Windows 原生跟随、GUI 启动器、本地 IPC、当前 API 余额/用量、汇率、账本、恢复日志及安装回滚。

当前版本包含费用归属、设置保存、额度窗口合并、音频资源释放、气泡配置保真等修复。详情见 [README](README.md)、[变更记录](CHANGELOG.md) 和 [已知问题](docs/KNOWN-ISSUES-0.4.md)。

## 许可边界

| 范围 | 许可与分发方式 |
| --- | --- |
| 代码和文档 | MIT，保留 [LICENSE](LICENSE) 中的上游版权 |
| assets 中的图片、动图、音频 | 按上游条款 as-is 随挂件分发；本仓库不授予再许可，不声明为本次原创，不因代码 MIT 而扩大素材权利 |
| vendor/smol-toml | BSD-3-Clause，保留原包许可证 |
| Electron 与 Chromium | 安装时另外下载，保留其自带许可证和第三方声明 |

见 [第三方声明](THIRD_PARTY_NOTICES.md)。发布包不包含聊天截图和历史测试截图；其中角色素材仍遵循上述素材边界。

## 隐私和历史

公开打包规则排除个人密钥、账号、账本、运行日志、真实账户截图、缓存和本机备份。完整旧实现可通过 Git 历史追溯。本版由协作者 Yang-huai406 发布，仓库所有者仍为 MeteorNOX；不改写旧发布或主线 Latest。平台验证边界见已知问题文档。

如果认为某个素材侵犯权利，请沿用仓库既有反馈渠道说明文件名和依据；核实后由维护者处理。安全问题按 [SECURITY.md](SECURITY.md) 私下报告，不提交凭据或完整日志。
