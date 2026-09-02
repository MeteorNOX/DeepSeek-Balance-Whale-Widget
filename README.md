# DeepSeek Whale Naijing Widget（奶鲸余额挂件）

![奶鲸余额挂件](assets/DSH2.png)

DeepSeek Harness（DSH）Web 界面右下角的常驻余额挂件。基于 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 修改的 **奶鲸版**：含 **四套形象切换**（默认 / 奶鲸 / 糖鲸 / 睡觉）、**六套音效**、**奶鲸空闲自动睡觉 + zzz 动画**、**代码模块化**。本插件是标准 DSH bundle 插件包。

> 与原版的差异一览：
>
> - 🎭 形象菜单新增 **奶鲸**（参考奶龙爱音），四选一（默认 / 奶鲸 / 糖鲸 / 睡觉）
> - 😴 **奶鲸空闲睡觉**：选中奶鲸形象后 10 秒无操作自动切换到睡觉形象 + 漂浮 ZZZ 动画；点击/对话交互自动唤醒
> - 🔊 音效新增 **爱音笑**、**奶龙笑**，共六套可选
> - 🛣️ 路由前缀改为 `/dsh-whale-naijing/`，插件 id 改为 `dsh-whale-naijing`
> - 📦 奶鲸形象已压缩至 310KB（原图 4MB → 310KB，压缩 92.4%）
> - 🏗️ **代码模块化**：拆分为 `constants.js` / `widget.js` / `index.js`，改配置去 constants、改前端去 widget、改宿主去 index

## 特性

- 🐋 **常驻自启**：随 DSH Web 界面每次打开自动出现（标准 DSH bundle 插件）
- 🎭 **形象切换**：菜单第一行「形象」四选一——默认 / 奶鲸 / 糖鲸 / 睡觉，即时换图、持久保存
- 😴 **奶鲸空闲睡觉**：奶鲸形象下 10 秒无操作自动切换到睡觉形象 + 漂浮 Z/Z/Z 动画；点击或对话交互时自动唤醒（先切回奶鲸，再执行原有交互逻辑）
- 💰 **余额**：60 秒自动刷新 + 点击鲸鱼手动刷新；余额变化时数字**滚动动画**；瞬时网络抖动自动沿用最近余额不报错
- 📊 **今日已用**：两种模式任选（见下），显示今日消耗金额
  - **小鲸鱼记账（推荐，免令牌）**：不需要任何会话令牌，鲸鱼娘每次观测余额后用余额差值自动记账
  - **实时·令牌**：填入平台会话令牌后直接调用平台用量接口，按**峰谷定价**实时换算今日已用
- 💬 **每轮对话消耗统计**：监听本机会话事件，每轮对话结束后弹出本轮消耗金额（精确 usage，非估算）
- 🖱️ **拖拽 + 四边四分之一吸附**，左吸附整体水平镜像翻转（文字同步反向）
- 🧸 **按压 Q 弹**玩偶效果 + 按压/松手音效
- 🎚️ **汉堡菜单**：形象、大小滑块、音效、音量、用量模式、峰谷文案、气泡开关、每轮消耗开关与自动关闭时间、滚动条避让
- 💬 **随机台词**：点击气泡切换随机台词段（加权随机，含峰谷提示/今日已用/gif/卖萌吐槽），5 秒自动收起
- 📐 随浏览器窗口自动缩放；文字位置/字号与图片联动

## 目录结构

```text
DSH-Whale-Widget/
├── package.json            # DSH bundle 插件元数据（dsh.bundle.patch → cordis.patch.yml）
├── cordis.patch.yml        # 插件挂载声明（id: dsh-whale-naijing）
├── lib/
│   ├── index.js            # 宿主插件入口（name/inject/apply，HTTP 路由、余额、记账、会话事件）
│   ├── constants.js        # 宿主常量 + 纯函数（皮肤表/音效表/定价表/峰谷判定/夹紧函数）
│   └── widget.js           # 前端 WIDGET_JS 模板字符串（浏览器侧 CSS/DOM/逻辑）
├── test/
│   └── helpers.test.mjs    # 纯函数自检（npm test），从 constants.js 直接导入
├── tools/
│   └── zzz-position.html   # ZZZ 位置调试器（实时拖拽/点击定位+大小调整+复制CSS）
├── assets/
│   ├── DSH2.png            # README 顶部展示图
│   ├── DSniang1.png        # 默认形象（原版鲸鱼娘，610×610 cut-out）
│   ├── DSniang-naijing.png # 奶鲸形象（1179×1179 cut-out，压缩 310KB）
│   ├── DSniang-sleep.png   # 睡觉形象（1179×1179 cut-out，自动触发）
│   ├── DSniang02.png       # 备用整图（兼容旧版手动安装路径）
│   ├── rua.gif             # 随机台词 gif（可选）
│   ├── Ya1.mp3 / Ya2.mp3   # 小黄鸭音效（按下/松手）
│   ├── D1.mp3 / D2.mp3     # 音效1（按下/松手）
│   ├── T1.mp3 / T2.mp3     # 爱音笑音效（按下/松手，分两段）
│   └── L1.mp3 / L2.mp3     # 奶龙笑音效（按下/松手，不分割）
└── whale-widget-prompt.md  # 完整规格/维护提示词
```

## 安装

### 方式 A：从 GitHub 安装（推荐）

无需本地克隆，一条命令安装：

```powershell
dsh plugin --profile web add github:kirintea/DSH-Whale-Widget
```

- 装完后插件会出现在 DSH 的**插件管理页面**里，可直接在页面里更新
- 网络环境需要代理时，先设置代理环境变量再执行：
  ```powershell
  $env:http_proxy="http://<ip>:<port>"; $env:https_proxy="http://<ip>:<port>"; dsh plugin --profile web add github:kirintea/DSH-Whale-Widget
  ```

### 方式 B：本地 link 安装（开发用）

在仓库根目录（`package.json` 所在目录）执行：

```powershell
dsh plugin --profile web add link:.
```

- `link:.` 表示链接当前目录，仓库根目录本身就是插件包（**不要**写成 `link:.\dsh-whale-naijing` 这种带子目录的路径）
- 安装后重启 DSH，右下角出现鲸鱼娘即成功

## 形象切换

菜单「形象」可在四套形象间即时切换，选择写入 `size.json` 的 `skin` 字段，重启保持。

|    默认    |    奶鲸    |     糖鲸     | 睡觉（自动触发） |
| :---------: | :---------: | :----------: | :--------------: |
|            |            |              |                  |
| `default` | `naijing` | `tangjing` |    `sleep`    |

### 奶鲸睡觉功能

选中「奶鲸」形象后，**10 秒无操作**自动触发：

1. 切换到睡觉形象 + 漂浮 Z/Z/Z 动画
2. 点击鲸鱼 → 先唤醒（切回奶鲸）→ 再触发原有交互（音效/Q 弹/气泡）
3. 对话结束弹消耗泡泡 → 先唤醒 → 再显示金额
4. 睡觉状态不会覆盖用户皮肤配置（始终保存为 `naijing`）
5. 切换到非奶鲸形象时自动停止睡觉计时器

> 空闲时间默认 10 秒，可在 `lib/widget.js` 中修改 `IDLE_MS` 值。ZZZ 位置可通过 `tools/zzz-position.html` 调试器实时调整。

## 音效说明

菜单「音效」五选一，按压时播 `press`，松手播 `release`；对应 mp3 缺失时静默降级为无声。

| 音效集       | 名称   | 按下    | 松手    | 说明                  |
| ------------ | ------ | ------- | ------- | --------------------- |
| `duck`     | 小黄鸭 | Ya1.mp3 | Ya2.mp3 | 经典黄鸭叫            |
| `fx1`      | 音效1  | D1.mp3  | D2.mp3  | 默认音效              |
| `tangxiao` | 爱音笑 | T1.mp3  | T2.mp3  | 按下前 0.9s，松手后段 |
| `laugh`    | 奶龙笑 | L1.mp3  | L2.mp3  | 完整笑声（不分割）    |

## 令牌与用量模式

> **默认不需要任何令牌。** 只需配置 `DEEPSEEK_API_KEY`（拉取余额必需），「今日已用」自动使用**小鲸鱼记账**模式（余额差值本地记账），开箱即用。

- **小鲸鱼记账（默认）**：零配置，观测余额差值自动记账，账本在 `$DSH_HOME/.dshw-usage.json`，跨天归零、保留 30 天
- **实时·令牌（可选）**：需要 `DEEPSEEK_PLATFORM_TOKEN`（DeepSeek 平台网页会话令牌）。按**峰谷定价**精确换算
- **每轮对话消耗**：监听本机会话事件按真实 usage 结算，无需任何令牌

## HTTP 接口（宿主路由）

所有路由前缀为 `/dsh-whale-naijing/`：

| 路由                                                   | 说明                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `GET image.png?skin=default\|naijing\|tangjing\|sleep`  | 返回对应形象 PNG                                                           |
| `GET balance.json`                                   | 余额 + 今日已用（永远 200 + JSON）                                         |
| `GET last-turn.json`                                 | 最近一轮对话消耗                                                           |
| `GET size.json` / `PUT`                            | 挂件配置（scale/vol/soundSet/usageMode/**skin** 等），PUT 写盘持久化 |
| `GET sound/press.mp3?set=…`、`release.mp3?set=…` | 按音效集返回按压/松手音效                                                  |
| `GET widget.js`                                      | 前端挂件源码（tapIndex 自动注入`<script defer>`）                        |

## 验证

```powershell
dsh --profile web --dump-config | Select-String -Pattern "naijing"
curl http://127.0.0.1:3080/dsh-whale-naijing/balance.json
curl http://127.0.0.1:3080/dsh-whale-naijing/size.json
```

## 开发与维护

### 模块结构

| 文件                 | 职责                        | 改什么来这里                |
| -------------------- | --------------------------- | --------------------------- |
| `lib/constants.js` | 宿主常量 + 纯函数           | 加角色/音效/调价/改峰谷时段 |
| `lib/widget.js`    | 前端浏览器 JS（模板字符串） | 改 UI/CSS/动画/菜单/交互    |
| `lib/index.js`     | 宿主插件入口 + apply()      | 改路由/余额/记账/会话逻辑   |

### 自检

```powershell
npm test   # 运行 24 项纯函数自检（不需要 DSH 运行时）
```

### ZZZ 位置调试

```powershell
# 直接用浏览器打开，拖拽/点击实时调整位置和大小，复制 CSS 给代码
start tools/zzz-position.html
```

### 新增形象

1. 制作正方形透明 cut-out PNG（建议 1179×1179，其它形象以脸宽为基准对齐）
2. 放入 `assets/DSniang-xxx.png`
3. 在 `lib/constants.js` 的 `SKIN_FILES` 和 `normalizeSkin` 中加一条
4. 在 `lib/widget.js` 的 `skinSelect`、`prefetchSkins`、`setSkin` 中加对应项
5. 重启 DSH 生效

### 新增音效

1. 放入 `assets/` 目录（mp3 格式，按下/松手各一个）
2. 在 `lib/constants.js` 的 `SOUND_SETS` 和 `normalizeSoundSet` 中加一条
3. 在 `lib/widget.js` 的 `soundSelect` 和 `normalizeSoundSetClient` 中加对应项
4. 重启 DSH 生效

## 常见问题

- **挂件不出现**：确认插件已登记进 profile 的 `dsh.profile.bundles` 且 `pnpm install` 成功；重启 DSH。
- **改了图片/代码不生效**：宿主对图片按 skin 内存缓存，需**重启 DSH**；前端 JS 同理。
- **换图后人物变形**：画布不是正方形（CSS 按正方形拉伸）。
- **没有声音**：确认 `assets/*.mp3` 在包内；缺失时静默降级。
- **余额报「未配置 DEEPSEEK_API_KEY」**：去 DSH 凭据服务配置。
- **奶鲸不睡觉**：确认选中的是「奶鲸」形象（非默认）；10 秒内无任何鼠标操作。

## 许可证

本项目基于 **MIT License** 开源。原版作者 [MeteorNOX](https://github.com/MeteorNOX)，感谢他们的优秀工作。
