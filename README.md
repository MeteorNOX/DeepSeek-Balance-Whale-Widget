# DS 小鲸鱼 · 独立 Windows 桌面版

> DS Desktop Whale · Standalone Windows Desktop Edition · v2.0.0

基于 [Tauri v2](https://tauri.app) 的 Windows 桌面桌宠 + DeepSeek 余额挂件：一只 Q 版小鲸鱼常驻桌面，实时展示余额与今日已用，自带本地记账、峰谷倒计时、模块化气泡、多供应商与模型路由，以及完全离线的智能抠图。

A Windows desktop pet + DeepSeek balance widget built with Tauri v2. It shows your account balance and today's usage in real time, and also ships local usage tracking, peak/off-peak countdown, modular bubbles, multi-supplier & model routing, and fully offline background removal. No browser extension and no third-party relay.

***

## 功能特性 · Features

### 桌宠本体

- **多状态形象**：生气 / 失落 / 害羞 / 疲惫 / 眨眼 / 半睁眼 / 被抚摸等状态自动或交互切换。
- **自定义挂件本体**：上传图片 → 智能抠图（Rust 原生、完全离线）→ 保存为自定义挂件组，按状态动态切换；可管理多个挂件组。
- **智能抠图**：内置 BiRefNet（birefnet-general-lite）模型与 onnxruntime，首次使用时按需下载/释放到本地，**全程无需联网推理、无需 Python**。
- **大小缩放**：挂件与气泡内容整体等比缩放，不产生「字与图两张皮」。
- **拖拽与边缘吸附**：按住拖动，松手后吸附屏幕四边；吸附距离随屏幕尺寸缩放，左侧吸附自动镜像翻转。
- **顶部吸附预留气泡区**：吸附到屏幕上沿时，气泡占据顶部预留区并完整显示、绝不超出屏幕，鲸鱼紧接在气泡下方；预留高度随挂件缩放等比变化，因此自定义大小与不同分辨率下都成立（吸附状态跨重启保持）。
- **鼠标穿透**：鲸鱼实体之外的透明区域不拦截点击，可直接操作其下方窗口。
- **互动与心情**：点击 / 长按 / 抚摸触发不同反应；失望、生气、害羞阈值与眨眼频率均可配置。
- **疲惫模式**：余额低于自定义阈值时自动切换疲惫表情并提示。
- **右键菜单**：喂养（打开充值页）、打开配置、隐藏桌宠、退出程序。
- **系统托盘**：显示/隐藏桌宠、打开配置、退出；同一时刻只允许一个实例，重复启动会唤回已有桌宠。

### 余额与记账

- **余额实时展示**：每 60 秒自动刷新，数值变化带滚动动画。
- **今日已用**：按余额差值本地记账，跨天自动归档，保留近 30 天历史。
- **多币种显示**：CNY / USD / EUR / JPY / GBP / HKD 切换，按汇率换算并缓存汇率结果。
- **失败可见**：取数失败或刚切换数据源时显示占位而非上一次的旧数字。

### Deepseek峰谷时段（谷价倒计时）

- **峰/谷标签 + 倒计时**：北京时间 09:00–12:00、14:00–18:00 为高峰，其余为空闲；实时显示当前时段与切换到下一时段的剩余时间。
- **峰谷提前预警**：进入/离开高峰前分档提醒（可开关、可配置提前分钟数）。

### 气泡

- **内置三行气泡**：余额金额 / 今日已用 / 峰谷倒计时，开箱即用。
- **模块化气泡**：自由组合文本、余额、今日已用、DS 峰谷倒计时、超链接、图片/动图六类模块；每个模块可单独设置字号、颜色、加粗/斜体/下划线、背景色、流光，并可上传字体文件。
- **气泡组管理**：新建 / 保存 / 切换 / 删除多个气泡组；编辑期间只在预览区生效，点击应用后才上屏。
- **气泡配色与重置**：气泡颜色、描边与预览实时联动，重置设置后立即生效。

### 台词与音效

- **自定义台词**：任意条数的气泡台词，支持轮播 / 随机两种播放模式，可配置间隔时长与波动幅度。
- **音效**：内置默认音效；支持上传自定义音效组（按下 / 松开 / 按下松开三种模式），音量可调。

### 供应商与模型路由

- **供应商管理**：余额数据源与各客户端（Claude Code / Codex 等）的供应商分别独立管理；每张卡片支持「应用 / 编辑 / 测试连接 / 详细账单 / 删除」，启用中的供应商受保护不会被误删。
- **预设库与图标**：内置来自 cc-switch 的供应商预设与 logo 素材，一键填充名称、请求地址、认证方式。
- **连接测试**：保存前一键测试连通性与鉴权。
- **详细账单**：按小时 / 天 / 月聚合的用量图表（ECharts），支持自定义时间区间与模型维度。
- **写入客户端配置**：把选定供应商一键写入 Claude Code / Codex 的配置文件，支持预览将要写入的文件内容、读取当前生效配置、编辑并抽取「通用配置片段」；旧版本遗留字段会自动清理。
- **模型路由**：在线拉取供应商模型列表并配置默认模型 / 模型映射。

### 系统与界面

- **开机自启**（可开关）。
- **三态主题**：浅色 / 深色 / 毛玻璃，仅作用于配置界面。
- **全局颜色**：一键调整界面主色调。
- **配置文件入口**：配置界面直接显示数据目录并可一键打开。
- **检查更新**：比对远端版本清单，有新版本时跳转发布页。
- **重置设置**：一键恢复出厂配置（含预览气泡颜色）。
- **统一提示体系**：轻提示 toast + 必要时的确认弹窗，全中文界面。

### 工程

- **DDD 分层架构**：`api → application → domain ← infrastructure`，`types` 为公共基础层，`shell` 为宿主外壳层；领域层通过仓储接口与依赖倒置解耦具体实现（详见 [1.md](./1.md)）。
- **纯原生前端**：HTML / CSS / JS，无前端框架、无打包步骤。
- **可测**：Rust 端 300+ 单元测试覆盖领域规则、用例与线缆契约。

***

## 环境要求 · Requirements

- Windows 10 / 11（自带 WebView2 运行时；缺失时安装包会引导安装）
- [Node.js](https://nodejs.org)（仅开发/构建需要）
- [Rust](https://www.rust-lang.org)（仅开发/构建需要，`rust-version = "1.77"`）

> 终端用户**无需安装 Python 或任何 AI/推理环境**——智能抠图所需的模型与 onnxruntime 已随程序分发，首次使用时释放到本地目录。

***

## 安装与运行 · Install & Run

### 直接运行

构建产物位于 `src-tauri/target/release/`：

| 文件                                                 | 说明                 |
| -------------------------------------------------- | ------------------ |
| `bundle/nsis/DS Desktop Whale_2.0.0_x64-setup.exe` | 标准安装包（当前用户模式，免管理员） |
| `DS Desktop Whale.exe`                             | 便携版，免安装，双击即用       |

### 从源码构建

```bash
# 安装前端依赖
npm install

# 开发运行（启动桌宠，可调试）
npm run dev

# 打包发布（生成 NSIS 安装包与便携版）
npm run build
```

***

## 首次使用 · First-run Setup

1. 手动启动程序时会自动打开「小鲸鱼设置」窗口（开机自启时不打扰）。
2. 在 **余额与模型路由配置 → 余额配置** 中新增一个供应商：选择预设（如 DeepSeek）或手工填写，填入 API Key。
3. 请求地址默认 `https://api.deepseek.com`，一般无需修改；保存前可点「测试连接」确认。
4. 保存并启用后，桌宠即刻开始拉取余额。
5. 需要给 Claude Code / Codex 配置模型时，切到对应客户端页签，用同一套供应商一键写入并应用。

> 随时可打开设置：右键鲸鱼 → 打开配置，或右键系统托盘图标 → 打开配置。

***

## 挂件本体与智能抠图 · Custom Widget & Matting

在「挂件配置 → 挂件本体」中可上传自定义图片作为桌宠的各个状态：

1. 点击「挂件本体」→ 新建 / 选择一个自定义挂件组。
2. 为某个状态上传图片，或点击「智能抠图」一键去背景；抠图在本地完成，可离线使用。
3. 保存后，桌宠会在对应状态下自动切换为该组图片。

***

## 数据存储 · Data Storage

所有配置与记账数据默认保存在主程序同级的 `data` 目录（安装目录不可写时回退 `%APPDATA%\DS Desktop Whale\`），不经过任何第三方平台：

```
<安装目录>\data\
├── config.json       # API Key / 请求地址 / 模型 / 挂件显示 / 台词 / 音效 / 开机自启
├── usage.json        # 小鲸鱼记账数据（含近 30 天历史归档）
├── rate_cache.json   # 汇率缓存
├── supplier\         # 供应商列表、凭证、模型目录与用量缓存
├── bubble\           # 模块化气泡：媒体文件 + 每个气泡组的 group.json
├── audio\            # 自定义音效组（按组名存放音频与 meta.json）
├── fonts\            # 上传的气泡字体
├── pic\              # 自定义挂件图片组（按组名 / 状态分类）
├── holiday\          # 峰谷日历缓存（每年一份 CN-<年份>.json）
└── ort\              # 智能抠图运行时（BiRefNet 模型 + onnxruntime）
```

API Key 仅保存在本机，程序直接请求各供应商官方接口。

***

## 目录结构 · Project Layout

```
frontend/                      # 编译期打进可执行文件的纯静态前端
├── html/                      # widget.html（桌宠窗口） / config.html（设置窗口）
├── css/
├── js/                        # 按职责拆分的原生模块（无框架、无打包）
└── assets/                    # 图标 / 挂件图 / 音效 / 字体 / 供应商预设与 logo

src-tauri/src/                 # Rust 后端（DDD 分层）
├── api/                       # 对前端的命令与线缆 DTO（camelCase）
├── application/               # 用例编排 + 仓储装配（registry / 组合根）
├── domain/                    # 领域模型与规则（model / service / repository）
├── infrastructure/            # 仓储实现、HTTP 客户端、系统能力
├── shell/                     # 宿主外壳：窗口与托盘
└── types/                     # 公共基础层：枚举、异常、工具、常量

scripts/                       # 一次性资源提取/同步脚本（预设、logo、图标、echarts）
```

***

## 常见问题 · FAQ

- **桌宠显示「尚未配置余额供应商」**：打开设置 → 余额配置，新增并启用一个供应商。
- **峰谷提示整行不见了**：峰谷是 DeepSeek 的计价规则，当前余额数据源不是 DeepSeek 时会自动隐藏。
- **法定节假日 / 补班日当天为什么没有高峰？**：假期与周六日的调休上班日都按谷价计，只有普通工作日有高峰。节假日安排按年自动获取并缓存，新一年的通知发布后会自动更新，不需要等版本升级。
- **峰谷日历取不到数据怎么办？**：无需操作。节假日数据由后端从内置的免费接口自动获取并缓存（免注册、免 AppKey），用户不需要配置任何接口地址或密钥；只有当所有免费接口都不可用时才会退化为自然周规则（不会把周末误判为高峰），网络恢复后下一次巡检会自动补齐。
- **关闭桌宠**：右键鲸鱼 → 隐藏桌宠（后台继续运行），或托盘 → 退出。
- **换电脑怎么迁移**：整个 `data` 目录随程序目录一起拷贝即可（便携版）。

***

## 致谢 · Acknowledgments

本项目由原 DSH 插件 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 独立化改造而来，感谢原作者 [MeteorNOX](https://github.com/MeteorNOX) 的创意与实现；供应商预设与 logo 素材提取自 cc-switch。许可证请以原仓库为准。

This project is derived from the original DSH extension [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget). Thanks to [MeteorNOX](https://github.com/MeteorNOX) for the original idea and implementation. Please refer to the original repository for licensing.
