# Codex-v0.4(fixed)：issue 与反馈状态

适用包名：`Codex-v0.4(fixed)`；内部版本：`0.4.1`；构建：`auto-probe-fixed-20261005`。发行标签为 `codex-v0.4.0(fixed)`。本表记录本适配版本覆盖范围，不表示上游 issue 已关闭。

状态按当前 For-Codex 的实际范围划分。“完整”仅指表内明确列出的 Codex 缺陷已实现修复，不等于原讨论的全部平台、设备和功能都完成验收。此前记录保留在 [v0.4 历史状态表](ISSUE-STATUS-0.4.md)。

## 完整：已覆盖所列 Codex 缺陷

| 讨论 | 累计实现范围 | 验证边界 |
| --- | --- | --- |
| [#181](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/181) 额度类型与窗口覆盖 | 按账户额度来源筛选；分别合并五小时和每周窗口；保留逐窗口时间，处理同文件、跨文件、别名冲突、登录边界和过期 | 已有生产解析器与合成回放；真实订阅账号完整切换链路仍待验收 |
| [#172](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/172) / [#195](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/195) 气泡队列卡住 | 队列项与场景共享生命周期；失败、取消和替换释放占用；旧异步回调不能清掉新场景 | 当前自动回归覆盖相关逻辑；不扩大为所有素材和设备的无限时长验收 |
| [#159](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/159) 气泡文字溢出 | 双缓冲、安全区测量、换行与缩放统一；金额语义和短标题保持可读，设置可滚动 | 本轮七个布局样本；较早五十二个通用布局场景是历史基线，不是本轮重跑 |
| [#88](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/88) 失败静默 | 明确区分缺失、不可读和损坏配置；读写失败可见，避免把坏文件当空配置覆盖 | 不替用户修复磁盘权限，也不承诺物理存储故障时仍能完成保存 |
| [#97](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/97) 初始化覆盖设置 | 加载合并、局部更新和顺序保存；编辑与预览防止迟到结果覆盖新表单 | 保留延迟、交错与关闭重开回归 |
| [#163](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/163) 旧账户账本不可查看 | 提供匿名账户与币种历史入口，不依赖失效密钥 | 不自动合并账户，不恢复旧版已经删除的记录，不校正历史错误金额 |
| [#188](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/188) 隐藏后超时不收敛 | 场景保留截止时间，恢复、图片失败与回退后重新判断；常驻提示仍保持常驻语义 | 不把所有提示统一改成同一种超时策略 |

## 部分：子问题已处理，其余仍保留

| 讨论 | 已完成部分 | 尚未完成或未验证 |
| --- | --- | --- |
| [#190](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/190) POST/body 余额接口 | 命名连接已支持 GET、POST JSON、独立 Bearer/自定义请求头认证、结构化头与查询参数；独立认证 POST 已纳入本轮合成 Electron 流程 | 未实测 issue 涉及的全部服务；不支持任意网页登录、执行表达式或把秘密直接保存到 JSON body。不能再标为“仅 GET、未实现”，也不能列为所有服务已适配 |
| [#108](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/108) 台词池及屏名 | 普通屏、选择屏及候选名称往返保留 | 共享台词池仍未实现；模块库复制不等于共享引用 |
| [#135](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/135) 音频阻止睡眠 | 播放/裁剪上下文有限生命周期；关闭、取消和迟到回调处理 | 未进行 Mac 硬件睡眠断言与整机睡眠验收 |
| [#79](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/79) 触屏与取消坐标 | 共用取消、捕获丢失、失焦和无效坐标不提交坏位置 | Android WebView、触控长按菜单等子问题未实现或未验收 |
| [#121](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/121) 还原后空白浮窗 | 保留软件合成、可见性协调、绘制区域生命周期与条件式层级恢复 | 不宣称根治所有 GPU、DPI、多屏及长期偶发消失 |
| [#184](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/184) 观测中断跨日 | 保留跨午夜观测基线，恢复时不丢掉整个区间差额 | 精确逐日拆分、补录和完整流水还原未实现 |
| [#187](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/187) 设备吞首音 | 保留预解码与播放生命周期管理 | 专用前导唤醒方案及故障设备实测未完成 |
| [#197](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/197) 双重声音 | 单实例、事件去重与音频通道管理 | 原报告根因尚未在当前版明确复现，不能按推测关闭 |

## 本轮余额连接与自动检测反馈

| 反馈 | fixed 结果 | 状态与边界 |
| --- | --- | --- |
| 切换 provider/profile 后地址与认证混配 | 递归合并配置、精确来源匹配、固定连接、旧覆盖绑定；同域租户路径变更也受约束 | 所列来源隔离已实现；只跟随实际读取到的配置，不能还原未读取的 CLI 临时覆盖 |
| 初期 0.4.1 普通自动模式一直待确认 | 改为有界顺序探测、严格契约校验和命中缓存；强协议直接生效，有完整规则的候选可“确认并使用” | 已实现；不是让未知字段、币种或范围自动获得记账资格 |
| `100000000` 被显示为巨额资金 | 区分已知不限额哨兵、有限金额与未知口径；不限额不等于账户资金无限 | 已实现对应协议规则；不能只靠“大数”猜测其它服务的含义 |
| NewAPI 原始 quota 被当成金额 | 自动及显式规则识别 `token_usage` / `credit_summary`；验证安全整数与关系后换算；占位消费零不参与差分 | 已实现；自建站单位仍需可靠元数据或正确配置，不能二次除以默认换算系数 |
| 不同接口、单位或计数器切换产生虚假消费 | 计量标识区分协议、字段、单位、范围和计数器周期；变化时先建立新基准 | 已实现；既有历史不重算，退款后净额仍未实现 |
| 刷新或预览反复遍历接口 | 命中及选定候选只刷新对应计划；明确未命中短缓存；限流退避在实时查询与预览间共享 | 已实现；手动重探测可跳过识别缓存，但不能绕过限流退避 |
| 旧预览结果错误确认新表单 | 临时候选证明绑定草稿、配置与来源，限时且单次使用；过期、迟到或来源变更后失效 | 已实现；预览不写账本，不顺带保存未提交模型价格 |
| 不同服务认证与请求格式不统一 | 折叠高级连接支持完整/相对 URL、POST JSON 和环境变量引用 | 部分覆盖；复杂网页登录、任意表达式和所有第三方服务未全适配 |

注册表的 **13 项是来源记录**，包括路径别名、账单配对、匿名单位元数据和需管理凭据的接口，不是十三个品牌分别实测。普通推理密钥不默认试探管理接口。协议依据见 [公开来源表](BALANCE-PROTOCOL-SOURCES.md)，操作与缓存规则见 [自动检测说明](AUTO-PROBE-FIXED.md)。

此前并行消费与连续点击的修复继续保留：账户新增批次独立于单轮估算，首样本建基准、重复采样去重；人物命中、输入路由与原生区域共享稳定轮廓。它们是累计能力，不将旧专项计数冒充本轮复测。

## 未实现与主动不采用

| 讨论 | 当前状态 |
| --- | --- |
| [#118 PR](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/118) 输入框/侧栏避让 | DSH DOM 依赖未移植，未实现完整避让 |
| [#160](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/160) / [#192](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/192) 提问、授权及阶段角色 | 尚无完整 Codex 等待交互/运行阶段事件链 |
| [#186](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/186) 点击提示跳转聊天 | 未实现 |
| [#175](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/175) 独立透明度 | 未实现人物与气泡各自的透明度设置 |
| [#166](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/166) / [#180](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/180) 厂商套餐模板 | 无对应命名套餐适配；余额协议不等于厂商订阅窗口 |
| [#170](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/170) 通用额度回退 | 未实现 API→估算→手动额度回退；不拿本机 token 猜官方余额 |
| [#177](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/177) 全局空白点击关闭 | **主动不采用**；保留明确关闭、人物交互与提示自身超时，见 [设计决定](OUTSIDE-CLICK-DECISION.md) |

DSH 的网页注入、市场安装、`allowCustomHost` 控件和主输入框 DOM 故障并非此独立 Electron 架构的同一问题。#171/#199、#165/#176/#189、#183/#191/#193/#200、#179、#167 等既有适用性判断仍保留在历史状态表，不计作本版“已修复数量”。

## 本轮证据

本地构建记录为 **482 项自动测试、9 项隐私门禁**；真实 Electron 使用隔离合成服务完成 **6 组流程、7 个布局样本、8 张截图**，渲染错误为零。本机真实查询已确认能够正常取得候选结果（candidate），这不等于该候选的全部单位假设、所有服务商或 Mac 已通过验收。

旧 **341** 项自动测试、**120** 次边缘连击、**18** 次透明区对照、**52** 个布局场景属于各自先前基线，本轮没有据此声称重新执行；不同阶段数字不相加。当前限制见 [已知问题](KNOWN-ISSUES-FIXED.md)，过程见 [开发摘要](DEVELOPMENT-FIXED.md)。
