# DSH 小鲸鱼余额挂件（DeepSeek Balance Whale Widget）

![DSH 小鲸鱼余额挂件](assets/DSH2.png)

DeepSeek Harness（DSH）Web 界面右下角的常驻余额挂件：小鲸鱼气泡图 + DeepSeek API 余额 + 今日已用 + 每轮对话消耗统计，每次打开界面自动启用。本项目是标准 DSH 插件包，可通过 `dsh plugin` 安装/卸载。

## 特性

- 🐋 **常驻自启**：随 DSH Web 界面每次打开自动出现（标准 DSH bundle 插件）
- 💰 **余额**：60 秒自动刷新 + 点击鲸鱼手动刷新；余额变化时数字**滚动动画**；瞬时网络抖动自动沿用最近余额不报错
- 📊 **今日已用**：两种模式任选（见下），显示今日消耗金额
  - **小鲸鱼记账（推荐，免令牌）**：不需要任何会话令牌，鲸鱼娘每次观测余额后用余额差值自动记账（`.dshw-usage.json`，跨天自动归零归档）
  - **实时·令牌**：填入平台会话令牌后直接调用平台用量接口，按**峰谷定价**（空闲 9:00–12:00 与 14:00–18:00 之外 / 高峰 9–12 与 14–18 点）实时换算今日已用
- 💬 **每轮对话消耗统计**：监听本机会话事件，每轮对话结束后弹出本轮消耗金额（精确 usage，非估算）
  - 菜单可开关「每轮对话后自动显示消耗金额」；「自动关闭时间」可自定义秒数（填 0 表示不自动关闭）
  - 消耗金额泡泡显示期间，余额变动不弹普通泡泡
- 🖱️ **拖拽 + 四边四分之一吸附**（左/右/上/下，角落可组合）
- 🔄 左吸附时整体**水平镜像翻转**（文字同步反向、带动画）
- 🧸 **按压 Q 弹**玩偶效果（按压时底部坐标不变）
- 🎚️ **汉堡菜单**（悬停鲸鱼右上角出现）：大小滑块（0.6–2.5 倍）、音效切换（小黄鸭 / 音效1）、音量调节、用量模式、峰谷提示文案（默认 / 梁文峰谷 / !?强强?!）、气泡开关、每轮消耗开关与自动关闭时间
- 🔊 **音效**：按压/松手音效（可选包内 mp3，缺失时静默降级）
- 💬 **随机台词**：点击气泡切换随机台词段（加权随机，含峰谷提示/今日已用/gif 动图/卖萌吐槽），再点一次关闭；气泡总显示 5 秒自动收起
- 📐 随浏览器窗口自动缩放；文字位置/字号与图片联动

## 目录结构

```text
dsh-whale-widget/
├── package.json          # DSH bundle 插件元数据
├── README.md             # 本文件
├── cordis.patch.yml      # 插件挂载声明
├── lib/
│   └── index.js          # 宿主侧插件本体
├── assets/
│   ├── DSH2.png          # README 顶部展示图
│   ├── DSniang1.png      # 小鲸鱼本体（cut-out，气泡由代码绘制）
│   ├── DSniang02.png     # 备用整图（兼容旧版手动安装路径）
│   ├── rua.gif           # 随机台词 gif（可选）
│   ├── Ya1.mp3 / Ya2.mp3 # 小黄鸭音效（可选）
│   └── D1.mp3 / D2.mp3   # 音效1（可选）
└── whale-widget-prompt.md # 完整规格/维护提示词
```

## 安装

### 方式 A：本地开发安装（当前项目）

在项目根目录（`DeepSeek-Balance-Whale-Widget-main`）执行：

```powershell
dsh plugin --profile web add link:.\dsh-whale-widget
```

说明：

- `dsh plugin` 会把参数转发给 pnpm，并在成功后自动把 `dsh-whale-widget` 加入 `dsh.profile.bundles`
- 使用 `link:` 会在 profile 的 `node_modules` 里链接到当前源码目录，方便继续改代码
- 安装完成后重启 `dsh web`，再 F5 刷新浏览器
- **如果之后移动了源码目录**，必须重新到新的项目根目录执行一次：
  ```powershell
  dsh plugin --profile web add link:.\dsh-whale-widget
  ```
  因为 `link:` 记录的是源目录的绝对路径；移动后旧链接会失效。若提示已存在/冲突，可先 `dsh plugin --profile web remove dsh-whale-widget` 再重新 add。

### 方式 B：发布到 npm 后安装

如果你把这个包发布到 npm：

```powershell
cd dsh-whale-widget
npm publish
```

然后任意机器上安装：

```powershell
dsh plugin --profile web add dsh-whale-widget
```

### 关于令牌（安装后必读）

> **默认不需要任何令牌。** 安装后只需配置 `DEEPSEEK_API_KEY`（拉取余额必需），「今日已用」会自动使用默认的**小鲸鱼记账**模式（余额差值本地记账），开箱即用。
>
> 「实时·令牌」模式用到的 `DEEPSEEK_PLATFORM_TOKEN`（DeepSeek 平台网页会话令牌）是**可选的**，仅在你想要更精确的实时用量换算时才需要配置。获取方式见下方「用量模式使用教程」。

## 卸载

```powershell
dsh plugin --profile web remove dsh-whale-widget
```

## 从旧手动安装升级

如果你之前按旧方式手动安装过（复制 `whale-balance.mjs` + 改 `cordis.patch.yml`），先清理：

```powershell
$web = "$env:USERPROFILE\.dsh\profiles\web"

Remove-Item "$web\whale-balance.mjs" -ErrorAction SilentlyContinue
Remove-Item "$web\whale-balance.cjs" -ErrorAction SilentlyContinue
Remove-Item "$web\DSniang1.png" -ErrorAction SilentlyContinue
Remove-Item "$web\DSniang02.png" -ErrorAction SilentlyContinue
```

然后编辑 `$web\cordis.patch.yml`，删除这段旧补丁：

```yaml
- insert:
    - id: whale-balance-widget
      name: ./whale-balance.mjs?v=1
```

如果里面只有这段，直接改成：

```yaml
[]
```

清理后再执行上面的安装命令。

## 用量模式使用教程

### 必需的凭据

- **`DEEPSEEK_API_KEY`**（必需）：DeepSeek API 密钥，用于拉取余额（`api.deepseek.com/user/balance`）。在 DSH 凭据服务中配置即可（`dsh` 的凭据管理界面 / `.dsh/.credentials.yaml`）。

### 两种用量模式

挂件的「今日已用」有两种模式，在**菜单 → 用量**中选择：

**① 小鲸鱼记账（推荐，默认）—— 完全不需要额外配置**

鲸鱼娘自己用**余额差值**记账：每次观测到余额下降就把差值累加到当天用量，跨天自动归零归档（保留 30 天）。只要配好了 `DEEPSEEK_API_KEY` 就能用，**开箱即用**。

- 账本文件：`$DSH_HOME/.dshw-usage.json`（自动生成）
- 优点：零配置、免令牌
- 说明：依赖「观测到的余额下降」累计，若 DSH 关闭期间有消耗会漏记；要精确请用令牌模式

**② 实时·令牌（可选）—— 需要 `DEEPSEEK_PLATFORM_TOKEN`**

鲸鱼娘直接调用 DeepSeek 平台用量接口，按**峰谷定价**实时换算今日已用，**精确到每小时的 token 用量**。

**令牌在哪获取：**
1. 浏览器打开并登录 **https://platform.deepseek.com**
2. 按 **F12** 打开开发者工具 → 切到 **Network（网络）** 标签
3. 在平台页面点击「用量」或刷新页面，找到名为 `usage/by_api_key/amount` 的请求
4. 点开该请求 → **Request Headers（请求标头）** → 复制 `Authorization` 的值（形如 `Bearer eyJ...` 的一长串）
5. 把整段值（含 `Bearer` 前缀或只要后面的 token 部分均可）配置为 DSH 凭据 `DEEPSEEK_PLATFORM_TOKEN`：
   ```powershell
   # 在 DSH 凭据服务中设置，例如编辑 $env:USERPROFILE\.dsh\.credentials.yaml
   # DEEPSEEK_PLATFORM_TOKEN: <你复制的令牌>
   ```
6. 重启 `dsh web`，在**菜单 → 用量**里选择「实时·令牌」

**说明：**
- ⚠️ **令牌非必需**：不配置时挂件自动使用默认的「小鲸鱼记账」模式，功能不受影响
- 该令牌是 DeepSeek **平台网页的会话令牌**（不是 `sk-` 开头的 API key），仅在登录平台网页时有效；重新登录后可能需要重新获取
- 接口不返回金额，只返回 token 分桶，挂件会按内置峰谷定价表换算成金额；定价表在 `lib/index.js` 顶部 `PRICING` 常量，DeepSeek 调价时可自行修改

### 每轮对话消耗（无需任何凭据）

「每轮对话消耗统计」直接监听 DSH 本机会话事件，按模型真实 usage 换算金额（与今日已用同一套峰谷定价表），**不需要** `DEEPSEEK_PLATFORM_TOKEN`。

## 验证

```powershell
dsh --profile web --dump-config | Select-String -Pattern "whale"

curl http://127.0.0.1:3080/dsh-whale/image.png
curl http://127.0.0.1:3080/dsh-whale/balance.json
curl http://127.0.0.1:3080/dsh-whale/size.json
curl http://127.0.0.1:3080/dsh-whale/last-turn.json
```

- `/dsh-whale/image.png` → 200 `image/png`
- `/dsh-whale/balance.json` → 200，含 `{"ok":true,"totalBalance":...,"currency":"CNY","todayUsage":...}`
- `/dsh-whale/size.json` → GET 返回配置；PUT 写入
- `/dsh-whale/last-turn.json` → 200，含最近一轮对话消耗 `{seq, turn, amount, tokens}`
- 浏览器 F5 后右下角出现挂件

## 常见问题

- **挂件不出现**：确认 `dsh plugin add` 成功；`dsh --profile web --dump-config` 里能看到 `dsh-whale-widget`；重启 `dsh web` 后 F5。
- **图片不显示**：确认 `assets/DSniang1.png` 在插件包内，且没有把旧文件放在 profile 里占用了同名路由。
- **余额报「未配置 DEEPSEEK_API_KEY」**：去 DSH 配置凭据。
- **今日已用显示 --**：记账模式下需要先跑一次余额观测（60 秒内自动完成）；令牌模式需要配置 `DEEPSEEK_PLATFORM_TOKEN`。
- **每轮消耗不显示**：确认菜单「每轮对话后自动显示消耗金额」已勾选；一轮对话必须完整结束（turn/end）才会结算。
- **没有声音**：确认 `assets/*.mp3` 在包内；若不想带音效文件，静默降级为无声音。
- **本地开发改了代码不生效**：使用 `link:` 安装时，修改源码后重启 `dsh web`（ESM 模块缓存）；如果用已发布版本，需要 `npm publish` 新版本后 `dsh plugin --profile web update dsh-whale-widget`。
- **自定义图片**：气泡由代码绘制（SVG），鲸鱼本体为 cut-out PNG，放在右下角 59.45%；换图需保证透明背景 cut-out，否则按 `whale-widget-prompt.md` 调整几何参数。

## 开发与维护

完整规格、视觉参数、架构结论和生成提示词见 `whale-widget-prompt.md`。修改文字位置、颜色、动画、吸附逻辑、台词组或定价表时参考该文件。
