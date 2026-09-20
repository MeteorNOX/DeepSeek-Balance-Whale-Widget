//! 在线用量查询客户端（声明式）
//!
//! 本模块是**唯一**的在线用量出口：不再针对某家供应商写死请求代码，而是按
//! [`SupplierUsageQuery`] 这份**声明式描述**发起请求、按描述解析响应。描述由
//! `domain::supplier::service::supplier_service::builtin_usage_preset` 按供应商标识内置提供
//! （不落盘、不由用户编辑），因此「日 / 周 / 月 / 年用量走在线」对已收录的供应商都成立。
//!
//! # 关键约定
//! - **地址模板**：`{name}` 占位符的取值规则见
//!   [`crate::domain::supplier::model::usage_query`]（保留名由客户端自动解析，
//!   其余取 `params`）；缺半边的花括号与取不到值的占位符都会报错，绝不拼出坏地址。
//! - **取值路径**：点号分隔，数字段表示数组下标（如 `balance_infos.0.total_balance`）；
//!   空路径表示该字段不取值；任一段缺失即视为取不到。`*` 段表示「展开全部子项」：
//!   用在金额路径上是**求和**（各模型各指标加总），用在 `daily_list` 上是**拼接**
//!   （把按模型分组的多个数组合成一个明细列表）。
//! - **日期取值**：逐日明细的日期既接受 `2026-01-01` 这类日期串，也接受 Unix 秒
//!   时间戳（控制台内部接口的 `time` 字段），统一换算成本地日期；同一日期多条明细
//!   求和后合并。
//! - **重试策略**：网络错误 / 超时 / 5xx 视为瞬时失败，重试 1 次（间隔 500ms）；
//!   4xx 是确定性失败（地址 / 密钥 / 参数问题），不重试。
//! - **宽容解析**：数值兼容 JSON 数字与数字字符串；逐日明细里非法日期、非法或负金额
//!   会被跳过而不是整体失败；只有**全部字段都取不到**才算失败，避免「只配了余额的接口」
//!   被误判为不可用。
//! - **无副作用**：本模块只做请求与解析，不读写任何本地文件（落盘由用例层决定）。

use std::collections::BTreeMap;
use std::time::Duration;

use chrono::{DateTime, Local, TimeZone};
use serde_json::Value;

use crate::domain::supplier::model::{
    ModelUsage, SupplierCredential, SupplierEndpoint, SupplierUsageQuery, TimeWindow, UsageExtract,
    UsageSnapshot, DEFAULT_AUTH_FIELD, TOKEN_SOURCE_USAGE_TOKEN, WILDCARD_SEGMENT,
};
use crate::domain::supplier::service::supplier_service::{
    is_date_key, resolve_placeholder, template_placeholders,
};
use crate::types::enums::ErrorCode;
use crate::types::exception::{AppError, AppResult};

/// 用量查询超时。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// 连通性探测超时：探测只判断「能否连上」，比正式查询更短更干脆。
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// 瞬时失败的重试间隔。
const RETRY_DELAY: Duration = Duration::from_millis(500);
/// 重试次数（首次 + 1 次重试）。
const MAX_ATTEMPTS: usize = 2;

/// 构造瞬时失败错误（可重试 / 可回退）。
fn transient(message: impl Into<String>) -> AppError {
    AppError::network(message).transient()
}

/// 渲染 URL 模板：把 `{name}` 全部替换为实际取值。
///
/// 纯函数，便于单测；模板的成对性复用领域校验（
/// [`template_placeholders`]），因此保存期与读取期的判定完全一致。
///
/// `window` 由调用方给出（当天 / 当月），模板里的 `{start}` / `{end}` / `{tz}` 直接读它。
pub fn render_url(
    template: &str,
    credential: &SupplierCredential,
    query: &SupplierUsageQuery,
    now: DateTime<Local>,
    window: TimeWindow,
) -> AppResult<String> {
    // 先做花括号成对校验：手改过的坏模板也能得到与保存时一致的错误文案。
    template_placeholders(template)?;

    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else {
            return Err(AppError::invalid("用量查询接口模板的占位符缺少右花括号"));
        };
        let name = after[..end].trim();
        let value = resolve_placeholder(name, credential, &query.params, now, window)
            .ok_or_else(|| AppError::invalid(format!("用量查询模板缺少参数：{}", name)))?;
        out.push_str(&value);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// 按路径从响应体取值：点号分隔，数字段为数组下标。
///
/// 路径为空、某一段为空串、或任一段在响应体里不存在时都返回 `None`。
fn value_at<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let mut current = root;
    for segment in path.split('.') {
        let segment = segment.trim();
        if segment.is_empty() {
            return None;
        }
        current = match current {
            Value::Object(map) => map.get(segment)?,
            // 数字段表示数组下标：非数字段落在数组上即视为路径不存在。
            Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

/// 取数值：兼容 JSON 数字与数字字符串，非有限值视为取不到。
fn as_number(value: &Value) -> Option<f64> {
    let parsed = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    // `inf` / `NaN` 不是有效金额：放进去会污染后续求和与绘图。
    parsed.filter(|number| number.is_finite())
}

/// 数值取值：路径可含通配段 `*`（对数组的每个元素继续取值并求和）。
///
/// 控制台内部用量接口的金额是「按模型 × 按指标」两层数组，例如
/// `days[].data[].usage[].amount`，用 `data.*.usage.*.amount` 即可把某天各模型、
/// 各指标加总成一个数——这正是「与官网逐日数字对齐」所必需的能力。
fn number_at(root: &Value, path: &str) -> Option<f64> {
    if !path.contains(WILDCARD_SEGMENT) {
        return value_at(root, path).and_then(as_number);
    }
    sum_with_wildcard(root, path)
}

/// 通配求和：任一段取不到都返回 `None`。
///
/// 与普通路径「缺一段即取不到」保持一致：不允许「部分取到」被当成完整金额展示，
/// 否则会出现「少算几个模型」的静默错误数据。
fn sum_with_wildcard(node: &Value, path: &str) -> Option<f64> {
    let (head, rest) = match path.split_once('.') {
        Some((head, rest)) => (head.trim(), Some(rest)),
        None => (path.trim(), None),
    };
    if head.is_empty() {
        return None;
    }
    if head == WILDCARD_SEGMENT {
        let mut sum = 0.0;
        match node {
            // `[]` 逐项求和。
            Value::Array(items) => {
                if items.is_empty() {
                    return None;
                }
                for item in items {
                    sum += match rest {
                        Some(rest) => sum_with_wildcard(item, rest)?,
                        None => as_number(item)?,
                    };
                }
            }
            // `{}` 逐值求和：控制台接口常用「指标名 → 数值」的映射（如 `usage` 下的
            // `RESPONSE_TOKEN` / `PROMPT_CACHE_HIT_TOKEN` 等），一个模型一次请求的全部
            // 指标就是该模型的消耗量。
            Value::Object(map) => {
                if map.is_empty() {
                    return None;
                }
                for value in map.values() {
                    sum += match rest {
                        Some(rest) => sum_with_wildcard(value, rest)?,
                        None => as_number(value)?,
                    };
                }
            }
            _ => return None,
        }
        return Some(sum);
    }
    let next = match node {
        Value::Object(map) => map.get(head)?,
        // 数字段表示数组下标：非数字段落在数组上即视为路径不存在。
        Value::Array(items) => items.get(head.parse::<usize>().ok()?)?,
        _ => return None,
    };
    match rest {
        Some(rest) => sum_with_wildcard(next, rest),
        None => as_number(next),
    }
}

/// 桶长等于该秒数即表示明细是**小时桶**（官网用量接口在单日窗口下如此应答）。
const BUCKET_HOUR_SECONDS: i64 = 3600;

/// 明细解析结果：逐日合计与逐小时合计（时间键 → 金额，按时间升序）。
#[derive(Debug, Clone, Default, PartialEq)]
struct ParsedSeries {
    /// 逐日合计：`YYYY-MM-DD` → 金额。
    daily: Vec<(String, f64)>,
    /// 逐小时合计：`YYYY-MM-DD HH` → 金额（只有小时桶才有内容）。
    hourly: Vec<(String, f64)>,
    /// 按模型拆分的逐日明细。
    daily_models: BTreeMap<String, BTreeMap<String, ModelUsage>>,
    /// 按模型拆分的逐小时明细。
    hourly_models: BTreeMap<String, BTreeMap<String, ModelUsage>>,
}

/// 解析明细列表：同时给出「逐日合计」与「逐小时合计」。
///
/// 单条明细里的非法日期、非法金额、负金额都被跳过（一条坏数据不该毁掉整张图）。
/// 同一日期出现多条时**求和**：控制台内部接口按模型分组（`series[].buckets[]`），
/// 同一天的数据天然散落在多条明细里，覆盖式写入会丢掉除最后一个模型之外的消耗。
///
/// 小时合计只在响应声明桶长为 3600 时才收集——否则天桶的时间戳会被误当成
/// 「当天 0 点这一小时」，画出错误的 24 倍偏差。
fn parse_series(body: &Value, extract: &UsageExtract) -> ParsedSeries {
    // 配了模型路径就走「模型 → 桶」两层解析：金额柱状图的逐模型 tooltip 与
    // 模型 Token 柱状图都依赖模型维度，扁平解析会把它求和丢掉。
    if extract.by_model() {
        return parse_series_by_model(body, extract);
    }
    if extract.daily_list.is_empty() {
        return ParsedSeries::default();
    }
    let hourly = number_at(body, &extract.bucket) == Some(BUCKET_HOUR_SECONDS as f64);
    let items = daily_items(body, &extract.daily_list);

    // BTreeMap 直接给出「按日期 / 按小时升序」。
    let mut days: BTreeMap<String, f64> = BTreeMap::new();
    let mut hours: BTreeMap<String, f64> = BTreeMap::new();
    for item in items {
        let Some(time) = value_at(item, &extract.daily_date).and_then(parse_item_time) else {
            continue;
        };
        let Some(amount) = number_at(item, &extract.daily_amount) else {
            continue;
        };
        // 逐日明细与余额共用同一套换算倍率，保证图表与余额口径一致。
        let amount = amount * extract.scale;
        if amount < 0.0 {
            continue;
        }
        *days
            .entry(time.format("%Y-%m-%d").to_string())
            .or_insert(0.0) += amount;
        if hourly {
            *hours
                .entry(time.format("%Y-%m-%d %H").to_string())
                .or_insert(0.0) += amount;
        }
    }
    ParsedSeries {
        daily: days.into_iter().collect(),
        hourly: hours.into_iter().collect(),
        ..ParsedSeries::default()
    }
}

/// 按模型解析：`series_list` → 每个模型的模型名与桶数组 → 逐个桶取值。
///
/// 一次解析里同时处理两个口径，因为它们常常来自**两条不同的接口**
/// （DeepSeek 的 `by_api_key/cost` 给金额、`by_api_key/amount` 给 Token 计数），
/// 同一条接口也可能两者都给：口径由 [`UsageExtract::money`] / [`UsageExtract::tokens`]
/// 决定，没配的那个自然保持 0 且不参与合计。
///
/// 同一（日期 / 小时，模型）出现多个桶时**累加**：单日窗口下 24 个小时桶要合成当天合计。
fn parse_series_by_model(body: &Value, extract: &UsageExtract) -> ParsedSeries {
    let money = extract.money();
    let tokens = extract.tokens();
    let hourly = number_at(body, &extract.bucket) == Some(BUCKET_HOUR_SECONDS as f64);
    let mut parsed = ParsedSeries::default();
    let mut days: BTreeMap<String, f64> = BTreeMap::new();
    let mut hours: BTreeMap<String, f64> = BTreeMap::new();

    for series in daily_items(body, &extract.series_list) {
        // 模型名取不到就跳过这一组：没有名字的桶无法归属到任何柱子上。
        let Some(model) = value_at(series, &extract.series_model)
            .and_then(|value| value.as_str())
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
        else {
            continue;
        };
        for item in daily_items(series, &extract.series_items) {
            let Some(time) = value_at(item, &extract.daily_date).and_then(parse_item_time) else {
                continue;
            };
            let Some(usage) = read_bucket(item, extract, money, tokens) else {
                continue;
            };
            let date = time.format("%Y-%m-%d").to_string();
            let hour_key = hourly.then(|| time.format("%Y-%m-%d %H").to_string());

            let day_models = parsed.daily_models.entry(date.clone()).or_default();
            accumulate(day_models.entry(model.clone()).or_default(), &usage);
            if let Some(key) = &hour_key {
                let hour_models = parsed.hourly_models.entry(key.clone()).or_default();
                accumulate(hour_models.entry(model.clone()).or_default(), &usage);
            }
            // 逐日 / 逐小时合计只统计**金额**口径：Token 来源的合计是 Token 个数，
            // 混进 `daily` 会把账单金额顶掉（界面上就是「消费」列显示 1.5 亿）。
            if money {
                *days.entry(date).or_insert(0.0) += usage.cost;
                if let Some(key) = hour_key {
                    *hours.entry(key).or_insert(0.0) += usage.cost;
                }
            }
        }
    }

    parsed.daily = days.into_iter().collect();
    parsed.hourly = hours.into_iter().collect();
    parsed
}

/// 读取一个桶的明细：三个口径都没配、或值非法（负数 / 非有限）时返回 `None`。
fn read_bucket(
    item: &Value,
    extract: &UsageExtract,
    money: bool,
    tokens: bool,
) -> Option<ModelUsage> {
    let mut usage = ModelUsage::default();
    let mut any = false;
    if money {
        if let Some(amount) = number_at(item, &extract.daily_amount) {
            let amount = amount * extract.scale;
            if amount >= 0.0 {
                usage.cost = amount;
                any = true;
            }
        }
    }
    if tokens {
        for (path, slot) in [
            (&extract.token_hit, 0usize),
            (&extract.token_miss, 1),
            (&extract.token_out, 2),
        ] {
            let Some(value) = number_at(item, path) else {
                continue;
            };
            if value < 0.0 {
                continue;
            }
            match slot {
                0 => usage.hit = value,
                1 => usage.miss = value,
                _ => usage.out = value,
            }
            any = true;
        }
    }
    any.then_some(usage)
}

/// 把同一（时间桶，模型）的多个桶累加进同一条明细。
fn accumulate(target: &mut ModelUsage, usage: &ModelUsage) {
    target.cost += usage.cost;
    target.hit += usage.hit;
    target.miss += usage.miss;
    target.out += usage.out;
}

/// 明细里的时间取值：既认 `2026-01-01` 这类日期串，也认 Unix 秒时间戳
/// （控制台内部接口的 `time` 字段就是秒级时间戳），统一换算成本地时间。
fn parse_item_time(value: &Value) -> Option<DateTime<Local>> {
    if let Some(text) = value.as_str() {
        let text = text.trim();
        if is_date_key(text) {
            return Local
                .with_ymd_and_hms(
                    text[..4].parse().ok()?,
                    text[5..7].parse().ok()?,
                    text[8..10].parse().ok()?,
                    0,
                    0,
                    0,
                )
                .single();
        }
    }
    let seconds = match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }?;
    Local.timestamp_opt(seconds, 0).single()
}

/// 取逐日明细列表：路径里的 `*` 段把所有分支的**数组拼接**成一个列表。
///
/// 余额路径的 `*` 是「求和」，这里不能照搬：逐日明细要保留每一条的日期，
/// 因此通配段在这里是「展开」。路径不以数组结尾时返回空列表。
fn daily_items<'a>(body: &'a Value, path: &str) -> Vec<&'a Value> {
    let mut items = Vec::new();
    collect_daily_items(body, path.trim(), &mut items);
    items
}

fn collect_daily_items<'a>(node: &'a Value, path: &str, out: &mut Vec<&'a Value>) {
    let (head, rest) = match path.split_once('.') {
        Some((head, rest)) => (head.trim(), Some(rest)),
        None => (path.trim(), None),
    };
    if head.is_empty() {
        return;
    }
    if head == WILDCARD_SEGMENT {
        // 先收集子节点再递归：避免在遍历 `node` 的同时可变借用 `out`。
        let children: Vec<&Value> = match node {
            Value::Array(items) => items.iter().collect(),
            Value::Object(map) => map.values().collect(),
            _ => Vec::new(),
        };
        for child in children {
            match rest {
                Some(rest) => collect_daily_items(child, rest, out),
                None => out.extend(child.as_array().into_iter().flatten()),
            }
        }
        return;
    }
    let next = match node {
        Value::Object(map) => map.get(head),
        // 数字段表示数组下标：非数字段落在数组上即视为路径不存在。
        Value::Array(children) => head
            .parse::<usize>()
            .ok()
            .and_then(|index| children.get(index)),
        _ => None,
    };
    let Some(next) = next else {
        return;
    };
    match rest {
        Some(rest) => collect_daily_items(next, rest, out),
        None => out.extend(next.as_array().into_iter().flatten()),
    }
}

/// 按 `extract` 路径从响应体取值（可单测，不触网）。
///
/// `balance` / `used` / `total` / 币种 / 逐日明细全部取不到时返回错误；
/// 只要有一项取到就视为成功（例如只提供余额的接口）。
pub fn parse_snapshot(body: &Value, query: &SupplierUsageQuery) -> AppResult<UsageSnapshot> {
    let extract = &query.extract;
    // 部分平台按最小单位返回金额（如万分之一美元），因此取值后统一乘换算倍率；
    // 倍率已在保存时归一化为正有限数，这里直接用即可。
    let scale = extract.scale;
    let balance = number_at(body, &extract.balance).map(|value| value * scale);
    let used = number_at(body, &extract.used).map(|value| value * scale);
    let total = number_at(body, &extract.total).map(|value| value * scale);
    // 币种优先取响应里的字段；响应没有该字段时用配置兜底，
    // 否则金额会被当成默认币种展示（错误数据比没有数据更糟）。
    let response_currency = value_at(body, &extract.currency)
        .and_then(|value| value.as_str())
        .map(|text| text.trim().to_ascii_uppercase())
        .filter(|text| !text.is_empty());
    let currency = response_currency
        .clone()
        .unwrap_or_else(|| query.currency.trim().to_ascii_uppercase());
    let ParsedSeries {
        daily,
        hourly,
        daily_models,
        hourly_models,
    } = parse_series(body, extract);

    // 兜底币种不算「取到了数据」：否则任何配了兜底币种的接口，在返回
    // 「令牌无效」「参数错误」这类空壳响应时都会被判成成功（实测控制台接口
    // 认错令牌时就是 `{"code":40003,...}`），用户会以为余额查询是通的。
    //
    // 「桶粒度」同样算有效数据：只统计 Token 的接口（DeepSeek `by_api_key/amount`）
    // 既没有余额也没有币种，若这个月确实没有用量（`series` 为空数组），
    // 只靠逐日明细会把它误判成接口故障。
    if balance.is_none()
        && used.is_none()
        && total.is_none()
        && response_currency.is_none()
        && daily.is_empty()
        && daily_models.is_empty()
        && number_at(body, &extract.bucket).is_none()
    {
        return Err(AppError::external("用量接口返回中未找到可识别的数据"));
    }
    Ok(UsageSnapshot {
        balance,
        used,
        total,
        currency,
        daily,
        hourly,
        daily_models,
        hourly_models,
        // 口径由**配置**决定而不是「本次解析到几个非零值」：某天确实没用量时
        // 全部数值都是 0，若据此判定「本次不带金额」，那些天的账单会被旧值顶住。
        money: extract.money(),
        tokens: extract.tokens(),
    })
}

/// 组装一次请求：请求头按「公共头 → 鉴权头 → 用户自定义头」依次叠加。
///
/// 用户自定义头放最后，因此可以覆盖任何默认头（这也是它唯一的作用）。
fn build_request(
    client: &reqwest::Client,
    endpoint: &SupplierEndpoint,
    token: &str,
    query: &SupplierUsageQuery,
    url: &str,
) -> reqwest::RequestBuilder {
    // POST 统一发送空 JSON 体：声明式配置没有「请求体模板」这一层，
    // 而不少网关会拒绝无 Content-Length 的 POST。
    let mut request = if query.method == "POST" {
        client
            .post(url)
            .header("Content-Type", "application/json")
            .body("{}")
    } else {
        client.get(url)
    };
    request = request.header("Accept", "application/json");

    match query.auth_type.as_str() {
        "bearer" => {
            request = request.header("Authorization", format!("Bearer {}", token));
        }
        "header" => {
            // 头名沿用请求地址配置里的认证字段（白名单保证它是合法的头名）。
            let field = if endpoint.auth_field.trim().is_empty() {
                DEFAULT_AUTH_FIELD
            } else {
                endpoint.auth_field.as_str()
            };
            request = request.header(field, token);
        }
        // `none`：接口无需鉴权（如内网网关），不附加任何鉴权头。
        _ => {}
    }

    for (name, value) in &query.headers {
        request = request.header(name, value);
    }
    request
}

/// 发起在线用量查询（取数窗口按来源声明的口径自动选择）。
///
/// 前置校验决定了错误分类：未配置查询 → `Unavailable`；凭证缺失 → `NoApiKey`
/// （按 `token_source` 区分是 API Key 还是平台登录令牌，文案直接告诉用户该填哪个）。
pub async fn fetch_usage(
    endpoint: &SupplierEndpoint,
    credential: &SupplierCredential,
    query: &SupplierUsageQuery,
) -> AppResult<UsageSnapshot> {
    let window = TimeWindow::of(&query.window, Local::now());
    fetch_usage_in_window(endpoint, credential, query, window).await
}

/// 在指定时间窗内发起在线用量查询（回填历史月份时由调用方给出窗口）。
pub async fn fetch_usage_in_window(
    endpoint: &SupplierEndpoint,
    credential: &SupplierCredential,
    query: &SupplierUsageQuery,
    window: TimeWindow,
) -> AppResult<UsageSnapshot> {
    if query.url_template.trim().is_empty() {
        return Err(AppError::new(
            ErrorCode::Unavailable,
            "该供应商未配置在线用量查询",
        ));
    }
    let token = credential.token_for(&query.token_source);
    if query.auth_type != "none" && token.is_empty() {
        let missing = if query.token_source.trim() == TOKEN_SOURCE_USAGE_TOKEN {
            "未配置平台令牌"
        } else {
            "未配置API-KEY"
        };
        return Err(AppError::new(ErrorCode::NoApiKey, missing));
    }

    let url = render_url(&query.url_template, credential, query, Local::now(), window)?;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| transient(format!("HTTP 客户端初始化失败: {}", e)))?;

    let mut last_err: Option<AppError> = None;
    for attempt in 0..MAX_ATTEMPTS {
        match build_request(&client, endpoint, token, query, &url)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    // 4xx 是确定性失败（地址 / 密钥 / 参数问题），重试没有意义。
                    if !status.is_server_error() {
                        return Err(AppError::external(format!(
                            "用量接口请求失败: HTTP {}",
                            status.as_u16()
                        )));
                    }
                    last_err = Some(transient(format!(
                        "用量接口请求失败: HTTP {}",
                        status.as_u16()
                    )));
                } else {
                    // 成功：先取完整字节再解析，区分「读体失败」与「解析失败」。
                    let raw = match resp.bytes().await {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            last_err = Some(transient(format!("读取用量响应失败: {}", e)));
                            if attempt + 1 < MAX_ATTEMPTS {
                                tokio::time::sleep(RETRY_DELAY).await;
                            }
                            continue;
                        }
                    };
                    let body: Value = match serde_json::from_slice(&raw) {
                        Ok(value) => value,
                        Err(_) => return Err(AppError::external("用量接口返回不是合法 JSON")),
                    };
                    return parse_snapshot(&body, query);
                }
            }
            Err(e) => last_err = Some(transient(format!("用量接口请求失败: {}", e))),
        }

        if attempt + 1 < MAX_ATTEMPTS {
            tokio::time::sleep(RETRY_DELAY).await;
        }
    }

    Err(last_err.unwrap_or_else(|| transient("用量接口请求失败")))
}

/// 连通性探测：请求 `endpoint.base_url`（GET），返回 HTTP 状态码。
///
/// 只做**可达性**判断：收到任何响应（含 4xx / 5xx）都算链路通，
/// 状态码交给上层原样展示；只有网络错误 / 超时才返回瞬时错误。
pub async fn probe(endpoint: &SupplierEndpoint) -> AppResult<u16> {
    let url = endpoint.base_url.trim();
    if url.is_empty() {
        return Err(AppError::invalid("未配置请求地址"));
    }

    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|e| transient(format!("HTTP 客户端初始化失败: {}", e)))?;
    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| transient(format!("请求地址不可达: {}", e)))?;
    Ok(resp.status().as_u16())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};
    use serde_json::json;

    /// 构造一个只带取值路径的查询配置（测试不触网，模板只用于渲染单测）。
    fn query_with(extract: UsageExtract) -> SupplierUsageQuery {
        SupplierUsageQuery {
            url_template: "https://api.x.com/usage".to_string(),
            extract,
            ..SupplierUsageQuery::default()
        }
    }

    /// 按当天窗口渲染（绝大多数用例与窗口无关，这里省去重复的窗口构造）。
    fn render_day(
        template: &str,
        credential: &SupplierCredential,
        query: &SupplierUsageQuery,
        now: DateTime<Local>,
    ) -> AppResult<String> {
        render_url(template, credential, query, now, TimeWindow::day(now))
    }

    /// 只填 API Key 的凭证。
    fn cred(api_key: &str) -> SupplierCredential {
        SupplierCredential {
            api_key: api_key.to_string(),
            ..SupplierCredential::default()
        }
    }

    #[test]
    fn path_lookup_handles_arrays_and_missing_segments() {
        let body = json!({
            "balance_infos": [{ "total_balance": "8.50", "currency": "cny" }],
            "data": { "daily": [{ "date": "2026-01-01", "amount": 1.5 }] },
            "nested": { "value": 3 }
        });

        assert_eq!(
            value_at(&body, "balance_infos.0.total_balance").and_then(as_number),
            Some(8.5),
            "数字字符串应可解析为数值"
        );
        assert_eq!(
            value_at(&body, "nested.value").and_then(as_number),
            Some(3.0)
        );
        assert_eq!(value_at(&body, "balance_infos.1"), None, "越界下标取不到");
        assert_eq!(
            value_at(&body, "balance_infos.x"),
            None,
            "数组上的非数字段取不到"
        );
        assert_eq!(value_at(&body, "missing.path"), None);
        assert_eq!(
            value_at(&body, "nested.value.deeper"),
            None,
            "标量不能再下钻"
        );
        assert_eq!(value_at(&body, ""), None, "空路径表示不取值");
        assert_eq!(value_at(&body, "a..b"), None, "空段视为非法路径");

        for text in ["abc", "", "inf", "NaN"] {
            assert_eq!(as_number(&json!(text)), None, "「{}」不是有效金额", text);
        }
        assert_eq!(as_number(&json!(null)), None);
    }

    #[test]
    fn render_url_substitutes_every_placeholder() {
        let now = Local::now();
        let query = SupplierUsageQuery {
            url_template:
                "https://api.x.com/{year}/{month}/{date}/usage?k={apiKey}&at={timestamp}&r={region}"
                    .to_string(),
            params: BTreeMap::from([("region".to_string(), "cn".to_string())]),
            ..SupplierUsageQuery::default()
        };

        let url = render_day(&query.url_template, &cred("sk-1"), &query, now).unwrap();
        assert_eq!(
            url,
            format!(
                "https://api.x.com/{}/{}/{}/usage?k=sk-1&at={}&r=cn",
                now.format("%Y"),
                now.format("%Y-%m"),
                now.format("%Y-%m-%d"),
                now.timestamp()
            ),
            "year → YYYY、month → YYYY-MM、date → YYYY-MM-DD"
        );
        assert!(!url.contains('{'), "不得残留未替换的占位符");

        // `key` / `api_key` 别名等价。
        for alias in ["key", "api_key", "apiKey"] {
            let template = format!("https://api.x.com/usage?k={{{}}}", alias);
            let query = SupplierUsageQuery {
                url_template: template.clone(),
                ..SupplierUsageQuery::default()
            };
            assert_eq!(
                render_day(&template, &cred(" sk-1 "), &query, now).unwrap(),
                "https://api.x.com/usage?k=sk-1"
            );
        }
    }

    /// 平台登录令牌与 API Key 是两套凭证：模板写 `{token}` 取令牌、写 `{key}` 取 Key，
    /// 互不串用（拿错凭证只会得到「鉴权失败」）。
    #[test]
    fn usage_token_placeholder_uses_platform_token() {
        let now = Local::now();
        let credential = SupplierCredential {
            api_key: "sk-official".to_string(),
            usage_token: "  web-session-token\n".to_string(),
        };

        let token_query = SupplierUsageQuery {
            url_template: "https://platform.x.com/api/v0/usage?t={usage_token}".to_string(),
            ..SupplierUsageQuery::default()
        };
        assert_eq!(
            render_day(&token_query.url_template, &credential, &token_query, now).unwrap(),
            "https://platform.x.com/api/v0/usage?t=web-session-token",
            "令牌应 trim 后原样拼入"
        );

        // `token` 与 `usage_token` 等价；缺令牌时必须报「缺少取值」而不是拼出空串。
        let alias_query = SupplierUsageQuery {
            url_template: "https://platform.x.com/api/v0/usage?t={token}".to_string(),
            ..SupplierUsageQuery::default()
        };
        assert!(render_day(&alias_query.url_template, &credential, &alias_query, now).is_ok());
        let err = render_day(
            &alias_query.url_template,
            &cred("sk-only"),
            &alias_query,
            now,
        )
        .unwrap_err();
        assert_eq!(err.message(), "用量查询模板缺少参数：token");
    }

    /// 控制台内部用量接口按「窗口起点 ~ 次日起点 + 时区偏移秒」取数：
    /// `start` / `end` / `tz` 必须自动解析；当天窗口恰好一天，当月窗口从当月 1 日起。
    #[test]
    fn window_placeholders_resolve_per_window_kind() {
        let now = Local::now();
        let query = SupplierUsageQuery {
            url_template: "https://platform.x.com/api/v0/usage?start={start}&end={end}&tz={tz}"
                .to_string(),
            ..SupplierUsageQuery::default()
        };
        let parse = |url: String| -> BTreeMap<String, String> {
            url.split_once('?')
                .unwrap()
                .1
                .split('&')
                .map(|pair| pair.split_once('=').unwrap())
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };

        // 当天窗口（默认口径）。
        let params = parse(render_day(&query.url_template, &cred("sk-1"), &query, now).unwrap());
        let start: i64 = params["start"].parse().unwrap();
        let end: i64 = params["end"].parse().unwrap();
        assert_eq!(end - start, 86_400, "当天窗口区间必须恰好一天");
        assert_eq!(
            now.timestamp() - start,
            i64::from(now.time().num_seconds_from_midnight()),
            "start 必须是当地当天 00:00"
        );
        assert_eq!(
            params["tz"].parse::<i32>().unwrap(),
            now.offset().local_minus_utc(),
            "tz 必须是本地时区偏移秒数"
        );

        // 当月窗口：起点落在当月 1 日 00:00，终点不早于次日 00:00（含今天）。
        let month_window = TimeWindow::month(now);
        let params = parse(
            render_url(
                &query.url_template,
                &cred("sk-1"),
                &query,
                now,
                month_window,
            )
            .unwrap(),
        );
        let start: i64 = params["start"].parse().unwrap();
        let end: i64 = params["end"].parse().unwrap();
        let month_start = Local
            .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp();
        assert_eq!(start, month_start, "当月窗口起点必须是当月 1 日 00:00");
        assert!(end - start >= 86_400, "当月窗口至少覆盖一天");
        assert!(
            (end - start) / 86_400 <= 31,
            "当月窗口不超过 31 天（官方接口对窗口长度有上限）"
        );
    }

    #[test]
    fn render_url_reports_missing_params_and_broken_braces() {
        let now = Local::now();
        let query = SupplierUsageQuery {
            url_template: "https://api.x.com/usage?k={key}".to_string(),
            ..SupplierUsageQuery::default()
        };

        let err = render_day(&query.url_template, &cred("  "), &query, now).unwrap_err();
        assert_eq!(err.message(), "用量查询模板缺少参数：key");

        let unbound = SupplierUsageQuery {
            url_template: "https://api.x.com/usage?r={region}".to_string(),
            ..SupplierUsageQuery::default()
        };
        let err = render_day(&unbound.url_template, &cred("sk-1"), &unbound, now).unwrap_err();
        assert_eq!(err.message(), "用量查询模板缺少参数：region");

        // 落单的花括号必须在请求之前就被拦下。
        assert!(render_day("https://api.x.com/{date", &cred("sk-1"), &query, now).is_err());
        assert!(render_day("https://api.x.com/date}", &cred("sk-1"), &query, now).is_err());

        // 无占位符的模板原样返回。
        assert_eq!(
            render_day("https://api.x.com/usage", &cred(""), &query, now).unwrap(),
            "https://api.x.com/usage"
        );
    }

    /// DeepSeek 的余额响应：只配了余额与币种，也应解析成功。
    #[test]
    fn parses_balance_only_payload() {
        let query = query_with(UsageExtract {
            balance: "balance_infos.0.total_balance".to_string(),
            currency: "balance_infos.0.currency".to_string(),
            ..UsageExtract::default()
        });
        let body = json!({
            "is_available": true,
            "balance_infos": [{ "currency": "cny", "total_balance": "110.00", "granted_balance": "10.00" }]
        });
        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert_eq!(snapshot.balance, Some(110.0));
        assert_eq!(snapshot.currency, "CNY", "币种应统一大写");
        assert_eq!(snapshot.used, None);
        assert!(snapshot.daily.is_empty());
    }

    #[test]
    fn parses_daily_list_in_ascending_order() {
        let query = query_with(UsageExtract {
            used: "data.used".to_string(),
            daily_list: "data.daily".to_string(),
            daily_date: "date".to_string(),
            daily_amount: "amount".to_string(),
            ..UsageExtract::default()
        });
        let body = json!({
            "data": {
                "used": 3.5,
                "daily": [
                    { "date": "2026-01-02", "amount": 2 },
                    { "date": "2026-01-01", "amount": "1.5" },
                    { "date": "2026-01-02", "amount": 3 },
                    { "date": "2026-1-1", "amount": 9 },
                    { "date": "2026-01-03", "amount": -5 },
                    { "date": "2026-01-04", "amount": "abc" },
                    { "amount": 7 },
                    { "date": "2026-01-05" }
                ]
            }
        });
        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert_eq!(snapshot.used, Some(3.5));
        assert_eq!(
            snapshot.daily,
            vec![
                ("2026-01-01".to_string(), 1.5),
                // 同日期多条求和（含字符串金额）。
                ("2026-01-02".to_string(), 5.0),
            ],
            "非日期键 / 负金额 / 非法金额 / 缺字段的条目都应被跳过"
        );
    }

    /// 明细路径不是数组时视为「本次没有逐日数据」，而不是整体失败。
    #[test]
    fn non_array_daily_list_yields_no_points() {
        let query = query_with(UsageExtract {
            balance: "balance".to_string(),
            daily_list: "data.daily".to_string(),
            daily_date: "date".to_string(),
            daily_amount: "amount".to_string(),
            ..UsageExtract::default()
        });

        for daily in [
            json!("not-array"),
            json!({ "date": "2026-01-01" }),
            json!(null),
        ] {
            let body = json!({ "balance": 1.0, "data": { "daily": daily } });
            let snapshot = parse_snapshot(&body, &query).unwrap();
            assert_eq!(snapshot.balance, Some(1.0));
            assert!(snapshot.daily.is_empty());
        }
    }

    /// 全部字段都取不到才算失败。
    #[test]
    fn empty_extract_is_rejected() {
        let query = query_with(UsageExtract {
            balance: "data.balance".to_string(),
            used: "data.used".to_string(),
            total: "data.total".to_string(),
            currency: "data.currency".to_string(),
            daily_list: "data.daily".to_string(),
            daily_date: "date".to_string(),
            daily_amount: "amount".to_string(),
            ..UsageExtract::default()
        });
        let err = parse_snapshot(&json!({ "error": "unauthorized" }), &query).unwrap_err();
        assert_eq!(err.message(), "用量接口返回中未找到可识别的数据");
        assert!(!err.is_transient(), "结构不匹配属于确定性失败");

        // 配了兜底币种时同样必须判失败：控制台用量接口认错令牌时返回的
        // `{"code":40003,...}` 正是这种空壳响应，兜底币种不能把失败伪装成成功。
        let mut with_fallback = query.clone();
        with_fallback.currency = "CNY".to_string();
        let err = parse_snapshot(
            &json!({ "code": 40003, "msg": "Authorization Failed (invalid token)" }),
            &with_fallback,
        )
        .unwrap_err();
        assert_eq!(err.message(), "用量接口返回中未找到可识别的数据");

        // 未配置任何路径时同样「取不到」。
        let err = parse_snapshot(
            &json!({ "balance": 1.0 }),
            &query_with(UsageExtract::default()),
        )
        .unwrap_err();
        assert_eq!(err.message(), "用量接口返回中未找到可识别的数据");
    }

    /// 数值字段缺失但提供了逐日明细时，仍算成功。
    #[test]
    fn daily_only_payload_is_enough() {
        let query = query_with(UsageExtract {
            daily_list: "daily".to_string(),
            daily_date: "date".to_string(),
            daily_amount: "amount".to_string(),
            ..UsageExtract::default()
        });
        let body = json!({ "daily": [{ "date": "2026-01-01", "amount": 0 }] });
        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert!(snapshot.balance.is_none());
        assert_eq!(snapshot.daily, vec![("2026-01-01".to_string(), 0.0)]);
    }

    /// 换算倍率：余额 / 已用 / 总额 / 逐日明细一律按倍率折算。
    ///
    /// 例：按「万分之一美元」计价的平台返回 1000000，实际金额应为 100 美元。
    #[test]
    fn scale_is_applied_to_every_amount() {
        let query = query_with(UsageExtract {
            balance: "availableBalance".to_string(),
            used: "usedCredits".to_string(),
            total: "totalCredits".to_string(),
            daily_list: "daily".to_string(),
            daily_date: "date".to_string(),
            daily_amount: "amount".to_string(),
            scale: 0.0001,
            ..UsageExtract::default()
        });
        let body = json!({
            "availableBalance": "1000000",
            "usedCredits": 250000,
            "totalCredits": 1250000,
            "daily": [{ "date": "2026-09-15", "amount": 10000 }],
        });
        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert_eq!(snapshot.balance, Some(100.0));
        assert_eq!(snapshot.used, Some(25.0));
        assert_eq!(snapshot.total, Some(125.0));
        assert_eq!(snapshot.daily, vec![("2026-09-15".to_string(), 1.0)]);
    }

    /// 默认倍率 1.0 不改变任何数值（旧配置的行为不受影响）。
    #[test]
    fn default_scale_keeps_amounts_untouched() {
        let query = query_with(UsageExtract {
            balance: "balance".to_string(),
            ..UsageExtract::default()
        });
        assert_eq!(UsageExtract::default().scale, 1.0);
        let snapshot = parse_snapshot(&json!({ "balance": 12.34 }), &query).unwrap();
        assert_eq!(snapshot.balance, Some(12.34));
    }

    /// 币种兜底：响应没有币种字段（或为空）时用配置里的币种，避免金额被当成错误币种。
    #[test]
    fn configured_currency_is_used_as_fallback() {
        let mut query = query_with(UsageExtract {
            balance: "availableBalance".to_string(),
            ..UsageExtract::default()
        });
        query.currency = "usd".to_string();

        let snapshot = parse_snapshot(&json!({ "availableBalance": 1000000 }), &query).unwrap();
        assert_eq!(snapshot.currency, "USD", "配置币种应大写后兜底");

        // 响应里给了币种时以响应为准。
        let mut with_field = query.clone();
        with_field.extract.currency = "currency".to_string();
        let snapshot = parse_snapshot(
            &json!({ "availableBalance": 1.0, "currency": "cny" }),
            &with_field,
        )
        .unwrap();
        assert_eq!(snapshot.currency, "CNY");

        // 响应里的币种是空串时同样回落到配置币种。
        let snapshot = parse_snapshot(
            &json!({ "availableBalance": 1.0, "currency": "  " }),
            &with_field,
        )
        .unwrap();
        assert_eq!(snapshot.currency, "USD");
    }

    /// 控制台内部用量接口的「按模型 × 按指标」两层数组：`*` 通配段必须逐项求和。
    #[test]
    fn wildcard_path_sums_nested_amounts() {
        let body = json!({
            "data": {
                "biz_data": {
                    "series": [
                        {
                            "model": "deepseek-v4-flash",
                            "buckets": [
                                { "time": 1, "usage": { "PROMPT_CACHE_HIT_TOKEN": 10, "RESPONSE_TOKEN": 5 } },
                                { "time": 2, "usage": { "PROMPT_CACHE_HIT_TOKEN": 2.5, "RESPONSE_TOKEN": "1.5" } }
                            ]
                        },
                        {
                            "model": "deepseek-v4-pro",
                            "buckets": [
                                { "time": 1, "usage": { "PROMPT_CACHE_HIT_TOKEN": 100 } }
                            ]
                        }
                    ]
                }
            }
        });

        assert_eq!(
            number_at(&body, "data.biz_data.series.*.buckets.*.usage.*"),
            Some(119.0),
            "两层通配段应把全部模型、全部指标加总"
        );
        assert_eq!(
            number_at(
                &body,
                "data.biz_data.series.0.buckets.1.usage.RESPONSE_TOKEN"
            ),
            Some(1.5),
            "通配段与数组下标可混用"
        );
        // 任一项取不到即整体取不到：不允许「少算几个模型」的静默错误数据。
        assert_eq!(
            number_at(&body, "data.biz_data.series.*.buckets.*.usage.MISSING"),
            None
        );
        assert_eq!(number_at(&body, "data.biz_data.series.*.missing.*"), None);
        assert_eq!(
            number_at(&body, "data.biz_data.series.*"),
            None,
            "数组本身不是金额"
        );
    }

    /// 逐日明细的金额路径同样支持通配段：这是「某天金额 = 各模型各指标之和」的落地方式。
    #[test]
    fn daily_amount_supports_wildcard_sum() {
        let query = query_with(UsageExtract {
            daily_list: "data.days".to_string(),
            daily_date: "date".to_string(),
            daily_amount: "usage.*.amount".to_string(),
            ..UsageExtract::default()
        });
        let body = json!({
            "data": {
                "days": [
                    { "date": "2026-09-16", "usage": [ { "type": "A", "amount": "1.25" }, { "type": "B", "amount": 0.75 } ] },
                    { "date": "2026-09-17", "usage": [ { "type": "A", "amount": 2 } ] }
                ]
            }
        });
        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert_eq!(
            snapshot.daily,
            vec![
                ("2026-09-16".to_string(), 2.0),
                ("2026-09-17".to_string(), 2.0),
            ]
        );
    }

    /// 控制台内部用量接口的完整形态：按模型分组的 `series[].buckets[]`，
    /// 日期是秒级时间戳，金额是「指标名 → 数值」映射。
    ///
    /// 断言三件事：通配段把各模型的 buckets 拼成一个列表、时间戳换算成本地日期、
    /// 同一天各模型各指标**求和**（而不是被最后一条覆盖）。
    #[test]
    fn console_series_shape_is_flattened_and_summed_per_day() {
        let query = query_with(UsageExtract {
            daily_list: "data.biz_data.series.*.buckets".to_string(),
            daily_date: "time".to_string(),
            daily_amount: "usage.*".to_string(),
            ..UsageExtract::default()
        });
        // 取两个确定的时间点：本地 2026-09-16 与 2026-09-17 的 12:00。
        let day0 = Local
            .with_ymd_and_hms(2026, 9, 16, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp();
        let day1 = day0 + 86_400;
        let body = json!({
            "data": {
                "biz_data": {
                    "series": [
                        {
                            "model": "deepseek-chat",
                            "buckets": [
                                { "time": day0, "usage": { "PROMPT_CACHE_HIT_TOKEN": 10, "RESPONSE_TOKEN": 5 } },
                                { "time": day1, "usage": { "RESPONSE_TOKEN": 1.5 } }
                            ]
                        },
                        {
                            "model": "deepseek-reasoner",
                            "buckets": [
                                { "time": day0, "usage": { "PROMPT_CACHE_MISS_TOKEN": "100" } }
                            ]
                        }
                    ]
                }
            }
        });
        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert_eq!(
            snapshot.daily,
            vec![
                ("2026-09-16".to_string(), 115.0),
                ("2026-09-17".to_string(), 1.5),
            ],
            "两天数字必须来自两个模型的加总，而不是最后一次赋值"
        );
    }

    /// 时间取值兼容性：日期串按当地零点解析，秒级时间戳按本地时区换算，其余一律丢弃。
    #[test]
    fn item_time_accepts_date_string_and_epoch_seconds() {
        fn key(value: &Value) -> Option<String> {
            parse_item_time(value).map(|time| time.format("%Y-%m-%d %H").to_string())
        }
        assert_eq!(key(&json!("2026-01-02")), Some("2026-01-02 00".to_string()));
        assert_eq!(
            key(&json!(" 2026-01-02 ")),
            Some("2026-01-02 00".to_string())
        );
        let noon = Local
            .with_ymd_and_hms(2026, 1, 2, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp();
        assert_eq!(
            key(&json!(noon)),
            Some("2026-01-02 12".to_string()),
            "数字时间戳按本地时区换算"
        );
        assert_eq!(
            key(&json!(noon.to_string())),
            Some("2026-01-02 12".to_string()),
            "字符串时间戳同样接受"
        );
        assert_eq!(key(&json!("not-a-date")), None);
        assert_eq!(key(&json!(true)), None);
    }

    /// 小时桶：响应声明 `bucket = 3600` 时，同一天的各小时分别累计，
    /// 逐日合计仍然等于各小时之和（两者的日维度必须一致）。
    #[test]
    fn hourly_buckets_are_kept_alongside_daily_totals() {
        let query = SupplierUsageQuery {
            url_template: "https://api.x.com/usage".to_string(),
            currency: "CNY".to_string(),
            extract: UsageExtract {
                daily_list: "data.buckets".to_string(),
                daily_date: "time".to_string(),
                daily_amount: "cost".to_string(),
                bucket: "data.bucket".to_string(),
                ..UsageExtract::default()
            },
            ..SupplierUsageQuery::default()
        };
        let hour = |h: u32| {
            Local
                .with_ymd_and_hms(2026, 9, 18, h, 0, 0)
                .single()
                .unwrap()
                .timestamp()
        };
        let body = json!({
            "data": {
                "bucket": 3600,
                "buckets": [
                    { "time": hour(0), "cost": "1.5" },
                    { "time": hour(1), "cost": "0.25" },
                    // 同一小时的两条明细（不同模型）必须求和。
                    { "time": hour(1), "cost": "0.25" },
                    { "time": hour(23), "cost": "2" }
                ]
            }
        });

        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert_eq!(
            snapshot.hourly,
            vec![
                ("2026-09-18 00".to_string(), 1.5),
                ("2026-09-18 01".to_string(), 0.5),
                ("2026-09-18 23".to_string(), 2.0),
            ]
        );
        assert_eq!(
            snapshot.daily,
            vec![("2026-09-18".to_string(), 4.0)],
            "逐日合计 = 各小时之和"
        );
    }

    /// 天桶（`bucket = 86400`）不得产生小时明细：否则一天的数据会被当成「0 点这一小时」。
    #[test]
    fn daily_buckets_produce_no_hourly_points() {
        let query = SupplierUsageQuery {
            url_template: "https://api.x.com/usage".to_string(),
            extract: UsageExtract {
                daily_list: "data.buckets".to_string(),
                daily_date: "time".to_string(),
                daily_amount: "cost".to_string(),
                bucket: "data.bucket".to_string(),
                ..UsageExtract::default()
            },
            ..SupplierUsageQuery::default()
        };
        let body = json!({
            "data": {
                "bucket": 86400,
                "buckets": [{ "time": 1789603200_i64, "cost": "3" }]
            }
        });

        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert!(snapshot.hourly.is_empty(), "{:?}", snapshot.hourly);
        assert_eq!(snapshot.daily.len(), 1);
    }

    /// 金额接口（DeepSeek `by_api_key/cost`）的真实形态：
    /// `data.biz_data.data[].series[].buckets[].{time, cost}`。
    ///
    /// 断言模型维度被**保留**（而不是求和压平）：金额柱状图的悬浮提示要靠它逐模型列金额。
    #[test]
    fn console_cost_shape_keeps_model_dimension() {
        let query = query_with(UsageExtract {
            series_list: "data.biz_data.data.*.series".to_string(),
            series_model: "model".to_string(),
            series_items: "buckets".to_string(),
            daily_date: "time".to_string(),
            daily_amount: "cost".to_string(),
            bucket: "data.biz_data.bucket".to_string(),
            currency: "data.biz_data.data.0.currency".to_string(),
            ..UsageExtract::default()
        });
        let day0 = Local
            .with_ymd_and_hms(2026, 9, 16, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp();
        let day1 = day0 + 86_400;
        let body = json!({
            "data": { "biz_code": 0, "biz_data": {
                "bucket": 86400,
                "data": [{ "currency": "CNY", "series": [
                    { "model": "deepseek-flash", "buckets": [
                        { "time": day0, "cost": "14.7644250800000000" },
                        { "time": day1, "cost": "0" }] },
                    { "model": "deepseek-v4-pro", "buckets": [
                        { "time": day0, "cost": "1.24" }] }
                ]}]
            }}
        });

        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert_eq!(snapshot.currency, "CNY");
        assert!(snapshot.money, "配了金额路径即带金额口径");
        assert!(!snapshot.tokens, "没有配 Token 路径就不该声称有 Token 数据");
        // 逐日合计仍是「各模型求和」，账单口径不变。
        assert_eq!(
            snapshot.daily,
            vec![
                ("2026-09-16".to_string(), 16.00442508),
                ("2026-09-17".to_string(), 0.0),
            ]
        );
        // 模型维度必须完整保留。
        let day0_models = &snapshot.daily_models["2026-09-16"];
        assert_eq!(day0_models.len(), 2);
        assert!((day0_models["deepseek-flash"].cost - 14.76442508).abs() < 1e-9);
        assert!((day0_models["deepseek-v4-pro"].cost - 1.24).abs() < 1e-9);
        assert_eq!(
            day0_models["deepseek-flash"].tokens(),
            0.0,
            "金额接口不携带 Token，不能凭空造出数字"
        );
    }

    /// Token 接口（DeepSeek `by_api_key/amount`）的真实形态：
    /// 桶里是 `usage.{PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN, RESPONSE_TOKEN}`，
    /// 而且**没有 `data[]` 外层**（`series` 直接挂在 `biz_data` 下）。
    ///
    /// 断言 `daily`（金额合计）保持为空：Token 个数若混进金额，账单会变成天文数字。
    #[test]
    fn console_token_shape_feeds_tokens_only() {
        let query = query_with(UsageExtract {
            series_list: "data.biz_data.series".to_string(),
            series_model: "model".to_string(),
            series_items: "buckets".to_string(),
            daily_date: "time".to_string(),
            bucket: "data.biz_data.bucket".to_string(),
            token_hit: "usage.PROMPT_CACHE_HIT_TOKEN".to_string(),
            token_miss: "usage.PROMPT_CACHE_MISS_TOKEN".to_string(),
            token_out: "usage.RESPONSE_TOKEN".to_string(),
            ..UsageExtract::default()
        });
        let day = Local
            .with_ymd_and_hms(2026, 9, 16, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp();
        let body = json!({
            "data": { "biz_code": 0, "biz_data": {
                "bucket": 86400,
                "series": [
                    { "model": "deepseek-flash", "buckets": [
                        { "time": day, "usage": {
                            "RESPONSE_TOKEN": 874201,
                            "REQUEST": 1136,
                            "PROMPT_CACHE_HIT_TOKEN": 253977984,
                            "PROMPT_CACHE_MISS_TOKEN": 4298589 } }] },
                    { "model": "deepseek-v4-pro", "buckets": [
                        { "time": day, "usage": {
                            "RESPONSE_TOKEN": 0, "REQUEST": 0,
                            "PROMPT_CACHE_HIT_TOKEN": 0, "PROMPT_CACHE_MISS_TOKEN": 0 } }] }
                ]
            }}
        });

        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert!(!snapshot.money, "Token 来源不带金额口径");
        assert!(snapshot.tokens);
        assert!(
            snapshot.daily.is_empty() && snapshot.hourly.is_empty(),
            "Token 个数绝不能进金额合计：{:?}",
            snapshot.daily
        );
        let models = &snapshot.daily_models["2026-09-16"];
        assert_eq!(models.len(), 2, "全 0 的模型也要留下条目（官方口径如此）");
        let flash = &models["deepseek-flash"];
        assert_eq!(flash.hit, 253977984.0);
        assert_eq!(flash.miss, 4298589.0);
        assert_eq!(flash.out, 874201.0);
        assert_eq!(flash.cost, 0.0, "Token 来源不产生金额");
    }

    /// 单日窗口下按模型解析也要出逐小时明细：Token 图在「今天 / 昨天」按小时画。
    #[test]
    fn by_model_hourly_buckets_are_split_per_hour() {
        let query = query_with(UsageExtract {
            series_list: "data.series".to_string(),
            series_model: "model".to_string(),
            series_items: "buckets".to_string(),
            daily_date: "time".to_string(),
            bucket: "data.bucket".to_string(),
            token_hit: "usage.hit".to_string(),
            token_miss: "usage.miss".to_string(),
            token_out: "usage.out".to_string(),
            ..UsageExtract::default()
        });
        let hour0 = Local
            .with_ymd_and_hms(2026, 9, 18, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp();
        let body = json!({
            "data": {
                "bucket": 3600,
                "series": [{ "model": "deepseek-flash", "buckets": [
                    { "time": hour0, "usage": { "hit": 10, "miss": 1, "out": 2 } },
                    { "time": hour0 + 3600, "usage": { "hit": 5, "miss": 0, "out": 1 } }
                ]}]
            }
        });

        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert_eq!(snapshot.hourly_models.len(), 2, "两个小时各一条");
        let first = &snapshot.hourly_models["2026-09-18 00"]["deepseek-flash"];
        assert_eq!(first.hit, 10.0);
        assert_eq!(first.miss, 1.0);
        assert_eq!(first.out, 2.0);
        // 逐日合计 = 当天各小时的三维度之和。
        let day = &snapshot.daily_models["2026-09-18"]["deepseek-flash"];
        assert_eq!(day.hit, 15.0);
        assert_eq!(day.out, 3.0);
    }

    /// 模型的桶里三条 Token 路径全缺（例如接口只回了一部分指标）时跳过该桶，
    /// 而不是把缺的当成 0 画出来。
    #[test]
    fn bucket_without_any_configured_metric_is_skipped() {
        let query = query_with(UsageExtract {
            series_list: "data.series".to_string(),
            series_model: "model".to_string(),
            series_items: "buckets".to_string(),
            daily_date: "time".to_string(),
            bucket: "data.bucket".to_string(),
            token_hit: "usage.hit".to_string(),
            token_miss: "usage.miss".to_string(),
            token_out: "usage.out".to_string(),
            ..UsageExtract::default()
        });
        let body = json!({
            "data": { "bucket": 86400, "series": [
                { "model": "deepseek-flash", "buckets": [
                    { "time": 1789603200_i64, "unexpected": 1 }] },
                { "model": "", "buckets": [{ "time": 1789603200_i64, "usage": { "hit": 1 } }] }
            ]}
        });

        let snapshot = parse_snapshot(&body, &query).unwrap();
        assert!(
            snapshot.daily_models.is_empty(),
            "既没有指标、模型名也为空的桶都必须被跳过：{:?}",
            snapshot.daily_models
        );
    }
}
