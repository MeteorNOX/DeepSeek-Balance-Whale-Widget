# 小鲸鱼余额挂件 · Android 版

> DeepSeek API 余额悬浮窗小鲸鱼 —— Android 原生悬浮窗移植版

## 来源与致谢

本项目是 **Android 原生悬浮窗版本**，完全参照以下开源项目的桌面版（Tauri v2）实现移植：

- 原项目：https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget
- 参考分支：`For–WinDesktop`（独立 Windows 桌面版，Tauri v2 + Wry）
- 移植内容：表情状态机（normal / angry / disappointed / shy / exhausted）、4 帧眨眼时序（半闭 70ms → 闭眼 150ms → 半睁 70ms，间隔 4~6s）、按压反馈（stroking 按压图 + 弹跳 + 音效）、点击序列（余额 → 台词/时间 → 时间）、高频连点警告/生气、长按 1.5s 害羞、3 分钟闲置失落（18 条语录轮播）、余额差记账、峰谷时间气泡、窗口缩放公式 `(250×scale).clamp(122,625)`、1/4 磁吸、左边缘镜像等。
- 全部表情素材（main / angry / close_eyes / disappointed / exhausted / half_closed_eyes / half_open_eyes / shy / stroking）与气泡 SVG 布局参数均取自原项目。

感谢原作者的创意与素材！❤️

## 功能

- 悬浮余额挂件：默认右下角，可拖动、贴边磁吸、左右镜像
- 表情互动：眨眼 / 按压 Q 弹 / 害羞 / 生气 / 失落 / 疲惫
- 点击查询：余额 → 随机台词或时间气泡 → 时间气泡
- 余额差记账：跨天归档、今日已用、峰值/低谷时段提示
- AI 宠物对话（内置 DeepSeek API 聊天窗）
- 设置面板：大小（1~20 级）、音量、眨眼频率、疲惫模式阈值、自定义台词（轮播/随机），全局/气泡颜色、开机自启等

## 构建

手工工具链（无需 Gradle）：Java 17 + Android SDK 35 + aapt2/d8/zipalign/apksigner。

```bash
bash build.sh
# 产物：build/app-release.apk

# 签名密码可通过环境变量指定（默认 whale-widget-release）
WHALE_KS_PASS=your-pass bash build.sh
```

## 权限

- SYSTEM_ALERT_WINDOW 悬浮窗
- INTERNET 网络查询余额
- FOREGROUND_SERVICE 常驻模式
- RECEIVE_BOOT_COMPLETED 开机自启
- POST_NOTIFICATIONS Android 13+ 通知

## 免责声明

- API Key 仅保存在本机（Android Keystore 加密）；请勿公开您的 Key。
- 本移植项目与原项目无直接关系；素材版权归原作者所有。
