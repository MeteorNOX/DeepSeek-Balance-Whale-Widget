# 余额协议公开来源核查

核查日期：2026-10-05。这里只读取公开官网文档、官方 SDK 和开源服务端代码；没有向任何余额接口发送用户密钥，也没有进行第三方账户实测。仓库 `main` 的内容代表下面固定提交的实现，不代表所有中转站部署版本。品牌名称、OpenAI 兼容路径和字段名都不能单独证明币种、账户范围或额度性质。

## 先处理的三个实际问题

1. **100,000,000 是已证实的不限额哨兵。** OneAPI、NewAPI、Veloera 的 `GetSubscription` 在 `token.UnlimitedQuota` 为真时把三个 `*_limit_usd` 都赋为 `100000000`，随后账单消耗接口仍返回消耗。因此 `99999761.20` 可以只是该哨兵减消耗，不能显示成账户资金。不要把所有大数判为不限额；应以命中的协议和不限额字段/明确哨兵契约识别。
2. **NewAPI 原生 `token_usage` 的 `total_*` 是原始 quota。** `total_available = token.RemainQuota`、`total_used = token.UsedQuota`，不能因为名字是 `total_available` 就直接当美元。`QuotaPerUnit` 默认 `500000`；公开 `/api/status` 返回实际 `quota_per_unit` 等元数据。当前代码还存在 `credit_summary` 控制器，其 `total_used` 固定为 `0 // not supported currently`，该值不是可靠消费计数器；本次没有找到它在所查路由中的公开注册，因此不据此猜测新路径。
3. **NewAPI 当前注册路径带尾斜杠。** 路由由 `/api`、`/usage`、`/token`、`GET("/")` 组成，即 `/api/usage/token/`。不同部署的斜杠规范化与 `redirect: error` 可能冲突。优先使用源码精确路径，并在同源请求预算内尝试固定的无尾斜杠拼写 `/api/usage/token`；它只是路径兼容别名，不是新品牌/协议，也不依赖任何响应的 `Location`。

## 有出处的候选注册表

下面有 **13 个带来源的注册项**，覆盖若干协议族，其中 SiliconFlow 两个地区使用相同路径。它们不是“13 个不同品牌都已实测”，也不是每次刷新必须全部请求的列表。四个账单路径实际构成两组双请求协议；`/api/status` 是元数据；需要管理凭据的条目不能作为普通推理 key 的盲探测候选。

| # | 注册项 / GET 路径 | 前置条件、凭据 | 结果与注意事项 | 来源 |
|---|---|---|---|---|
| 1 | NewAPI `/api/usage/token/`，同源兼容别名 `/api/usage/token` | 普通服务 API token，Bearer；只读 token 鉴权 | 同一协议的两种路径拼写，共享请求上限；`data.object=token_usage`、安全整数 raw quota、granted=used+available；`unlimited_quota` 为布尔值 | [N1][N2][N3] |
| 2 | `/dashboard/billing/subscription` | OneAPI/NewAPI/Veloera 普通 API token；OneHub `OpenaiAuth` | 与 #3 配对；额度、范围、币种需按具体契约核验 | [B1][B2][B3][B4] |
| 3 | `/dashboard/billing/usage` | 同上 | `total_usage / 100` 还原的是站点展示额度单位，未必 USD | [B1][B2][B3][B4] |
| 4 | `/v1/dashboard/billing/subscription` | 同上，源码明确注册的别名 | 与 #5 配对；不能把四条路径拼成更多未经证实协议 | [B1][B2][B3][B4] |
| 5 | `/v1/dashboard/billing/usage` | 同上，源码明确注册的别名 | 同 #3 | [B1][B2][B3][B4] |
| 6 | `/api/status` | OneAPI/NewAPI 等站点公开元数据；无需发送 API key | 读取白名单 `quota_per_unit`、`display_in_currency`，NewAPI 还有 `quota_display_type`、`usd_exchange_rate`；不作为余额样本 | [M1][M2][N2] |
| 7 | `/api/user/self` | 站点控制台会话或用户管理 access token/PAT，**不是普通推理 token**；版本可能要求额外权限 | 账户级 `data.quota`、`data.used_quota` raw quota；只用显式专用认证配置启用，不获取/缓存其余个人信息 | [A1][A2][A3] |
| 8 | OpenRouter `https://openrouter.ai/api/v1/credits` | **Management key**；官方 SDK 当前明确要求 | 账户级 USD：`data.total_credits - data.total_usage` | [O1][O2] |
| 9 | OpenRouter `https://openrouter.ai/api/v1/key` | 当前认证 API key，Bearer | 密钥级 USD，优先 `data.limit_remaining`；`data.usage` 是该 key 的消费，不是账户总消费 | [O3] |
| 10 | LiteLLM `{proxy}/key/info` | 当前虚拟 key 可查自身；管理角色/授权用户能查其他获授权 key | 省略 `key` query 即取 Authorization key；`info.max_budget - info.spend` 是该 key 当前预算窗口余量 | [L1][L2][L3] |
| 11 | SiliconFlow `https://api.siliconflow.cn/v1/user/info` | 普通 API key，Bearer | 账户级 `data.totalBalance`；不要只取 `data.balance` | [S1] |
| 12 | SiliconFlow `https://api.siliconflow.com/v1/user/info` | 国际站普通 API key，Bearer | 相同字段；不能把中国站 key 自动发送国际站，反之亦然 | [S2] |
| 13 | DeepSeek `https://api.deepseek.com/user/balance` | 普通 API key，Bearer | `balance_infos[]` 各币种 `total_balance` 数字字符串；币种为 `CNY` 或 `USD` | [D1][D2] |

反向代理前缀来自用户已经选择/绑定的连接，不属于新增服务端路径证据。不要自动尝试独立账单域名、任意 `/api/balance`、`/wallet`、`/credit_grants` 等本次未核实路径。命中官方域名可以确定官方族；自建兼容站仍需校验响应契约与单位元数据，不能仅信 `system_name` 文本。

## 各协议族的金额与不限额语义

### OneAPI / NewAPI / Veloera：兼容账单

共同基础：订阅端取得 `remainQuota + usedQuota`；usage 端取得消耗后乘 `100` 输出为 `total_usage`。普通 API token 可调用，范围受服务端设置影响：`DisplayTokenStatEnabled=true` 时取当前 token 的额度，否则取用户账户额度。

- **OneAPI**：`DisplayInCurrencyEnabled=true` 时除 `QuotaPerUnit`；false 时直接使用 raw quota。默认 `QuotaPerUnit=500*1000.0`，默认两个 display 标志为 true。[B1][Q1]
- **NewAPI**：当前实现明确注释 `*_USD` 按“站点展示类型”解释。USD 分支除 `QuotaPerUnit`；CNY 分支先除再乘 `USDExchangeRate`；TOKENS 分支保持原始数值。因此后缀 `_usd` 不是可靠的实际币种证据。[B2]
- **Veloera**：所查提交与 OneAPI 类似，由 `DisplayInCurrencyEnabled` 决定是否除 `QuotaPerUnit`；默认除数也是 `500000`。[B3][Q3]
- 以上三者只有在存在 token 且 `UnlimitedQuota=true` 时把额度改为 `100000000`。金额阈值不能替代该实现条件；未知站点恰好返回同一数值时应避免把它记作真实资金，优先寻找原生不限额标志。
- `/api/status` 有单位与展示元数据，但所查 OneAPI/NewAPI 状态响应**没有** `DisplayTokenStatEnabled`，因此元数据本身不能完全解除账单的账户/密钥范围歧义。[M1][M2]

### NewAPI：原生 token usage

源码返回：

```json
{
  "code": true,
  "message": "ok",
  "data": {
    "object": "token_usage",
    "total_granted": "RemainQuota + UsedQuota 的原始 quota",
    "total_used": "UsedQuota 的原始 quota",
    "total_available": "RemainQuota 的原始 quota",
    "unlimited_quota": true,
    "expires_at": "秒级时间戳，永久有效转换为 0"
  }
}
```

上面字符串是字段说明，不是实际示例值；实际 `total_*` 为 Go 整数，且 `total_granted=total_used+total_available`。自动识别要求三者都能以 JavaScript 安全整数精确表示，并满足这项关系；混入金额单位、分数、越过安全整数范围或加总矛盾的响应不自动确认。确认 `token_usage` 契约后应以 `quota_per_unit` 转换 raw quota，而不是把原值当资金。默认除数来源明确，但自建站可以更改；存在有效单位元数据时优先使用实际值。

`unlimited_quota=true` 表示当前 key 不设这一额度上限，不表示用户账户无限资金；此时余额应为 null，不限额标签独立显示，`total_used` 仍可作为该 key 的消费计数器。`TokenAuthReadOnly` 允许已耗尽或已过期 token 查询只读信息，显式禁用 token 会拒绝；用户被禁用返回权限错误。[N1][N3]

### OneHub：与其它 forks 的重要区别

OneHub `GetSubscription` **没有**上述 `100000000` 赋值。有限额 token 取 token quota；不限额 token 改取用户 `quota` 与 `used_quota`。usage 端也随同切换为用户消耗。[B4]

因此一个不限额 token 的兼容账单可以返回真实账户余额，另一个有限额 token 同路径却返回密钥额度。仅凭这个响应形状无法可靠识别范围切换。不能把 OneAPI 的哨兵行为套用到整个 OneHub 家族。显示金额也受 `DisplayInCurrencyEnabled` 和 `QuotaPerUnit` 控制；默认除数 `500000`。[Q4]

### OpenRouter

`/credits` 是已认证用户的购买与已用总 credits；当前官方 SDK 明写 **Management key required**。账户余额为 USD 的 `total_credits-total_usage`。普通推理 key 在这条管理接口被拒绝，不意味着推理 key 无效，更不能据此终止所有该 key 可用的只读接口。[O1][O2]

`/key` 是当前 key 的信息。`limit` 为该 key USD 限额，`limit_remaining` 为剩余限额；`usage` 为该 key 的总 OpenRouter credit 消费。`limit_reset` 和 `include_byok_in_limit` 会影响限额口径；有 `limit_remaining` 时不得盲目用 lifetime `limit-usage` 重建。[O3]

官方 limits 文档进一步明确 `limit: number | null // Credit limit for the key, or null if unlimited`，`limit_remaining` 也注明 `null if unlimited`。因此可以把这两个 null 按该官方契约识别为 **key 不限额**，但不是无限账户资金。[O4] `rate_limit` 的文档则明确写“Legacy ... Will always return -1”，**该 -1 只属于废弃速率限制字段，不是余额无限哨兵**。[O3]

### LiteLLM

`GET /key/info` 的 `key` query 参数默认采用 Authorization 中的 key；因此查询自身不需要把 key 再复制到 URL。权限函数允许管理员、只读管理员、自身 key，以及具备对应用户/团队权限的调用者，不能任意查询别人的 key。[L1]

`info.spend` 是当前预算窗口的 USD 消耗：源码特别说明当 `budget_duration` 存在时，它不是 lifetime 消耗。`info.max_budget` 是对 spend 生效的限额，`budget_duration` / `budget_reset_at` 应参与计量基准判定。[L1][L3]

认证检查只在 `max_budget is not None` 时执行该 key 预算检查，因此 null 表示没有此 key 的预算上限；团队、用户、组织等约束仍可能生效。**不能把 0 或负数统一当不限额**；源码对有限数值执行 `spend >= max_budget` 检查。[L2]

### SiliconFlow

官方 OpenAPI 有三个数字字符串示例：`balance="0.88"`、`chargeBalance="88.00"`、`totalBalance="88.88"`。这支持优先读取 `totalBalance`；只读 `balance` 会漏掉充值部分。schema 没有累计 used 字段，也没有不限额布尔值或负值哨兵定义。[S1][S2]

API schema 本身没有币种字段。中国价格页采用 `¥`，国际价格页采用 `$`，因此 cn→CNY、com→USD 是有官方区域定价支持的映射，但不是响应自带币种的契约；非官方镜像不能自动套用这一映射。国际条款仅说付款使用平台标明币种。[S3][S4][S5]

### DeepSeek

官方文档明确 `currency` 取 `CNY` 或 `USD`；`total_balance` 是含赠送与充值的总可用余额；`granted_balance` 是未过期赠送余额；`topped_up_balance` 为充值余额。应选择明确币种，不能把不同币种相加。[D1]

`is_available` 表示余额是否足够调用 API，**不是不限额标志**。接口未给累计消耗字段，也未给大数/负数/空值无限哨兵。保持余额计数器语义即可；普通 API key 的 Bearer 认证来自官方基础调用说明。[D1][D2]

## 对有界顺序探测的直接约束

- 候选注册项要记录所需凭据类型、精确路径、响应 discriminator、金额字段、单位转换、scope、不限额规则和计数器周期；缓存命中的是完整契约，不只是 adapter 名称。
- 先尝试已确认的命中缓存；失效后按有限列表顺序找路径。精确 slash 路径优先，不靠自动重定向搬运认证。
- `404/405`、HTML、JSON shape 不匹配属于候选不匹配；`429/5xx/timeout` 属于临时失败。401/403 必须结合该候选的权限要求分类：管理接口拒绝普通 key 不能证明 key 全局失效。
- 有原生 `token_usage`、DeepSeek 明确币种、OpenRouter 明确 `limit_remaining` 等强契约时自动确认该**具体范围**；不要再要求用户只为选择已知字段而手工填映射。
- 兼容 billing 的真实币种或账户/key scope 仍有歧义时，不把猜测提升为账户资金；继续有界寻找更明确的原生协议，或显示准确的不限额/待确认状态。
- `credit_summary.total_used=0`、OpenRouter legacy `rate_limit=-1`、DeepSeek `is_available` 都不能冒充余额或消费计数器。

## 固定源码与官方文档来源

开源源码核查提交：OneAPI `8df4a2670b98266bd287c698243fff327d9748cf`；NewAPI `1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5`；Veloera `6525dfce816beaa270e78f0d8b762e19e54d13b8`；OneHub `387f8bf16ed0d601fdede7ade378adb10aa1a35a`。

[B1]: https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/controller/billing.go
[B2]: https://github.com/QuantumNous/new-api/blob/1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5/controller/billing.go
[B3]: https://github.com/Veloera/Veloera/blob/6525dfce816beaa270e78f0d8b762e19e54d13b8/controller/billing.go
[B4]: https://github.com/MartialBE/one-hub/blob/387f8bf16ed0d601fdede7ade378adb10aa1a35a/controller/billing.go
[N1]: https://github.com/QuantumNous/new-api/blob/1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5/controller/token.go
[N2]: https://github.com/QuantumNous/new-api/blob/1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5/router/api-router.go
[N3]: https://github.com/QuantumNous/new-api/blob/1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5/middleware/auth.go
[Q1]: https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/common/config/config.go
[Q3]: https://github.com/Veloera/Veloera/blob/6525dfce816beaa270e78f0d8b762e19e54d13b8/common/constants.go
[Q4]: https://github.com/MartialBE/one-hub/blob/387f8bf16ed0d601fdede7ade378adb10aa1a35a/common/config/constants.go
[M1]: https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/controller/misc.go
[M2]: https://github.com/QuantumNous/new-api/blob/1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5/controller/misc.go
[A1]: https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/middleware/auth.go
[A2]: https://github.com/QuantumNous/new-api/blob/1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5/controller/user.go
[A3]: https://github.com/MartialBE/one-hub/blob/387f8bf16ed0d601fdede7ade378adb10aa1a35a/router/api-router.go
[O1]: https://github.com/OpenRouterTeam/typescript-sdk/blob/main/docs/sdks/credits/README.mdx
[O2]: https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/operations/getcredits.ts
[O3]: https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/operations/getcurrentkey.ts
[O4]: https://openrouter.ai/docs/api/reference/limits.md
[L1]: https://github.com/BerriAI/litellm/blob/main/litellm/proxy/management_endpoints/key_management_endpoints.py
[L2]: https://github.com/BerriAI/litellm/blob/main/litellm/proxy/auth/auth_checks.py
[L3]: https://github.com/BerriAI/litellm/blob/main/litellm/proxy/_types.py
[S1]: https://github.com/siliconflow/siliconcloud/blob/main/openapi.yaml
[S2]: https://docs.siliconflow.com/en/api-reference/userinfo/get-user-info.md
[S3]: https://www.siliconflow.cn/pricing
[S4]: https://www.siliconflow.com/pricing
[S5]: https://docs.siliconflow.com/en/legals/terms-of-service.md
[D1]: https://api-docs.deepseek.com/api/get-user-balance
[D2]: https://api-docs.deepseek.com/

账单四条路径的路由注册证据：

- [OneAPI router/dashboard.go](https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/router/dashboard.go)
- [NewAPI router/dashboard.go](https://github.com/QuantumNous/new-api/blob/1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5/router/dashboard.go)
- [Veloera router/dashboard.go](https://github.com/Veloera/Veloera/blob/6525dfce816beaa270e78f0d8b762e19e54d13b8/router/dashboard.go)
- [OneHub router/dashboard.go](https://github.com/MartialBE/one-hub/blob/387f8bf16ed0d601fdede7ade378adb10aa1a35a/router/dashboard.go)
