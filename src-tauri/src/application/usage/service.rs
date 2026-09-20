//! 用量用例：**在线优先 → 本地记账兜底**
//!
//! # 两种口径
//! - **本地离线统计（默认）**：余额接口只给「此刻余额」，当天用了多少靠相邻两次观测的
//!   落差累计（`domain::ledger::service::ledger_service::usage_delta`），与官网账单无关；
//! - **令牌用量统计（实验性功能，`AppConfig::token_usage`）**：额外按平台令牌向官网取
//!   逐日用量，逐日数字与官网账单一致，是账单展示的数据来源。
//!
//! 开关关闭时**完全不请求**官网用量接口（界面同时隐藏相关配置项），只走本地记账。
//!
//! # 在线来源是内置的
//! 余额 / 用量接口都由 `supplier_service::builtin_usage_preset` 按供应商目录名匹配，
//! 不再落盘、不再由用户编辑：绝大多数供应商的接口地址与响应结构是固定事实。
//! 没有内置来源的供应商（含自定义）只走本地记账。
//!
//! # 落盘时机
//! - 在线成功：把 `remote` 值写入历史，并用本次余额做一次差值记账（累进 `local`），
//!   随后整体落盘到 `balance/<slug>/usage_history.json`；
//! - 在线失败：**只**取本地数据组装报表，不改写任何 `remote` 字段、不动差值基准。
//!   基准留着，下次成功观测的差值就会覆盖整段离线期，本地曲线不会断档。
//!
//! 落盘失败只 `log::warn!`：它不该让用户看不到余额（内存里的数据本轮依然完整）。
//!
//! # 连接性测试
//! [`test_connection`] 只做「能不能用」的判断，**不落盘、不计账**，
//! 避免用户点几次「测试连接」就污染用量曲线。判定方式按列表用途区分：
//! 客户端列表（模型路由）只探测请求地址可达性，余额配置列表才真实取一次数。
//!
//! # 只读缓存报表
//! [`cached_usage_report`] 完全不触网，只读 `usage_history.json`，供界面**先**把
//! 柱状图与账单画出来（数据来自上一次落盘的结果），随后再用 [`get_usage_report`]
//! 的在线结果覆盖。用户因此不会再盯着空白面板等几百毫秒。

use std::collections::BTreeSet;
use std::time::Instant;

use chrono::{DateTime, Datelike, Days, Local, NaiveDate, NaiveDateTime};

use crate::application::config;
use crate::domain::ledger::service::ledger_service;
use crate::domain::supplier::model::{
    ConnectionTestResult, ModelUsage, SupplierCredential, SupplierEndpoint, SupplierUsageHistory,
    SupplierUsageQuery, TimeWindow, UsageHour, UsageModel, UsagePoint, UsageReport, UsageSnapshot,
};
use crate::domain::supplier::service::supplier_service::{self, BALANCE_SCOPE};
use crate::types::exception::AppResult;
use crate::application::registry;

/// 观测一次余额并返回报表（挂件 / 配置页的余额刷新走这里）。
///
/// 一定会尝试写盘并参与差值记账：这是「本地离线兜底」数据的唯一累积时机。
pub async fn observe_balance(scope: &str, slug: &str) -> AppResult<UsageReport> {
    observe(scope, slug).await
}

/// 只读报表：优先在线，失败回落本地记账（用量图表面板走这里）。
///
/// 与 [`observe_balance`] 是同一套逻辑：面板刷新**同样会落盘**并参与差值记账，
/// 属预期行为——否则用户只开着面板时本地兜底数据就会停止累积。
pub async fn get_usage_report(scope: &str, slug: &str) -> AppResult<UsageReport> {
    observe(scope, slug).await
}

/// 只读**已落盘**的用量历史并组装报表：不发起任何网络请求、不写盘。
///
/// 界面打开详细账单时先调它——一次文件读取即可出图，柱状图与逐日账单都在同一个
/// 帧里渲染完，用户不必等官网接口往返。随后再用 [`get_usage_report`] 的结果覆盖。
pub fn cached_usage_report(scope: &str, slug: &str) -> AppResult<UsageReport> {
    let history = registry::usage_history().read_usage_history(scope, slug)?;
    Ok(report_of(&history, &history.currency))
}

/// 按界面所选**时间段**重新取数并落盘（日期筛选器联动用）。
///
/// 与 [`observe`] 的分工：`observe` 只保证「最近的数据是新的」（当月 + 今昨两天），
/// 本函数负责「用户换了个时间段，就把那段区间拉全」——用户选「近一年」时若只靠
/// `observe`，跨年那几个月永远不会有数据，柱子会凭空缺一段。
///
/// 官网接口对窗口长度有上限（≥60 天直接 `INVALID_PARAM`），因此按**自然月**切片，
/// 每片对每条统计来源各发一次请求。单日区间不切片：官网对单日窗口给小时桶，
/// 这样「今天 / 昨天」正好能拿到逐小时明细。
pub async fn refresh_usage_window(
    scope: &str,
    slug: &str,
    start: NaiveDate,
    end: NaiveDate,
) -> AppResult<UsageReport> {
    let credential = registry::supplier().read_credential(scope, slug)?;
    let endpoint = registry::supplier().read_endpoint(scope, slug)?;
    let mut history = registry::usage_history().read_usage_history(scope, slug)?;
    let mut remote_error = String::new();
    let mut fetched = false;

    if config::service::token_usage_enabled() {
        if let Some(query) = supplier_service::builtin_usage_preset(slug) {
            let sources = stats_sources(&query);
            let now = Local::now();
            for window in monthly_windows(start, end, now) {
                for (_, stats) in &sources {
                    match registry::usage_gateway()
                        .fetch_usage_in_window(&endpoint, &credential, stats, window)
                        .await
                    {
                        Ok(snapshot) => {
                            record_stats(&mut history, &snapshot);
                            fetched = true;
                        }
                        Err(err) => {
                            log::warn!("所选时间段用量查询失败（{}/{}）：{}", scope, slug, err);
                            if remote_error.is_empty() {
                                remote_error = err.message().to_string();
                            }
                        }
                    }
                }
            }
        }
    }

    if fetched {
        if let Err(err) = registry::usage_history().save_usage_history(scope, slug, &history) {
            log::warn!("保存用量历史失败（{}/{}）：{}", scope, slug, err);
        }
    }

    let mut report = report_of(&history, &history.currency);
    report.remote_error = remote_error;
    Ok(report)
}

/// 把 `[start, end]`（含端点，本地日期）切成若干取数窗口。
///
/// 单日区间直接用单日窗口（换来小时桶）；更长区间按自然月切片，每片与原区间求交，
/// 因此「自定义 9 月 20 日 → 10 月 5 日」会得到两片：9/20–9/30 与 10/1–10/5。
fn monthly_windows(start: NaiveDate, end: NaiveDate, now: DateTime<Local>) -> Vec<TimeWindow> {
    let (start, end) = if end < start { (end, start) } else { (start, end) };
    // 未来日期没有数据，截到今天为止：否则「自定义」选到明天会多打一次空请求。
    let today = now.date_naive();
    let end = if end > today { today } else { end };
    if end < start {
        return Vec::new();
    }
    if start == end {
        return TimeWindow::on_day(start, now).into_iter().collect();
    }
    let mut windows = Vec::new();
    let mut cursor = start;
    while cursor <= end {
        let slice_end = month_end(cursor).min(end);
        if let Some(window) = TimeWindow::on_days(cursor, slice_end, now) {
            windows.push(window);
        }
        match slice_end.checked_add_days(Days::new(1)) {
            Some(next) => cursor = next,
            None => break,
        }
    }
    windows
}

/// 该日期所在自然月的最后一天。
fn month_end(date: NaiveDate) -> NaiveDate {
    let (year, month) = if date.month() == 12 {
        (date.year() + 1, 1)
    } else {
        (date.year(), date.month() + 1)
    };
    NaiveDate::from_ymd_opt(year, month, 1)
        .and_then(|first| first.pred_opt())
        .unwrap_or(date)
}

/// 由历史组装报表（在线与缓存两条路径共用同一套口径，避免两处展示不一致）。
///
/// `currency` 由调用方给出：在线路径要优先用本次应答的币种，缓存路径用历史里记的。
fn report_of(history: &SupplierUsageHistory, currency: &str) -> UsageReport {
    // 口径由**开关**决定，而不是「本次取数是否成功」：开关开着但官网暂时取不到时，
    // 账单仍应展示已缓存的官方数字，而不是悄悄回落到与官网对不上的本地估算。
    let official = config::service::token_usage_enabled();
    let points = build_points(history, official);
    let today = ledger_service::today_key();
    let today_usage = points
        .iter()
        .find(|point| point.date == today)
        .map(|point| point.usage)
        .unwrap_or(0.0);
    UsageReport {
        // 有官方逐日数据才算在线口径：只有本地记账时如实标 `local`。
        source: if official && !history.remote_days.is_empty() {
            "remote"
        } else {
            "local"
        }
        .to_string(),
        remote_error: String::new(),
        balance: history.last_balance,
        currency: currency.to_string(),
        today_usage,
        points,
        hourly: build_hours(history, official),
    }
}

/// 连通性测试（含毫秒级耗时）。
///
/// 有内置在线来源 → 按真实查询测一次（开关打开时连用量统计来源一并测）；
/// 没有 → 退化为对请求地址的可达性探测。
/// 无论哪种方式都**不落盘**。存储读取失败也会返回可展示的失败结果（而非 `Err`），
/// 因为该函数本身就是要「把失败原因展示出来」。
pub async fn test_connection(scope: &str, slug: &str) -> ConnectionTestResult {
    let loaded = (|| -> AppResult<(SupplierCredential, SupplierEndpoint)> {
        Ok((
            registry::supplier().read_credential(scope, slug)?,
            registry::supplier().read_endpoint(scope, slug)?,
        ))
    })();
    let (credential, endpoint) = match loaded {
        Ok(loaded) => loaded,
        Err(err) => {
            return ConnectionTestResult {
                ok: false,
                latency_ms: 0,
                message: err.message().to_string(),
                url: String::new(),
            };
        }
    };

    // 客户端列表只做**模型路由**：既不查余额也不查用量，因此测试连接只判断
    // 「这个请求地址通不通」，不要求填 API Key / 平台令牌（参照 cc-switch 的做法，
    // 对地址做一次可达性探测即可）。余额配置列表才需要真实取一次余额。
    if scope != BALANCE_SCOPE {
        let url = endpoint.base_url.trim().to_string();
        let started = Instant::now();
        let outcome = registry::usage_gateway()
            .probe(&endpoint)
            .await
            .map(|status| format!("连接成功（HTTP {}）", status));
        return test_result(outcome, started, url);
    }

    let Some(query) = supplier_service::builtin_usage_preset(slug) else {
        // 没有内置来源：只判断请求地址是否可达，用途仍成立（模型路由也靠它）。
        let url = endpoint.base_url.trim().to_string();
        let started = Instant::now();
        let outcome = registry::usage_gateway()
            .probe(&endpoint)
            .await
            .map(|status| format!("连接成功（HTTP {}）", status));
        return test_result(outcome, started, url);
    };

    // 先渲染 URL：它就是用户最需要核对的「实际请求地址」（渲染失败时留空，
    // 错误文案由下面的查询原样给出）。
    let window = TimeWindow::of(&query.window, Local::now());
    let url = registry::usage_gateway()
        .render_url(
            &query.url_template,
            &credential,
            &query,
            Local::now(),
            window,
        )
        .unwrap_or_default();
    let started = Instant::now();
    let outcome = registry::usage_gateway()
        .fetch_usage(&endpoint, &credential, &query)
        .await
        .map(|_| "连接成功".to_string());
    let mut result = test_result(outcome, started, url);
    // 开了令牌用量统计就一并测：它用另一套凭证（平台令牌），单独失败必须单独报出来，
    // 否则用户只会看到「余额正常」而以为用量统计也可用。金额与 Token 是两条接口，
    // 谁失败就报谁——只报金额那条会让「Token 图一直是空的」变得无法自查。
    if result.ok && config::service::token_usage_enabled() {
        for (kind, stats) in stats_sources(&query) {
            let stats_window = TimeWindow::of(&stats.window, Local::now());
            let stats_url = registry::usage_gateway()
                .render_url(
                    &stats.url_template,
                    &credential,
                    stats,
                    Local::now(),
                    stats_window,
                )
                .unwrap_or_default();
            let started = Instant::now();
            if let Err(err) = registry::usage_gateway()
                .fetch_usage(&endpoint, &credential, stats)
                .await
            {
                let label = match kind {
                    StatsKind::Money => "用量统计接口",
                    StatsKind::Token => "Token 统计接口",
                };
                result = ConnectionTestResult {
                    ok: false,
                    latency_ms: started.elapsed().as_millis() as u64,
                    message: format!("{}：{}", label, err.message()),
                    url: stats_url,
                };
                break;
            }
        }
    }
    result
}

/// 取出真正配置了地址的用量统计来源。
fn configured_stats(query: &SupplierUsageQuery) -> Option<&SupplierUsageQuery> {
    query
        .stats
        .as_deref()
        .filter(|stats| !stats.url_template.trim().is_empty())
}

/// 取出真正配置了地址的 **Token** 统计来源。
fn configured_token_stats(query: &SupplierUsageQuery) -> Option<&SupplierUsageQuery> {
    query
        .token_stats
        .as_deref()
        .filter(|stats| !stats.url_template.trim().is_empty())
}

/// 统计来源的口径。
///
/// 两条来源的**回填标记必须分开保存**：任一条接口都可能单独失败（例如平台令牌过期、
/// 该接口限流），共用一个标记会让「Token 从没回填成功」被金额的成功永久掩盖，
/// 界面上就是「近一年只有金额、没有 Token」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatsKind {
    /// 金额（账单）。
    Money,
    /// Token 计数。
    Token,
}

/// 该口径是否已完成整年回填。
fn backfilled_year(history: &SupplierUsageHistory, kind: StatsKind) -> i32 {
    match kind {
        StatsKind::Money => history.backfilled_year,
        StatsKind::Token => history.token_backfilled_year,
    }
}

/// 记下该口径已完成整年回填。
fn mark_backfilled(history: &mut SupplierUsageHistory, kind: StatsKind, year: i32) {
    match kind {
        StatsKind::Money => history.backfilled_year = year,
        StatsKind::Token => history.token_backfilled_year = year,
    }
}

/// 该供应商实际可用的统计来源清单（金额在前、Token 在后）。
fn stats_sources(query: &SupplierUsageQuery) -> Vec<(StatsKind, &SupplierUsageQuery)> {
    let mut sources = Vec::new();
    if let Some(stats) = configured_stats(query) {
        sources.push((StatsKind::Money, stats));
    }
    if let Some(stats) = configured_token_stats(query) {
        sources.push((StatsKind::Token, stats));
    }
    sources
}

/// 组装连通性测试结果（耗时 = 从发起到拿到结果的真实耗时）。
fn test_result(outcome: AppResult<String>, started: Instant, url: String) -> ConnectionTestResult {
    let latency_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(message) => ConnectionTestResult {
            ok: true,
            latency_ms,
            message,
            url,
        },
        Err(err) => ConnectionTestResult {
            ok: false,
            latency_ms,
            message: err.message().to_string(),
            url,
        },
    }
}

/// 观测与组装报表的统一实现（两个公开入口共用）。
async fn observe(scope: &str, slug: &str) -> AppResult<UsageReport> {
    let credential = registry::supplier().read_credential(scope, slug)?;
    let endpoint = registry::supplier().read_endpoint(scope, slug)?;
    let mut history = registry::usage_history().read_usage_history(scope, slug)?;

    let today = ledger_service::today_key();
    let mut remote_error = String::new();
    let mut online: Option<UsageSnapshot> = None;

    // 在线来源是内置的：没有内置来源的供应商（含自定义）只走本地记账，
    // 这不是错误，因此不产生 `remote_error`。
    let source = supplier_service::builtin_usage_preset(slug);
    if let Some(query) = &source {
        match registry::usage_gateway()
            .fetch_usage(&endpoint, &credential, query)
            .await
        {
            Ok(snapshot) => {
                record_online(&mut history, &snapshot, &today);
                online = Some(snapshot);
            }
            Err(err) => {
                // 在线失败不改写 `remote`、不动差值基准：见模块文档「落盘时机」。
                log::warn!(
                    "在线余额查询失败（{}/{}），回退本地记账：{}",
                    scope,
                    slug,
                    err
                );
                remote_error = err.message().to_string();
            }
        }
    }

    // 令牌用量统计（实验性功能）：关闭时**完全不请求**官网用量接口，
    // 账单只按本地余额差值展示。它用另一套凭证（平台令牌），与余额来源各自独立。
    let mut stats_ok = false;
    if config::service::token_usage_enabled() {
        if let Some(query) = &source {
            stats_ok = fetch_official_usage(
                &endpoint,
                &credential,
                query,
                &mut history,
                &mut remote_error,
            )
            .await;
        }
    }
    if online.is_some() || stats_ok {
        // 落盘失败不影响报表：内存里的历史本轮已是完整的，下次观测会再写一次。
        if let Err(err) = registry::usage_history().save_usage_history(scope, slug, &history) {
            log::warn!("保存用量历史失败（{}/{}）：{}", scope, slug, err);
        }
    }

    // 报表组装：口径与缓存报表完全一致（共用 `report_of`），因此界面先画缓存、
    // 再被在线结果覆盖时不会出现「同一份数据显示两套口径」的跳变。
    // 币种优先用本次应答的，接口没给才用历史里记的。
    let currency = online
        .as_ref()
        .map(|snapshot| snapshot.currency.clone())
        .filter(|currency| !currency.is_empty())
        .unwrap_or_else(|| history.currency.clone());

    let mut report = report_of(&history, &currency);
    report.remote_error = remote_error;
    Ok(report)
}

/// 组装逐日点位：单日取值「有官方用量值用官方，否则用本地」。
///
/// 令牌用量统计未启用（`official = false`）时一律用本地余额差值：这是「本地离线
/// 统计模式」的定义，磁盘上残留的历史 `remote` 值不得混进账单。
///
/// 「有官方用量值」不能只看数值是否大于 0：官网口径下某天确实是 0（没有调用）与
/// 「官网根本没给这天的数据」是两件事。前者必须以 0 展示，否则会被本地估算顶替，
/// 两边永远对不上；后者才允许回落本地记账兜底。
///
/// 按模型明细与点位同进同出：官方口径关闭时一并清空，界面不会拿旧模型数据去拆一张
/// 本地估算的柱子。
fn build_points(history: &SupplierUsageHistory, official: bool) -> Vec<UsagePoint> {
    history
        .daily
        .iter()
        .map(|(date, usage)| {
            let online_known =
                official && (usage.remote > 0.0 || history.remote_days.contains(date));
            let (value, point_source) = if online_known {
                (usage.remote, "remote")
            } else {
                (usage.local, "local")
            };
            UsagePoint {
                date: date.clone(),
                usage: value,
                source: point_source.to_string(),
                models: if official {
                    model_list(&usage.models)
                } else {
                    Vec::new()
                },
            }
        })
        .collect()
}

/// 组装逐小时点位：与 [`build_points`] 同一套开关口径，未启用时返回空。
///
/// 逐小时明细只有一个来源（官网单日窗口），因此不需要 `local` 兜底：没有就是没有，
/// 界面把「今天 / 昨天」画成空白，而不是拿本地估算拼出假的 24 根柱子。
fn build_hours(history: &SupplierUsageHistory, official: bool) -> Vec<UsageHour> {
    if !official {
        return Vec::new();
    }
    history
        .hourly
        .iter()
        .filter_map(|(key, usage)| {
            let (date, hour) = key.split_once(' ')?;
            Some(UsageHour {
                date: date.to_string(),
                hour: hour.parse().ok()?,
                usage: *usage,
                models: history
                    .hourly_models
                    .get(key)
                    .map(model_list)
                    .unwrap_or_default(),
            })
        })
        .collect()
}

/// 把「模型 → 明细」摊平成前端要的数组（按模型名升序，BTreeMap 天然有序）。
///
/// 全零条目在落盘归一化时已被丢掉，这里再挡一次：内存里的历史可能来自测试或
/// 旧版本文件，界面不该为一个「三个维度都是 0」的模型画一根空柱。
fn model_list(models: &std::collections::BTreeMap<String, ModelUsage>) -> Vec<UsageModel> {
    models
        .iter()
        .filter(|(_, usage)| !usage.is_empty())
        .map(|(model, usage)| UsageModel {
            model: model.clone(),
            cost: usage.cost,
            hit: usage.hit,
            miss: usage.miss,
            out: usage.out,
        })
        .collect()
}

/// 把一次成功的在线结果记入历史（纯计算，落盘由调用方负责）。
fn record_online(history: &mut SupplierUsageHistory, snapshot: &UsageSnapshot, today: &str) {
    // 今日已用：接口若直接给出「当日口径」，就覆盖当天的在线值。
    if let Some(used) = snapshot.used {
        history.daily.entry(today.to_string()).or_default().remote = used;
    }
    // 逐日明细：接口给出哪天就写哪天（会覆盖 `used` 落下的同一天）。
    for (date, amount) in &snapshot.daily {
        history.daily.entry(date.clone()).or_default().remote = *amount;
    }
    // 余额差值记账：接口只给「此刻余额」时，当天用了多少只能靠相邻两次观测的落差累计。
    if let Some(current) = snapshot.balance {
        let delta = ledger_service::usage_delta(history.last_balance, current);
        history.daily.entry(today.to_string()).or_default().local += delta;
        history.last_balance = Some(current);
    }
    if !snapshot.currency.is_empty() {
        history.currency = snapshot.currency.clone();
    }
}

/// 取官方（令牌）逐日用量并写入历史，返回「本次是否取到了官方数据」。
///
/// # 取数窗口
/// 官网用量接口对窗口长度有上限（实测 ≥60 天直接 `INVALID_PARAM`），因此按**自然月**
/// 取数：当月窗口是「当月 1 日 → 次日」，历史月份是整月。「当年 1 月 1 日至今」只能拆成
/// 若干次请求，所以这套**整年回填**只在每个自然年做一次（见
/// [`SupplierUsageHistory::backfilled_year`]），之后的刷新只取当月。
///
/// 金额与 Token 两条来源各走一遍：它们窗口相同、凭证相同，差异只在响应结构，
/// 因此共用同一套「当月 + 回填」策略。
///
/// # 失败处理
/// 任何一个月失败只记日志、不写盘：历史里已有的官方数据照常展示，也不会把
/// `backfilled_year` 标记成已完成——下次刷新会重试整段回填。
async fn fetch_official_usage(
    endpoint: &SupplierEndpoint,
    credential: &SupplierCredential,
    query: &SupplierUsageQuery,
    history: &mut SupplierUsageHistory,
    remote_error: &mut String,
) -> bool {
    let sources = stats_sources(query);
    if sources.is_empty() {
        return false;
    }
    let now = Local::now();
    let mut fetched = false;
    for (kind, stats) in &sources {
        fetched |=
            fetch_stats_source(endpoint, credential, stats, *kind, history, remote_error).await;
    }

    // 今天 / 昨天再各取一次**单日**窗口：官网对单日窗口按小时粒度应答，
    // 界面上的「今天」「昨天」两张图需要逐小时明细，逐日合计还原不出一天内的高峰。
    // 这两次额外请求按 TTL 复用缓存，不会跟着每次余额刷新一起打。
    if hourly_due(history, now) {
        fetched |= refresh_hourly(endpoint, credential, query, history, now, remote_error).await;
    }
    fetched
}

/// 取**一条**统计来源的逐日明细（自然月 + 年度回填），返回本次是否取到数据。
async fn fetch_stats_source(
    endpoint: &SupplierEndpoint,
    credential: &SupplierCredential,
    stats: &SupplierUsageQuery,
    kind: StatsKind,
    history: &mut SupplierUsageHistory,
    remote_error: &mut String,
) -> bool {
    let now = Local::now();
    let year = now.year();
    let backfill = backfilled_year(history, kind) != year;

    let mut months: Vec<u32> = if backfill {
        (1..=now.month()).collect()
    } else {
        vec![now.month()]
    };
    months.sort_unstable();

    let mut fetched = false;
    let mut complete = true;
    for month in months {
        let window = if month == now.month() {
            TimeWindow::month(now)
        } else {
            match TimeWindow::for_month(year, month, now) {
                Some(window) => window,
                None => {
                    complete = false;
                    continue;
                }
            }
        };
        match registry::usage_gateway()
            .fetch_usage_in_window(endpoint, credential, stats, window)
            .await
        {
            Ok(snapshot) => {
                record_stats(history, &snapshot);
                fetched = true;
            }
            Err(err) => {
                log::warn!("令牌用量统计查询失败（{} 年 {} 月）：{}", year, month, err);
                complete = false;
                if remote_error.is_empty() {
                    *remote_error = err.message().to_string();
                }
            }
        }
    }

    if fetched && complete {
        mark_backfilled(history, kind, year);
    }
    fetched
}

/// 逐小时明细的缓存有效期（分钟）。
///
/// 单日窗口要多花两次请求，而余额刷新可能是几十秒一次；官网数字本身也有延迟，
/// 因此缓存几分钟完全够用。
const HOURLY_TTL_MINUTES: i64 = 5;

/// 逐小时明细覆盖的天数：今天与昨天（「今天 / 昨天」两张图的数据来源）。
const HOURLY_DAYS: u64 = 2;

/// 该不该刷新逐小时明细：从未取过、时间戳不可解析、或缓存已超过 [`HOURLY_TTL_MINUTES`]。
fn hourly_due(history: &SupplierUsageHistory, now: DateTime<Local>) -> bool {
    let stamp = history.hourly_updated_at.trim();
    if stamp.is_empty() {
        return true;
    }
    match NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M:%S") {
        Ok(time) => (now.naive_local() - time).num_minutes() >= HOURLY_TTL_MINUTES,
        Err(_) => true,
    }
}

/// 取「今天 + 昨天」两个单日窗口的逐小时明细并写入历史，返回本次是否取到数据。
///
/// 每条统计来源都要取：金额来源给逐小时金额，Token 来源给逐小时的三类 Token，
/// 两者缺一个就无法在「今天 / 昨天」的两张图上同时画出柱子。
///
/// 任意一次失败都只记日志、不更新时间戳（下次刷新会重试），已取到的部分照常入账——
/// 半天的小时数据也总比没有强。
async fn refresh_hourly(
    endpoint: &SupplierEndpoint,
    credential: &SupplierCredential,
    query: &SupplierUsageQuery,
    history: &mut SupplierUsageHistory,
    now: DateTime<Local>,
    remote_error: &mut String,
) -> bool {
    let sources = stats_sources(query);
    let mut fetched = false;
    let mut complete = true;
    for offset in 0..HOURLY_DAYS {
        let Some(date) = now.date_naive().checked_sub_days(Days::new(offset)) else {
            complete = false;
            continue;
        };
        let Some(window) = TimeWindow::on_day(date, now) else {
            complete = false;
            continue;
        };
        for (_, stats) in &sources {
            match registry::usage_gateway()
                .fetch_usage_in_window(endpoint, credential, stats, window)
                .await
            {
                Ok(snapshot) => {
                    record_stats(history, &snapshot);
                    fetched = true;
                }
                Err(err) => {
                    log::warn!("逐小时用量查询失败（{}）：{}", date, err);
                    complete = false;
                    if remote_error.is_empty() {
                        *remote_error = err.message().to_string();
                    }
                }
            }
        }
    }
    if fetched && complete {
        history.hourly_updated_at = now.format("%Y-%m-%d %H:%M:%S").to_string();
    }
    fetched
}

/// 把一次成功的**用量统计**结果记入历史（纯计算，落盘由调用方负责）。
///
/// # 口径隔离
/// 金额统计与 Token 统计是两条独立接口，各自只允许改写自己那一半：
/// - `snapshot.money` 为真才写 `daily[].remote` 与 `remote_days`（账单口径）；
/// - `snapshot.tokens` 为真才写 `models[].{hit, miss, out}`。
///
/// 少了这道隔离，Token 接口返回的「1.5 亿个 Token」会被当成 1.5 亿元写进账单。
///
/// 统计接口的「已用」通常是整周期口径（如本月合计），写进「今天」会是错误数据——
/// 今日口径与余额一律由余额来源负责，因此这里只消费逐日 / 逐小时明细。
fn record_stats(history: &mut SupplierUsageHistory, snapshot: &UsageSnapshot) {
    if snapshot.money {
        for (date, amount) in &snapshot.daily {
            history.daily.entry(date.clone()).or_default().remote = *amount;
            // 记下「官方给过这天数据」：0 也是官方结论，不能再被本地估算顶替。
            history.remote_days.insert(date.clone());
        }
    }
    // 按模型明细：**逐模型覆盖**而不是累加。同一份窗口会被反复拉取，
    // 累加会让每次刷新都把金额翻一倍。
    for (date, models) in &snapshot.daily_models {
        let entry = history.daily.entry(date.clone()).or_default();
        for (model, usage) in models {
            merge_model(entry.models.entry(model.clone()).or_default(), usage, snapshot);
        }
    }
    // 逐小时明细：先清掉本次窗口覆盖日期的旧时段，再整体写入。
    // 不清的话，本次没给的时段（例如刚跨天）会留下上次请求的陈旧柱子。
    // 两个口径各清各的：Token 来源不该把金额来源刚写好的小时柱抹掉。
    if snapshot.money && !snapshot.hourly.is_empty() {
        clear_hours(history, snapshot.hourly.iter().map(|(key, _)| key.as_str()));
        for (key, amount) in &snapshot.hourly {
            history.hourly.insert(key.clone(), *amount);
        }
    }
    if !snapshot.hourly_models.is_empty() {
        // 清的是**本次口径的那一半**（金额或 Token），不是整个条目：
        // `hourly_models` 同时承载两个口径，整条删掉会把另一条接口刚写好的数据抹掉
        // （实测表现：金额来源先写、Token 来源随后一清，小时桶里就只剩 Token，金额没了）。
        clear_hour_models(
            history,
            snapshot.hourly_models.iter().map(|(key, _)| key.as_str()),
            !snapshot.money,
        );
        for (key, models) in &snapshot.hourly_models {
            let entry = history.hourly_models.entry(key.clone()).or_default();
            for (model, usage) in models {
                merge_model(entry.entry(model.clone()).or_default(), usage, snapshot);
            }
        }
    }
    if snapshot.money && !snapshot.currency.is_empty() {
        history.currency = snapshot.currency.clone();
    }
    // 兜底日期集合随逐日数据一起收敛，避免磁盘上留下已不存在的日期。
    history
        .remote_days
        .retain(|date| history.daily.contains_key(date));
}

/// 把一条模型明细并入目标：**按口径覆盖**（本次应答带什么口径就覆盖什么）。
fn merge_model(target: &mut ModelUsage, usage: &ModelUsage, snapshot: &UsageSnapshot) {
    if snapshot.money {
        target.cost = usage.cost;
    }
    if snapshot.tokens {
        target.hit = usage.hit;
        target.miss = usage.miss;
        target.out = usage.out;
    }
}

/// 清掉逐小时**金额**明细里被本次窗口覆盖的日期。
fn clear_hours<'a>(history: &mut SupplierUsageHistory, keys: impl Iterator<Item = &'a str>) {
    let days = covered_days(keys);
    if days.is_empty() {
        return;
    }
    history
        .hourly
        .retain(|key, _| !key.split_once(' ').is_some_and(|(date, _)| days.contains(date)));
}

/// 清掉逐小时**按模型**明细里被本次窗口覆盖的日期，但只清本次口径的那一半。
///
/// `tokens_only = true` 表示本次是 Token 来源：只把三个 Token 维度归零，
/// 金额保留（那是另一条接口的数据）；反之只把金额归零。
/// 清完整条会被另一条来源的数据「顺手带走」，正是「金额图有柱、提示里没有模型行」
/// 这类静默缺口的来源。
fn clear_hour_models<'a>(
    history: &mut SupplierUsageHistory,
    keys: impl Iterator<Item = &'a str>,
    tokens_only: bool,
) {
    let days = covered_days(keys);
    if days.is_empty() {
        return;
    }
    history.hourly_models.retain(|key, models| {
        if !key
            .split_once(' ')
            .is_some_and(|(date, _)| days.contains(date))
        {
            return true;
        }
        for usage in models.values_mut() {
            if tokens_only {
                usage.hit = 0.0;
                usage.miss = 0.0;
                usage.out = 0.0;
            } else {
                usage.cost = 0.0;
            }
        }
        // 两半都空了才丢：只剩另一半的条目仍有意义。
        models.retain(|_, usage| !usage.is_empty());
        !models.is_empty()
    });
}

/// 从一批 `YYYY-MM-DD HH` 键里取出覆盖到的日期集合。
fn covered_days<'a>(keys: impl Iterator<Item = &'a str>) -> BTreeSet<&'a str> {
    keys.filter_map(|key| key.split_once(' ').map(|(date, _)| date))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::supplier::model::DailyUsage;

    fn history_with(last_balance: Option<f64>, today: &str) -> SupplierUsageHistory {
        SupplierUsageHistory {
            last_balance,
            currency: "USD".to_string(),
            daily: std::collections::BTreeMap::from([(
                today.to_string(),
                DailyUsage {
                    local: 1.0,
                    remote: 0.0,
                    ..DailyUsage::default()
                },
            )]),
            ..SupplierUsageHistory::default()
        }
    }

    /// 在线成功：`used` / 逐日明细写入 `remote`，余额差值累进 `local`。
    #[test]
    fn online_snapshot_is_recorded_into_history() {
        let mut history = history_with(Some(100.0), "2026-01-02");
        history.daily.insert(
            "2026-01-01".to_string(),
            DailyUsage {
                local: 0.0,
                remote: 0.0,
                ..DailyUsage::default()
            },
        );
        let snapshot = UsageSnapshot {
            balance: Some(90.0),
            used: Some(12.5),
            total: None,
            currency: "CNY".to_string(),
            daily: vec![("2026-01-01".to_string(), 7.5)],
            hourly: Vec::new(),
            ..UsageSnapshot::default()
        };

        record_online(&mut history, &snapshot, "2026-01-02");

        assert_eq!(
            history.daily["2026-01-02"].remote, 12.5,
            "今日已用写入 remote"
        );
        assert_eq!(
            history.daily["2026-01-01"].remote, 7.5,
            "逐日明细写入 remote"
        );
        assert_eq!(
            history.daily["2026-01-02"].local, 11.0,
            "余额下降 10 应累进当地时间用量"
        );
        assert_eq!(history.last_balance, Some(90.0), "差值基准前移");
        assert_eq!(history.currency, "CNY", "在线币种覆盖历史币种");
    }

    /// 只有余额、没有用量口径的接口（DeepSeek）：本地兜底数据必须继续累积。
    #[test]
    fn balance_only_snapshot_still_feeds_local_ledger() {
        let mut history = history_with(Some(50.0), "2026-01-02");
        let snapshot = UsageSnapshot {
            balance: Some(48.0),
            ..UsageSnapshot::default()
        };

        record_online(&mut history, &snapshot, "2026-01-02");

        assert_eq!(history.daily["2026-01-02"].remote, 0.0, "没有在线用量口径");
        assert_eq!(history.daily["2026-01-02"].local, 3.0, "1.0 + 差值 2.0");
        assert_eq!(history.currency, "USD", "接口未给币种时不得清空已有值");
    }

    /// 首次观测只建立基准，不产生用量（与 ledger 规则一致）。
    #[test]
    fn first_observation_only_sets_baseline() {
        let mut history = history_with(None, "2026-01-02");
        let snapshot = UsageSnapshot {
            balance: Some(88.0),
            ..UsageSnapshot::default()
        };

        record_online(&mut history, &snapshot, "2026-01-02");

        assert_eq!(history.daily["2026-01-02"].local, 1.0, "仅保留原有本地值");
        assert_eq!(history.last_balance, Some(88.0));
    }

    /// 充值（余额上升）不产生负用量，只前移基准。
    #[test]
    fn top_up_does_not_produce_negative_usage() {
        let mut history = history_with(Some(10.0), "2026-01-02");
        let snapshot = UsageSnapshot {
            balance: Some(110.0),
            ..UsageSnapshot::default()
        };

        record_online(&mut history, &snapshot, "2026-01-02");

        assert_eq!(history.daily["2026-01-02"].local, 1.0);
        assert_eq!(history.last_balance, Some(110.0));
    }

    /// 用量统计来源落账：逐日明细进 `remote`，并把日期记进 `remote_days`
    /// （0 也是官方结论，不能再被本地估算顶替）。
    #[test]
    fn stats_snapshot_marks_official_days_even_when_zero() {
        let mut history = SupplierUsageHistory {
            currency: "USD".to_string(),
            ..SupplierUsageHistory::default()
        };
        let snapshot = UsageSnapshot {
            // 金额口径：只有带金额的应答才允许改写账单与「官方给过这天」的标记。
            money: true,
            currency: "CNY".to_string(),
            daily: vec![
                ("2026-09-16".to_string(), 3.5),
                ("2026-09-17".to_string(), 0.0),
            ],
            ..UsageSnapshot::default()
        };

        record_stats(&mut history, &snapshot);

        assert_eq!(history.daily["2026-09-16"].remote, 3.5);
        assert_eq!(history.daily["2026-09-17"].remote, 0.0);
        assert!(
            history.remote_days.contains("2026-09-17"),
            "官方给的 0 同样要记账"
        );
        assert_eq!(history.currency, "CNY", "统计来源的币种覆盖历史币种");

        // 官方不再提及的日期必须从集合里收敛掉，避免磁盘上留下幽灵日期。
        history.remote_days.insert("2026-09-15".to_string());
        record_stats(&mut history, &snapshot);
        assert!(!history.remote_days.contains("2026-09-15"));
    }

    /// 逐日取值口径：官方给过的日期一律用官方数字（含 0），其余才回落本地估算。
    #[test]
    fn points_prefer_official_values_including_zero() {
        let history = SupplierUsageHistory {
            daily: std::collections::BTreeMap::from([
                (
                    // 官方给过 0：必须显示 0，不能被本地估算顶替。
                    "2026-09-15".to_string(),
                    DailyUsage {
                        local: 9.0,
                        remote: 0.0,
                        ..DailyUsage::default()
                    },
                ),
                (
                    // 官方给过 3.5：用官方值。
                    "2026-09-16".to_string(),
                    DailyUsage {
                        local: 9.0,
                        remote: 3.5,
                        ..DailyUsage::default()
                    },
                ),
                (
                    // 官方没给过：才允许回落本地记账。
                    "2026-09-17".to_string(),
                    DailyUsage {
                        local: 1.25,
                        remote: 0.0,
                        ..DailyUsage::default()
                    },
                ),
            ]),
            remote_days: std::collections::BTreeSet::from([
                "2026-09-15".to_string(),
                "2026-09-16".to_string(),
            ]),
            ..SupplierUsageHistory::default()
        };

        let points = build_points(&history, true);
        let index_of = |date: &str| {
            points
                .iter()
                .position(|point| point.date == date)
                .expect("点位应存在")
        };
        let official_zero = index_of("2026-09-15");
        assert_eq!(points[official_zero].usage, 0.0);
        assert_eq!(
            points[official_zero].source, "remote",
            "官方口径的 0 也算在线"
        );
        let official_value = index_of("2026-09-16");
        assert_eq!(points[official_value].usage, 3.5);
        assert_eq!(points[official_value].source, "remote");
        let local_only = index_of("2026-09-17");
        assert_eq!(points[local_only].usage, 1.25);
        assert_eq!(points[local_only].source, "local");
    }

    /// 关闭「令牌用量统计」时是彻底的本地离线口径：磁盘上残留的官方值一律不参与展示。
    #[test]
    fn points_ignore_official_values_when_token_usage_disabled() {
        let history = SupplierUsageHistory {
            daily: std::collections::BTreeMap::from([
                (
                    "2026-09-15".to_string(),
                    DailyUsage {
                        local: 9.0,
                        remote: 0.0,
                        ..DailyUsage::default()
                    },
                ),
                (
                    "2026-09-16".to_string(),
                    DailyUsage {
                        local: 9.0,
                        remote: 3.5,
                        ..DailyUsage::default()
                    },
                ),
            ]),
            remote_days: std::collections::BTreeSet::from(["2026-09-16".to_string()]),
            ..SupplierUsageHistory::default()
        };

        let points = build_points(&history, false);
        assert_eq!(points.len(), 2);
        for point in &points {
            assert_eq!(point.usage, 9.0, "{} 应使用本地余额差值", point.date);
            assert_eq!(point.source, "local", "{} 不得标成在线口径", point.date);
        }
    }

    /// 连通性结果：成功与失败都要带上耗时与地址。
    #[test]
    fn connection_result_carries_latency_and_url() {
        let success = test_result(
            Ok("连接成功".to_string()),
            Instant::now(),
            "https://api.x.com/usage".to_string(),
        );
        assert!(success.ok);
        assert_eq!(success.message, "连接成功");
        assert_eq!(success.url, "https://api.x.com/usage");

        let failure = test_result(
            Err(crate::types::exception::AppError::external(
                "用量接口请求失败",
            )),
            Instant::now(),
            "https://api.x.com/usage".to_string(),
        );
        assert!(!failure.ok);
        assert_eq!(failure.message, "用量接口请求失败");
    }

    /// 逐小时明细按「本次窗口覆盖的日期」整体替换：当天所有小时先清空再写入，
    /// 因此上一次请求留下的、这次已经不存在的时段不会残留在图里。
    #[test]
    fn stats_snapshot_replaces_hours_of_the_covered_day() {
        let mut history = SupplierUsageHistory {
            hourly: std::collections::BTreeMap::from([
                ("2026-09-18 09".to_string(), 1.0),
                ("2026-09-18 10".to_string(), 1.0),
                ("2026-09-17 20".to_string(), 5.0),
            ]),
            ..SupplierUsageHistory::default()
        };
        let snapshot = UsageSnapshot {
            money: true,
            daily: vec![("2026-09-18".to_string(), 2.5)],
            hourly: vec![
                ("2026-09-18 09".to_string(), 0.5),
                ("2026-09-18 11".to_string(), 2.0),
            ],
            ..UsageSnapshot::default()
        };

        record_stats(&mut history, &snapshot);

        assert_eq!(history.hourly["2026-09-18 09"], 0.5, "同日旧值被覆盖");
        assert_eq!(history.hourly["2026-09-18 11"], 2.0, "本次给的新时段入账");
        assert!(
            !history.hourly.contains_key("2026-09-18 10"),
            "本次没给的时段必须清掉，否则会留下陈旧柱子"
        );
        assert_eq!(
            history.hourly["2026-09-17 20"], 5.0,
            "本次窗口之外的日期不受影响"
        );
    }

    /// 逐小时明细的可见性跟着开关走：关闭时一行都不外露（与逐日点位同一口径）。
    #[test]
    fn hours_are_hidden_when_token_usage_disabled() {
        let history = SupplierUsageHistory {
            hourly: std::collections::BTreeMap::from([("2026-09-18 09".to_string(), 1.25)]),
            ..SupplierUsageHistory::default()
        };

        assert!(build_hours(&history, false).is_empty());
        let hours = build_hours(&history, true);
        assert_eq!(hours.len(), 1);
        assert_eq!(hours[0].date, "2026-09-18");
        assert_eq!(hours[0].hour, 9);
        assert_eq!(hours[0].usage, 1.25);
    }

    /// 逐小时明细的刷新节流：从未取过要刷，刚取过不刷，超过 TTL 再刷，
    /// 时间戳不可解析（文件被手改）时按「需要刷新」处理。
    #[test]
    fn hourly_refresh_is_throttled_by_ttl() {
        use chrono::TimeZone;

        let now = Local
            .with_ymd_and_hms(2026, 9, 18, 12, 0, 0)
            .single()
            .unwrap();
        let at = |stamp: &str| SupplierUsageHistory {
            hourly_updated_at: stamp.to_string(),
            ..SupplierUsageHistory::default()
        };

        let never = at("");
        assert!(hourly_due(&never, now), "从未取过要刷新");
        let fresh = at("2026-09-18 11:58:00");
        assert!(!hourly_due(&fresh, now), "刚取过不刷新");
        let stale = at("2026-09-18 11:50:00");
        assert!(hourly_due(&stale, now), "超过 5 分钟要刷新");
        let broken = at("坏时间戳");
        assert!(hourly_due(&broken, now), "不可解析按需刷新");
    }

    /// 造一条按模型明细（金额与 Token 都给，便于按口径各取一半）。
    fn model_usage(model: &str, cost: f64, hit: f64, miss: f64, out: f64) -> (String, ModelUsage) {
        (
            model.to_string(),
            ModelUsage {
                cost,
                hit,
                miss,
                out,
            },
        )
    }

    /// 金额与 Token 是两条接口，各自只允许改写自己那一半。
    ///
    /// 这是整个模型维度最容易出错的地方：Token 接口的「已用量」是**计数**，
    /// 一旦被当成金额写进 `daily[].remote`，账单会直接放大到亿级。
    #[test]
    fn money_and_token_snapshots_merge_without_clobbering() {
        let day = "2026-09-16".to_string();
        let mut history = SupplierUsageHistory::default();

        // ① 金额来源：写金额合计 + 当日模型金额。
        let money = UsageSnapshot {
            money: true,
            currency: "CNY".to_string(),
            daily: vec![(day.clone(), 16.0)],
            daily_models: std::collections::BTreeMap::from([(
                day.clone(),
                std::collections::BTreeMap::from([model_usage("flash", 14.0, 0.0, 0.0, 0.0)]),
            )]),
            ..UsageSnapshot::default()
        };
        record_stats(&mut history, &money);
        assert_eq!(history.daily[&day].remote, 16.0);
        assert!(history.remote_days.contains(&day));
        assert_eq!(history.daily[&day].models["flash"].cost, 14.0);

        // ② Token 来源：只补 Token，不得碰金额与「官方给过这天」的标记。
        let tokens = UsageSnapshot {
            tokens: true,
            daily_models: std::collections::BTreeMap::from([(
                day.clone(),
                std::collections::BTreeMap::from([model_usage("flash", 0.0, 253.0, 4.0, 0.8)]),
            )]),
            ..UsageSnapshot::default()
        };
        record_stats(&mut history, &tokens);

        assert_eq!(history.daily[&day].remote, 16.0, "Token 不得覆盖金额");
        let merged = &history.daily[&day].models["flash"];
        assert_eq!(merged.cost, 14.0, "金额必须原样保留");
        assert_eq!(merged.hit, 253.0);
        assert_eq!(merged.miss, 4.0);
        assert_eq!(merged.out, 0.8);
    }

    /// 只有 Token 的应答不得凭空造出账单金额。
    #[test]
    fn token_only_snapshot_leaves_money_totals_empty() {
        let day = "2026-09-16".to_string();
        let mut history = SupplierUsageHistory::default();
        let tokens = UsageSnapshot {
            tokens: true,
            daily: vec![(day.clone(), 1.5e8)],
            daily_models: std::collections::BTreeMap::from([(
                day.clone(),
                std::collections::BTreeMap::from([model_usage("flash", 0.0, 1.5e8, 0.0, 0.0)]),
            )]),
            ..UsageSnapshot::default()
        };

        record_stats(&mut history, &tokens);

        assert_eq!(history.daily[&day].remote, 0.0, "Token 个数不能进金额");
        assert!(
            !history.remote_days.contains(&day),
            "没有金额口径就不该宣称「官方给过这天的账单」"
        );
        assert_eq!(history.daily[&day].models["flash"].hit, 1.5e8);
    }

    /// 同一份窗口会被反复拉取：按模型明细必须**覆盖**而不是累加。
    #[test]
    fn repeated_snapshot_overwrites_instead_of_accumulating() {
        let day = "2026-09-16".to_string();
        let mut history = SupplierUsageHistory::default();
        let snapshot = UsageSnapshot {
            money: true,
            tokens: true,
            daily: vec![(day.clone(), 2.0)],
            daily_models: std::collections::BTreeMap::from([(
                day.clone(),
                std::collections::BTreeMap::from([model_usage("flash", 2.0, 10.0, 1.0, 0.5)]),
            )]),
            ..UsageSnapshot::default()
        };

        record_stats(&mut history, &snapshot);
        record_stats(&mut history, &snapshot);

        assert_eq!(history.daily[&day].remote, 2.0, "刷新不该把金额翻倍");
        let usage = &history.daily[&day].models["flash"];
        assert_eq!(usage.cost, 2.0);
        assert_eq!(usage.hit, 10.0);
    }

    /// 逐小时明细两条口径各清各的：Token 来源不得把金额来源刚写好的小时柱抹掉。
    #[test]
    fn token_hours_do_not_wipe_money_hours() {
        let mut history = SupplierUsageHistory::default();
        let money = UsageSnapshot {
            money: true,
            hourly: vec![("2026-09-18 09".to_string(), 1.5)],
            ..UsageSnapshot::default()
        };
        record_stats(&mut history, &money);
        let tokens = UsageSnapshot {
            tokens: true,
            hourly_models: std::collections::BTreeMap::from([(
                "2026-09-18 09".to_string(),
                std::collections::BTreeMap::from([model_usage("flash", 0.0, 100.0, 0.0, 5.0)]),
            )]),
            ..UsageSnapshot::default()
        };
        record_stats(&mut history, &tokens);

        assert_eq!(history.hourly["2026-09-18 09"], 1.5, "金额小时柱必须留下");
        assert_eq!(
            history.hourly_models["2026-09-18 09"]["flash"].hit,
            100.0
        );

        // 再取一次金额（同日）：小时合计整体替换，按模型的 Token 明细不受影响。
        let money_again = UsageSnapshot {
            money: true,
            hourly: vec![("2026-09-18 08".to_string(), 0.5)],
            ..UsageSnapshot::default()
        };
        record_stats(&mut history, &money_again);
        assert!(
            !history.hourly.contains_key("2026-09-18 09"),
            "本次没给的时段要清掉，避免陈旧柱子"
        );
        assert!(
            history.hourly_models.contains_key("2026-09-18 09"),
            "Token 小时明细由它自己的来源负责，不该被金额来源清空"
        );
    }

    /// 回归：Token 来源落账时**不能**把金额来源刚写好的逐小时模型金额抹掉。
    ///
    /// 实测症状：小时桶里只剩三类 Token，金额柱有值但悬浮提示里一行模型都没有
    /// （金额被清、又被 Token 来源以 0 重写）。
    #[test]
    fn token_hour_snapshot_keeps_money_model_cost() {
        let mut history = SupplierUsageHistory::default();
        record_stats(
            &mut history,
            &UsageSnapshot {
                money: true,
                hourly: vec![("2026-09-18 09".to_string(), 2.56)],
                hourly_models: std::collections::BTreeMap::from([(
                    "2026-09-18 09".to_string(),
                    std::collections::BTreeMap::from([model_usage(
                        "flash", 2.56, 0.0, 0.0, 0.0,
                    )]),
                )]),
                ..UsageSnapshot::default()
            },
        );
        record_stats(
            &mut history,
            &UsageSnapshot {
                tokens: true,
                hourly_models: std::collections::BTreeMap::from([(
                    "2026-09-18 09".to_string(),
                    std::collections::BTreeMap::from([model_usage(
                        "flash", 0.0, 100.0, 5.0, 2.0,
                    )]),
                )]),
                ..UsageSnapshot::default()
            },
        );

        let usage = &history.hourly_models["2026-09-18 09"]["flash"];
        assert_eq!(usage.cost, 2.56, "Token 来源不得清掉金额");
        assert_eq!(usage.hit, 100.0);
        assert_eq!(usage.miss, 5.0);
        assert_eq!(usage.out, 2.0);

        // 反过来也要成立：金额来源刷新时不得清掉 Token。
        record_stats(
            &mut history,
            &UsageSnapshot {
                money: true,
                hourly: vec![("2026-09-18 09".to_string(), 3.0)],
                hourly_models: std::collections::BTreeMap::from([(
                    "2026-09-18 09".to_string(),
                    std::collections::BTreeMap::from([model_usage(
                        "flash", 3.0, 0.0, 0.0, 0.0,
                    )]),
                )]),
                ..UsageSnapshot::default()
            },
        );
        let usage = &history.hourly_models["2026-09-18 09"]["flash"];
        assert_eq!(usage.cost, 3.0, "金额刷新为最新值");
        assert_eq!(usage.hit, 100.0, "Token 必须存活");
    }

    /// 按模型明细与开关同进同出：关掉「令牌用量统计」后界面拿不到任何模型数据。
    #[test]
    fn model_breakdown_is_hidden_when_token_usage_disabled() {
        let history = SupplierUsageHistory {
            daily: std::collections::BTreeMap::from([(
                "2026-09-16".to_string(),
                DailyUsage {
                    local: 0.0,
                    remote: 2.0,
                    models: std::collections::BTreeMap::from([model_usage(
                        "flash", 2.0, 10.0, 1.0, 0.5,
                    )]),
                },
            )]),
            hourly: std::collections::BTreeMap::from([("2026-09-16 09".to_string(), 2.0)]),
            hourly_models: std::collections::BTreeMap::from([(
                "2026-09-16 09".to_string(),
                std::collections::BTreeMap::from([model_usage("flash", 2.0, 10.0, 1.0, 0.5)]),
            )]),
            ..SupplierUsageHistory::default()
        };

        let off = build_points(&history, false);
        assert!(off[0].models.is_empty(), "关闭时不得外露模型明细");
        assert!(build_hours(&history, false).is_empty());

        let on = build_points(&history, true);
        assert_eq!(on[0].models.len(), 1);
        assert_eq!(on[0].models[0].model, "flash");
        assert_eq!(on[0].models[0].hit, 10.0);
        let hours = build_hours(&history, true);
        assert_eq!(hours[0].models.len(), 1);
        assert_eq!(hours[0].models[0].out, 0.5);
    }

    /// 全零的模型条目不下发：界面不该为一个三维度都是 0 的模型画空柱。
    #[test]
    fn all_zero_models_are_dropped_from_report() {
        let history = SupplierUsageHistory {
            daily: std::collections::BTreeMap::from([(
                "2026-09-16".to_string(),
                DailyUsage {
                    local: 0.0,
                    remote: 1.0,
                    models: std::collections::BTreeMap::from([
                        model_usage("flash", 1.0, 10.0, 0.0, 0.0),
                        model_usage("pro", 0.0, 0.0, 0.0, 0.0),
                    ]),
                },
            )]),
            remote_days: std::collections::BTreeSet::from(["2026-09-16".to_string()]),
            ..SupplierUsageHistory::default()
        };

        let points = build_points(&history, true);
        let names: Vec<&str> = points[0]
            .models
            .iter()
            .map(|model| model.model.as_str())
            .collect();
        assert_eq!(names, vec!["flash"], "全零模型必须被过滤掉");
    }

    /// 时间段切片：按自然月切开，端点含在窗口内，单日区间不切。
    #[test]
    fn monthly_windows_split_by_natural_month() {
        use chrono::TimeZone;

        let now = Local
            .with_ymd_and_hms(2026, 10, 6, 12, 0, 0)
            .single()
            .unwrap();
        let at = |text: &str| NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap();

        // 单日：不切片（换来官网的小时桶）。
        let single = monthly_windows(at("2026-10-05"), at("2026-10-05"), now);
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].end - single[0].start, 86_400);

        // 跨月：9/20–10/5 切成 9/20–9/30 与 10/1–10/5 两片，且首尾严格衔接。
        let cross = monthly_windows(at("2026-09-20"), at("2026-10-05"), now);
        assert_eq!(cross.len(), 2, "{:?}", cross);
        assert_eq!(cross[0].end, cross[1].start, "两片之间不能有缝也不能重叠");
        assert_eq!(cross[0].end - cross[0].start, 11 * 86_400);
        assert_eq!(cross[1].end - cross[1].start, 5 * 86_400);

        // 端点写反时自动纠正，未来日期截到今天。
        let reversed = monthly_windows(at("2026-09-30"), at("2026-09-01"), now);
        assert_eq!(reversed.len(), 1);
        assert_eq!(reversed[0].end - reversed[0].start, 30 * 86_400);
        let future = monthly_windows(at("2026-10-05"), at("2027-01-01"), now);
        assert_eq!(future.len(), 1, "今天之后不该继续切片");
        assert_eq!(
            future[0].end - future[0].start,
            2 * 86_400,
            "只取到「今天」为止（10/05–10/06）"
        );
    }
}
