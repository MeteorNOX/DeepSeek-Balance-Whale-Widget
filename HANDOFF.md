# HANDOFF — dsh-whale-widget 自定义开发环境

本文件面向 AI agent，是本环境的事实来源（single source of truth）。
人类向说明见 `README.md`；设计规格见 `whale-widget-prompt.md`。
最后校准：2026-09-19。标注「已实测」的条目为实测结果，未实测项已明确标注。

---

## 0. TL;DR

1. 源码唯一真身 = `lib/index.js`
2. 该文件已通过 **junction** 挂进 DSH 的 `desktop` profile → **改它即改插件，不存在第二份需要同步**
3. 前端调试走本地 harness（`:5599`），**存盘 + F5 即可，不必重启 DSH**
4. 只有「服务端逻辑」和「图片/音效素材」需重启 DSH Desktop
5. 改代码前先 `git switch -c <branch>`

---

## 1. 事实表

```yaml
workspace_root:   C:\Users\19721\vscode_files\fork_work\DeepSeek-Balance-Whale-Widget-main
main_code:        <workspace_root>\lib\index.js        # 2023 行 / 79KB，唯一代码文件
assets_dir:       <workspace_root>\assets\
harness_server:   <workspace_root>\dev\server.mjs
harness_page:     <workspace_root>\dev\index.html
vscode_launch:    <workspace_root>\.vscode\launch.json
vscode_settings:  <workspace_root>\.vscode\settings.json

dsh_home:         C:\Users\19721\.dsh
dsh_profile:      desktop                              # 注意：不是 web
dsh_plugin_path:  C:\Users\19721\.dsh\profiles\desktop\node_modules\dsh-whale-widget
                  # LinkType=Junction -> workspace_root（已实测）
dsh_size_file:    C:\Users\19721\.dsh\.dshw-size.json
dsh_usage_file:   C:\Users\19721\.dsh\.dshw-usage.json
backup_dir:       C:\Users\19721\.dsh\.whale-backup-20260919-095304\

dsh_ui:           http://127.0.0.1:43120
harness_url:      http://127.0.0.1:5599

plugin_pkg_name:  dsh-whale-widget
plugin_version:   0.2.10
cordis_name:      whale-balance-widget                 # lib/index.js:1417
inject:           ["webServer", "credentials"]         # lib/index.js:1418

node:             v24.16.0
git_head_setup:   89c27ea                              # 环境就绪态（无任何自定义）
```

### 状态（截至最后校准）

| 项 | 值 |
|---|---|
| git | 分支 `main`，工作区干净 |
| commits | `8bd8dcd` baseline → `f782ed1` harness → `9b948d4` → `89c27ea` docs |
| junction | 有效（`LinkType=Junction`） |
| Node 解析实测 | `require.resolve('dsh-whale-widget',{paths:[<profile>]})` → `<workspace_root>\lib\index.js` |
| harness | 10 条路由实测通过 |
| DSH 挂件 | 运行中，`balance.json` 返回真实数据 |
| upstream remote | 已配置但**从未 fetch**，故无 `upstream/main` |
| 幽灵副本 | **无**。全系统仅 backup_dir + junction 两处 |
| 触发重启前的进程 | DSH 进程启动时间须晚于 link 安装时间，否则仍在跑旧模块 |

---

## 2. 不变量与禁令

### MUST

- 代码改动只落在 `<workspace_root>\lib\index.js`
- 保持 `lib/index.js:2023` 的 `export { name, inject, apply }` 原样 ——
  `dev/server.mjs` 靠正则替换此行来抠出 `WIDGET_JS`。改它必须同步改 harness。
- 替换主图时保持 **610×610、alpha 透明**
- 动手前先开 git 分支
- 若改动属「服务端逻辑」，明确告知用户：harness 覆盖不到，须重启 DSH 验证

### NEVER

- 不要往 `C:\Users\19721\.dsh\` 复制/同步源码 —— junction 已保证同源
- 不要用 `--profile web` —— 插件不在该 profile，命令会静默无效
- 不要用 Live Server / Live Preview 打开本项目 —— 无 HTML 入口，只会得到目录列表
- 不要改 `package.json` 的 `main` / `dsh.bundle.patch`

### 环境前提（先探测）

- shell 沙箱可能禁止写 `C:\Users\19721\.dsh\`。执行 `dsh plugin` 前先探测：
  `New-Item C:\Users\19721\.dsh\.__probe -ItemType File`。
  被拒 → **必须让用户在自己的终端执行**，不要反复重试。
- `dsh` 在 PATH 上。其 stderr 有 crashpad 噪音（`registration_protocol_win.cc`），可忽略；
  它可能污染 cwd 产生 `debug.log`，属垃圾文件，可删。

---

## 3. 自校验命令

```powershell
$ws = 'C:\Users\19721\vscode_files\fork_work\DeepSeek-Balance-Whale-Widget-main'

# A. junction 是否有效      PASS = LinkType: Junction
Get-Item 'C:\Users\19721\.dsh\profiles\desktop\node_modules\dsh-whale-widget' |
  Select-Object Name, LinkType, Target

# B. DSH 实际加载哪个文件（决定性）  PASS = 输出 workspace 路径
node -e "const fs=require('fs');const p=require.resolve('dsh-whale-widget',{paths:['C:/Users/19721/.dsh/profiles/desktop']});console.log(p, fs.realpathSync(p))"

# C. harness 存活            PASS = 返回含 totalBalance 的 JSON
Invoke-WebRequest 'http://127.0.0.1:5599/dsh-whale/balance.json' -UseBasicParsing | % Content

# D. 真机挂件路由存活        PASS = 200；404 = 插件未加载
(Invoke-WebRequest 'http://127.0.0.1:43120/dsh-whale/widget.js' -UseBasicParsing).StatusCode

# E. harness 与真机是否同源  PASS = True
$a=(Invoke-WebRequest 'http://127.0.0.1:43120/dsh-whale/widget.js' -UseBasicParsing).Content
$b=(Invoke-WebRequest 'http://127.0.0.1:5599/dsh-whale/widget.js' -UseBasicParsing).Content
$a -eq $b

# F. git 状态
git -C $ws log --oneline; git -C $ws status --porcelain
```

`http://127.0.0.1:43120/` 返回 **401 属正常**（网页需登录态）；
`/dsh-whale/*` 路由无需登录，可直接探测。

---

## 4. 开发循环

### 启动 harness

```powershell
cd C:\Users\19721\vscode_files\fork_work\DeepSeek-Balance-Whale-Widget-main
node dev/server.mjs          # 或 VS Code 按 F5（读 .vscode/launch.json）
```

⚠️ **DSH 重启会杀掉以 agent 后台任务方式启动的 harness。**
应让用户自己用 F5 启动，不要依赖 agent 会话的存活。

### 改动类型 → 验证路径

| 改动类型 | harness(5599) | 真机(43120) | 成本 |
|---|---|---|---|
| 前端：CSS / 气泡 / 动画 / 拖拽 / 点击 | 存盘 → F5 | 需重启 | 秒级 / 一次重启 |
| 台词文案 | 存盘 → F5 | 需重启 | 秒级 |
| 图片 / 音效素材 | F5（无缓存） | 需重启（内存缓存） | 秒级 |
| 服务端：余额 / 定价 / 账本 / 凭证 | **覆盖不到** | 必须重启 | 一次重启 |

harness 免重启原理：`dev/server.mjs` 按 `lib/index.js` 的 **mtime** 判断变更，
变更则重新抠取 `WIDGET_JS`；素材每请求 `fs.readFile` 不缓存。
故 harness 进程本身也无需重启。

### harness 页面控制面板（`dev/index.html`）

可改：假余额 / 今日已用 / 峰谷开关 / 触发一轮消耗（递增 `last-turn.json` 的 `seq`）/
模拟错误 / 深浅底色。用于穷举 UI 状态，不消耗真实额度。

---

## 5. 代码地图（`lib/index.js`）

```
001–115      顶部配置常量
  015–021      IMAGE_CANDIDATES                      图片路径候选
  041–050      SOUND_SETS                            duck / fx1
  060–064      RUA_GIF_CANDIDATES
  068–071      PEAK_HOURS                            峰谷时段
  072–082      BASE_PRICE / PRO_PRICE / PRICING       定价表
  083–090      priceFor()
  095–108      isPeakTime()                          含周末全天谷价

116–1414     ★ 前端，整体包在 `const WIDGET_JS = `...`` 模板字符串内
  120–132      常量：REFRESH_MS / ANIM_MS / BUBBLE_MS / MIN_SCALE / MAX_SCALE
  134–179      CSS 数组（.dshwv-root / .dshwv-bubble / .dshwv-text …）
  184–420      DOM 构建 + 设置菜单控件
  422–446      state
  447          BUBBLE_STYLE_CLASS   # A→label B→amount P→period C→hint
  448–483      台词文案：pickOne / singleCenter / buildGroup1 / RANDOM_GROUPS
  485–616      applyBubbleLines / swapBubbleContent / showBubble / hideBubble
  619–657      showCostBubble / hideCostBubble
  672–707      fmt / animateAmount（数字滚动）
  709–728      render
  730–761      express / settle（气泡定位）
  763–827      refresh（拉 balance.json）
  828–861      配置默认值 / saveConfig（PUT size.json）
  910–965      setScale / setVol / setSoundSet
  967–1043     音效播放
  1045–1116    toggleMenu / snapCheck（边缘吸附）
  1118–1152    setupHitTest / isWhaleHit（610×610 alpha 判定）
  1153–1300    拖拽 / 点击 / 光标
  1388–1413    pollLastTurn（每 1s）

1417–1419    name / inject
1420–2021    apply(ctx)
  1432–1483    finalizeTurn / handleSessionEvent（每轮消耗分桶）
  1485–1511    loadGif / loadImage（⚠️ 内存缓存 → 换素材须重启）
  1513–1607    余额解析
  1608–1736    computeTodayUsage / 账本读写
  1737–1766    getBalance（调 https://api.deepseek.com/user/balance）
  1767–1833    readSizeConfig / writeSizeConfig
  1853–2022    HTTP 路由注册（8 条）
  2009–2014    tapIndex 注入 <script src="/dsh-whale/widget.js">

2023         export { name, inject, apply }   ← harness 依赖此行
```

---

## 6. HTTP 路由契约

前端硬编码绝对路径，**全部**由本插件注册。新增前端请求必须同步注册路由。

| 路由 | 方法 | 响应体 |
|---|---|---|
| `/dsh-whale/widget.js` | GET | `WIDGET_JS` 源码 |
| `/dsh-whale/balance.json` | GET | `{ok,totalBalance,currency,todayUsage,isPeak,updatedAt,usageMode}` 或 `{ok:false,error}` |
| `/dsh-whale/size.json` | GET | `{scale,sound,vol,soundSet,usageMode,peakMode,bubbleOn,turnCostOn,turnCostCloseMs,scrollGapOn,scrollGapPx}` |
| `/dsh-whale/size.json` | **PUT** | 同上（保存用，**不是 POST**） |
| `/dsh-whale/last-turn.json` | GET | `{ok,seq,turn,amount,tokens,ts}`；`seq` 递增 = 新的一轮 |
| `/dsh-whale/image.png` | GET | `assets/DSniang1.png`（回退 `DSniang02.png`） |
| `/dsh-whale/rua.gif` | GET | `assets/rua.gif` |
| `/dsh-whale/sound/press.mp3?set=duck\|fx1` | GET | `Ya1.mp3` / `D1.mp3` |
| `/dsh-whale/sound/release.mp3?set=duck\|fx1` | GET | `Ya2.mp3` / `D2.mp3` |

harness 额外提供（真机不存在）：`GET /__dev/state`、`POST /__dev/update`。

### harness 实现要点（改动 harness 前必读）

抠取 `WIDGET_JS` 的方式：把 `export { name, inject, apply }` 替换为
`export { name, inject, apply, WIDGET_JS }`，写入 `dev/.widget.mjs`，再
`import(pathToFileURL(...).href + '?t=' + Date.now())` 破除 ESM 缓存。

- **临时模块必须写在 `dev/` 下**：`lib/index.js:8` 用
  `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')` 推 `PACKAGE_ROOT`，
  只有 `dev/` 的上一级才是仓库根。放别处会导致素材路径全错。
- 该模块顶层**无副作用**（仅常量与函数定义，`apply()` 不被调用），
  故可安全 import，不会触发 API 调用或凭证读取。
- `lib/index.js` 语法错误时，harness 会把错误以红色浮层显示在页面上，便于定位。

---

## 7. Git

```
89c27ea  docs: HANDOFF.md            ← 环境就绪态（无任何自定义）
9b948d4  docs: HANDOFF.md
f782ed1  dev: harness + .vscode 配置
8bd8dcd  baseline: upstream v0.2.10（zip 解压原样）
```

`git_head_setup` 可能已因后续 commit 前移；用 `git log --oneline` 确认。

### 分支策略

```powershell
git switch -c <branch>                       # 动手
git switch main && git branch -D <branch>    # 失败则整条丢弃
```

### 回退

| 场景 | 命令 |
|---|---|
| 未提交的改动 | `git checkout -- lib/index.js` |
| 已提交，回到环境就绪态 | `git reset --hard 89c27ea` |
| 回到上游原样 | `git reset --hard 8bd8dcd` |
| 查看改动 | `git diff 89c27ea -- lib/index.js` |

**回退注意**

1. git 回退后**真机需重启**才生效；harness 刷新即可。
2. ⚠️ **挂件设置不在 git 内**：`dsh_size_file`（缩放/音量/模式）与 `dsh_usage_file`（账本）。
   设置被改坏时 git 无法恢复，须直接改/删这两个文件。
3. `dev/.widget.mjs` 被 gitignore，自动重建。

### 插件安装回滚（极端情况）

```powershell
dsh plugin --profile desktop remove dsh-whale-widget
dsh plugin --profile desktop add dsh-whale-widget@0.2.10
```

---

## 8. 故障模式表

| 症状 | 根因 | 处置 |
|---|---|---|
| 改了代码真机没反应 | ESM 模块缓存 + `imageBytes`/`gifBytes` 内存缓存 | 重启 DSH Desktop（托盘也退） |
| 真机挂件消失 | link 未生效 / profile 用错 | 跑自校验 A、B；确认 `desktop` |
| harness 白屏 + 左下红色浮层 | `lib/index.js` 语法错误（`WIDGET_JS` 被破坏） | 读浮层内容修语法，多为漏括号或反引号 |
| harness 报「未能定位 export 行」 | `lib/index.js:2023` 被改 | 还原该行，或更新 `dev/server.mjs` 的替换规则 |
| 点击鲸鱼无反应 / 判定区错位 | 图片非 610×610 | 换成 610×610 PNG |
| 主体图变形或错位 | 误删 `DSniang1.png` → 回退到 1026×1026 的 `DSniang02.png` | 恢复 `DSniang1.png` |
| 透明区域挡住下方 UI | 图片背景不透明（`alpha>10` 即视为命中） | 重做透明底 |
| harness `:5599` 打不开 | DSH 重启杀掉了 agent 的后台任务 | 让用户自行 `node dev/server.mjs` 或 F5 |
| `dsh plugin` 报 EPERM | shell 沙箱禁写 `.dsh` | 让用户在自己的终端执行 |
| `git diff upstream/main` 无输出 | 从未 `git fetch upstream` | 先 fetch |

**编辑 `WIDGET_JS` 的固有限制**：它是第 116–1414 行的模板字符串，
VS Code 不做语法高亮、无补全、无括号匹配。**每次改动后必须用 harness 验证。**

---

## 9. 本次计划改动（用户已选定）

**① 台词文案** — `lib/index.js:448–483`
`buildGroup1()`(450–465) 峰谷台词；`RANDOM_GROUPS`(467–474) 随机台词组；
`pickRandomLines()`(475–483) 按权重抽取。
元素格式 `{t:文本, s:样式, c:颜色, w:是否换行}`；样式代号见 `:447`。

**② 外观** — `lib/index.js`
CSS `134–179`；气泡定位 `730–761`；尺寸常量 `120–132`；缩放/音量 `910–965`；吸附 `1045–1116`。
调气泡位置的最快路径：真机 F12 → Elements 实时改 `.dshwv-root` / `.dshwv-bubble`，
满意后回填源码。

**③ 数据逻辑**（⚠️ harness 覆盖不到，须重启验证）— `lib/index.js`
峰谷时段 `68–71`；定价表 `72–82`；`isPeakTime` `95–108`；
账本 `1608–1736`；`getBalance` `1737–1766`。

---

## 10. 新会话引导语

```
项目：DSH 插件 dsh-whale-widget 自定义开发。
先完整读取仓库根目录的 HANDOFF.md —— 那是本环境的事实来源，
含路径、不变量、自校验命令、行号地图与故障模式表。
读完先执行第 3 节的自校验命令，确认环境状态后再动手。

工作目录：C:\Users\19721\vscode_files\fork_work\DeepSeek-Balance-Whale-Widget-main
主代码：lib\index.js（唯一；已 junction 挂进 DSH desktop profile，改它即改插件）

硬约束：
- 调试优先用 harness：node dev/server.mjs → http://127.0.0.1:5599，存盘 F5，不必重启 DSH
- 改服务端逻辑或换素材才需重启 DSH Desktop，此时提醒用户
- 替换主图必须 610x610、alpha 透明
- 勿改 lib/index.js:2023 的 export 行（harness 依赖）
- 动手前先开 git 分支

本次目标：<填写>

要求：动手前先说明「改哪个文件、哪几行、为什么」，并用 harness 验证后再交付。
```
