//! 在线数据来源描述（**仅内置**，不落盘、不由用户编辑）
//!
//! 本文件把「怎么问供应商要余额 / 令牌用量」描述成一份声明式结构：
//! 地址模板 + 请求头 + 鉴权方式 + 响应取值路径 + 取数窗口。新增一家供应商的
//! 内置来源，只需在 `supplier_service::builtin_sources` 里补一条，不需要新增代码。
//!
//! 为什么不再让用户配置：绝大多数供应商的接口地址与响应结构是**固定事实**，
//! 让用户手填只会带来「填错一个路径就静默取不到数」的问题；参照 cc-switch 的做法，
//! 供应商条目只保留「请求地址 + 密钥」这类真正因账号而异的信息。
//!
//! # 模板占位符
//! 模板（[`SupplierUsageQuery::url_template`]）里的 `{name}` 会被替换为实际取值，
//! 取值来源分两类：
//! - **保留名**（由客户端自动解析，无需写入 [`SupplierUsageQuery::params`]）：
//!   - [`API_KEY_PLACEHOLDERS`]：`key` / `api_key` / `apiKey` → 该供应商 API Key；
//!   - [`USAGE_TOKEN_PLACEHOLDERS`]：`token` / `usage_token` → 平台令牌
//!     （控制台内部接口专用，与 API Key 是两套凭证）；
//!   - `date` → 当天 `YYYY-MM-DD`；`month` → 当月 `YYYY-MM`；`month_num` → 当月数字；
//!     `year` → 当年 `YYYY`；
//!   - `start` / `end` / `tz` → 由调用方给出的 [`TimeWindow`]（默认当天窗口）；
//!   - `timestamp` → 当前 Unix 秒。
//! - **其余名字**：一律从 [`SupplierUsageQuery::params`] 按名取值（键值都做 trim）。
//!
//! # 取值路径语法
//! [`UsageExtract`] 里的路径为**点号分隔**的相对路径，数字段表示数组下标，例如
//! `balance_infos.0.total_balance` 表示「`balance_infos` 数组第 0 个元素的
//! `total_balance` 字段」；`data.daily` 表示嵌套对象里的数组。任何一段不存在
//! 都返回 `None`（静默跳过，由调用方决定是否整体报错）。
//!
//! 数值型字段（余额 / 已用 / 总额 / 逐日金额）额外支持**通配段** `*`：表示对数组里
//! 每个元素继续按剩余路径取值并求和。控制台内部接口的用量是「按模型 × 按指标」两层
//! 嵌套的，例如 `data.*.usage.*.amount` 能把某天的全部模型、全部指标加总成一个数。
//!
//! 空路径（`""`）表示**该字段不取值**。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 默认请求方法。
pub const DEFAULT_METHOD: &str = "GET";

/// 默认鉴权方式（`Authorization: Bearer <key>`）。
pub const DEFAULT_AUTH_TYPE: &str = "bearer";

/// 保留占位符：API Key（多个别名等价，便于各家模板沿用自家命名习惯）。
pub const API_KEY_PLACEHOLDERS: [&str; 3] = ["key", "api_key", "apiKey"];

/// 保留占位符：平台登录令牌（控制台内部接口专用，与 API Key 是两套凭证）。
pub const USAGE_TOKEN_PLACEHOLDERS: [&str; 2] = ["token", "usage_token"];

/// 鉴权取值来源：该供应商的 API Key（默认）。
pub const TOKEN_SOURCE_API_KEY: &str = "api_key";

/// 鉴权取值来源：平台登录令牌。
pub const TOKEN_SOURCE_USAGE_TOKEN: &str = "usage_token";

/// 鉴权取值来源白名单。
pub const TOKEN_SOURCES: [&str; 2] = [TOKEN_SOURCE_API_KEY, TOKEN_SOURCE_USAGE_TOKEN];

/// 保留占位符：当天 00:00 的 Unix 秒（控制台内部用量接口按时间区间取数）。
pub const START_PLACEHOLDER: &str = "start";

/// 保留占位符：次日 00:00 的 Unix 秒（与 `start` 构成左闭右开的一天）。
pub const END_PLACEHOLDER: &str = "end";

/// 保留占位符：本地时区偏移秒数（东八区 = 28800）。
///
/// 控制台内部用量接口按「调用方时区」切分自然日，漏传会让「今天」整体偏移一天。
pub const TZ_PLACEHOLDER: &str = "tz";

/// 取值路径里的通配段：对该数组的所有元素继续按剩余路径取值并求和。
pub const WILDCARD_SEGMENT: &str = "*";

/// 取数窗口口径：当天（当地 00:00 → 次日 00:00）。
pub const WINDOW_DAY: &str = "day";

/// 取数窗口口径：当月（当月 1 日 00:00 → 次日 00:00）。
///
/// 官网用量接口按窗口长度自动选择聚合粒度（≤1 天给小时桶，更长给天桶），
/// 两种粒度的每日合计一致；但当月窗口能顺带修正最近几天的迟到数据。
pub const WINDOW_MONTH: &str = "month";

/// 取数窗口口径白名单。
pub const WINDOWS: [&str; 2] = [WINDOW_DAY, WINDOW_MONTH];

/// 一次请求的时间窗（本地时区下的左闭右开区间）。
///
/// 窗口是**调用方**决定的，而不是模板里的固定表达式：同一份接口描述既可能按天
/// 取数（`{start}` → `{end}`）、也可能需要按月回填，只靠模板无法表达。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeWindow {
    /// 起始 Unix 秒（含）。
    pub start: i64,
    /// 结束 Unix 秒（不含）。
    pub end: i64,
    /// 本地时区相对 UTC 的偏移秒数（东八区 = 28800）。
    pub tz: i32,
}

/// 保留占位符：当天日期（`YYYY-MM-DD`）。
pub const DATE_PLACEHOLDER: &str = "date";

/// 保留占位符：当月（`YYYY-MM`）。
pub const MONTH_PLACEHOLDER: &str = "month";

/// 保留占位符：当月数字（`1`–`12`，无前导零）。
///
/// 部分控制台接口按「数字月份 + 数字年份」取数（如 `?month=9&year=2026`），
/// 与 [`MONTH_PLACEHOLDER`] 的 `YYYY-MM` 不能互换。
pub const MONTH_NUM_PLACEHOLDER: &str = "month_num";

/// 保留占位符：当年（`YYYY`）。
pub const YEAR_PLACEHOLDER: &str = "year";

/// 保留占位符：当前 Unix 秒。
pub const TIMESTAMP_PLACEHOLDER: &str = "timestamp";

/// 该占位符是否为保留名。
///
/// 保留名由客户端自动解析，因此**不应**再写入 [`SupplierUsageQuery::params`]，
/// 校验时也不要求 `params` 提供取值。
///
/// 调用方是保存期校验，而在线来源已改为内置常量表（没有用户输入要校验），
/// 因此当前只有回归测试消费它。
#[allow(dead_code)]
pub fn is_reserved_placeholder(name: &str) -> bool {
    API_KEY_PLACEHOLDERS.contains(&name)
        || USAGE_TOKEN_PLACEHOLDERS.contains(&name)
        || name == DATE_PLACEHOLDER
        || name == MONTH_PLACEHOLDER
        || name == MONTH_NUM_PLACEHOLDER
        || name == YEAR_PLACEHOLDER
        || name == TIMESTAMP_PLACEHOLDER
        || name == START_PLACEHOLDER
        || name == END_PLACEHOLDER
        || name == TZ_PLACEHOLDER
}

/// 默认金额换算倍率（1.0 = 接口返回的数值就是实际金额）。
pub const DEFAULT_SCALE: f64 = 1.0;

/// 在线用量查询配置：把「怎么问供应商要用量」描述清楚。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SupplierUsageQuery {
    /// 接口模板（URL 骨架 + `{参数}` 占位符，如 `https://api.x.com/usage/{date}`）。
    pub url_template: String,
    /// 请求方法（白名单见 `supplier_service`）。
    pub method: String,
    /// 额外请求头。
    pub headers: BTreeMap<String, String>,
    /// 鉴权方式（白名单见 `supplier_service`）。
    pub auth_type: String,
    /// 响应取值路径。
    pub extract: UsageExtract,
    /// 额外必填参数（模板 / 查询串中必须提供的参数名）。
    pub required_params: Vec<String>,
    /// 模板占位符取值：占位符名 → 值。保留名无需在此提供，由客户端自动解析。
    pub params: BTreeMap<String, String>,
    /// 接口未返回币种时使用的币种（如 `USD`）；空串表示按调用方的默认币种处理。
    ///
    /// 不少平台（如按「万分之一美元」计价的供应商）响应里既没有金额单位也没有币种，
    /// 只能由配置补上，否则金额会被当成默认币种展示，属于**错误数据**。
    pub currency: String,
    /// 鉴权取值来源：`api_key`（默认）或 `usage_token`（平台令牌）。
    ///
    /// 官方接口与控制台内部接口的凭证互不通用，因此必须逐条声明，而不是「有令牌就用令牌」。
    pub token_source: String,
    /// 取数窗口口径：`day`（默认）或 `month`。见 [`WINDOW_DAY`] / [`WINDOW_MONTH`]。
    pub window: String,
    /// 用量统计来源（可选）：配置后「今日已用 + 日 / 周 / 月 / 年用量」由该接口提供。
    ///
    /// 与上面的余额来源**相互独立**：两者常常是不同域名、不同凭证的接口
    /// （例如 DeepSeek 余额走官方 API Key，用量走平台控制台的网页登录令牌）。
    /// 这里直接复用同一套结构，唯一的约定是**只解析一层**（嵌套层里的 `stats` 会被忽略）。
    ///
    /// 为什么需要它：日 / 周 / 月 / 年统计需要**逐日明细**，而多数官方余额接口并不提供，
    /// 过去只能靠「余额差值记账」估算，与官网数字长期对不上。
    pub stats: Option<Box<SupplierUsageQuery>>,
    /// Token 统计来源（可选）：提供「输入（命中缓存）→ 输入（未命中缓存）→ 输出」三类 Token。
    ///
    /// 与 [`Self::stats`]（金额）是**两条不同的接口**，不能合成一条：
    /// DeepSeek 的金额在 `by_api_key/cost`（桶里是 `cost`），Token 计数在
    /// `by_api_key/amount`（桶里是 `usage.{PROMPT_CACHE_HIT_TOKEN, …}`），
    /// 两者的响应结构完全不同，只是共用同一套窗口参数与凭证。
    ///
    /// 未配置时界面上的模型 Token 柱状图整体隐藏（「没有这项数据」而不是画一排 0）。
    pub token_stats: Option<Box<SupplierUsageQuery>>,
}

impl Default for SupplierUsageQuery {
    /// 默认即「未配置查询」：空模板，但请求方法与鉴权给出可用默认值。
    fn default() -> Self {
        Self {
            url_template: String::new(),
            method: DEFAULT_METHOD.to_string(),
            headers: BTreeMap::new(),
            auth_type: DEFAULT_AUTH_TYPE.to_string(),
            extract: UsageExtract::default(),
            required_params: Vec::new(),
            params: BTreeMap::new(),
            currency: String::new(),
            token_source: TOKEN_SOURCE_API_KEY.to_string(),
            window: WINDOW_DAY.to_string(),
            stats: None,
            token_stats: None,
        }
    }
}

/// 响应取值路径：分别指向余额 / 已用 / 总额 / 币种 / 逐日明细，空路径表示该字段不取值。
///
/// 拆成多个字段而非单个字符串，是因为一份用量响应通常同时给出这些信息，
/// 单路径无法表达；调用方按需消费其中一个或多个。
///
/// 逐日明细由三部分组成：[`Self::daily_list`] 指向明细数组，数组内每个元素的
/// 日期与金额再分别由 [`Self::daily_date`] / [`Self::daily_amount`] 按**相对路径**定位，
/// 因此三个字段要么都为空（不提供明细），要么都给出。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UsageExtract {
    /// 余额字段路径。
    pub balance: String,
    /// 已用额度字段路径。
    pub used: String,
    /// 总额度字段路径。
    pub total: String,
    /// 余额币种字段路径（如 `balance_infos.0.currency`）。
    ///
    /// 除了给出币种，它还是「接口正常应答」的判据之一：取到币种即视为这次应答有效，
    /// 因此**当月确实没有用量**（有币种、无金额）这种空数据不会被误判成接口故障
    /// （对照：令牌无效时响应里连 `data` 都是 `null`）。
    pub currency: String,
    /// 逐日明细数组的路径（如 `data.daily`）；空表示该接口不提供逐日明细。
    pub daily_list: String,
    /// 明细数组内日期字段的相对路径（如 `date`）。
    pub daily_date: String,
    /// 明细数组内金额字段的相对路径（如 `amount`）。
    pub daily_amount: String,
    /// 桶粒度字段路径（如 `data.biz_data.bucket`），值为秒数（3600 / 86400）。
    ///
    /// 官网用量接口按**窗口长度**自动选择聚合粒度：单日窗口给小时桶、更长窗口给天桶，
    /// 并在响应里回传实际粒度。界面上的「今天 / 昨天」要按小时画柱状图，
    /// 光是逐日合计不够用，因此需要它来判断「这条明细落在哪个小时」。
    /// 空路径表示接口不声明粒度——此时一律按天桶处理（与旧行为一致）。
    ///
    /// 它同时是「接口正常应答」的判据之一（见 [`Self::currency`]）：
    /// **没有币种字段**的接口（如 DeepSeek 的 `by_api_key/amount` 只回 Token 计数）
    /// 就靠它区分「这个月确实没有用量」与「令牌无效」。
    pub bucket: String,
    /// 金额换算倍率：接口返回的数值 × 本倍率 = 实际金额。
    ///
    /// 用于「接口按最小单位计价」的供应商（例如返回值为万分之一美元时填 `0.0001`）；
    /// `1.0`（默认）表示接口返回的就是实际金额。
    pub scale: f64,
    /// **按模型分组**的明细数组路径（如 `data.biz_data.data.*.series`）。
    ///
    /// 非空时改用「模型 → 桶」两层解析：先由 [`Self::series_model`] 取出模型名，
    /// 再由 [`Self::series_items`] 取出该模型的桶数组，桶内字段仍用
    /// [`Self::daily_date`] / [`Self::daily_amount`] / [`Self::token_hit`] 等相对路径定位。
    /// 这样「金额柱状图」与「Token 柱状图」都能拿到**按模型拆分**的数据，
    /// 而不是像 [`Self::daily_list`] 那样把各模型求和压平成一个数。
    ///
    /// 为空时保持原行为：只按 [`Self::daily_list`] 取「各模型合计」。
    pub series_list: String,
    /// [`Self::series_list`] 内**模型名**字段的相对路径（如 `model`），空表示不按模型拆分。
    pub series_model: String,
    /// [`Self::series_list`] 内**桶数组**字段的相对路径（如 `buckets`）。
    pub series_items: String,
    /// 桶内「输入（命中缓存）」Token 数的相对路径（如 `usage.PROMPT_CACHE_HIT_TOKEN`）。
    ///
    /// 三类 Token 路径要么都给、要么都不给：只给一部分会把缺的那部分当成 0，
    /// 画出「没有输出」这种错误结论。
    pub token_hit: String,
    /// 桶内「输入（未命中缓存）」Token 数的相对路径。
    pub token_miss: String,
    /// 桶内「输出」Token 数的相对路径。
    pub token_out: String,
}

impl UsageExtract {
    /// 是否按模型拆分（三个模型相关路径都给出才成立）。
    pub fn by_model(&self) -> bool {
        !self.series_list.trim().is_empty()
            && !self.series_model.trim().is_empty()
            && !self.series_items.trim().is_empty()
    }

    /// 是否携带 Token 口径（三条 Token 路径都给出才成立）。
    pub fn tokens(&self) -> bool {
        !self.token_hit.trim().is_empty()
            && !self.token_miss.trim().is_empty()
            && !self.token_out.trim().is_empty()
    }

    /// 是否携带金额口径。
    ///
    /// 它是「本次应答能不能改写历史里的金额」的判据：Token 统计来源只配 Token 路径，
    /// 它的 `daily` 合计是 **Token 个数**而不是金额，绝不能拿去覆盖账单金额。
    ///
    /// 金额路径配了即成立；逐日明细的**列表**路径只在非按模型解析时才需要
    /// （走 [`Self::series_list`] 时桶数组由 [`Self::series_items`] 指定）。
    pub fn money(&self) -> bool {
        !self.daily_amount.trim().is_empty()
            && (self.by_model() || !self.daily_list.trim().is_empty())
    }
}

impl Default for UsageExtract {
    fn default() -> Self {
        Self {
            balance: String::new(),
            used: String::new(),
            total: String::new(),
            currency: String::new(),
            daily_list: String::new(),
            daily_date: String::new(),
            daily_amount: String::new(),
            bucket: String::new(),
            scale: DEFAULT_SCALE,
            series_list: String::new(),
            series_model: String::new(),
            series_items: String::new(),
            token_hit: String::new(),
            token_miss: String::new(),
            token_out: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 保留名清单是客户端自动解析的唯一依据，必须与文档注释保持一致。
    #[test]
    fn reserved_placeholders_cover_documented_names() {
        for name in [
            "key",
            "api_key",
            "apiKey",
            "token",
            "usage_token",
            "date",
            "month",
            "year",
            "timestamp",
            "start",
            "end",
            "tz",
        ] {
            assert!(is_reserved_placeholder(name), "「{}」应为保留名", name);
        }
        for name in ["", "Key", "API_KEY", "Token", "day", "from", "to"] {
            assert!(!is_reserved_placeholder(name), "「{}」不应是保留名", name);
        }
    }

    /// 旧配置（没有 token_source / stats 字段）必须能原样读入：默认按 API Key 鉴权、
    /// 未配置用量统计来源。
    #[test]
    fn legacy_config_without_new_fields_still_loads() {
        let legacy = r#"{
            "url_template": "https://api.deepseek.com/user/balance",
            "method": "GET",
            "auth_type": "bearer",
            "extract": { "balance": "balance_infos.0.total_balance" },
            "currency": ""
        }"#;
        let query: SupplierUsageQuery = serde_json::from_str(legacy).unwrap();
        assert_eq!(query.token_source, TOKEN_SOURCE_API_KEY);
        assert!(query.stats.is_none());
        assert_eq!(query.extract.balance, "balance_infos.0.total_balance");
        assert_eq!(query.extract.scale, DEFAULT_SCALE);
    }

    /// 用量统计来源可独立配置，且带自己的凭证来源（平台登录令牌）。
    #[test]
    fn stats_source_round_trips() {
        let json = r#"{
            "url_template": "https://api.deepseek.com/user/balance",
            "stats": {
                "url_template": "https://platform.deepseek.com/api/v0/usage/cost?month={month}&year={year}",
                "auth_type": "bearer",
                "token_source": "usage_token",
                "extract": {
                    "daily_list": "biz_data.days",
                    "daily_date": "date",
                    "daily_amount": "data.*.usage.*.amount"
                }
            }
        }"#;
        let query: SupplierUsageQuery = serde_json::from_str(json).unwrap();
        let stats = query.stats.as_deref().unwrap();
        assert_eq!(stats.token_source, TOKEN_SOURCE_USAGE_TOKEN);
        assert_eq!(stats.extract.daily_amount, "data.*.usage.*.amount");
        // 往返一圈不得丢字段（落盘 → 读回 → 再落盘）。
        let roundtrip: SupplierUsageQuery =
            serde_json::from_str(&serde_json::to_string(&query).unwrap()).unwrap();
        assert_eq!(roundtrip, query);
    }
}
