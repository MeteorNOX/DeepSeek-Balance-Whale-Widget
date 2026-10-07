> 历史开发专题，保留当时实现与验证范围。当前 v0.4 状态以 [版本说明](RELEASE-0.4.md) 和 [验收清单](TEST-CHECKLIST-0.4.md) 为准；旧构建号、专用回滚入口或测试数量不代表本包。

# Issue 核查后的六组修复与通用气泡布局

内部版本：`0.3.0+codex.20261004.issue-audit`。基于原小鲸鱼 `20261004.root-fixes`，保留此前九项修复、位置记忆、macOS PR #128 与撤除空白点击关闭的既定行为。

| Issue | 缺陷 | 本次实现 |
| --- | --- | --- |
| [181](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/181) | 其他额度类型或部分窗口替换账户窗口 | 按来源筛选；五小时与七天分别合并并保留各自时间；跨文件合并；逐窗口过滤登录边界并重新判断过期；未知来源不能覆盖明确账户来源 |
| [172](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/172)、[195](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/195) | 渲染失败遗留队列占用，后续消费气泡停滞 | 队列项和场景共享生命周期；渲染失败、取消、关闭释放对应占用，继续队列，旧异步回调不能影响新场景 |
| [79](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/79) | 拖拽取消的零坐标被保存 | 取消、失去捕获、失焦及无效坐标恢复已有位置意图，不提交；正常松手包括合法屏幕零坐标照常保存 |
| [88](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/88) | 设置不可读被伪装成空配置 | 文件不存在返回明确的未配置状态；损坏或权限错误返回失败，提示用户并保留原文件；同一严格读取也保护增量保存 |
| [108](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/108) | 配置转换丢失已有屏名 | 普通屏、选择屏和选项等受支持名称在读取、编辑、运行转换与保存中保留；未追加共享台词池功能 |
| [135](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/135) | 关闭音频裁剪后残留活动 AudioContext | 离线解码不占音频设备；预览按需启动，结束、关闭、取消、失焦、隐藏、卸载及错误释放；异步回调有代次检查；导出 WAV 不依赖活动音频设备 |
| [159](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/159) | 通用多行、长文、图文越出气泡白底 | 隐藏缓冲提交前按统一安全区换行、测量、适配；缩窗、缩放、内容更新重排；保留内容与节点，不用裁剪隐藏文字 |

## 验证与实际边界

- 全量 Node 自动测试及真实 Electron 布局和位置进程重启验证随交付保存于私有 QA 目录。
- 额度测试采用合成记录和真实采集器／Worker，覆盖来源、跨文件、同时间戳、部分窗口、认证变更和过期。无法从缺失快照创造真实订阅额度。
- 音频测试覆盖自然结束、关闭途中解码／恢复、再次预览、父窗口关闭、失焦和 WAV 内容。Windows 验证不能代替 Mac 睡眠断言；硬件首音裁切和重复音效另属待实机定位问题。
- 原消费归属隔离、内部详细金额及两位小数显示继续保留。
- 自定义内容过多或挂件极小时，为完整容纳内容会缩小字号；建议合理控制文本长度和挂件大小。

## 手动验证

1. 订阅模式出现有效额度快照后，观察只有一个窗口更新时另一个仍保留，过期窗口明确标注。
2. 拖动后按窗口切换导致取消，应回到此前记住的位置；正常松手后重启应保持新位置。
3. 打开音频裁剪、预览、关闭，再次打开预览及保存；关闭后不继续播放。
4. 编辑并保存已有命名泡泡，关闭重开仍保留名称。使用多行、长文、图文和不同挂件大小确认内容在白底内。
5. 通知渲染失败的自动测试验证后续通知继续；不要求用户破坏真实配置或图片来模拟故障。

## 安装和回滚

完整安装保留用户设置与用量。专用回滚入口绑定此次安装回执，恢复 `20261004.root-fixes`，保留新增用量记录；原始备份和此版代码继续保留。无需修改 Codex 配置或删除账本。

macOS 原始兼容来源：https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/128 。未上传 GitHub、未自动修改任何 issue。
