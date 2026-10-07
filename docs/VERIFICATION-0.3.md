# 早期 v0.3(fixed) 验证记录（历史）

本页只保存早期 0.3.0+codex.20260929173027 的范围，不代表 v0.4 当前验收结果。当前说明见 [v0.4](RELEASE-0.4.md)，成品校验以发行目录 verification-report.json 与 release-manifest.json 为准。

该历史阶段通过 238 项单元测试、Windows 原生绘制区域/点击穿透专项、B 版分页界面审计，以及本机安装和回滚预检。关闭气泡时保留尾泡淡出；跨透明缝隙可到达菜单按钮；旧动画回调不应裁掉重新打开的气泡。

该阶段不包括后来完成的位置记忆、费用归属、设置读写竞争、额度窗口合并、裁剪音频生命周期与通用安全区修复。早期计数不与新版本相加。

真实会员账号、Mac 硬件、不同 GPU/DPI、多显示器及长期稳定性未全面验收。旧 scripts/smoke-desktop.mjs 使用旧菜单选择器，不能宣称所有测试脚本通过。当前验证入口见 [用户测试清单](TEST-CHECKLIST-0.4.md)。

历史专题：[绘制生命周期](SURFACE-LIFECYCLE-FIX.md)、[界面布局](DASHBOARD-B.md)、[空白点击取舍](OUTSIDE-CLICK-DECISION.md)。
