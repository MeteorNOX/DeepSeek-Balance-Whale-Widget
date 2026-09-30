# 订阅类额度：`quota.source` 契约与阿里云百炼 Token Plan

厂商额度过去只有一个判据：模板里有没有 `quota.url`。订阅类套餐（这里以阿里云百炼 Token Plan 为例）没有可查的额度接口，数字只能由本机 token 账本折算，旧写法直接回 `NO_QUOTA` —— 消费方拿到一个 51% 时，分不出它是接口读来的还是本地折出来的。

这份文档说三件事：契约长什么样、这一家的折算怎么算、以及哪些事**确认不了**。

## 一、契约

模板的 `quota` 段声明来源，分派与回落只写在 `lib/index.js` 的 `fetchModelQuota()` 一处：

| `quota.source` | 行为 |
| --- | --- |
| `api`（缺省） | 按 `quota.url` 取数；成功回包带 `source: 'api'`、`reliability: 'interface'` |
| `estimate` | 不查网络，交给同进程估算；回包带 `source: 'estimate'` 与 `reliability` |

- 同时声明 `source: 'api'` 与 `quota.fallback: 'estimate'` 的模板，在接口失败时才降级，并带出 `degradedFrom` / `degradedNote`；既没有可查接口、也没有估算来源时，仍然如实回 `NO_QUOTA`，不编数字。
- `reliability` 只给类别，不给数值：`calibrated` / `tier-table` / `tier-table-default` / `user-cap` / `unknown`。阈值怎么用属于消费方的决定。
- 同时带出两个原始出处字段：`capSource`（上限从哪来：`config` = 人从控制台抄的实测值，`tier-table:<档>` = 内置档位表）、`calibSource`（校准系数是配置写的还是没设）。
- 旧字段 `quota.local` 兼容一版：自定义模板没写 `source` 时不会突然认不出账。

## 二、这一家：阿里云百炼 Token Plan

### 为什么只能估算

官方的用量接口只有百分比、没有绝对值、没有按模型明细，而且要吃登录态 Cookie（走控制台网关，页面里跨域 fetch 会被 CORS 挡）。所以这里的读数是**本机折算**，不是官方读数。

### 折算口径

- Credits = 按量价（元 / 百万 token）× 100，价目表见 `lib/tokenplan-usage.js` 的 `PRICE_CNY_PER_M`。
- 两份输入账本：
  - `~/.dsh/dsh-usage/usage-ledger.json` —— 逐日逐模型的 token，由 `@linxin666/dsh-usage` 插件写，与本插件无关、跨重启；
  - `~/.dsh/.dshw-qwen.json` —— 本插件自己的实时账本（`days[date][model]`）。
  - 同一天两份都有时**按天取大**合并。
- 窗口：默认 30 天一期（`qwenPeriodDays`），起点取 `qwenWindowAnchor`，取不到就用 `subscribed` 或账本最早一天；控制台给了下次重置时刻就填 `qwenResetAt`，它优先。

### 档位上限：没有查询接口，只能人确认

`TIER_CAPS` 是控制台订阅总览页的四档月度额度：

| 档 | 每期 Credits |
| --- | --- |
| Lite | 11,500 |
| Essential | 25,500 |
| Standard | 45,000 |
| Pro | 180,000 |

**没有接口能查你在哪一档**，所以：默认按 Standard 算（`capSource: tier-table:default`）；知道自己是哪档就在配置里写 `qwenTier`；从控制台抄到实测上限就写 `qwenCap`（此时 `capSource: config`）。回包里的 `capSource` / `reliability` 就是给这件事用的 —— 它让你能分辨「这个百分比的分母是查来的、抄来的，还是内置表默认的」。

档位表会过期：官方调整过口径（早期按周记的 2,500 / 10,000 / 40,000 现在只作为历史值留在 `TIER_CAPS_WEEKLY`），过期时百分比就是编的 —— 这也是 `capSource` 要出现在回包里的原因。

### 失败三态

`classifyFailure()` 把 429 分成三类：每分钟限流（TPM，与剩余额度无关，只标 `rateLimitedAt`）、周期额度真耗尽（判成触顶候选，还要过 `capConfirmPct` 的确认闸）、免费额度用完（与套餐无关）。规则是**已确认的触顶优先于限流**。

### 只读路由

| 路由 | 内容 |
| --- | --- |
| `/dsh-whale/tokenplan.json` | 明细：`used` / `cap` / `pct` / 套餐期进度 / 账本来源 / 告警 / 失败标记 |
| `/dsh-whale/tokenplan-quota.json` | 上游 plan 同形：`ok` / `usedPct` / `remainPct` / `resetAt` / `level`，外加本文这套出处字段 |

## 三、配置

改 `~/.dsh/.dshw-tokenplan.json`（模块自带 5 秒缓存，最多 5 秒生效，不用重启）：

| 键 | 含义 | 默认 |
| --- | --- | --- |
| `qwenEnabled` | 总开关 | `true` |
| `qwenCap` | 上限 Credits；> 0 时优先于档位表 | `0`（按档位表） |
| `qwenTier` | `lite` / `essential` / `standard` / `pro` | `standard` |
| `qwenWarnPct` | 告警线 | `70` |
| `qwenCalib` | 折算校准系数 | `1` |
| `qwenPeriodDays` | 一期天数 | `30` |
| `qwenResetAt` | 下次重置时刻（精确到分或毫秒） | 空 |
| `qwenWindowAnchor` / `qwenWindowAnchorExact` | 窗口起点（日期 / 精确到分） | 空（用 `subscribed` 或账本最早一天） |
| `qwenAnchorSubtract` | 窗口首日「重置前已计」的 Credits | `0` |
| `qwenOfficialPct` / `qwenOfficialAt` / `qwenOfficialCap` | 抄一次控制台读数，用来看我方估算偏了多少 | 空 |
| `qwenCalibNote` | 校准系数的来源与时刻 | 空 |

## 四、两条命令

```bash
npm run check       # 接线、账本、模板、额度链通没通；一条命令给判定
npm run calibrate   # 拿控制台的两个读数对表，反算 qwenCalib
npm test            # 估算引擎与只读路由的零依赖回归
```

`calibrate` 的用法：把控制台此刻的百分比与时刻抄进 `qwenOfficialPct` / `qwenOfficialAt`，它会把官方折算值与本地估算摆在一起，并给出建议的 `qwenCalib = 官方 Credits ÷ 本地估算 Credits`。**只在长期系统性偏移时才动系数**，重置当天别拿它凑数。

## 五、已知边界

- 估算是本机折算，不是官方读数：同一时刻本机自估与控制台有过 4.4 / 8.2 / 15 倍的偏差（价目表未含隐藏消耗、窗口相位可能不同）。`reliability` 只说这个数靠什么撑住，百分比该不该直接显示、要不要设阈值，由消费方决定。
- 档位与重置时刻都需要人确认（见第二节），插件不猜。
- 模板本身不带任何本机语义：换成别的订阅类厂商，写的还是同一套 `source` / `fallback` 契约。
