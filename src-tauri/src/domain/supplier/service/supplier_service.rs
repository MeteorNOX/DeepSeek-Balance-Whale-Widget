//! 供应商领域规则
//!
//! 只包含**与存储无关**的规则：slug 生成与目录名校验、字段归一化、必填校验。
//! 文件读写见 `infrastructure::repository::supplier::supplier_store`。
//!
//! slug 既是供应商的唯一标识，也是其子目录名，因此校验必须同时满足两件事：
//! 1. **可安全用作目录名**——字符集收窄到 `[a-z0-9-]`，从根上杜绝目录穿越
//!    （`.` / `..` / 路径分隔符都无法通过校验）；
//! 2. **稳定可比较**——只允许 ASCII 小写，避免同一供应商因大小写产生两份目录。
//!
//! 供应商按「列表」组织，列表用 scope 标识（`balance` 为余额配置列表，其余为客户端
//! id）：scope 同样是一级目录名，与 slug 共用同一套字符集校验，因此拼接出的路径
//! 不可能越出供应商根目录。

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Timelike};

use crate::domain::supplier::model::{
    is_reserved_placeholder, ModelCatalogEntry, ModelUsage, ScopeActive, SupplierCredential,
    SupplierEndpoint, SupplierIndex, SupplierProfile, SupplierRouting, SupplierUsageHistory,
    SupplierUsageQuery, TimeWindow, UsageExtract, API_KEY_PLACEHOLDERS, DATE_PLACEHOLDER,
    DEFAULT_API_FORMAT, DEFAULT_AUTH_FIELD, DEFAULT_AUTH_TYPE, DEFAULT_METHOD, DEFAULT_SCALE,
    END_PLACEHOLDER, INDEX_VERSION, MONTH_NUM_PLACEHOLDER, MONTH_PLACEHOLDER, START_PLACEHOLDER,
    TIMESTAMP_PLACEHOLDER, TOKEN_SOURCES, TOKEN_SOURCE_API_KEY, TOKEN_SOURCE_USAGE_TOKEN,
    TZ_PLACEHOLDER, USAGE_TOKEN_PLACEHOLDERS, WINDOWS, WINDOW_DAY, WINDOW_MONTH, YEAR_PLACEHOLDER,
};
use crate::types::exception::{AppError, AppResult};

/// 「余额配置」列表的保留 scope 名。
///
/// 它既是 scope 目录名，也标记了「这个列表只用于查余额/用量、不参与模型路由」。
pub const BALANCE_SCOPE: &str = "balance";

/// slug / 目录名长度上限。
pub const MAX_SLUG_LEN: usize = 48;
/// 供应商名称长度上限（字符数）。
pub const MAX_NAME_LEN: usize = 64;
/// 上下文窗口上限（token 数）。
pub const MAX_CONTEXT_WINDOW: u32 = 10_000_000;
/// 允许的 API 协议格式（白名单）。
pub const API_FORMATS: [&str; 4] = ["anthropic", "openai", "openai-responses", "gemini"];
/// 允许的认证字段（请求头名，白名单）。
pub const AUTH_FIELDS: [&str; 3] = ["x-api-key", "authorization", "api-key"];
/// 允许的用量查询鉴权方式（白名单）。
pub const AUTH_TYPES: [&str; 3] = ["bearer", "header", "none"];
/// 允许的用量查询请求方法（白名单）。
pub const HTTP_METHODS: [&str; 2] = ["GET", "POST"];
/// 无法识别请求地址时生成的供应商名称。
pub const CUSTOM_SUPPLIER_NAME: &str = "自定义供应商";
/// 无法识别请求地址时生成的供应商分类。
pub const CUSTOM_SUPPLIER_CATEGORY: &str = "自定义";
/// 历史用量保留天数上限。
///
/// 与 `domain::ledger` 的 30 天不同：用量图表要能画「年」视图，30 天远远不够，
/// 400 天足以覆盖一整年外带少量跨年数据。
pub const HISTORY_DAY_LIMIT: usize = 400;

/// 逐小时明细保留天数上限。
///
/// 逐小时数据只服务于「今天 / 昨天」两张图（其余时间范围都按天 / 按月聚合），
/// 因此留 3 天足够覆盖跨零点的刷新间隙，也不会让 `usage_history.json` 膨胀。
pub const HOURLY_DAY_LIMIT: usize = 3;

// ---------------------------------------------------------------------------
// slug（标识 / 目录名）
// ---------------------------------------------------------------------------

/// 由展示名生成 slug：仅保留 ASCII 字母数字，其余一律折叠为 `-`。
///
/// 结果可能为空（如纯中文名）——此时调用方必须改用显式 slug，
/// 而不是让空串变成目录名。
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    // 截断只可能砍掉尾部，且截断后可能以 `-` 结尾（如 "a-b" → "a-"）。
    if out.len() > MAX_SLUG_LEN {
        out.truncate(MAX_SLUG_LEN);
        out.truncate(out.trim_end_matches('-').len());
    }
    out
}

/// slug 校验的字段名（错误文案的一部分）。
const SLUG_LABEL: &str = "供应商标识";
/// scope 校验的字段名。
const SCOPE_LABEL: &str = "列表标识";
/// 客户端标识校验的字段名。
const CLIENT_LABEL: &str = "客户端标识";

/// 校验供应商标识（即目录名）。
///
/// 字符集收窄到 `[a-z0-9-]` 即已排除 `.` / `..` / `/` / `\`，
/// 目录穿越在这一层就被彻底挡住，存储层无需再做二次防护。
pub fn validate_slug(slug: &str) -> AppResult<String> {
    validate_dir_name(SLUG_LABEL, slug)
}

/// 校验列表标识（scope，即一级目录名）。
///
/// 与 slug 同规则同实现：scope 会被拼进路径，必须和 slug 一样不可穿越目录。
pub fn validate_scope(scope: &str) -> AppResult<String> {
    validate_dir_name(SCOPE_LABEL, scope)
}

/// 校验客户端标识。
///
/// 与 slug 同一字符集：客户端标识会被用作 scope 目录名，必须与 slug 一样不可穿越目录。
pub fn validate_client_id(client_id: &str) -> AppResult<String> {
    validate_dir_name(CLIENT_LABEL, client_id)
}

/// 自定义供应商标识：`custom-1`、`custom-2`…（序号由存储层按目录现状分配）。
pub fn custom_slug(index: u32) -> String {
    format!("custom-{}", index)
}

/// 目录名（slug / scope / 客户端标识）的统一校验实现。
///
/// 三类取值都会被拼成路径或文件名，因此共用同一套规则；只有报错文案按
/// `kind_label` 区分，便于用户定位到具体是哪个输入出了问题。
fn validate_dir_name(kind_label: &str, value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid(format!("{}不能为空", kind_label)));
    }
    if trimmed.len() > MAX_SLUG_LEN {
        return Err(AppError::invalid(format!(
            "{}过长（上限 {} 个字符）",
            kind_label, MAX_SLUG_LEN
        )));
    }
    if !has_slug_charset(trimmed) {
        return Err(AppError::invalid(format!(
            "{}只能包含小写字母、数字与连字符",
            kind_label
        )));
    }
    // 首尾连字符不会造成安全问题，但会生成难以辨识、易被误读的目录名。
    if trimmed.starts_with('-') || trimmed.ends_with('-') {
        return Err(AppError::invalid(format!(
            "{}不能以连字符开头或结尾",
            kind_label
        )));
    }
    Ok(trimmed.to_string())
}

/// 字符集校验：仅 ASCII 小写字母、数字与连字符。
fn has_slug_charset(value: &str) -> bool {
    value
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

// ---------------------------------------------------------------------------
// 旧配置迁移：按 host 推断供应商
// ---------------------------------------------------------------------------

/// 已知供应商模板。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownSupplier {
    /// 供应商标识（目录名）。
    pub slug: &'static str,
    /// 展示名称。
    pub name: &'static str,
    /// 分类。
    pub category: &'static str,
}

/// 供应商推断结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InferredSupplier {
    /// 命中已知供应商。
    Known(KnownSupplier),
    /// 未命中：由调用方分配 `custom-<n>` 标识。
    Custom,
}

/// host 关键字 → 已知供应商（按声明顺序匹配，先到先得）。
///
/// 关键字而非完整域名：各家 API 域名前缀差异很大（`api.` / `api-inference.` 等），
/// 匹配关键字对子域变化的容忍度更高。
const KNOWN_SUPPLIERS: [(&str, KnownSupplier); 7] = [
    (
        "deepseek",
        KnownSupplier {
            slug: "deepseek",
            name: "DeepSeek",
            category: "官方",
        },
    ),
    (
        "moonshot",
        KnownSupplier {
            slug: "kimi",
            name: "Kimi",
            category: "第三方",
        },
    ),
    (
        "kimi",
        KnownSupplier {
            slug: "kimi",
            name: "Kimi",
            category: "第三方",
        },
    ),
    (
        "modelscope",
        KnownSupplier {
            slug: "modelscope",
            name: "ModelScope",
            category: "第三方",
        },
    ),
    (
        "aihubmix",
        KnownSupplier {
            slug: "aihubmix",
            name: "AiHubMix",
            category: "第三方",
        },
    ),
    (
        "shengsuanyun",
        KnownSupplier {
            slug: "shengsuanyun",
            name: "神算云",
            category: "第三方",
        },
    ),
    (
        "xiaomimimo",
        KnownSupplier {
            slug: "xiaomimimo",
            name: "小米MiMo",
            category: "第三方",
        },
    ),
];

/// 按请求地址推断供应商。
pub fn infer_supplier(base_url: &str) -> InferredSupplier {
    match known_supplier_for(&host_of(base_url)) {
        Some(known) => InferredSupplier::Known(known),
        None => InferredSupplier::Custom,
    }
}

/// 按 host 关键字匹配已知供应商。
pub fn known_supplier_for(host: &str) -> Option<KnownSupplier> {
    let host = host.to_lowercase();
    KNOWN_SUPPLIERS
        .iter()
        .find(|(keyword, _)| host.contains(keyword))
        .map(|(_, supplier)| *supplier)
}

/// 提取请求地址的 host（小写）。
///
/// 完全无法解析时回退为整串小写：畸形地址下推断结果仍然是确定的，
/// 不会因为「解析失败」而随机落到不同的供应商。
pub fn host_of(url: &str) -> String {
    let trimmed = url.trim();
    let rest = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // 去掉 userinfo（`user:pass@host`）。
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = if host_port.starts_with('[') {
        // IPv6 字面量形如 `[::1]:8080`，端口分隔符只可能出现在 `]` 之后。
        host_port
            .find(']')
            .map(|end| &host_port[..=end])
            .unwrap_or(host_port)
    } else {
        host_port.split(':').next().unwrap_or_default()
    };
    let host = host.trim_matches(|c| c == '[' || c == ']').to_lowercase();
    if host.is_empty() {
        trimmed.to_lowercase()
    } else {
        host
    }
}

/// 是否为 DeepSeek 官方接口。
///
/// 峰谷提示是 DeepSeek 独有的计费形态，其它供应商没有这个概念：余额展示据此
/// 决定是否计算峰谷，切换供应商后提示会自动消失（无需额外开关）。
/// 复用 [`host_of`] 提取 host（已小写化），因此对地址大小写不敏感。
pub fn is_deepseek_endpoint(base_url: &str) -> bool {
    host_of(base_url).contains("deepseek")
}

/// 当前本地时间戳（`YYYY-MM-DD HH:MM:SS`）。
pub fn now_timestamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/// 归一化展示信息：去空白；`slug` 统一小写后再由校验兜底。
pub fn normalize_profile(profile: &mut SupplierProfile) {
    profile.slug = profile.slug.trim().to_ascii_lowercase();
    profile.name = profile.name.trim().to_string();
    profile.note = profile.note.trim().to_string();
    profile.homepage = profile.homepage.trim().to_string();
    profile.api_key_url = profile.api_key_url.trim().to_string();
    profile.category = profile.category.trim().to_string();
    profile.logo = profile.logo.trim().to_string();
    profile.created_at = profile.created_at.trim().to_string();
}

/// 归一化当前启用项：去空白 + 小写（空串合法，表示该列表未启用任何供应商）。
pub fn normalize_scope_active(active: &mut ScopeActive) {
    active.active_slug = active.active_slug.trim().to_ascii_lowercase();
}

/// 归一化密钥：去首尾空白（粘贴密钥时的换行/空格是最常见的失败原因）。
///
/// 平台登录令牌同样处理：它是从浏览器复制的长串，几乎必带换行。
pub fn normalize_credential(credential: &mut SupplierCredential) {
    credential.api_key = credential.api_key.trim().to_string();
    credential.usage_token = credential.usage_token.trim().to_string();
}

/// 归一化请求地址：裁剪地址、白名单收敛协议与认证字段、清理候选端点。
///
/// 认证字段的白名单**按 scope 决定**：客户端列表用它表达「密钥写进客户端配置的哪个键」
/// （见 [`ClientDescriptor::auth_fields`]），余额配置列表没有客户端语义，
/// 沿用请求头名白名单（它的认证字段用于在线用量查询时附加请求头）。
pub fn normalize_endpoint(scope: &str, endpoint: &mut SupplierEndpoint) {
    endpoint.base_url = normalize_base_url(&endpoint.base_url);
    let fallback_format = default_api_format_for(scope);
    endpoint.api_format = normalize_choice(&endpoint.api_format, &API_FORMATS, &fallback_format);
    endpoint.auth_field = normalize_auth_field(scope, &endpoint.auth_field);
    // 候选端点顺序即尝试优先级，只能保序去重，不能排序。
    endpoint.endpoint_candidates = dedup_preserving_order(
        endpoint
            .endpoint_candidates
            .iter()
            .map(|candidate| normalize_base_url(candidate))
            .filter(|candidate| !candidate.is_empty()),
    );
}

/// 该列表「协议缺失 / 非法」时使用的 API 格式。
///
/// 客户端列表一律取注册表登记的默认值：Codex 只讲 OpenAI 协议（默认 Responses），
/// 拿全局默认的 Anthropic 兜底会写出它根本讲不了的 `wire_api`；余额配置列表没有
/// 客户端语义，沿用全局默认。
fn default_api_format_for(scope: &str) -> String {
    crate::domain::client::service::client_service::find_client(scope)
        .map(|client| client.default_api_format.to_string())
        .unwrap_or_else(|| DEFAULT_API_FORMAT.to_string())
}

/// 认证字段归一化：大小写不敏感地匹配白名单，命中后回写**白名单里的规范写法**。
///
/// - 客户端列表：白名单来自注册表（Claude 是 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`
///   两个大写环境变量名，Codex 一个都没有——它的密钥固定写 `auth.json`）；
/// - 余额配置列表：白名单是请求头名，与在线用量查询的附加头一一对应。
pub fn normalize_auth_field(scope: &str, value: &str) -> String {
    let candidate = value.trim();
    if let Some(client) = crate::domain::client::service::client_service::find_client(scope) {
        if client.auth_fields().is_empty() {
            // 该客户端没有认证字段配置项：清空旧值，避免残留值影响渲染。
            return String::new();
        }
        return match client
            .auth_fields()
            .iter()
            .find(|field| field.value.eq_ignore_ascii_case(candidate))
        {
            Some(field) => field.value.to_string(),
            None => client.default_auth_field.to_string(),
        };
    }
    normalize_choice(candidate, &AUTH_FIELDS, DEFAULT_AUTH_FIELD)
}

/// 归一化在线用量查询配置。
pub fn normalize_usage_query(query: &mut SupplierUsageQuery) {
    query.url_template = query.url_template.trim().to_string();
    query.method = normalize_http_method(&query.method);
    query.auth_type = normalize_choice(&query.auth_type, &AUTH_TYPES, DEFAULT_AUTH_TYPE);
    query.headers = query
        .headers
        .iter()
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .filter(|(key, _)| !key.is_empty())
        .collect();
    query.params = query
        .params
        .iter()
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .filter(|(key, _)| !key.is_empty())
        .collect();
    query.extract = UsageExtract {
        balance: query.extract.balance.trim().to_string(),
        used: query.extract.used.trim().to_string(),
        total: query.extract.total.trim().to_string(),
        currency: query.extract.currency.trim().to_string(),
        daily_list: query.extract.daily_list.trim().to_string(),
        daily_date: query.extract.daily_date.trim().to_string(),
        daily_amount: query.extract.daily_amount.trim().to_string(),
        bucket: query.extract.bucket.trim().to_string(),
        // 倍率必须是正的有限数：0 / 负数 / NaN 会把整段用量算成 0 或污染统计，
        // 因此非法值一律回落 1.0（= 接口返回的就是实际金额）。
        scale: normalize_scale(query.extract.scale),
        series_list: query.extract.series_list.trim().to_string(),
        series_model: query.extract.series_model.trim().to_string(),
        series_items: query.extract.series_items.trim().to_string(),
        token_hit: query.extract.token_hit.trim().to_string(),
        token_miss: query.extract.token_miss.trim().to_string(),
        token_out: query.extract.token_out.trim().to_string(),
    };
    // 币种统一大写，避免 `usd` 与 `USD` 被当成两种币种而触发多余的汇率换算。
    query.currency = query.currency.trim().to_ascii_uppercase();
    query.token_source =
        normalize_choice(&query.token_source, &TOKEN_SOURCES, TOKEN_SOURCE_API_KEY);
    query.window = normalize_choice(&query.window, &WINDOWS, WINDOW_DAY);
    query.required_params = normalize_set(&query.required_params);
    // 用量统计来源与主来源同构，同样要归一化：否则「保存时写了大小写混合的鉴权方式、
    // 重启后读出来被纠正」会让用户看到配置自己变了。
    if let Some(stats) = query.stats.as_mut() {
        normalize_usage_query(stats);
    }
    if let Some(stats) = query.token_stats.as_mut() {
        normalize_usage_query(stats);
    }
}

/// 归一化金额换算倍率：非正数或非有限值一律回落默认倍率。
fn normalize_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        DEFAULT_SCALE
    }
}

// ---------------------------------------------------------------------------
// 内置在线用量配置
// ---------------------------------------------------------------------------

/// 拥有内置在线用量配置的供应商标识（[`builtin_usage_preset`] 的键集合）。
///
/// 生产路径按目录名直接查表，不需要枚举；这份清单由回归测试消费，
/// 用来逐个校验内置来源自洽（见 `builtin_usage_presets_are_valid_and_scoped`）。
#[allow(dead_code)]
pub const BUILTIN_USAGE_SLUGS: [&str; 7] = [
    "deepseek",
    "kimi",
    "openrouter",
    "novita-ai",
    "siliconflow",
    "stepfun",
    "aihubmix",
];

/// 控制台内部接口用到的浏览器 UA：这类接口按「网页端请求」校验，缺 UA 常被直接拒绝。
const CONSOLE_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// 内置供应商的在线余额 / 用量来源（只收录**官方接口可核对**的地址，宁缺毋滥）。
///
/// 这是在线取数的**唯一事实来源**，按供应商目录名匹配：不落盘、不由用户编辑
/// （绝大多数供应商的接口地址与响应结构是固定事实，让用户手填只会「填错一个路径
/// 就静默取不到数」）。
///
/// 未收录的供应商一律返回 `None`：它们只走本地余额差值记账。
pub fn builtin_usage_preset(slug: &str) -> Option<SupplierUsageQuery> {
    let slug = slug.trim().to_ascii_lowercase();
    let query = match slug.as_str() {
        // 余额与用量**分属两个鉴权域**，因此拆成两段配置：
        // - 余额：官方公开接口 `GET /user/balance` → `balance_infos[0].{total_balance, currency}`，
        //   金额即元，用 API Key（`Authorization: Bearer sk-…`）。
        // - 用量：官方**没有**公开用量统计 API（`/v1/usage` 实测 404），只有平台控制台
        //   前端自用的内部接口，它只认网页登录令牌（用 API Key 调会得到
        //   `{"code":40003,"msg":"Authorization Failed (invalid token)"}`）。
        //   取数用 `GET /api/v0/usage/by_api_key/cost?start=&end=&tz=`：按时间窗返回
        //   「按模型分组的桶」，桶金额与官网用量页逐日数字一致。
        //   实测对照（同一账号同一天，官网 ¥55.99）：本接口 ¥55.998；
        //   而旧的 `cost?month=&year=` 给的是 ¥39.988 —— 后者口径不对，已弃用。
        //   注意该接口对窗口长度有上限（≥60 天返回 `INVALID_PARAM`），故按自然月取数，
        //   年维度靠 `usage_history.json` 逐日累积。
        //   模型维度必须按 `data[].series[]` 保留：金额柱状图的悬浮提示要逐模型列金额，
        //   求和压平后就再也拆不回来了。
        // - Token：`GET /api/v0/usage/by_api_key/amount?start=&end=&tz=` 与金额同源同窗口，
        //   桶里是 `usage.{PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN, RESPONSE_TOKEN}`。
        //   该接口**没有 `data[]` 外层**（金额接口有），因此 series 路径不同：
        //   `data.biz_data.series`（实测两接口的差异就在这一层）。
        "deepseek" => SupplierUsageQuery {
            url_template: "https://api.deepseek.com/user/balance".to_string(),
            extract: UsageExtract {
                balance: "balance_infos.0.total_balance".to_string(),
                currency: "balance_infos.0.currency".to_string(),
                ..UsageExtract::default()
            },
            stats: Some(Box::new(SupplierUsageQuery {
                url_template:
                    "https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start={start}&end={end}&tz={tz}"
                        .to_string(),
                headers: BTreeMap::from([(
                    "User-Agent".to_string(),
                    CONSOLE_USER_AGENT.to_string(),
                )]),
                token_source: TOKEN_SOURCE_USAGE_TOKEN.to_string(),
                window: WINDOW_MONTH.to_string(),
                currency: "CNY".to_string(),
                extract: UsageExtract {
                    // 「模型 → 桶」两层：`model` 是模型名，`buckets` 是该模型的桶数组。
                    series_list: "data.biz_data.data.*.series".to_string(),
                    series_model: "model".to_string(),
                    series_items: "buckets".to_string(),
                    daily_date: "time".to_string(),
                    daily_amount: "cost".to_string(),
                    // 桶粒度由响应回传（单日窗口给 3600 = 小时桶，更长窗口给 86400）：
                    // 「今天 / 昨天」按小时画柱状图就靠它判断明细落在哪个小时。
                    bucket: "data.biz_data.bucket".to_string(),
                    // 币种路径顺带充当「接口正常应答」的判据：该月确实没有用量时
                    // 响应是 `data.biz_data.data: [{currency: "CNY", series: []}]`
                    // （没有任何金额桶），只靠金额无法区分它与「令牌无效」——
                    // 后者是 `{"code":40003, "data": null}`。取到币种即视为应答有效，
                    // 于是「空月份」得到 0 而不是一条吓人的错误提示。
                    currency: "data.biz_data.data.0.currency".to_string(),
                    ..UsageExtract::default()
                },
                ..SupplierUsageQuery::default()
            })),
            token_stats: Some(Box::new(SupplierUsageQuery {
                url_template:
                    "https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start={start}&end={end}&tz={tz}"
                        .to_string(),
                headers: BTreeMap::from([(
                    "User-Agent".to_string(),
                    CONSOLE_USER_AGENT.to_string(),
                )]),
                token_source: TOKEN_SOURCE_USAGE_TOKEN.to_string(),
                window: WINDOW_MONTH.to_string(),
                // 该接口不返回币种（它统计的是 Token 个数），有效性靠 bucket 路径判定。
                extract: UsageExtract {
                    series_list: "data.biz_data.series".to_string(),
                    series_model: "model".to_string(),
                    series_items: "buckets".to_string(),
                    daily_date: "time".to_string(),
                    bucket: "data.biz_data.bucket".to_string(),
                    token_hit: "usage.PROMPT_CACHE_HIT_TOKEN".to_string(),
                    token_miss: "usage.PROMPT_CACHE_MISS_TOKEN".to_string(),
                    token_out: "usage.RESPONSE_TOKEN".to_string(),
                    ..UsageExtract::default()
                },
                ..SupplierUsageQuery::default()
            })),
            ..SupplierUsageQuery::default()
        },
        // `GET /v1/users/me/balance` → data.available_balance，单位人民币元（响应无币种字段）。
        "kimi" => SupplierUsageQuery {
            url_template: "https://api.moonshot.cn/v1/users/me/balance".to_string(),
            currency: "CNY".to_string(),
            extract: UsageExtract {
                balance: "data.available_balance".to_string(),
                ..UsageExtract::default()
            },
            ..SupplierUsageQuery::default()
        },
        // `GET /api/v1/key` → data.limit_remaining 为剩余额度、usage_daily 为当日消费（美元）。
        "openrouter" => SupplierUsageQuery {
            url_template: "https://openrouter.ai/api/v1/key".to_string(),
            currency: "USD".to_string(),
            extract: UsageExtract {
                balance: "data.limit_remaining".to_string(),
                used: "data.usage_daily".to_string(),
                total: "data.limit".to_string(),
                ..UsageExtract::default()
            },
            ..SupplierUsageQuery::default()
        },
        // `GET /openapi/v1/billing/balance/detail` → availableBalance，单位为万分之一美元。
        "novita-ai" => SupplierUsageQuery {
            url_template: "https://api.novita.ai/openapi/v1/billing/balance/detail".to_string(),
            currency: "USD".to_string(),
            extract: UsageExtract {
                balance: "availableBalance".to_string(),
                scale: 0.0001,
                ..UsageExtract::default()
            },
            ..SupplierUsageQuery::default()
        },
        // `GET /v1/user/info` → data.balance（赠送余额）/ data.totalBalance（可用总额），
        // 数值以字符串返回、单位人民币元（与 `chargeBalance` 合计即账户总额）。
        "siliconflow" => SupplierUsageQuery {
            url_template: "https://api.siliconflow.cn/v1/user/info".to_string(),
            currency: "CNY".to_string(),
            extract: UsageExtract {
                balance: "data.totalBalance".to_string(),
                ..UsageExtract::default()
            },
            ..SupplierUsageQuery::default()
        },
        // `GET /v1/accounts` → balance（当前可用余额），响应无币种字段；
        // 该域名是官方国内站（国际站为 `api.stepfun.ai`），按人民币元计费。
        "stepfun" => SupplierUsageQuery {
            url_template: "https://api.stepfun.com/v1/accounts".to_string(),
            currency: "CNY".to_string(),
            extract: UsageExtract {
                balance: "balance".to_string(),
                ..UsageExtract::default()
            },
            ..SupplierUsageQuery::default()
        },
        // `GET /api/user/self` → data.quota（账户余额），官方文档写明换算：
        // 实际美元 = quota / 500000。
        "aihubmix" => SupplierUsageQuery {
            url_template: "https://aihubmix.com/api/user/self".to_string(),
            currency: "USD".to_string(),
            extract: UsageExtract {
                balance: "data.quota".to_string(),
                scale: 0.000002,
                ..UsageExtract::default()
            },
            ..SupplierUsageQuery::default()
        },
        _ => return None,
    };
    let mut query = query;
    normalize_usage_query(&mut query);
    Some(query)
}

/// 归一化历史用量：丢弃非法日期键、把非法数值归零、裁剪超限的天数。
pub fn normalize_usage_history(history: &mut SupplierUsageHistory) {
    history.updated_at = history.updated_at.trim().to_string();
    // 负余额 / 非有限值不是有效观测：直接丢弃基准（下次观测只重建基准，不计用量）。
    history.last_balance = match history.last_balance {
        Some(balance) if balance.is_finite() && balance >= 0.0 => Some(balance),
        _ => None,
    };
    // 币种统一大写，避免 `cny` / `CNY` 被当成两种币种。
    history.currency = history.currency.trim().to_ascii_uppercase();
    history.daily.retain(|date, _| is_date_key(date));
    for usage in history.daily.values_mut() {
        if !usage.local.is_finite() || usage.local < 0.0 {
            usage.local = 0.0;
        }
        if !usage.remote.is_finite() || usage.remote < 0.0 {
            usage.remote = 0.0;
        }
        normalize_model_usage(&mut usage.models);
    }
    trim_usage_history(history);
    // 「官方给过数据的日期」必须始终是 `daily` 的子集：先裁掉非法日期，再跟随截断。
    history
        .remote_days
        .retain(|date| is_date_key(date) && history.daily.contains_key(date));
    // 逐小时明细：键必须是 `YYYY-MM-DD HH`（小时 00–23），金额非法则归零。
    history.hourly.retain(|key, _| is_hour_key(key));
    for usage in history.hourly.values_mut() {
        if !usage.is_finite() || *usage < 0.0 {
            *usage = 0.0;
        }
    }
    // 逐小时的按模型明细：键必须合法、模型名去空、数值非法归零；
    // 两半都被清空的条目直接丢掉，避免磁盘上留下一堆 `"2026-09-18 03": {}`。
    history.hourly_models.retain(|key, models| {
        normalize_model_usage(models);
        is_hour_key(key) && !models.is_empty()
    });
    trim_hourly_usage(history);
    history.hourly_updated_at = history.hourly_updated_at.trim().to_string();
}

/// 归一化一组「模型 → 明细」：丢掉空模型名、把非法数值归零，再丢弃全零条目。
///
/// 丢弃全零条目是**必要的**：模型改名或下线后，旧的模型名会永远留在文件里，
/// 界面上的图例也会跟着多出一批没有数据的条目。
fn normalize_model_usage(models: &mut BTreeMap<String, ModelUsage>) {
    models.retain(|model, _| !model.trim().is_empty());
    for usage in models.values_mut() {
        for value in [
            &mut usage.cost,
            &mut usage.hit,
            &mut usage.miss,
            &mut usage.out,
        ] {
            if !value.is_finite() || *value < 0.0 {
                *value = 0.0;
            }
        }
    }
    models.retain(|_, usage| !usage.is_empty());
}

/// 逐小时明细的时间键：`YYYY-MM-DD HH`（小时两位、00–23）。
pub fn is_hour_key(key: &str) -> bool {
    let text = key.trim();
    if text.len() != 13 {
        return false;
    }
    let bytes = text.as_bytes();
    if bytes[10] != b' ' {
        return false;
    }
    if !is_date_key(&text[..10]) {
        return false;
    }
    match text[11..13].parse::<u32>() {
        Ok(hour) => hour < 24,
        Err(_) => false,
    }
}

/// 逐小时明细只保留最近 [`HOURLY_DAY_LIMIT`] 天（键有序，从最旧开始删）。
///
/// 逐小时数据只服务于「今天 / 昨天」两张图，留太多天只会让文件无意义地膨胀。
fn trim_hourly_usage(history: &mut SupplierUsageHistory) {
    let mut days: Vec<String> = Vec::new();
    for key in history.hourly.keys() {
        let day = key[..10].to_string();
        if days.last() != Some(&day) {
            days.push(day);
        }
    }
    // 按模型明细与合计是同一份数据的两面，保留天数必须一致：
    // 只裁一边会让「今天 / 昨天」的 Token 图比金额图多出或少掉几天。
    for key in history.hourly_models.keys() {
        let day = key[..10].to_string();
        if days.last() != Some(&day) {
            days.push(day);
        }
    }
    days.sort_unstable();
    days.dedup();
    while days.len() > HOURLY_DAY_LIMIT {
        let oldest = days.remove(0);
        history.hourly.retain(|key, _| !key.starts_with(&oldest));
        history
            .hourly_models
            .retain(|key, _| !key.starts_with(&oldest));
    }
}

/// 历史用量仅保留最近 [`HISTORY_DAY_LIMIT`] 天（BTreeMap 键有序，从最旧开始删）。
///
/// 与 `ledger_service::trim_history` 同一手法：只裁最旧的键，保证「最近的图」永远完整。
fn trim_usage_history(history: &mut SupplierUsageHistory) {
    while history.daily.len() > HISTORY_DAY_LIMIT {
        if let Some(oldest) = history.daily.keys().next().cloned() {
            history.daily.remove(&oldest);
        } else {
            break;
        }
    }
}

/// 「支持 1M」在模型名后的能力标记（写给 Claude Code 的形态）。
pub const ONE_M_MARKER: &str = "[1M]";

/// 模型目录最多保留的条目数（防止界面误操作把目录文件撑到不可用）。
pub const MAX_CATALOG_ENTRIES: usize = 100;
/// 模型名 / 显示名长度上限（字符数）。
pub const MAX_MODEL_NAME_LEN: usize = 128;

/// 模型名是否带 1M 能力标记（大小写不敏感，尾随空白不影响判定）。
pub fn has_one_m(model: &str) -> bool {
    model.trim_end().to_ascii_lowercase().ends_with("[1m]")
}

/// 去掉尾部的 1M 能力标记（没有标记时原样返回，只裁尾随空白）。
pub fn strip_one_m(model: &str) -> &str {
    let trimmed = model.trim_end();
    if has_one_m(trimmed) {
        trimmed[..trimmed.len() - ONE_M_MARKER.len()].trim_end()
    } else {
        trimmed
    }
}

/// 归一化模型目录：丢空条目、按模型名去重（先出现者优先）、钳制窗口与档位。
///
/// 档位只保留注册表登记过的取值，并按注册表顺序重排：Codex 的 `/model` 菜单与
/// 生成的目录文件都按数组顺序展示，乱序会让菜单里的档位看起来毫无规律。
fn normalize_model_catalog(catalog: &mut Vec<ModelCatalogEntry>) {
    let known: Vec<&str> = crate::domain::client::service::client_service::find_client("codex")
        .map(|client| {
            client
                .catalog_reasoning_levels()
                .iter()
                .map(|(value, _)| *value)
                .collect()
        })
        .unwrap_or_default();

    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for entry in catalog.iter() {
        let model = entry.model.trim().to_string();
        if model.is_empty() || !seen.insert(model.clone()) {
            continue;
        }
        let display_name = truncate_chars(entry.display_name.trim(), MAX_MODEL_NAME_LEN);
        let levels: Vec<String> = known
            .iter()
            .filter(|value| {
                entry
                    .reasoning_levels
                    .iter()
                    .any(|item| item.trim() == **value)
            })
            .map(|value| (*value).to_string())
            .collect();
        normalized.push(ModelCatalogEntry {
            display_name: if display_name.is_empty() {
                model.clone()
            } else {
                display_name
            },
            model: truncate_chars(&model, MAX_MODEL_NAME_LEN),
            context_window: entry.context_window.min(MAX_CONTEXT_WINDOW),
            reasoning_levels: levels,
        });
        if normalized.len() >= MAX_CATALOG_ENTRIES {
            break;
        }
    }
    *catalog = normalized;
}

/// 按字符数截断（不切开多字节字符）。
fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// 归一化模型路由。
///
/// 按键名索引的字段共用同一套规则：键去空白、丢空键；映射值去空白；
/// 选项取值统一小写（与注册表登记的取值同形，避免 `High` / `high` 被当成两种取值）。
/// 模型名上的 1M 标记按注册表校正：不支持 1M 的档位（如 Haiku）一律剥掉，
/// 否则界面上勾选框是禁用的、写进客户端配置的却带着标记，两边对不上。
pub fn normalize_routing(routing: &mut SupplierRouting) {
    routing.client_id = routing.client_id.trim().to_lowercase();
    routing.model_map = routing
        .model_map
        .iter()
        .map(|(from, to)| (from.trim().to_string(), to.trim().to_string()))
        .filter(|(from, to)| !from.is_empty() && !to.is_empty())
        .collect();
    routing.display_map = routing
        .display_map
        .iter()
        .map(|(from, to)| (from.trim().to_string(), to.trim().to_string()))
        .filter(|(from, to)| !from.is_empty() && !to.is_empty())
        // 显示名只影响 /model 菜单，1M 标记不属于名字的一部分。
        .map(|(from, to)| (from, strip_one_m(&to).to_string()))
        .filter(|(_, to)| !to.is_empty())
        .collect();
    // 不支持 1M 的档位：把标记剥掉（注册表是唯一事实来源；未登记客户端不干预）。
    if let Some(client) = crate::domain::client::service::client_service::find_client(&routing.client_id) {
        let disallowed: Vec<&str> = client
            .model_slots()
            .iter()
            .filter(|slot| !slot.supports_one_m)
            .map(|slot| slot.key)
            .collect();
        for (key, value) in routing.model_map.iter_mut() {
            if disallowed.contains(&key.as_str()) {
                *value = strip_one_m(value).to_string();
            }
        }
    }
    routing.switches = routing
        .switches
        .iter()
        .map(|(name, enabled)| (name.trim().to_string(), *enabled))
        .filter(|(name, _)| !name.is_empty())
        .collect();
    routing.options = routing
        .options
        .iter()
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_ascii_lowercase()))
        .filter(|(name, _)| !name.is_empty())
        .collect();
    // 0 表示「沿用客户端默认窗口」，是合法取值，只做上界保护。
    if routing.context_window > MAX_CONTEXT_WINDOW {
        routing.context_window = MAX_CONTEXT_WINDOW;
    }
    if routing.compact_token_limit > MAX_CONTEXT_WINDOW {
        routing.compact_token_limit = MAX_CONTEXT_WINDOW;
    }
    normalize_model_catalog(&mut routing.model_catalog);
}

/// 归一化索引：去重（`(scope, slug)` 唯一）、统一排序；版本号缺失时补当前版本。
pub fn normalize_index(index: &mut SupplierIndex) {
    if index.version == 0 {
        index.version = INDEX_VERSION;
    }
    for entry in &mut index.suppliers {
        entry.scope = entry.scope.trim().to_ascii_lowercase();
        entry.slug = entry.slug.trim().to_ascii_lowercase();
        entry.name = entry.name.trim().to_string();
        entry.category = entry.category.trim().to_string();
        entry.logo = entry.logo.trim().to_string();
    }
    // scope 与 slug 缺一不可：少了 scope 就无法定位条目属于哪个列表。
    index
        .suppliers
        .retain(|entry| !entry.scope.is_empty() && !entry.slug.is_empty());
    // 同一供应商可以在不同列表下各有一条，因此去重键必须是 `(scope, slug)`。
    let mut seen = BTreeSet::new();
    index
        .suppliers
        .retain(|entry| seen.insert((entry.scope.clone(), entry.slug.clone())));
    index.suppliers.sort_by(|a, b| {
        a.scope
            .cmp(&b.scope)
            .then_with(|| a.order.cmp(&b.order))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.slug.cmp(&b.slug))
    });
}

// ---------------------------------------------------------------------------
// 必填校验
// ---------------------------------------------------------------------------

/// 校验展示信息：标识、名称。
pub fn validate_profile(profile: &SupplierProfile) -> AppResult<()> {
    validate_slug(&profile.slug)?;
    if profile.name.is_empty() {
        return Err(AppError::invalid("供应商名称不能为空"));
    }
    if profile.name.chars().count() > MAX_NAME_LEN {
        return Err(AppError::invalid(format!(
            "供应商名称过长（上限 {} 个字符）",
            MAX_NAME_LEN
        )));
    }
    Ok(())
}

/// 校验请求地址：必须是非空的 http(s) 地址。
pub fn validate_endpoint(endpoint: &SupplierEndpoint) -> AppResult<()> {
    if endpoint.base_url.is_empty() {
        return Err(AppError::invalid("请求地址不能为空"));
    }
    if !is_http_url(&endpoint.base_url) {
        return Err(AppError::invalid("请求地址必须以 http:// 或 https:// 开头"));
    }
    Ok(())
}

/// 校验在线用量来源（余额来源与用量统计来源共用）。
///
/// 在线来源现在是**内置常量表**（[`builtin_usage_preset`]），没有用户输入，因此生产
/// 路径不再调用它；保留它是为了守住这张手写表——地址、取值路径、窗口口径写错一个
/// 字符就只会「静默取不到数」，正是最需要测试兜住的那类错误，回归测试逐个来源调它。
#[allow(dead_code)]
pub fn validate_usage_query(query: &SupplierUsageQuery) -> AppResult<()> {
    validate_usage_source(query)?;
    // 用量统计来源是同一套结构：整块缺席合法，写了就必须同样合规。
    if let Some(stats) = query.stats.as_deref() {
        validate_usage_source(stats)?;
    }
    // Token 统计来源同理。
    if let Some(stats) = query.token_stats.as_deref() {
        validate_usage_source(stats)?;
    }
    Ok(())
}

/// 校验单个来源（余额来源 / 用量统计来源共用）。调用方见 [`validate_usage_query`]。
#[allow(dead_code)]
fn validate_usage_source(query: &SupplierUsageQuery) -> AppResult<()> {
    if !TOKEN_SOURCES.contains(&query.token_source.as_str()) {
        return Err(AppError::invalid(format!(
            "鉴权凭证来源只能是 {} 或 {}",
            TOKEN_SOURCE_API_KEY, TOKEN_SOURCE_USAGE_TOKEN
        )));
    }
    if !WINDOWS.contains(&query.window.as_str()) {
        return Err(AppError::invalid(format!(
            "取数窗口口径只能是 {} 或 {}",
            WINDOW_DAY, WINDOW_MONTH
        )));
    }
    if query.url_template.is_empty() {
        return Ok(());
    }
    if !is_http_url(&query.url_template) {
        return Err(AppError::invalid(
            "用量查询接口地址必须以 http:// 或 https:// 开头",
        ));
    }
    // 占位符必须成对且非空：模板替换是「按名取值」，缺半边的模板只会拼出坏地址。
    let placeholders = template_placeholders(&query.url_template)?;
    for name in &query.required_params {
        // 必填参数却不出现在模板里：填了也没人用，属于配置自相矛盾。
        if !placeholders.contains(name) {
            return Err(AppError::invalid(format!(
                "必填参数 {} 未在用量查询接口地址中使用",
                name
            )));
        }
        // 保留名由客户端自动解析，不要求（也不应要求）在 params 里再填一遍。
        if is_reserved_placeholder(name) {
            continue;
        }
        let provided = query
            .params
            .get(name)
            .is_some_and(|value| !value.trim().is_empty());
        if !provided {
            return Err(AppError::invalid(format!("必填参数 {} 缺少取值", name)));
        }
    }
    // 逐日明细只给了数组路径、却缺日期或金额，等于配不出任何一天的数据。
    if !query.extract.daily_list.is_empty()
        && (query.extract.daily_date.is_empty() || query.extract.daily_amount.is_empty())
    {
        return Err(AppError::invalid("逐日明细需要同时指定日期字段与金额字段"));
    }
    // 按模型拆分：三个路径是**一组**，缺一个就既取不到模型名、也定位不到桶。
    let by_model = [
        &query.extract.series_list,
        &query.extract.series_model,
        &query.extract.series_items,
    ];
    let given = by_model
        .iter()
        .filter(|path| !path.trim().is_empty())
        .count();
    if given != 0 && given != by_model.len() {
        return Err(AppError::invalid(
            "按模型拆分的明细需要同时指定模型数组、模型名与桶数组三个路径",
        ));
    }
    if given == by_model.len() && query.extract.daily_date.is_empty() {
        return Err(AppError::invalid("按模型拆分的明细需要指定桶内的时间字段"));
    }
    // Token 口径：三条路径同样是一组——只配一部分会把缺的那部分当成 0，
    // 界面上就变成「某模型没有输出」这种错误结论。
    let token_paths = [
        &query.extract.token_hit,
        &query.extract.token_miss,
        &query.extract.token_out,
    ];
    let token_given = token_paths
        .iter()
        .filter(|path| !path.trim().is_empty())
        .count();
    if token_given != 0 && token_given != token_paths.len() {
        return Err(AppError::invalid(
            "Token 明细需要同时指定「命中缓存 / 未命中缓存 / 输出」三个路径",
        ));
    }
    Ok(())
}

/// 解析模板占位符取值：保留名优先，其余从 `params` 按名取。
///
/// 两套凭证各归其位：`key` / `api_key` / `apiKey` 取 API Key，
/// `token` / `usage_token` 取平台登录令牌——控制台内部接口只认后者，
/// 拿错凭证只会得到「鉴权失败」，因此这里不做任何「自动兜底」。
///
/// 返回 `None` 表示「没有取值」——调用方据此报「缺少取值」，
/// 而不是把空串悄悄拼进地址。
pub fn resolve_placeholder(
    name: &str,
    credential: &SupplierCredential,
    params: &BTreeMap<String, String>,
    now: DateTime<Local>,
    window: TimeWindow,
) -> Option<String> {
    // 保留名优先：即使 params 里写了同名键，也不得覆盖凭证 / 日期等系统取值。
    if API_KEY_PLACEHOLDERS.contains(&name) {
        let key = credential.token_for(TOKEN_SOURCE_API_KEY);
        return (!key.is_empty()).then(|| key.to_string());
    }
    if USAGE_TOKEN_PLACEHOLDERS.contains(&name) {
        let token = credential.token_for(TOKEN_SOURCE_USAGE_TOKEN);
        return (!token.is_empty()).then(|| token.to_string());
    }
    match name {
        DATE_PLACEHOLDER => return Some(now.format("%Y-%m-%d").to_string()),
        MONTH_PLACEHOLDER => return Some(now.format("%Y-%m").to_string()),
        MONTH_NUM_PLACEHOLDER => return Some(now.month().to_string()),
        YEAR_PLACEHOLDER => return Some(now.format("%Y").to_string()),
        TIMESTAMP_PLACEHOLDER => return Some(now.timestamp().to_string()),
        START_PLACEHOLDER => return Some(window.start.to_string()),
        END_PLACEHOLDER => return Some(window.end.to_string()),
        TZ_PLACEHOLDER => return Some(window.tz.to_string()),
        _ => {}
    }
    params
        .get(name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 当地当天 00:00 的 Unix 秒。
///
/// 用「当前时间戳 - 当日已过秒数」求，避免再引入一次时区换算；国内无夏令时，
/// 该式在所有实际时区偏移下都等于「当地日零点」。
fn day_start_epoch(now: DateTime<Local>) -> i64 {
    now.timestamp() - i64::from(now.time().num_seconds_from_midnight())
}

/// 当地某年某月 1 日 00:00 的 Unix 秒。
fn month_start_epoch(year: i32, month: u32) -> Option<i64> {
    Local
        .with_ymd_and_hms(year, month, 1, 0, 0, 0)
        .single()
        .map(|start| start.timestamp())
}

/// 会话默认时区偏移（秒）：所有内置来源都按「本机当地自然日」切分数据。
fn local_tz(now: DateTime<Local>) -> i32 {
    now.offset().local_minus_utc()
}

impl TimeWindow {
    /// 当天窗口：当地 00:00 → 次日 00:00。
    pub fn day(now: DateTime<Local>) -> Self {
        let start = day_start_epoch(now);
        Self {
            start,
            end: start + 86_400,
            tz: local_tz(now),
        }
    }

    /// 当月窗口：当月 1 日 00:00 → 次日 00:00（含今天，故不截断到月末）。
    pub fn month(now: DateTime<Local>) -> Self {
        let start =
            month_start_epoch(now.year(), now.month()).unwrap_or_else(|| day_start_epoch(now));
        Self {
            start,
            end: day_start_epoch(now) + 86_400,
            tz: local_tz(now),
        }
    }

    /// 指定自然月的整月窗口（用于回填历史月份）。
    pub fn for_month(year: i32, month: u32, now: DateTime<Local>) -> Option<Self> {
        let start = month_start_epoch(year, month)?;
        let (next_year, next_month) = if month == 12 {
            (year + 1, 1)
        } else {
            (year, month + 1)
        };
        let end = month_start_epoch(next_year, next_month)?;
        Some(Self {
            start,
            end,
            tz: local_tz(now),
        })
    }

    /// 指定自然日的整天窗口（本地时区）。
    ///
    /// 单日窗口会让官网按**小时**粒度应答，界面上的「今天 / 昨天」靠它拿到逐小时明细。
    pub fn on_day(date: NaiveDate, now: DateTime<Local>) -> Option<Self> {
        let start = Local
            .with_ymd_and_hms(date.year(), date.month(), date.day(), 0, 0, 0)
            .single()?
            .timestamp();
        Some(Self {
            start,
            end: start + 86_400,
            tz: local_tz(now),
        })
    }

    /// 指定闭区间 `[start, end]` 的窗口（本地时区，含 `end` 当天整天）。
    ///
    /// 用于「按界面所选时间段取数」：官网接口要求窗口端点落在当地零点，
    /// 这里统一按 `start 00:00 → end+1 00:00` 拼装，`end < start` 视为非法。
    pub fn on_days(start: NaiveDate, end: NaiveDate, now: DateTime<Local>) -> Option<Self> {
        if end < start {
            return None;
        }
        let from = Local
            .with_ymd_and_hms(start.year(), start.month(), start.day(), 0, 0, 0)
            .single()?
            .timestamp();
        let to = Local
            .with_ymd_and_hms(end.year(), end.month(), end.day(), 0, 0, 0)
            .single()?
            .timestamp()
            + 86_400;
        Some(Self {
            start: from,
            end: to,
            tz: local_tz(now),
        })
    }

    /// 按来源声明的口径取默认窗口。
    pub fn of(window: &str, now: DateTime<Local>) -> Self {
        if window.trim() == WINDOW_MONTH {
            Self::month(now)
        } else {
            Self::day(now)
        }
    }
}

/// 校验模型路由：客户端由 scope 目录确定，标识必须先合规。
pub fn validate_routing(routing: &SupplierRouting) -> AppResult<()> {
    validate_client_id(&routing.client_id)?;
    Ok(())
}

/// 提取模板占位符名称（`{name}`），按出现顺序返回。
///
/// 模板只约定「URL 骨架 + `{参数}`」这一层语法，不解析任何具体协议，
/// 因此这里只校验花括号成对与名称非空。
pub fn template_placeholders(template: &str) -> AppResult<Vec<String>> {
    let mut names = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else {
            return Err(AppError::invalid("用量查询接口模板的占位符缺少右花括号"));
        };
        let name = after[..end].trim();
        if name.is_empty() {
            return Err(AppError::invalid("用量查询接口模板的占位符不能为空"));
        }
        names.push(name.to_string());
        rest = &after[end + 1..];
    }
    // 走到这里已无 `{`，残留的 `}` 必然是落单的。
    if rest.contains('}') {
        return Err(AppError::invalid("用量查询接口模板的占位符缺少左花括号"));
    }
    Ok(names)
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// 归一化地址：去首尾空白与尾部斜杠（与 `config_service` 对 `base_url` 的处理一致）。
fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

/// 白名单归一化：去空白 + 小写后命中白名单才保留，否则回落默认值。
///
/// 「非法值兜底而非报错」是有意为之：读盘路径也会经过归一化，
/// 历史版本写入的旧值不能把用户挡在门外。
fn normalize_choice(value: &str, whitelist: &[&str], default: &str) -> String {
    let candidate = value.trim().to_ascii_lowercase();
    if whitelist.contains(&candidate.as_str()) {
        candidate
    } else {
        default.to_string()
    }
}

/// 请求方法归一化：HTTP 方法的规范写法是大写，故先大写再比对白名单。
fn normalize_http_method(value: &str) -> String {
    let candidate = value.trim().to_ascii_uppercase();
    if HTTP_METHODS.contains(&candidate.as_str()) {
        candidate
    } else {
        DEFAULT_METHOD.to_string()
    }
}

/// 归一化无序列表：去空白、去空项、去重并排序（结果稳定，便于比较与展示）。
fn normalize_set(values: &[String]) -> Vec<String> {
    let mut out: Vec<String> = values
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

/// 保序去重（顺序本身是语义的一部分时使用，如候选端点的优先级）。
fn dedup_preserving_order(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    items
        .into_iter()
        .filter(|item| seen.insert(item.clone()))
        .collect()
}

/// 是否为 http(s) 地址。
fn is_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

/// 日期键形状校验：`YYYY-MM-DD`（不校验真实日历日期，仅拒绝明显脏数据）。
///
/// 供用量明细解析复用（`infrastructure::http::usage_client` 用它筛掉
/// 接口返回里的非日期键），因此必须是 `pub`。
pub fn is_date_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::supplier::model::{DailyUsage, SupplierIndexEntry};
    use std::collections::BTreeMap;

    /// 构造凭证（API Key + 平台登录令牌），便于占位符解析测试。
    fn cred(api_key: &str, usage_token: &str) -> SupplierCredential {
        SupplierCredential {
            api_key: api_key.to_string(),
            usage_token: usage_token.to_string(),
        }
    }

    #[test]
    fn slugify_folds_non_alphanumeric_and_truncates() {
        assert_eq!(slugify(" My Supplier!! "), "my-supplier");
        assert_eq!(slugify("DeepSeek"), "deepseek");
        assert_eq!(slugify("a--b"), "a-b");
        // 纯中文名无法产出 ASCII slug：返回空串，由调用方改用显式 slug。
        assert_eq!(slugify("供应商"), "");
        assert_eq!(slugify("   "), "");

        let long = slugify(&"a".repeat(MAX_SLUG_LEN + 20));
        assert_eq!(long.len(), MAX_SLUG_LEN);
        assert!(!long.ends_with('-'), "截断后不得以连字符结尾");

        // 截断恰好落在连字符后：连字符也要一并裁掉，否则目录名以 `-` 结尾。
        let dashed = slugify(&format!("{}-b", "a".repeat(MAX_SLUG_LEN - 1)));
        assert_eq!(dashed.len(), MAX_SLUG_LEN - 1, "截断后应同时裁掉尾部连字符");
    }

    #[test]
    fn validate_slug_blocks_traversal_and_uppercase() {
        assert_eq!(validate_slug(" deepseek ").unwrap(), "deepseek");
        assert_eq!(validate_slug("custom-1").unwrap(), "custom-1");

        for bad in [
            "",
            "   ",
            ".",
            "..",
            "../evil",
            "a/b",
            "a\\b",
            "DeepSeek",
            "a_b",
            "供应商",
            "-a",
            "a-",
        ] {
            assert!(validate_slug(bad).is_err(), "「{}」不应通过校验", bad);
        }

        assert_eq!(
            validate_slug("").unwrap_err().message(),
            "供应商标识不能为空"
        );
        assert_eq!(
            validate_slug("..").unwrap_err().message(),
            "供应商标识只能包含小写字母、数字与连字符"
        );
        assert_eq!(
            validate_slug("a-").unwrap_err().message(),
            "供应商标识不能以连字符开头或结尾"
        );
        assert!(validate_slug(&"a".repeat(MAX_SLUG_LEN + 1)).is_err());

        assert_eq!(custom_slug(3), "custom-3");
    }

    #[test]
    fn validate_client_id_shares_slug_charset() {
        assert_eq!(validate_client_id("claude").unwrap(), "claude");
        assert_eq!(validate_client_id(" codex ").unwrap(), "codex");

        for bad in [
            "",
            "CLAUDE",
            "../claude",
            "a/b",
            "c_d",
            "-claude",
            "claude-",
        ] {
            assert!(validate_client_id(bad).is_err(), "「{}」不应通过校验", bad);
        }
    }

    /// scope 是列表的一级目录名：与 slug 同规则，但错误文案必须能区分出「列表标识」。
    #[test]
    fn validate_scope_shares_slug_rules_with_own_messages() {
        assert_eq!(validate_scope(" balance ").unwrap(), "balance");
        assert_eq!(validate_scope("claude").unwrap(), "claude");
        assert_eq!(validate_scope("gemini-cli").unwrap(), "gemini-cli");

        for bad in [
            "", "   ", "Balance", "../x", "a/b", "a\\b", "_x", "-x", "x-",
        ] {
            assert!(validate_scope(bad).is_err(), "「{}」不应通过校验", bad);
        }
        assert!(validate_scope(&"a".repeat(MAX_SLUG_LEN + 1)).is_err());

        assert_eq!(
            validate_scope("").unwrap_err().message(),
            "列表标识不能为空"
        );
        assert_eq!(
            validate_scope("../x").unwrap_err().message(),
            "列表标识只能包含小写字母、数字与连字符"
        );
        assert_eq!(
            validate_scope("x-").unwrap_err().message(),
            "列表标识不能以连字符开头或结尾"
        );
    }

    #[test]
    fn host_is_extracted_from_common_shapes() {
        assert_eq!(
            host_of("https://api.deepseek.com/anthropic/"),
            "api.deepseek.com"
        );
        assert_eq!(host_of("http://127.0.0.1:11434/v1"), "127.0.0.1");
        assert_eq!(host_of("api.deepseek.com/anthropic"), "api.deepseek.com");
        assert_eq!(
            host_of("https://user:pw@proxy.example.com:8443/v1"),
            "proxy.example.com"
        );
        assert_eq!(host_of("HTTPS://API.DeepSeek.com"), "api.deepseek.com");
        assert_eq!(host_of("https://[::1]:11434/v1"), "::1");
    }

    #[test]
    fn infer_supplier_matches_known_hosts() {
        let cases = [
            ("https://api.deepseek.com/anthropic", "deepseek", "DeepSeek"),
            ("https://api.moonshot.cn/v1", "kimi", "Kimi"),
            ("https://api.kimi.com/coding", "kimi", "Kimi"),
            (
                "https://api-inference.modelscope.cn/v1",
                "modelscope",
                "ModelScope",
            ),
            ("https://aihubmix.com/v1", "aihubmix", "AiHubMix"),
            ("https://api.shengsuanyun.com/v1", "shengsuanyun", "神算云"),
            ("https://api.xiaomimimo.com/v1", "xiaomimimo", "小米MiMo"),
        ];
        for (base_url, slug, name) in cases {
            match infer_supplier(base_url) {
                InferredSupplier::Known(known) => {
                    assert_eq!(known.slug, slug, "{}", base_url);
                    assert_eq!(known.name, name, "{}", base_url);
                }
                InferredSupplier::Custom => panic!("{} 应命中已知供应商", base_url),
            }
        }

        // 大小写不敏感，且 DeepSeek 归为「官方」。
        let known = known_supplier_for("API.DEEPSEEK.COM").unwrap();
        assert_eq!(known.slug, "deepseek");
        assert_eq!(known.category, "官方");

        // 未命中与空地址都落到自定义。
        for unknown in ["https://example.com/v1", "https://proxy.internal", ""] {
            assert_eq!(infer_supplier(unknown), InferredSupplier::Custom);
        }
    }

    #[test]
    fn endpoint_is_normalized_and_validated() {
        let mut endpoint = SupplierEndpoint {
            base_url: "  https://api.deepseek.com/anthropic/  ".into(),
            api_format: " OpenAI ".into(),
            auth_field: "X-Api-Key".into(),
            endpoint_candidates: vec![
                " https://api.deepseek.com/anthropic/ ".into(),
                "".into(),
                "https://api.deepseek.com/anthropic".into(),
            ],
            ..SupplierEndpoint::default()
        };
        normalize_endpoint(BALANCE_SCOPE, &mut endpoint);
        assert_eq!(endpoint.base_url, "https://api.deepseek.com/anthropic");
        assert_eq!(endpoint.api_format, "openai");
        assert_eq!(
            endpoint.auth_field, "x-api-key",
            "余额配置列表的认证字段是请求头名（大小写不敏感，回写规范写法）"
        );
        assert_eq!(
            endpoint.endpoint_candidates,
            vec!["https://api.deepseek.com/anthropic".to_string()],
            "候选端点应去空白、去空项、保序去重"
        );

        // 白名单之外的值回落默认值（读盘路径同样经过归一化）。
        let mut fallback = SupplierEndpoint {
            api_format: "乱写".into(),
            auth_field: "乱写".into(),
            ..SupplierEndpoint::default()
        };
        normalize_endpoint(BALANCE_SCOPE, &mut fallback);
        assert_eq!(fallback.api_format, DEFAULT_API_FORMAT);
        assert_eq!(fallback.auth_field, DEFAULT_AUTH_FIELD);

        // 客户端列表：认证字段是「密钥写进客户端配置的哪个键」，Claude 只有登记的两项。
        let mut claude = SupplierEndpoint {
            auth_field: " anthropic_api_key ".into(),
            ..SupplierEndpoint::default()
        };
        normalize_endpoint("claude", &mut claude);
        assert_eq!(
            claude.auth_field, "ANTHROPIC_API_KEY",
            "大小写不敏感，且回写白名单里的规范写法"
        );
        let mut claude_default = SupplierEndpoint {
            auth_field: "乱写".into(),
            ..SupplierEndpoint::default()
        };
        normalize_endpoint("claude", &mut claude_default);
        assert_eq!(
            claude_default.auth_field, "ANTHROPIC_AUTH_TOKEN",
            "非法值回落 Claude 的默认认证字段"
        );
        // Codex 没有认证字段配置项：旧值一律清空，避免残留影响渲染。
        let mut codex = SupplierEndpoint {
            auth_field: "anthropic_api_key".into(),
            ..SupplierEndpoint::default()
        };
        normalize_endpoint("codex", &mut codex);
        assert_eq!(codex.auth_field, "");
        // Codex 只讲 OpenAI 协议：协议缺失 / 非法时回落注册表登记的 Responses 协议，
        // 不能拿全局默认的 Anthropic 兜底（那样写出来的 wire_api 是错的）。
        let mut codex_format = SupplierEndpoint {
            api_format: "乱写".into(),
            ..SupplierEndpoint::default()
        };
        normalize_endpoint("codex", &mut codex_format);
        assert_eq!(
            codex_format.api_format, "openai-responses",
            "Codex 的 API 格式缺失 / 非法时回落 Responses 协议"
        );

        // 白名单内的每个取值都应被原样保留。
        for format in API_FORMATS {
            assert_eq!(normalize_endpoint_format(format), format);
        }
        for field in AUTH_FIELDS {
            assert_eq!(normalize_endpoint_auth_field(field), field);
        }

        let mut empty = SupplierEndpoint::default();
        assert_eq!(
            validate_endpoint(&empty).unwrap_err().message(),
            "请求地址不能为空"
        );
        empty.base_url = "api.deepseek.com".into();
        assert!(validate_endpoint(&empty).is_err(), "非 http 地址应被拒绝");
        empty.base_url = "https://api.deepseek.com".into();
        assert!(validate_endpoint(&empty).is_ok());
    }

    #[test]
    fn usage_query_is_normalized_and_validated() {
        let mut query = SupplierUsageQuery {
            url_template: " https://api.x.com/usage?key={key} ".into(),
            method: "post".into(),
            auth_type: "HEADER".into(),
            currency: " usd ".into(),
            headers: BTreeMap::from([
                ("  X-Trace ".to_string(), " on ".to_string()),
                (String::new(), "drop".to_string()),
            ]),
            extract: UsageExtract {
                balance: " data.balance ".into(),
                currency: " data.currency ".into(),
                daily_list: " data.daily ".into(),
                daily_date: " date ".into(),
                daily_amount: " amount ".into(),
                scale: 0.0001,
                ..UsageExtract::default()
            },
            required_params: vec!["key".into(), " key ".into(), "".into()],
            params: BTreeMap::from([
                (" token ".to_string(), " abc ".to_string()),
                (String::new(), "drop".to_string()),
            ]),
            ..SupplierUsageQuery::default()
        };
        normalize_usage_query(&mut query);
        assert_eq!(query.url_template, "https://api.x.com/usage?key={key}");
        assert_eq!(query.method, "POST");
        assert_eq!(query.auth_type, "header");
        assert_eq!(query.currency, "USD", "兜底币种应去空白并大写");
        assert_eq!(query.headers.get("X-Trace").map(String::as_str), Some("on"));
        assert_eq!(query.headers.len(), 1, "空键名的请求头应被丢弃");
        assert_eq!(query.extract.balance, "data.balance");
        assert_eq!(query.extract.currency, "data.currency");
        assert_eq!(query.extract.daily_list, "data.daily");
        assert_eq!(query.extract.daily_date, "date");
        assert_eq!(query.extract.daily_amount, "amount");
        assert_eq!(query.extract.scale, 0.0001, "合法倍率必须原样保留");
        assert_eq!(query.required_params, vec!["key".to_string()]);
        assert_eq!(query.params.get("token").map(String::as_str), Some("abc"));
        assert_eq!(query.params.len(), 1, "空键名的参数应被丢弃");
        assert!(validate_usage_query(&query).is_ok());

        // 非法方法 / 鉴权方式回落默认值。
        let mut fallback = SupplierUsageQuery {
            url_template: "https://api.x.com/usage".into(),
            method: "DELETE".into(),
            auth_type: "乱写".into(),
            ..SupplierUsageQuery::default()
        };
        normalize_usage_query(&mut fallback);
        assert_eq!(fallback.method, DEFAULT_METHOD);
        assert_eq!(fallback.auth_type, DEFAULT_AUTH_TYPE);

        // 必填校验：空模板合法（走本地记账兜底），写了但写坏才拒绝。
        let mut empty = SupplierUsageQuery::default();
        assert!(
            validate_usage_query(&empty).is_ok(),
            "空模板表示未配置在线查询，不应拦截保存"
        );
        empty.url_template = "api.x.com/usage".into();
        assert!(
            validate_usage_query(&empty).is_err(),
            "非 http 地址应被拒绝"
        );
    }

    /// 换算倍率只接受正的有限数：0 / 负数 / NaN / 无穷一律回落默认倍率。
    ///
    /// 这条规则是「宁可退回 1.0 也不要算出错误金额」的兜底：倍率写错会把整段
    /// 用量放大或清零，属于比缺数据更糟的结果。
    #[test]
    fn scale_falls_back_to_default_when_invalid() {
        for bad in [
            0.0,
            -1.0,
            -0.0001,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            let mut query = SupplierUsageQuery {
                url_template: "https://api.x.com/usage".into(),
                extract: UsageExtract {
                    scale: bad,
                    ..UsageExtract::default()
                },
                ..SupplierUsageQuery::default()
            };
            normalize_usage_query(&mut query);
            assert_eq!(
                query.extract.scale, DEFAULT_SCALE,
                "非法倍率 {:?} 应回落默认值",
                bad
            );
        }
        // 合法倍率（含极小值）必须原样保留。
        for good in [1.0, 0.0001, 100.0] {
            let mut query = SupplierUsageQuery {
                url_template: "https://api.x.com/usage".into(),
                extract: UsageExtract {
                    scale: good,
                    ..UsageExtract::default()
                },
                ..SupplierUsageQuery::default()
            };
            normalize_usage_query(&mut query);
            assert_eq!(query.extract.scale, good);
        }
        // 归一化必须幂等：反复读写不会让倍率漂移。
        let mut idempotent = SupplierUsageQuery {
            url_template: "https://api.x.com/usage".into(),
            extract: UsageExtract {
                scale: 0.0001,
                ..UsageExtract::default()
            },
            ..SupplierUsageQuery::default()
        };
        normalize_usage_query(&mut idempotent);
        let once = idempotent.extract.scale;
        normalize_usage_query(&mut idempotent);
        assert_eq!(once, idempotent.extract.scale);
    }

    /// 内置在线用量配置：每个都必须自洽（能过保存期校验），未收录的品牌一律没有。
    #[test]
    fn builtin_usage_presets_are_valid_and_scoped() {
        assert_eq!(BUILTIN_USAGE_SLUGS.len(), 7);
        for slug in BUILTIN_USAGE_SLUGS {
            let query =
                builtin_usage_preset(slug).unwrap_or_else(|| panic!("{} 应有内置配置", slug));
            assert!(
                validate_usage_query(&query).is_ok(),
                "{} 的内置配置必须能通过保存期校验：{:?}",
                slug,
                validate_usage_query(&query).unwrap_err()
            );
            assert!(
                !query.extract.balance.is_empty(),
                "{} 至少要能取到余额，否则这条在线配置没有意义",
                slug
            );
            assert_eq!(query.auth_type, DEFAULT_AUTH_TYPE);
            assert_eq!(query.method, DEFAULT_METHOD);
        }

        // 大小写与空白容错：目录名来自磁盘，可能带空格。
        assert!(builtin_usage_preset(" DeepSeek ").is_some());

        // 各家的关键差异必须落到配置上（避免复制粘贴写错）。
        let deepseek = builtin_usage_preset("deepseek").unwrap();
        assert_eq!(
            deepseek.url_template,
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(deepseek.extract.currency, "balance_infos.0.currency");
        assert_eq!(deepseek.extract.scale, 1.0);
        // 余额走官方 API Key；用量统计走控制台的网页登录令牌 —— 两套凭证不许混用。
        assert_eq!(deepseek.token_source, TOKEN_SOURCE_API_KEY);
        let stats = deepseek
            .stats
            .as_deref()
            .expect("deepseek 应配置用量统计来源");
        assert_eq!(stats.token_source, TOKEN_SOURCE_USAGE_TOKEN);
        assert!(
            stats.url_template.contains("/api/v0/usage/by_api_key/cost"),
            "用量统计必须走官网用量页同源的 by_api_key/cost 接口：{}",
            stats.url_template
        );
        assert!(
            stats.url_template.contains("{start}")
                && stats.url_template.contains("{end}")
                && stats.url_template.contains("{tz}"),
            "按时间窗取数：start / end / tz 必须都由模板自动解析"
        );
        assert_eq!(
            stats.window, WINDOW_MONTH,
            "窗口长度受接口限制，按自然月取数"
        );
        assert_eq!(stats.currency, "CNY");
        // 金额按「模型 → 桶」两层解析：层层保留模型名，悬浮提示才能逐模型列金额。
        assert_eq!(stats.extract.series_list, "data.biz_data.data.*.series");
        assert_eq!(stats.extract.series_model, "model");
        assert_eq!(stats.extract.series_items, "buckets");
        assert_eq!(stats.extract.daily_date, "time");
        assert_eq!(stats.extract.daily_amount, "cost");
        assert!(
            stats.headers.contains_key("User-Agent"),
            "控制台内部接口按网页端请求校验，必须带 UA"
        );

        // Token 统计：与金额同源同窗口的另一条接口，桶里是三类 Token 计数。
        let token_stats = deepseek
            .token_stats
            .as_deref()
            .expect("deepseek 应配置 Token 统计来源");
        assert_eq!(token_stats.token_source, TOKEN_SOURCE_USAGE_TOKEN);
        assert!(
            token_stats
                .url_template
                .contains("/api/v0/usage/by_api_key/amount"),
            "Token 必须走官网用量页同源的 by_api_key/amount 接口：{}",
            token_stats.url_template
        );
        assert_eq!(
            token_stats.window, WINDOW_MONTH,
            "与金额来源同窗口，才能合并到同一批逐日桶里"
        );
        assert_eq!(
            token_stats.extract.series_list, "data.biz_data.series",
            "amount 接口没有 data[] 外层，series 直接挂在 biz_data 下"
        );
        assert_eq!(token_stats.extract.series_model, "model");
        assert_eq!(token_stats.extract.series_items, "buckets");
        assert_eq!(token_stats.extract.daily_date, "time");
        assert!(
            token_stats.extract.daily_amount.is_empty(),
            "Token 来源不带金额口径：否则 Token 个数会被当成金额写进账单"
        );
        assert_eq!(
            token_stats.extract.token_hit,
            "usage.PROMPT_CACHE_HIT_TOKEN"
        );
        assert_eq!(
            token_stats.extract.token_miss,
            "usage.PROMPT_CACHE_MISS_TOKEN"
        );
        assert_eq!(token_stats.extract.token_out, "usage.RESPONSE_TOKEN");
        assert!(
            token_stats.headers.contains_key("User-Agent"),
            "同为控制台内部接口，必须带 UA"
        );

        let novita = builtin_usage_preset("novita-ai").unwrap();
        assert_eq!(novita.currency, "USD", "响应不含币种时必须由配置兜底");
        assert_eq!(novita.extract.scale, 0.0001, "按万分之一美元计价");

        let openrouter = builtin_usage_preset("openrouter").unwrap();
        assert_eq!(openrouter.extract.balance, "data.limit_remaining");
        assert_eq!(openrouter.extract.used, "data.usage_daily");

        // 按「万分之一美元」计价的平台必须配倍率，否则金额会被放大一万倍。
        let aihubmix = builtin_usage_preset("aihubmix").unwrap();
        assert_eq!(aihubmix.currency, "USD");
        assert_eq!(aihubmix.extract.scale, 0.000002, "quota / 500000 = 美元");

        let stepfun = builtin_usage_preset("stepfun").unwrap();
        assert_eq!(stepfun.url_template, "https://api.stepfun.com/v1/accounts");
        assert_eq!(stepfun.extract.balance, "balance");
        assert_eq!(stepfun.currency, "CNY");

        // 未收录的品牌一律没有（留空 = 走本地记账兜底）。
        for slug in ["modelscope", "shengsuanyun", "xiaomimimo", "custom-1", ""] {
            assert!(
                builtin_usage_preset(slug).is_none(),
                "「{}」没有可核对的接口，不应伪造内置配置",
                slug
            );
        }
    }

    /// 按模型 / Token 的路径是**成组**的：只配一部分必须在保存期就被拦下，
    /// 否则运行时只会「静默取不到数」，用户看到的是永远空着的图。
    #[test]
    fn usage_query_rejects_partial_model_and_token_paths() {
        let base = SupplierUsageQuery {
            url_template: "https://api.x.com/usage".into(),
            ..SupplierUsageQuery::default()
        };

        // 缺桶数组路径：无法定位到桶。
        let mut missing_items = base.clone();
        missing_items.extract.series_list = "data.series".into();
        missing_items.extract.series_model = "model".into();
        missing_items.extract.daily_date = "time".into();
        let err = validate_usage_query(&missing_items).unwrap_err();
        assert!(
            err.message().contains("按模型拆分的明细"),
            "{}",
            err.message()
        );

        // 三个路径齐了但缺桶内时间字段：取不出任何一天。
        let mut missing_date = missing_items.clone();
        missing_date.extract.series_items = "buckets".into();
        missing_date.extract.daily_date = String::new();
        let err = validate_usage_query(&missing_date).unwrap_err();
        assert!(err.message().contains("时间字段"), "{}", err.message());

        // Token 三条路径只给两条：缺的那条会被当成 0，画出错误结论。
        let mut partial_tokens = base.clone();
        partial_tokens.extract.token_hit = "usage.hit".into();
        partial_tokens.extract.token_miss = "usage.miss".into();
        let err = validate_usage_query(&partial_tokens).unwrap_err();
        assert!(err.message().contains("Token 明细"), "{}", err.message());

        // 三条齐全即合法。
        let mut ok = partial_tokens.clone();
        ok.extract.token_out = "usage.out".into();
        assert!(validate_usage_query(&ok).is_ok());
    }

    /// 归一化：全零的模型条目必须被丢掉，否则模型下线后旧名字会永久留在文件里。
    #[test]
    fn normalize_drops_all_zero_model_entries() {
        let mut history = SupplierUsageHistory {
            daily: BTreeMap::from([(
                "2026-09-16".to_string(),
                DailyUsage {
                    local: 0.0,
                    remote: 1.0,
                    models: BTreeMap::from([
                        (
                            "flash".to_string(),
                            ModelUsage {
                                cost: 1.0,
                                hit: 10.0,
                                miss: -2.0,
                                out: f64::NAN,
                            },
                        ),
                        ("ghost".to_string(), ModelUsage::default()),
                        (
                            "  ".to_string(),
                            ModelUsage {
                                cost: 5.0,
                                ..ModelUsage::default()
                            },
                        ),
                    ]),
                },
            )]),
            ..SupplierUsageHistory::default()
        };

        normalize_usage_history(&mut history);

        let models = &history.daily["2026-09-16"].models;
        assert_eq!(models.len(), 1, "只剩真实用过的合法模型：{:?}", models);
        let flash = &models["flash"];
        assert_eq!(flash.cost, 1.0);
        assert_eq!(flash.hit, 10.0);
        assert_eq!(flash.miss, 0.0, "负值归零");
        assert_eq!(flash.out, 0.0, "NaN 归零");
    }

    /// 逐小时的两份数据（合计与按模型）保留天数必须一致：
    /// 只裁一边会让「今天 / 昨天」的 Token 图比金额图多出或少掉几天。
    #[test]
    fn trim_keeps_hourly_and_hourly_models_in_sync() {
        let mut history = SupplierUsageHistory {
            hourly: BTreeMap::from([
                ("2026-09-10 09".to_string(), 1.0),
                ("2026-09-11 09".to_string(), 1.0),
                ("2026-09-12 09".to_string(), 1.0),
            ]),
            hourly_models: BTreeMap::from([(
                "2026-09-12 09".to_string(),
                BTreeMap::from([(
                    "flash".to_string(),
                    ModelUsage {
                        hit: 10.0,
                        ..ModelUsage::default()
                    },
                )]),
            )]),
            ..SupplierUsageHistory::default()
        };

        normalize_usage_history(&mut history);

        assert_eq!(history.hourly.len(), HOURLY_DAY_LIMIT, "只留最近两天");
        assert!(
            history.hourly_models.contains_key("2026-09-12 09"),
            "最近一天的按模型明细不能被裁掉"
        );
        assert!(
            !history
                .hourly_models
                .keys()
                .any(|key| key.starts_with("2026-09-10")),
            "被裁掉那天不该留在 token 明细里"
        );
    }

    /// 必填参数规则：必须真的用在模板里；非保留名还必须给出取值。
    #[test]
    fn usage_query_validates_required_params() {
        let base = SupplierUsageQuery {
            url_template: "https://api.x.com/usage?k={key}&region={region}".into(),
            ..SupplierUsageQuery::default()
        };

        // 未在模板中出现 → 拒绝。
        let mut unused = base.clone();
        unused.required_params = vec!["missing".to_string()];
        assert_eq!(
            validate_usage_query(&unused).unwrap_err().message(),
            "必填参数 missing 未在用量查询接口地址中使用"
        );

        // 非保留名但 params 没给取值 → 拒绝。
        let mut unbound = base.clone();
        unbound.required_params = vec!["region".to_string()];
        assert_eq!(
            validate_usage_query(&unbound).unwrap_err().message(),
            "必填参数 region 缺少取值"
        );

        // 只给空白值等同于没给。
        let mut blank = base.clone();
        blank.required_params = vec!["region".to_string()];
        blank.params = BTreeMap::from([("region".to_string(), "  ".to_string())]);
        assert_eq!(
            validate_usage_query(&blank).unwrap_err().message(),
            "必填参数 region 缺少取值"
        );

        // 给了取值即通过；保留名无需在 params 里出现。
        let mut ok = blank.clone();
        ok.params = BTreeMap::from([("region".to_string(), "cn".to_string())]);
        assert!(validate_usage_query(&ok).is_ok());

        let mut only_reserved = base;
        only_reserved.required_params = vec!["key".to_string()];
        assert!(
            validate_usage_query(&only_reserved).is_ok(),
            "保留名由客户端自动解析，不应要求 params 提供取值"
        );
    }

    /// 逐日明细三件套必须同时具备。
    #[test]
    fn usage_query_validates_daily_extract() {
        let mut query = SupplierUsageQuery {
            url_template: "https://api.x.com/usage".into(),
            extract: UsageExtract {
                daily_list: "data.daily".into(),
                ..UsageExtract::default()
            },
            ..SupplierUsageQuery::default()
        };
        assert_eq!(
            validate_usage_query(&query).unwrap_err().message(),
            "逐日明细需要同时指定日期字段与金额字段"
        );

        query.extract.daily_date = "date".into();
        assert!(
            validate_usage_query(&query).is_err(),
            "缺金额字段仍应被拒绝"
        );

        query.extract.daily_amount = "amount".into();
        assert!(validate_usage_query(&query).is_ok());

        // 完全不提供明细时三个字段都为空，合法。
        let no_daily = SupplierUsageQuery {
            url_template: "https://api.x.com/usage".into(),
            ..SupplierUsageQuery::default()
        };
        assert!(validate_usage_query(&no_daily).is_ok());
    }

    /// 占位符解析：保留名优先，其余从 params 取；取不到返回 `None`。
    #[test]
    fn placeholder_resolution_prefers_reserved_names() {
        let now = Local::now();
        let window = TimeWindow::day(now);
        let params = BTreeMap::from([
            ("region".to_string(), " cn ".to_string()),
            ("key".to_string(), "from-params".to_string()),
            ("blank".to_string(), "  ".to_string()),
        ]);
        // 绝大多数断言与窗口口径无关，这里统一按当天窗口解析。
        let resolve = |name: &str, credential: &SupplierCredential| {
            resolve_placeholder(name, credential, &params, now, window)
        };

        for name in ["key", "api_key", "apiKey"] {
            assert_eq!(
                resolve(name, &cred(" sk-1 ", "")).as_deref(),
                Some("sk-1"),
                "保留名优先于 params 里的同名键"
            );
            assert_eq!(
                resolve(name, &cred("   ", "")),
                None,
                "未配置密钥时应返回「无取值」，由调用方报错"
            );
        }

        // 平台令牌走另一套凭证：API Key 不能被当成令牌使用，反之亦然。
        for name in ["token", "usage_token"] {
            assert_eq!(
                resolve(name, &cred("sk-1", " tok-1\n")).as_deref(),
                Some("tok-1"),
                "令牌保留名只取平台令牌"
            );
            assert_eq!(
                resolve(name, &cred("sk-1", "  ")),
                None,
                "只有 API Key 时令牌取不到"
            );
        }

        assert_eq!(
            resolve("date", &cred("", "")),
            Some(now.format("%Y-%m-%d").to_string())
        );
        assert_eq!(
            resolve("month", &cred("", "")),
            Some(now.format("%Y-%m").to_string())
        );
        assert_eq!(
            resolve("year", &cred("", "")),
            Some(now.format("%Y").to_string())
        );
        assert_eq!(
            resolve("timestamp", &cred("", "")),
            Some(now.timestamp().to_string())
        );
        // 时间窗三件套：窗口起点 / 终点 / 时区偏移秒（官网用量接口必填）。
        let start: i64 = resolve("start", &cred("", "")).unwrap().parse().unwrap();
        let end: i64 = resolve("end", &cred("", "")).unwrap().parse().unwrap();
        assert_eq!(end - start, 86_400, "当天窗口恰好一天");
        assert_eq!(
            resolve("tz", &cred("", ""))
                .unwrap()
                .parse::<i32>()
                .unwrap(),
            now.offset().local_minus_utc()
        );
        // 换当月窗口：同一个占位符必须跟着窗口变（窗口是调用方决定的）。
        let month = TimeWindow::month(now);
        let month_start: i64 = resolve_placeholder("start", &cred("", ""), &params, now, month)
            .unwrap()
            .parse()
            .unwrap();
        assert!(month_start < start, "当月窗口的起点必须早于当天窗口的起点");

        assert_eq!(resolve("region", &cred("sk-1", "")).as_deref(), Some("cn"));
        assert_eq!(resolve("blank", &cred("", "")), None);
        assert_eq!(resolve("unknown", &cred("", "")), None);
    }

    /// DeepSeek 判定：只认 host，对大小写与路径不敏感。
    #[test]
    fn deepseek_endpoint_is_matched_by_host() {
        for url in [
            "https://api.deepseek.com/anthropic",
            "https://API.DEEPSEEK.COM",
            "api.deepseek.com/v1",
        ] {
            assert!(is_deepseek_endpoint(url), "「{}」应判为 DeepSeek", url);
        }
        for url in [
            "https://api.moonshot.cn/v1",
            "https://api.example.com/deepseek", // 关键字出现在 path，host 里没有
            "https://example.com",
            "",
        ] {
            assert!(!is_deepseek_endpoint(url), "「{}」不应判为 DeepSeek", url);
        }
    }

    #[test]
    fn template_placeholders_are_checked() {
        assert_eq!(
            template_placeholders("https://a.com/{date}/usage?k={key}").unwrap(),
            vec!["date".to_string(), "key".to_string()]
        );
        assert!(template_placeholders("https://a.com/usage")
            .unwrap()
            .is_empty());
        assert!(
            template_placeholders("https://a.com/{date").is_err(),
            "缺少右花括号应报错"
        );
        assert!(
            template_placeholders("https://a.com/date}").is_err(),
            "缺少左花括号应报错"
        );
        assert!(
            template_placeholders("https://a.com/{}").is_err(),
            "空占位符应报错"
        );
    }

    #[test]
    fn usage_history_drops_invalid_days_and_values() {
        let mut history = SupplierUsageHistory {
            updated_at: " 2026-01-01 10:00:00 ".into(),
            last_balance: Some(f64::NAN),
            currency: " cny ".into(),
            daily: BTreeMap::from([
                (
                    "2026-01-01".to_string(),
                    DailyUsage {
                        local: 1.5,
                        remote: 2.0,
                        ..DailyUsage::default()
                    },
                ),
                (
                    "2026-1-1".to_string(),
                    DailyUsage {
                        local: 1.0,
                        remote: 1.0,
                        ..DailyUsage::default()
                    },
                ),
                (
                    "not-a-date".to_string(),
                    DailyUsage {
                        local: 1.0,
                        remote: 1.0,
                        ..DailyUsage::default()
                    },
                ),
                (
                    "2026-01-02".to_string(),
                    DailyUsage {
                        local: -3.0,
                        remote: f64::NAN,
                        ..DailyUsage::default()
                    },
                ),
            ]),
            ..SupplierUsageHistory::default()
        };
        normalize_usage_history(&mut history);
        assert_eq!(history.updated_at, "2026-01-01 10:00:00");
        assert_eq!(history.last_balance, None, "非有限余额不能当作差值基准");
        assert_eq!(history.currency, "CNY", "币种应 trim + 大写");
        assert_eq!(history.daily.len(), 2, "非法日期键应被丢弃");
        let fixed = history.daily.get("2026-01-02").unwrap();
        assert_eq!(fixed.local, 0.0, "负用量应归零");
        assert_eq!(fixed.remote, 0.0, "非有限值应归零");

        // 负余额同样不能作为基准；空币种保持空串（由调用方按 CNY 兜底）。
        let mut negative = SupplierUsageHistory {
            last_balance: Some(-1.0),
            currency: "   ".into(),
            ..SupplierUsageHistory::default()
        };
        normalize_usage_history(&mut negative);
        assert_eq!(negative.last_balance, None);
        assert_eq!(negative.currency, "");
    }

    /// 历史用量超限后从最旧的日期开始裁剪。
    #[test]
    fn usage_history_drops_oldest_days_beyond_limit() {
        let mut history = SupplierUsageHistory {
            last_balance: Some(10.0),
            ..SupplierUsageHistory::default()
        };
        for day in 1..=(HISTORY_DAY_LIMIT + 5) {
            let date = chrono::NaiveDate::from_ymd_opt(2024, 1, 1)
                .expect("测试基准日必然合法")
                .checked_add_days(chrono::Days::new((day - 1) as u64))
                .expect("日期不应溢出")
                .format("%Y-%m-%d")
                .to_string();
            history.daily.insert(
                date,
                DailyUsage {
                    local: 1.0,
                    remote: 0.0,
                    ..DailyUsage::default()
                },
            );
        }

        normalize_usage_history(&mut history);
        assert_eq!(history.daily.len(), HISTORY_DAY_LIMIT);
        assert!(
            !history.daily.contains_key("2024-01-01"),
            "最旧的日期应被裁掉"
        );
        assert!(
            history.daily.contains_key("2024-01-06"),
            "最近的数据必须完整保留"
        );
        assert_eq!(history.last_balance, Some(10.0), "裁剪不影响差值基准");
    }

    /// 逐小时键的合法性：只有 `YYYY-MM-DD HH`（小时 00–23）才是有效键。
    #[test]
    fn hour_keys_are_validated_strictly() {
        for key in ["2026-09-18 00", "2026-09-18 23", " 2026-09-18 09 "] {
            assert!(is_hour_key(key), "「{}」应为有效小时键", key);
        }
        for key in [
            "",
            "2026-09-18",
            "2026-09-18 24",
            "2026-09-18 9",
            "2026-09-18T09",
            "2026-09-18 09:00",
            "20260918 09",
        ] {
            assert!(!is_hour_key(key), "「{}」不应是有效小时键", key);
        }
    }

    /// 逐小时明细的归一化：非法键与非法金额被清理，且只保留最近
    /// [`HOURLY_DAY_LIMIT`] 天（逐小时数据只服务于「今天 / 昨天」）。
    #[test]
    fn hourly_history_is_normalized_and_trimmed() {
        let mut history = SupplierUsageHistory::default();
        for day in 1..=(HOURLY_DAY_LIMIT + 2) {
            for hour in [0u32, 9, 23] {
                history.hourly.insert(
                    format!("2026-01-{:02} {:02}", day, hour),
                    if hour == 9 { -1.0 } else { 2.0 },
                );
            }
        }
        history.hourly.insert("2026-01-01 24".to_string(), 99.0);
        history.hourly.insert("坏键".to_string(), 99.0);
        history.hourly_updated_at = "  2026-01-05 10:00:00  ".to_string();

        normalize_usage_history(&mut history);

        assert!(!history.hourly.contains_key("2026-01-01 24"), "非法小时");
        assert!(!history.hourly.contains_key("坏键"), "非法键");
        assert_eq!(history.hourly["2026-01-05 09"], 0.0, "负金额归零");
        let days: BTreeSet<String> = history
            .hourly
            .keys()
            .map(|key| key[..10].to_string())
            .collect();
        assert_eq!(days.len(), HOURLY_DAY_LIMIT, "只保留最近几天：{:?}", days);
        assert!(!days.contains("2026-01-01"), "最旧的那天应被裁掉");
        assert_eq!(
            history.hourly_updated_at, "2026-01-05 10:00:00",
            "时间戳去空白"
        );
    }

    #[test]
    fn routing_is_normalized_and_validated() {
        let mut routing = SupplierRouting {
            client_id: " Claude ".into(),
            model_map: BTreeMap::from([
                (" claude-3-5-sonnet ".to_string(), " deepseek-chat ".into()),
                (String::new(), "x".to_string()),
                ("empty-value".to_string(), "  ".to_string()),
            ]),
            display_map: BTreeMap::from([
                (" sonnet ".to_string(), " 标准档 ".to_string()),
                (" haiku ".to_string(), " 快速档[1M] ".to_string()),
                (String::new(), "drop".to_string()),
            ]),
            context_window: u32::MAX,
            compact_token_limit: u32::MAX,
            switches: BTreeMap::from([(" stream ".to_string(), true), (String::new(), false)]),
            options: BTreeMap::from([
                (" reasoning_effort ".to_string(), " High ".to_string()),
                (String::new(), "drop".to_string()),
            ]),
            ..SupplierRouting::default()
        };
        normalize_routing(&mut routing);
        assert_eq!(routing.client_id, "claude");
        assert_eq!(
            routing
                .model_map
                .get("claude-3-5-sonnet")
                .map(String::as_str),
            Some("deepseek-chat")
        );
        assert_eq!(routing.model_map.len(), 1, "空键 / 空映射值应被丢弃");
        assert_eq!(routing.switches.get("stream"), Some(&true));
        assert_eq!(routing.switches.len(), 1, "空开关名应被丢弃");
        assert_eq!(
            routing.options.get("reasoning_effort").map(String::as_str),
            Some("high"),
            "选项键去空白、取值小写归一化"
        );
        assert_eq!(routing.options.len(), 1, "空选项名应被丢弃");
        assert_eq!(
            routing.context_window, MAX_CONTEXT_WINDOW,
            "越界上下文应被钳制"
        );
        assert_eq!(
            routing.compact_token_limit, MAX_CONTEXT_WINDOW,
            "越界压缩阈值同样应被钳制"
        );
        assert_eq!(
            routing.display_map.get("sonnet").map(String::as_str),
            Some("标准档"),
            "显示名去空白"
        );
        assert_eq!(
            routing.display_map.get("haiku").map(String::as_str),
            Some("快速档"),
            "显示名里的 1M 标记要剥掉（它不属于名字）"
        );
        assert!(validate_routing(&routing).is_ok());

        let mut bad = SupplierRouting {
            client_id: "a/b".into(),
            ..SupplierRouting::default()
        };
        normalize_routing(&mut bad);
        assert!(validate_routing(&bad).is_err(), "客户端标识非法应被拒绝");
    }

    /// 1M 能力标记：判定与剥离，以及「不支持 1M 的档位必须被剥掉」。
    #[test]
    fn one_m_marker_follows_the_client_registry() {
        assert!(has_one_m("deepseek-chat[1M]"));
        assert!(has_one_m("deepseek-chat[1m]"));
        assert!(has_one_m("deepseek-chat[1M]  "), "尾随空白不影响判定");
        assert!(!has_one_m("deepseek-chat"));
        assert_eq!(strip_one_m("deepseek-chat[1M]  "), "deepseek-chat");
        assert_eq!(strip_one_m("deepseek-chat"), "deepseek-chat");

        // Haiku 不参与 1M 声明：草稿里带着标记也会被归一化剥掉，避免「界面禁用、落盘带标记」。
        let mut routing = SupplierRouting {
            client_id: "claude".into(),
            model_map: BTreeMap::from([
                ("sonnet".to_string(), "a[1M]".to_string()),
                ("haiku".to_string(), "b[1M]".to_string()),
            ]),
            ..SupplierRouting::default()
        };
        normalize_routing(&mut routing);
        assert_eq!(
            routing.model_map.get("sonnet").map(String::as_str),
            Some("a[1M]"),
            "允许 1M 的档位保持原样"
        );
        assert_eq!(
            routing.model_map.get("haiku").map(String::as_str),
            Some("b"),
            "不允许 1M 的档位必须剥掉标记"
        );
    }

    /// 模型目录：丢空条目、按模型名去重、档位只留注册表登记过的取值并按深度排序。
    #[test]
    fn model_catalog_is_normalized() {
        let mut routing = SupplierRouting {
            client_id: "codex".into(),
            model_catalog: vec![
                ModelCatalogEntry {
                    display_name: "  DeepSeek V4  ".to_string(),
                    model: " deepseek-chat ".to_string(),
                    context_window: u32::MAX,
                    reasoning_levels: vec![
                        "xhigh".to_string(),
                        "乱填".to_string(),
                        "low".to_string(),
                        "low".to_string(),
                    ],
                },
                ModelCatalogEntry {
                    display_name: String::new(),
                    model: "deepseek-chat".to_string(),
                    ..ModelCatalogEntry::default()
                },
                ModelCatalogEntry {
                    model: "   ".to_string(),
                    ..ModelCatalogEntry::default()
                },
                ModelCatalogEntry {
                    model: "deepseek-reasoner".to_string(),
                    ..ModelCatalogEntry::default()
                },
            ],
            ..SupplierRouting::default()
        };
        normalize_routing(&mut routing);
        assert_eq!(routing.model_catalog.len(), 2, "重复与空条目被丢弃");
        let first = &routing.model_catalog[0];
        assert_eq!(first.model, "deepseek-chat");
        assert_eq!(first.display_name, "DeepSeek V4");
        assert_eq!(first.context_window, MAX_CONTEXT_WINDOW);
        assert_eq!(
            first.reasoning_levels,
            vec!["low".to_string(), "xhigh".to_string()],
            "未登记的档位被丢弃，且按思考深度升序重排"
        );
        let second = &routing.model_catalog[1];
        assert_eq!(
            second.display_name, "deepseek-reasoner",
            "没填显示名时用模型名兜底"
        );
        assert!(second.reasoning_levels.is_empty());
    }

    #[test]
    fn profile_is_normalized_and_validated() {
        let mut profile = SupplierProfile {
            slug: " DeepSeek ".into(),
            name: " DeepSeek ".into(),
            note: " 备注 ".into(),
            category: " 官方 ".into(),
            ..SupplierProfile::default()
        };
        normalize_profile(&mut profile);
        assert_eq!(profile.slug, "deepseek");
        assert_eq!(profile.name, "DeepSeek");
        assert_eq!(profile.note, "备注");
        assert_eq!(profile.category, "官方");
        assert!(validate_profile(&profile).is_ok());

        let mut nameless = SupplierProfile {
            slug: "a".into(),
            ..SupplierProfile::default()
        };
        assert_eq!(
            validate_profile(&nameless).unwrap_err().message(),
            "供应商名称不能为空"
        );

        nameless.name = "超".repeat(MAX_NAME_LEN + 1);
        assert!(validate_profile(&nameless).is_err(), "名称过长应被拒绝");

        nameless.name = "甲".into();
        nameless.slug = "a/b".into();
        assert!(validate_profile(&nameless).is_err(), "非法 slug 应被拒绝");

        let mut credential = SupplierCredential {
            api_key: " sk-x \n".into(),
            ..SupplierCredential::default()
        };
        normalize_credential(&mut credential);
        assert_eq!(credential.api_key, "sk-x");
    }

    /// 当前启用项归一化：去空白 + 小写；空串表示未启用，必须保留为空串。
    #[test]
    fn scope_active_is_normalized() {
        let mut active = ScopeActive {
            active_slug: " DeepSeek ".into(),
        };
        normalize_scope_active(&mut active);
        assert_eq!(active.active_slug, "deepseek");

        let mut empty = ScopeActive::default();
        normalize_scope_active(&mut empty);
        assert_eq!(empty.active_slug, "", "空串表示未启用，不应被改成其它值");
    }

    #[test]
    fn index_is_normalized_and_deduplicated() {
        let entry = |scope: &str, slug: &str, order: i64| SupplierIndexEntry {
            scope: scope.to_string(),
            slug: slug.to_string(),
            name: format!("名称-{}", slug),
            order,
            ..SupplierIndexEntry::default()
        };
        let mut index = SupplierIndex {
            version: 0,
            suppliers: vec![
                entry("claude", "b", 2),
                entry("balance", "a", 1),
                entry("claude", "a", 1),
                entry("claude", "a", 1),
            ],
        };
        normalize_index(&mut index);
        assert_eq!(index.version, INDEX_VERSION, "版本号缺失时应补齐");
        assert_eq!(
            index
                .suppliers
                .iter()
                .map(|entry| (entry.scope.as_str(), entry.slug.as_str()))
                .collect::<Vec<_>>(),
            vec![("balance", "a"), ("claude", "a"), ("claude", "b")],
            "应先去重（键为 scope + slug）再按 scope / order 排序"
        );

        // 缺少 scope 的条目无法定位所属列表，必须被丢弃。
        let mut orphan = SupplierIndex {
            version: INDEX_VERSION,
            suppliers: vec![SupplierIndexEntry {
                slug: "a".to_string(),
                ..SupplierIndexEntry::default()
            }],
        };
        normalize_index(&mut orphan);
        assert!(orphan.suppliers.is_empty());
    }

    #[test]
    fn normalization_is_idempotent() {
        let mut endpoint = SupplierEndpoint {
            base_url: " https://a.com/ ".into(),
            api_format: "未知".into(),
            endpoint_candidates: vec![" https://a.com/ ".into(), "https://b.com".into()],
            ..SupplierEndpoint::default()
        };
        normalize_endpoint(BALANCE_SCOPE, &mut endpoint);
        let once = serde_json::to_string(&endpoint).unwrap();
        normalize_endpoint(BALANCE_SCOPE, &mut endpoint);
        assert_eq!(once, serde_json::to_string(&endpoint).unwrap());

        let mut profile = SupplierProfile {
            slug: " A ".into(),
            name: " A ".into(),
            note: " note ".into(),
            ..SupplierProfile::default()
        };
        normalize_profile(&mut profile);
        let once_profile = serde_json::to_string(&profile).unwrap();
        normalize_profile(&mut profile);
        assert_eq!(once_profile, serde_json::to_string(&profile).unwrap());

        let mut active = ScopeActive {
            active_slug: " a ".into(),
        };
        normalize_scope_active(&mut active);
        let once_active = serde_json::to_string(&active).unwrap();
        normalize_scope_active(&mut active);
        assert_eq!(once_active, serde_json::to_string(&active).unwrap());
    }

    /// 白名单值域的小工具：让「白名单内取值必须原样保留」可直接断言。
    fn normalize_endpoint_format(value: &str) -> String {
        let mut endpoint = SupplierEndpoint {
            api_format: value.to_string(),
            ..SupplierEndpoint::default()
        };
        normalize_endpoint(BALANCE_SCOPE, &mut endpoint);
        endpoint.api_format
    }

    fn normalize_endpoint_auth_field(value: &str) -> String {
        let mut endpoint = SupplierEndpoint {
            auth_field: value.to_string(),
            ..SupplierEndpoint::default()
        };
        normalize_endpoint(BALANCE_SCOPE, &mut endpoint);
        endpoint.auth_field
    }
}
