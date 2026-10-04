# v0.4 issue 与反馈状态表

本表针对当前 **For-Codex** 源码和验证结果，不代表仓库维护者已经关闭这些 issue。编号链接保留原讨论；#118 是 PR。完整修复仅指所列的 Codex 缺陷范围，不把跨平台报告的其它子问题一并算作完成。

## 已覆盖当前 Codex 缺陷

| 问题 | 当前实现与验证 |
| --- | --- |
| [#181](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/181) 额度类型与窗口覆盖 | 筛选账户类型，按 5 小时/周窗口合并同文件和跨文件片段；处理别名冲突与过期。生产解析器合成回放通过，真实账号链路仍待验收。 |
| [#172](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/172) / [#195](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/195) 气泡队列卡住 | 队列所有权和场景 generation 一致；失败、取消、替换释放正确，旧回调不能清新内容。 |
| [#88](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/88) 失败静默 | 明确读写错误，损坏/不可读配置不当空文件覆盖；并不替用户修复磁盘权限。 |
| [#97](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/97) 初始化覆盖设置 | 加载合并、局部更新、顺序保存和失败处理，延迟/交错测试通过。 |
| [#159](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/159) 气泡文字溢出 | 双缓冲统一安全区排版和缩放；此前 52 场景为公共渲染层基线，新账户通知端到端也检查文字边界。 |
| [#163](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/163) 旧账户账本不可查看 | 匿名账户/币种选择入口；不要求恢复失效密钥，不自动合并账户金额。 |
| [#188](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/188) 隐藏后超时不收敛 | 场景保存截止时间，恢复/图片回退后重新判断；常驻提示保持原语义。 |

## 只覆盖子问题或仍需实机验证

| 问题 | 已做 | 未宣称完成 |
| --- | --- | --- |
| [#79](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/79) 触屏与取消坐标 | 共用取消、捕获丢失和失焦不写坏位置 | Android WebView 触控、长按菜单等其它子问题 |
| [#108](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/108) 台词池及屏名 | 普通屏/choice/候选名称往返保留 | 共享台词池 |
| [#135](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/135) 音频阻止睡眠 | 播放/裁剪上下文有限生命周期、关闭和迟到回调处理 | Mac 硬件睡眠断言与整机睡眠验收 |
| [#121](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/121) 还原后空白浮窗 | 本机可见性、软件合成、绘制区域与层级恢复措施 | 所有 GPU、DPI、多屏和长期偶发消失根治 |
| [#184](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/184) 观测中断跨日 | 保留跨午夜基线，不清掉区间差额 | 精确每日拆分、补录、完整流水还原 |
| [#187](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/187) 设备吞首音 | 保留预解码与播放生命周期 | 故障设备前导唤醒方案、实机验证 |
| [#197](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/197) 双重声音 | 单实例、通知去重、音频通道管理 | 原报告根因尚未在当前版复现 |

## 近期使用反馈，没有独立 issue

| 反馈 | v0.4 结果 |
| --- | --- |
| 并行任务没有直接的消费金额反馈 | 独立账户新增批次，无需单价；首次样本建基准，显示后确认，重复采样和重试去重，关闭期间合并累计。5 组 Electron 端到端通过。 |
| 连续点击人物误点背后内容 | 人物命中、输入路由和原生区域统一有限稳定轮廓；过滤迟到按键样本。120 次真实边缘连击零泄漏，18 次透明对照正常穿透。 |
| 小额舍入、位置记忆、编辑缓存和 IME | 高精度累计/两位显示；位置意图独立；编辑器读最新配置并检查冲突；组字期间不误保存/关闭。 |

“账户新增”不是逐轮账单；退款后净额仍未实现。通知与账本语义见 [版本说明](RELEASE-0.4.md) 和 [已知问题](KNOWN-ISSUES-0.4.md)。

## 功能未实现或主动不采用

| 讨论 | 状态 |
| --- | --- |
| [#118 PR](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/118) 输入框/侧栏避让 | 未移植 DSH DOM 依赖，不列为全部完成。 |
| [#177](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/177) 全局空白点击关闭 | 主动不采用，避免底层工作点击清空未读提示；保留明确关闭与自身超时。 |
| [#160](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/160) / [#192](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/192) 提问、授权、阶段角色 | 尚未接入完整 Codex 事件链。 |
| [#186](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/186) 点击跳转聊天 | 未实现。 |
| [#175](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/175) 独立透明度 | 未实现。 |
| [#190](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/190) POST/body 余额接口 | 当前仍为 GET，不因上游 DSH 版本支持而声称本版具备。 |
| [#166](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/166) / [#180](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/180) 厂商套餐模板 | 当前没有对应命名套餐适配；余额字段自定义与订阅窗口是不同能力。 |
| [#170](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/170) 额度来源回退链 | 有来源区分，未提供 API→估算→手动的通用额度回退。 |

## 不适用于当前 Codex 架构的上游报告

- #171/#199 的 DSH `tapIndex`/桌面 boot 注入：本版直接加载独立 Electron 页面。
- #165/#176/#189 的 DSH `allowCustomHost` 控件缺失：本版采用当前 API 配置与自定义同源路径，不使用该模型编辑器。
- #183/#191/#193/#200 的 DSH 市场安装失败：安装器、profile 和错误路径不同；不能根据只有 exit 1 的报告认定 Codex 安装包有同一问题。
- #179 的 DSH 主输入框 IME 干扰：本版不向 Codex 主输入框注入 DOM；自己的编辑器另有组字保护。
- #167 的统一人民币计价手填汇率：本版保留原币种账本、自动参考汇率仅供显示，计价语义不同。

这些条目不是“已在 Codex 修好”的数量。原讨论若提供新的 Codex 复现，可以重新核查。完整原始 issue 清单与私人调试现场不复制到公开材料。

本次发布源码重新运行 341 项自动测试和 9 项独立隐私门禁，全部通过。先前同一运行实现的 120 次边缘连击、18 次透明对照及 5 组账户通知端到端作为专项证据，本次未重跑；较早 52 个公共布局场景和位置重启为历史基线。表中不表示相关 issue 已关闭；待实机验证的项目保持标注。
