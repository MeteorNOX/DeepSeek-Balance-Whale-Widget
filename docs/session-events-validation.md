# 会话事件投递：验证和回滚

本修复为 `last-turn.json` 增加有界游标队列，保留旧客户端使用的顶层字段。每轮记录包含会话、工作目录、轮次、完成原因及独立事件 ID；金额未知使用 null，真实零金额使用 0。账本仍使用最后一条 usage 的时间，峰谷选择使用每条 usage 的事件时间，完成通知另有结束时间。

等待提问/授权按会话和请求 ID 管理。其他会话及迟到旧轮次的事件不能清掉当前等待；展示最新一项解除后，仍未处理的较早请求重新可见。支持 Web Locks 的同源页面共享声音去重事务，旧 WebView 只保证尽力而为的 localStorage 去重。

## 自动验证（不安装插件）

```sh
node --test tests/*.test.mjs
node --check lib/index.js
node --check lib/session-events.mjs
node --check assets/whale-widget.js
node tools/z-layer-audit.mjs assets/whale-widget.js
node tools/ci-audit.mjs --no-pack
node tools/ci-audit-selftest.mjs
node tools/check-dead-settings.mjs
git diff --check
```

测试直接使用生产模块和生产函数，所有宿主、网络、存储和凭据均为内存替身；无需 DSH、账号或真实用户数据。覆盖并发完成、零与未知、取消、重复/迟到事件、跨午夜、队列过期、轮询超时、标题兼容以及多个页面的声音认领。

## 经安装授权后的 DSH 验收

1. 在独立测试 profile 安装此分支，打开 Web/桌面端，等第一次轮询建立游标。
2. 让两个测试会话在一秒内完成：两条消耗提示均应按队列出现；只有有真实 usage 的零费用轮次显示 0，未知金额不造出 0。
3. A 等待提问，B 开始、完成或回答不同请求：A 提示仍在；多个等待同时存在时，完成当前项后可见尚未处理的上一项。
4. 在支持 Web Locks 的同源两窗口完成一轮，只播放一次系统提示音；点击/按压音仍由交互所在窗口播放。取消/错误轮次不播放成功音，已观测消费仍可显示。
5. 暂时阻断状态请求超过十秒，再恢复网络：轮询应自行继续。刷新页面或重启宿主后不重播历史完成。

## 明确边界

- 完成队列只在内存保留最近 128 项。客户端超过保留窗口会收到 `gap` 并打印通用提示；宿主重启采用新 stream ID，客户端先对齐当前游标，不伪装成持久消息队列。
- 保持旧版账本按一轮末条 usage 时间入账的口径，没有把跨午夜整轮强行分摊；这与余额观测区间的修复分开。
- 本修复提供工作区和会话字段，不实现按工作区静音界面、会话导航或角色动画；这些应单独评审。
- 未安装真实 DSH 验收，未验证不支持 Web Locks 的旧 WebView 的跨窗口原子去重。

## 回滚

合并前关闭 PR 即可。合并后 revert 本 PR 的提交并恢复上一版本插件文件，再重启测试 profile、刷新页面。没有账本或凭据迁移；原 `.dshw-turn.json` 的 seq 格式保持兼容。新增 localStorage 游标/已播放 ID 会被旧版忽略，无需清空全部站点数据。

如需逐字节恢复安装前状态，应在授权安装前备份该 profile 的插件文件及 `.dshw-turn.json`；本轮自动测试不修改这些文件。
