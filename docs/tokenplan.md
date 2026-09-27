# 阿里 Token Plan 接入（本分支唯一的非上游功能面）

上游 v0.3.0 已经有「小鲸鱼记账 → 模型」与「订阅额度」两套通用机制，但没有阿里云
Token Plan 这条：套餐没有「拿 key 查余额」的接口，Credits 口径也只能从本地 token
账本估算。所以本分支只做三处接线，用量计算全部留在自家文件里：

| 位置 | 内容 |
| --- | --- |
| `lib/index.js` 顶部 | `import { installTokenPlan } from './tokenplan-server.js'` |
| `lib/index.js` `API_TEMPLATES` | 一条 `tokenplan` 模板（`kind:'quota'` + `quota.source: 'estimate'`：订阅额度不查 HTTP，同进程取估算） |
| `lib/index.js` `apply()` 内 | `installTokenPlan(ctx, { templates: API_TEMPLATES })` 一次调用 + disposer；`fetchModelQuota()` 里三行短路 |
| `lib/tokenplan-server.js` | 两条只读路由、事件流归属、实时账本、配置读写、`planSnapshot()` |
| `lib/tokenplan-usage.js` | 纯算法：token → Credits 换算、7 天窗口、30 天套餐期、失败四态分诊、告警档位 |

## 数据从哪来

1. `~/.dsh/dsh-usage/usage-ledger.json` —— 逐日逐模型 token（`@linxin666/dsh-usage` 插件写的，与本挂件无关，跨重启）。只取 `provider == tokenplan` 那一段。
2. `~/.dsh/.dshw-qwen.json` —— 挂件自己的实时账本（事件流逐步累加）+ 告警去重 + 触顶/限流信号。两份按天取大值合并（`mergeDays`），所以既不会漏掉本步还没落盘的量，也不会重复计。
3. `~/token-plan-tools/state/state.json` 的 `subscribed` —— 套餐起点（第一次调用日起算 7 天窗口与 30 天期）。

Credits 口径：按量价 × 100（1 Credit = ¥0.01），`PRICE_CNY_PER_M` 见 `tokenplan-usage.js`。**全是本地估算**，官方控制台另含隐藏消耗项，UI 一律标「估算」。

## 路由

| 路由 | 作用 |
| --- | --- |
| `/dsh-whale/tokenplan.json` | 明细快照（周期第几天、日均、按此节奏能否撑到重置、套餐到期、ROI、逐模型分布、告警态）+ `chain` 接线自检段（模板挂没挂、凭据解析得到吗） |
| `/dsh-whale/tokenplan-quota.json` | 与上游 `plan` 对象同形的读数镜像（`usedPct / remainPct / resetAt / level`，`level` 是自由文本尾巴「剩 x Cr · 周第 N/7 · 套餐第 D/30」）；挂件本身不再打它，留着给脚本验收 |

**这两条是全插件仅有的免鉴权路由**（直接 `ctx.webServer.register`，不套 `registerRoute`）：
上游 v0.3.0 起给自定义路由统一套了 connection 信任栅栏 —— `requestRejection()` 先查 Host/Origin
再查浏览器 cookie，没登录态一律 403/401（09-15 实测：连 `/dsh-whale/widget.js` 都回 401）。这两条只出
本地估算的用量数字，不含密钥与余额；写面一条都不开（配置只认文件）。

## 配置

配置文件 `~/.dsh/.dshw-tokenplan.json`（**不放 `.dshw-size.json`**：上游 `writeSizeConfig()`
整份重写 size 文件且只保留自己的白名单键，套餐键存在那里等于用户改一次设置就丢一次）。
首次启动会自动从旧 size 文件继承 `qwen*` 键、并补上 `qwenPlanStart`。

| 键 | 含义 | 默认 |
| --- | --- | --- |
| `qwenEnabled` | 总开关 | true |
| `qwenCap` | 周 Credits 上限；0 = 按 `qwenTier` 档位取 | 0 |
| `qwenTier` | `lite`/`standard`/`pro` = 2500/10000/40000 | standard |
| `qwenWarnPct` | 告警线 | 70 |
| `qwenCalib` | 估算校准系数（拿控制台真值反算） | 1 |
| `qwenWindowAnchor` | 7 天窗口起点 `YYYY-MM-DD`；空 = 用 `subscribed` 或账本最早一天 | 空 |
| `qwenPlanStart` / `qwenPlanDays` / `qwenPlanPriceCny` | 30 天套餐期与票价 | 自动取 `subscribed` / 30 / 139 |

改法：直接编辑 `~/.dsh/.dshw-tokenplan.json`（模块自带 5 秒缓存，改完最多 5 秒生效，不用重启）。
本机现值：`qwenCap: 0`（= 按 `standard` 档取 10,000）、`qwenWarnPct: 70`、
`qwenPlanStart: 2026-09-05`（从 `~/token-plan-tools/state/state.json` 的 `subscribed` 继承，
7 天窗口与 30 天套餐期都锚在这一天）、`qwenCalib: 1`。拿控制台真值反算：`qwenCalib = 控制台 Credits ÷ 本地估算 Credits`。

## 挂件侧怎么配（一次性）

`~/.dsh/.dshw-api.json` 里已预置这条模型（`id: api_tokenplan`、`keyRef: TOKENPLAN_API_KEY`、
自定义单价 0.1 / 0.8 / 2.7 元·每百万 token，正好等于 Credits ÷ 100），菜单里看得见就能用。手动重建的步骤是：

1. 菜单 →「小鲸鱼记账 → 模型」→ 添加，厂商选 **阿里 Token Plan（订阅）**；
2. **不用填 Base URL**：额度读数按 `quota.source: 'estimate'` 分派到同进程估算（→ `tokenplan.planSnapshot()`），
   不绕 HTTP，所以既不吃栅栏的 401，也不依赖端口；
3. 密钥凭据名模板已带（`TOKENPLAN_API_KEY`，配置里只存名字不存明文）；只有「测试连通性」会真打套餐网关的 `/v1/models`；
4. 泡泡里加「订阅额度·Token Plan」模块（编辑器里有现成的一键芯片），占位符 `{plan}` / `{plan_left}` / `{plan_reset}`。

## 用了「额度重置卡」之后：窗口必须重设（09-15 补）

活动发的重置卡把**本周期已用的 Credits 当场清零**，30 天套餐期不变。挂件这边窗口全靠
`qwenWindowAnchor` 推，不重设就会把重置前那几天的量继续算进新窗口 ——
09-15 实测重置之后读数仍是 已用 10,658 / 10,000 = 106.6%、告警「套餐额度已触顶」，就是这个。

改 `~/.dsh/.dshw-tokenplan.json` 三个键（模块 5 秒重读，但**这几个键是新代码才认的，要重启一次 d web**）：

| 键 | 填什么 |
| --- | --- |
| `qwenWindowAnchorExact` | 重置生效的时刻：`2026-09-15T18:05` 或毫秒数。控制台若直接给「下次重置时间」，用 重置时刻 − 7 天 更准 |
| `qwenAnchorSubtract` | 锚点那天里**重置前**已计的 Credits：= 当天本地合计 − 控制台本周期已用（本地账本只到「天」，拆不开只能外部告诉它） |
| `qwenAnchorSubtractNote` | 给人看的备注，如 `09-15 18:05 用了重置卡` |

只填 `qwenWindowAnchor`（纯日期）也能把窗口挪过去，但那天的重置前用量会一起算进来（偏高）。
扣减跟着**锚点所在那一天**走，换到下一个窗口自动落空，不会一直往下扣（`test/tokenplan-usage.test.mjs` 钉住了）。
校准另一头：`qwenCalib` 只在控制台数字和本地估算长期系统性偏移时才动，重置当天别拿它凑数。

## 验收

```bash
cd /e/S_Software/deepseek-harness/plugins/DeepSeek-Balance-Whale-Widget
npm test                          # 25（算法）+ 15（宿主仿真：拿真实账本副本喂路由）
node scripts/check-tokenplan.mjs  # 打此刻线上 3080 那两条只读路由 + 读注册表文件
# 上游自己算出来的那份（planSupport / plan.ok）在栅栏后面，要带登录态：
# dsh web 启动时打印的 http://127.0.0.1:3080/?token=... → curl -c jar "<该 URL>" → 再 curl -b jar 打路由
# 探针实例（--profile whale030 --port 3081）的 token 就在它自己的 stdout 日志里，同样打法
```

## 2026-09-23：上限从 10,000 变 45,000，估算与页面差 4.4 倍（配置已改，代码没改）

- 页面读数：额度上限 **45,000 Credits**、本周期已用 **4.83%**（≈2,174 Cr）。而 `TIER_CAPS` 里写的是
  lite 2,500 / standard 10,000 / pro 40,000 —— **档位表一过期，百分比就是编的**：当时挂件显示 94.3%。
- 已把 `~/.dsh/.dshw-tokenplan.json` 的 `qwenCap` 从 0（=按档位自动）改成 **45000**，并写 `qwenCapNote` 记来源与时刻；
  备份 `.dshw-tokenplan.json.bak-20260923-cap45000`。改完 30 秒内生效（`SUMMARY_TTL_MS`），不用重启。
- **`qwenCalib` 仍是 1，没有去凑页面的数**：同一时间窗本地按 token 折算 9,587 Cr vs 页面 2,174 Cr，差 4.41 倍；
  而页面的统计周期**起止时刻**我们没有分钟级锚点（429 报文曾回过 `reset at ... 07:14:00 UTC`，相位不在 0 点），
  所以现在既可能是价目表错、也可能是窗口相位不同 —— 拿单个读数去凑系数，会把两种可能一起藏掉。宁可高估。
## 09-23 下午：额度单位搞错了，是「月」不是「周」——官方真数与接口都取到了

本人登录控制台后从订阅页取到权威读数（这三条以后别再重新翻）：

- **档位额度是月度**：Lite 11,500 / Essential 25,500 / **Standard 45,000** / Pro 180,000 Credits 每「月」，
  来源是订阅总览页四张档位卡；此前 `TIER_CAPS` 里的 2,500/10,000/40,000 是按「周」记的老口径，**数值与单位双双过期**。
- **本周期与重置时刻**：`startTime` 2026-09-05 15:05:52、`endTime`（= 重置）2026-10-06 00:00:00，剩余 12 天。
- **官方用量接口只有百分比**：`zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage` 回
  `{per1MonthPercentage, per1MonthResetTime}`，没有已用绝对值、没有上限、没有按模型明细；
  走的是 `bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway` 这一层控制台网关，**要登录态 Cookie**，
  跨域 fetch 在页面里会被 CORS 挡（我方试过），所以只能在已登录的浏览器里读，或走 CDP 附着。

代码跟着改了三件（本轮提交）：

1. `TIER_CAPS` 换成官方月度四档（含 essential），旧的周表另存为 `TIER_CAPS_WEEKLY` 备官方再切回去；
2. 窗口长度与重置时刻**改成跟着套餐走**：新增 `qwenPeriodDays`（默认 30）与 `qwenResetAt`，
   `currentWindow(anchor, now, periodDays, resetAt)` 给了 resetAt 就以官方那个时刻为准；
   柱子仍是 7 格，但一格变成 `ceil(周期天数/7)` 天（月周期 = 5 天一格），**used 与柱子合计的同源不变量保持成立**；
3. 顺带抓到并修掉一个自埋的雷：分格后 `future` 若拿「格起点时刻」与「今日零点」比，起点带时刻（用过重置卡）
   会把今天误标成未来格，used 直接归零 —— 现在按那一天判。

对表结论（**没有据此改系数**）：官方 10.97% × 45,000 = **4,936 Credits**，我方同周期估算 **40,355 Credits**，差 **8.2 倍**；
面板「本周期总 token 157.95M（缓存 140.70M / 命中率 89%）」vs 我方台账 qwen3.8-flash 单项 **2,391.6M**，差 **15 倍**。
两边缓存命中率接近（89% vs 91%）说明不是同一批请求被重复计，而是**要么面板只覆盖一类用量，要么我们的分账把非套餐调用记进来了**——
这一条已写进工单第二问（那个百分比 96 分钟跳 6 个百分点，本地增量只够解释 0.5 个百分点，本身就不是平滑计数器）。

## 对表校准：scripts/calibrate-tokenplan.mjs（09-23 新加，npm run calibrate）

两条口径先说死，免得又拿一个读数去凑系数：

- **`--from` 不给就不写盘。** 同一个页面读数（09-23 14:30 读到 4.83% × 45,000 ≈ 2,174 Cr），
  窗口取"今天 00:00 起"→ qwenCalib ≈ 0.530；取"昨天 15:14 起"→ ≈ 0.2342，**相差 2.26 倍**。
  系数与统计周期相位是同一件事的两面，页面不把起止时刻给你，任何一个系数都是猜的；
- 读数时刻也要 `--at` 传准：事件流是带时间戳的（`.dshw-usage.json` 的 `events`），
  本地折算与页面读数不在同一时刻，差的就是中间那段时间的用量。

两条路二选一，**优先两点法**（它绕开"不知道窗口起点"这个死结）：

1. 单点 + 页面起点：`--cap 45000 --pct 4.83 --at "2026-09-23 14:30" --from "2026-09-22 15:14" --write`
2. 两点法：同一个周期内取两次页面读数，`--cap 45000 --pct 4.83 --at "2026-09-23 14:30" --pct2 <第二次百分比> --at2 "2026-09-23 20:10"`
   —— 只比两个读数之差与本地事件流同段增量，与统计周期起点无关；中间跨了重置会失真，脚本看到增量异常就拒。

跑法：

```bash
node scripts/calibrate-tokenplan.mjs --cap 45000 --pct 4.83 --at '2026-09-23 14:30'   --from '2026-09-22 15:14'            # 页面上「本周期」的起始时刻，精确到分钟才加 --write
```

加了 `--write` 才会一次改四件：`qwenCap`、`qwenCalib`、`qwenWindowAnchorExact`、`qwenCapNote`/`qwenCalibNote`，
并先落一份 `.dshw-tokenplan.json.bak-<时刻>`；约 30 秒内生效，不用重启 dsh web。
气泡悬停明细第二行会写出「上限来源 / 校准」的出处（`tier-table:standard` 就是内置档位表，未对表；`config` 才是抄来的实测值）——
2026-09-23 那次把页面的 4.8% 显示成 94.3%，就是因为当时这行没处说，没人知道分母是哪来的。

本窗口对表结论（截至 09-23 14:30，`--from` 未定时按 09-22 15:14 的相位试算）：这批 549.9M token 页面折 3.95 Cr/百万，
现用价目表给 16.88 Cr/百万，**差 4.27 倍** —— 与上限从 10,000 变 45,000（4.5 倍）同量级，
怀疑阿里云改的是 Credit 的单位而非容量；这条正是工单要问清的第一问。在答复到之前 `qwenCalib` 保持 1（宁可高估）。

- 待阿里云工单答复（底稿 `~/token-plan-tools/工单草稿-tokenplan额度-20260923.md`：额度页报错带请求 ID
  `aa27d350-6352-4b73-aadc-9f437b0be774`、45,000 的构成、1 Credit 与各 token 类型的换算表、用量查询接口）。
  拿到对照表后要做的事，按顺序：① 若单价与现用三项不符 → 改 `tokenplan-usage.js` 的价目表并补一条断言；
  ② 若重置相位确定 → 把 `qwenWindowAnchorExact` 填成分钟级；③ 只剩换算比例不对时才动 `qwenCalib`。
- 一条判据（下次怀疑估算时先跑这个，别先看气泡）：把 `dsh-usage/usage-ledger.json` 当天三档 token 手算一遍，
  与 `curl -s http://127.0.0.1:3080/dsh-whale/tokenplan.json` 的 `used` 对照 —— 本轮 09-22 手算 5,358.7 与台账逐字相等，
  说明**挂件内部没有算错，错的是喂进去的单价表或窗口**；只有页面数与这两者对不上时，才是口径问题。

## 已知边界（相对 0.2.x 那份私有 fork）

- **显示面换成上游那套**：0.2.x 自己写的气泡/红点/告警持久化/悬停 tooltip（本会话消耗、派活读数、台词分池、账户隔离）这一轮**没跟过来**，明细只能从 `/dsh-whale/tokenplan.json` 读。要哪一块再单独挑。
- 「今日已用」这一栏走上游的会话事件估算，`matchIds` 只填了套餐独有的 `qwen3.x-*`；`glm-5.2`、`deepseek-v4-*` 这几个与别的路由同名的模型不掺进来（宁少不串），所以这一栏比 Credits 口径略低。周额度百分比本身不受影响：那是按 `provider` 归属算的。
- 上游的单价不分峰谷，套餐夜间 5 折（22:00–08:00）只体现在我们自己的 Credits 估算里。
- 0.2.x 的 `display: qwen`（点鲸鱼在两个账户间切）被上游的模块化泡泡取代；`~/.dsh/.dshw-size.json` 里那条
  `theme: mint` 也随上游整份重写丢了（09-15 实测：新版 `writeSizeConfig()` 用位置参数整份重写，白名单外
  的键一律丢，`qwen*` 与 `theme` 都没保住 —— 这正是套餐配置必须自家一份文件的原因）。鲸鱼形象改用「角色」：
  `~/.dsh/whale-roles/` 已放好薄荷青鲸与黑化鲸（置顶=排在列表最前），但**当前用哪一只是浏览器 localStorage 里的
  `dshw-role`**，服务端给不了 —— 要在菜单「角色」里点一次。

## 09-15 顺手修的一个真 bug（`tokenplan-usage.js`）

`classifyFailure()` 旧判定把**套餐周额度真耗尽**算成 `throttle`：那条报文是
`429 … Your token-plan 1-week quota has been exhausted. The quota will reset at …`，
`status===429` 这条兜底排在前面就把它吃掉了，结果真触顶永远不标（只会显示成限流）。
同时 `AllocationQuota.FreeTierOnly`（免费额度「用完即停」，403）反倒被兜底判成 `cap`。
现在加 `CAP_HARD_RE` 排在 429 之前，`FREE_QUOTA_RE` 补 `free.?tier.?only`。四类实测：
周额度耗尽 → `cap`；TPM `error-code#token-limit` → `throttle`；`FreeTierOnly` → `freeQuota`；
`Insufficient Balance` → `cap`。09-07 那条「429 一律不算触顶」的教训仍由 `CAP_CONFIRM_PCT`（估算用量 ≥85% 才敢抬告警）把关。

这一处 09-15 已同时挑回 `main`（`fb0a6a2`，两份测试都钉住了用例；
用 `git worktree` 出去改，没在挂件工作副本里切分支 —— 切分支会把线上正在读的资源文件换掉）。

**公开 PR #74 的处置（2026-09-15 本人定）**：不关，也不需要重开 —— 要的功能基本都有了，后续在用的过程中再改。
作者这轮没回只是单方面沉默；这个仓库上游正在大改主体结构（客户端整块搬进 `assets/whale-widget.js`、
泡泡引擎重写），改版期不回 PR 属常态。**不要把 DSH 那条「官方零回应就把判据从等回音改成探代码状态」的尺子套到这家** ——
一家一个样，对外判据按各仓自己的政策与实际动作看。
## 泡泡那几行怎么排（先量再改）

套餐那条泡占的是挂件里固定的白泡泡，三条预算与折行悬崖见 [bubble-fit.md](bubble-fit.md)；
尺子一条命令：`node scripts/bubble-fit-check.mjs --live --stress --run`。

## 和上游那套「按会话事件估算」的口径对照（09-15 实测）

上游 v0.3.0 自己就有一条估算路（百炼模板 `noBalanceApi` + `priceFor()` + `apiAttributeEvent()`），
不是只有我们在算。差的是**它没有阿里的价目**：内置 `PRICING` 只有 DeepSeek 几档，`_default` 就是 DeepSeek Flash 价
（缓存 0.02 / 输入 1 / 输出 4 元·每百万），自定义单价要从注册表按 `matchIds` 子串匹配才进得来。
拿同一批真实事件（`~/.dsh/dsh-usage/usage-ledger.json` 的 token 分类）对，折算成 Credits（元 ×100）：

| 日期 | 我们（0.1 / 0.8 / 2.7） | 上游@默认价·谷 | 上游@默认价·峰 | 上游@我们的单价 |
| --- | --- | --- | --- | --- |
| 09-06 | 2,999.3 | 1,989.1（-33.7%） | 3,978.3（+32.6%） | 2,999.3（0） |
| 09-07 | 3,370.0 | 1,982.0（-41.2%） | 3,963.9（+17.6%） | 3,370.0（0） |
| 09-13 | 3,936.6 | 2,542.7（-35.4%） | 5,085.3（+29.2%） | 3,936.6（0） |
| 09-15 | 3,355.3 | 2,659.3（-20.7%） | 5,318.7（+58.5%） | 3,355.3（0） |
| 8 天合计 | 20,598.1 | 13,523.8（**-34.3%**） | 27,047.6（**+31.3%**） | 逐日 0 |

误差方向由**缓存价**决定：qwen3.8-flash 缓存命中 0.10 元，DeepSeek base 0.02 元，差 5 倍；
而重度日九成的 token 是缓存读（09-15：缓存 154.8M / 输入 16.9M / 输出 1.6M），等于把最大的一块整个算漏。
注册表那条补上 `matchIds` 之后，上游那条路就和我们同源（最后一列差 0）—— 这一步不改代码，只改 `~/.dsh/.dshw-api.json`。

另外两条别踩：

1. 上游的「订阅额度自动累计」（`apiQuotaAutoUsed` 取 `tokensTotal`）单位是 **token 数**，不是 Credits，
   代码里自己也写了「单位是金额时自动统计意义不成立 → 回退手动值」。阿里是 Credits = 按量价 ×100，
   把 tokensTotal 当已用会差五万倍量级（09-15：1.75 亿 tokens 对 3,377 Credits）。
   我们的 `quota: { source: 'estimate' }` 分派正是为了绕开这条，别去接它。
2. 上游的事件归属**只按模型名子串、不看 provider**：`matchIds` 填了 `qwen3.7-max`，百炼那些带日期的快照
   （`qwen3.7-max-2026-05-17`、`qwen3.8-max-0902`）也会被归到套餐这条上，泡泡那行「今日已用」会偏大。
   **我们自己的周 Credits 有 provider 过滤，不受这个影响**；要精确就把 matchIds 收窄到只有套餐提供的模型名。

还有一处上游自己踩过的坑可以对照：`reasoningTokens` 曾被单独累加，输出侧按输出价重复计费，
实测偏高约一倍，09-14 才由 issue #89 / PR #83 修正（dsh 保证 reasoning ⊆ output）。我们从头只按 output 计，没这个包袱。

## 0.2.x 那套设计搬回来了（09-15）

上一版只动了字号，被判「修改得很差」：v0.3.0 的模板体系里没有套餐专属文本、没有台词词库、也没有周期时间标。
这一轮三样都接进上游的结构，**全在客户端 `assets/whale-widget.js`，改完硬刷新页面即生效**（上游按 mtime 重读，无需重启 dsh web）。

### 1. 套餐文本不再只有百分比

数据链：`lib/index.js:1914` 那句 `entry.plan = await fetchModelQuota(m)` 把整份 planSnapshot 交给前端，字段没被模板映射裁掉，
所以加占位符不用碰服务端。`bubbleContentTokenMap` 的套餐分支新增：

| 占位符 | 渲染出来 |
| --- | --- |
| `{plan_cr}` `{plan_cr_left}` `{plan_cr_total}` | 3,405 / 6,595 / 10,000 —— 整数 Credits、千分位（上游 `apiFmtQuotaNum` 会把数折成「万/亿」，套餐数字不适用） |
| `{plan_today}` | 今日 Credits |
| `{plan_window}` | `周第 1/7 天` ← 就是「时间标」 |
| `{plan_period}` `{plan_days_left}` | `套餐第 11/30 天` / `剩 20 天` |
| `{plan_all}` | `整期已用 48.8% · 预算 42,857 Cr` |
| `{plan_pace}` | `日均 341 Cr · 照这烧法还能撑 29 天` |
| `{plan_tone}` | 按当前额度状态挑一句台词（见下节） |
| `{plan_est}` | `估算` 二字，只有本地口径非空 —— 数字旁边必须带着它 |

编辑器里 `?` 的占位符说明（`bubbleTplHelpItems`）同步补了，GUI 里能直接看见。

### 2. 台词分档，而且串不到别人家

0.2.x 靠一个 `scope: 'ds' | 'qwen' | 'both'` 的加权池。v0.3.0 里这件事由结构承担：随机模块自带 `modelId`，
台词文本走同一张占位符表（新抽的 `bubbleApplyTokens`：只换算、不写回 —— 词库条目是共享的），
于是套餐台词只能拿到套餐的数，DeepSeek 的金额串不进来，反过来也一样。`bubblePlanTone(p)` 六档，按优先级取：

1. 触顶（`pct >= 100`，或命中过额度错误且不是存疑）
2. 被限流（`rateLimitedAt`：每分钟 token 打满，不是周额度尽）
3. 报不足但账上有钱（`quotaHitSuspectAt`，提醒去控制台核）
4. 九成以上
5. 到告警线（默认 70%，读 `p.alert.warnPct`）
6. 宽裕（含「这期套餐还剩 N 天」「照今天的烧法会在重置前 N 天见底」这类带真实节奏的句子）

### 3. 时间标跟着秒走

`registerIfCountdown()` 原先只认峰谷倒计时；现在模板里出现 `{plan_reset|plan_window|plan_period|plan_all|plan_pace|plan_today|quota_reset}`
的行也注册进同一个每秒 ticker，跨零点、跨周、跨套餐期都不用重开页面。`{plan_tone}` 故意不在名单里（台词不该每秒换一句）。
另外给 `bubbleCountdownTick` 的配色补了 `if (bubbleIsPeakCount(x.mod))` —— 不然套餐行会被峰谷逻辑顺手涂成红/绿。

### 4. 现在这两屏长这样（三行，其余进悬停）

0.2.x 的泡泡就是三行：时间标 / 大字数字 / 一句台词，明细在 tooltip。第一版我误把明细堆进泡泡（五行），
本人一句「我们之前的文本有这么拥挤嘛」判回来了。现在照原样：

    周第 1/7 天 · 估算      ← 5 档，时间标与口径标注同一行
    4,458 Cr              ← 20 档大字，rgb 走 indigo
    这周才吃了 4,458 Cr      ← 2 档，{plan_tone} 一句（分档见上）

第二屏（点气泡 tapAdvance 切过来）是台词屏：4 档一句长台词 + 3 档倒计时，两行。

明细全在**悬停 tooltip**：新函数 `bubblePlanTip(modelId)` 拼 14 行（周期与重置、今日与日均、照这烧法还能撑几天、
套餐第几天与到期日、整期预算与按此节奏、票价日均、换成按量多少钱与 ROI、主力三个模型、锚点来源与校准系数、
有减卡说明时带上、告警级别）。挂法是把整只泡泡的 title 设上（沿 `parentEl.closest('.dshwv-pop')` 往上找）—— 上游本来就用原生 title 做提示，零侵入。
不能挂在文本框上：`.dshwv-text` 写着 `pointer-events:none`，title 放它身上永远浮不出来（这条有静态守护）。
这一屏没有套餐模块就清空 title，不会把上一屏的字留在鼠标底下。

句子为什么短：一行只装得下十几个字（560u ÷ 44u ≈ 12 个汉字），所以 `bubblePlanTone` 六档全部给短句，
长句只出现在台词屏与 tooltip。量过：明细屏文字栈 269u、台词屏 186u（文本框 448u），三行全单行，
最坏值（42,857 Cr、`周第 7/7 天 · 估算`、台词落在宽裕档）也是单行；泡本身没变大。

### 5. 当天踩到的两格

**台词进不了占位符表。** 表是按模块类型分支的，guard 里只有 `balance/today/quota/plan`，`random` 不在内 ——
台词屏上直接显示 `{plan_tone}` 这串花括号，零报错。修法是两处 guard（渲染用的 `bubbleContentTokenMap` 与
? 说明用的 `bubbleTplHelpItems`）都放 `random`；`test/whale-bubble-text.test.mjs` 第三条守住它。

**尺子抄了一份文案。** `bubble-fit-check.mjs` 原来自己拼 `plan_tone` 的句子，于是「真机上句子多长」这件事
量不到 —— 第一版五行拥挤就是被这个盲区放过去的。现在抽了 `scripts/whale-text.mjs`：把客户端那几个纯函数
切出来共用，尺子的 SAMPLE/STRESS 改喂「一份套餐数据」，字由客户端算；句子改短改长，尺子自动跟。

两条验收（都不需要重启 dsh web）：

    node scripts/bubble-text-smoke.mjs     # 字对不对：每屏最终文本 + 悬停明细行数，漏换占位符就退出码 1
    node scripts/bubble-fit-check.mjs --live --stress --run --quick   # 会不会溢出：三条预算 560u/弦宽/448u

冒烟要读 HTTP，所以不进 `npm test`（离线会假红）。

### 6. 皮肤不进展示

`~/.dsh/whale-roles/` 下那些是本机导入的角色，走上游的角色导入规则，**不参与展示**：
`--shot` 默认拿仓库自带的 `assets/whale-mint.png` 当模特，要拍本机某张皮肤得显式 `--role <名字>`。
给作者看的三张图（`docs/img/`）因此与本机皮肤无关，也不含真实用量（走的是 SAMPLE 那套假数字）。

## 7. 超宽那档改了判据（09-15）

上游的兜底是折行：一行超 560u 就多赔一整行高，台词屏两句长话能把整屏顶出轮廓。
现在改成「定宽裁掉 + 悬停滚出」——鼠标停在泡泡上，超出的那截横向滚出来，移开回到起点。
效果是 0.2.x「长文字先长气泡」那格想解决的事（不丢字），但不换泡泡尺寸。

两处必须同改，少一处就是丢字：

- 每行都得有内层 `.dshwv-trowtx`（滚的是它，行只负责裁）；
- 滚的触发挂在整只 `.dshwv-pop` 的 `pointerover` 上（同 tooltip 那个理由）。

量法与验收组见 `docs/bubble-fit.md`。
