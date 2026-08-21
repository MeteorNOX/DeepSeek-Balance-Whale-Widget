//! API 请求模块（余额查询）
//!
//! 负责与 DeepSeek 官方接口交互：
//! 1. 余额查询：`GET {base_url}/user/balance`，携带 `Authorization: Bearer <key>`。
//!
//! 健壮性要求（对齐原 DSH 插件）：
//! - 网络错误/超时/5xx 重试 1 次（间隔 500ms）；4xx 不重试。
//! - 瞬时失败（网络/超时/5xx）标记 `transient=true`，上层可回退最近成功值。

use chrono::Timelike;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

// ---------------------------------------------------------------------------
// 峰谷定价表（复刻原插件 `PEAK_HOURS` / `BASE_PRICE` / `PRICING`）
// ---------------------------------------------------------------------------

/// 高峰时段：每日 9:00–12:00 与 14:00–18:00（北京时间 UTC+8）。
const PEAK_HOURS: [(u32, u32); 2] = [(9, 12), (14, 18)];

/// 判断给定 epoch 秒是否处于高峰时段（按北京时间判定）。
pub fn is_peak_time(time_sec: i64) -> bool {
    let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap_or_else(|| chrono::FixedOffset::east_opt(0).unwrap());
    let hour = chrono::DateTime::<chrono::Utc>::from_timestamp(time_sec, 0)
        .map(|t| t.with_timezone(&offset).hour())
        .unwrap_or_else(|| chrono::Local::now().hour());
    PEAK_HOURS.iter().any(|(start, end)| hour >= *start && hour < *end)
}

// ---------------------------------------------------------------------------
// 返回给前端的余额载荷
// ---------------------------------------------------------------------------

/// 余额/用量载荷（前端挂件据此渲染金额与「今日已用」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalancePayload {
    pub ok: bool,
    pub total_balance: Option<f64>,
    pub currency: Option<String>,
    pub today_usage: Option<f64>,
    pub is_peak: bool,
    pub error: Option<String>,
}

impl BalancePayload {
    fn ok(total_balance: f64, currency: String, today_usage: f64, is_peak: bool) -> Self {
        Self {
            ok: true,
            total_balance: Some(total_balance),
            currency: Some(currency),
            today_usage: Some(today_usage),
            is_peak,
            error: None,
        }
    }

    fn err(code: &str, transient: bool, message: &str) -> Self {
        // 原插件用 `code` 字段区分错误类型；这里并入 error 文案，方便前端统一提示。
        let _ = (code, transient);
        Self {
            ok: false,
            total_balance: None,
            currency: None,
            today_usage: None,
            is_peak: false,
            error: Some(message.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// 余额查询
// ---------------------------------------------------------------------------

/// 内部余额查询结果。
struct BalanceData {
    total_balance: f64,
    currency: String,
}

/// 内部错误：区分瞬时（可回退）与确定性（不可回退）失败。
struct BalanceError {
    code: String,
    transient: bool,
    message: String,
}

/// 请求余额接口（带一次瞬时失败重试）。
async fn fetch_balance(base_url: &str, api_key: &str) -> Result<BalanceData, BalanceError> {
    // 兼容 OpenAI/Anthropic 双协议：余额接口始终位于根域 /user/balance。
    let trimmed = base_url.trim_end_matches('/');
    let root = trimmed.strip_suffix("/anthropic").unwrap_or(trimmed);
    let url = format!("{}/user/balance", root);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| BalanceError {
            code: "CLIENT".to_string(),
            transient: true,
            message: format!("HTTP 客户端初始化失败: {}", e),
        })?;

    let mut last_err: Option<BalanceError> = None;

    // 最多尝试 2 次：首次失败（瞬时）后间隔 500ms 重试一次。
    for attempt in 0..2 {
        let result = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Accept", "application/json")
            .send()
            .await;

        match result {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    let transient = status.is_server_error();
                    let err = BalanceError {
                        code: "HTTP".to_string(),
                        transient,
                        message: format!("余额接口请求失败: HTTP {}", status.as_u16()),
                    };
                    // 4xx 不重试，直接返回。
                    if !transient {
                        return Err(err);
                    }
                    last_err = Some(err);
                } else {
                    // 成功：先取完整字节再解析，区分「读体失败」与「解析失败」。
                    let raw = match resp.bytes().await {
                        Ok(b) => b,
                        Err(e) => {
                            let err = BalanceError {
                                code: "READ".to_string(),
                                transient: true,
                                message: format!("读取余额响应失败: {}", e),
                            };
                            last_err = Some(err);
                            if attempt == 0 {
                                tokio::time::sleep(Duration::from_millis(500)).await;
                            }
                            continue;
                        }
                    };
                    let body: Value = match serde_json::from_slice(&raw) {
                        Ok(v) => v,
                        Err(_) => {
                            return Err(BalanceError {
                                code: "PARSE".to_string(),
                                transient: false,
                                message: "余额接口返回不是合法 JSON".to_string(),
                            });
                        }
                    };
                    return parse_balance_response(&body);
                }
            }
            Err(e) => {
                let err = BalanceError {
                    code: "NET".to_string(),
                    transient: true,
                    message: format!("余额接口请求失败: {}", e),
                };
                last_err = Some(err);
            }
        }

        if attempt == 0 {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    Err(last_err.unwrap_or(BalanceError {
        code: "HTTP".to_string(),
        transient: true,
        message: "余额接口请求失败".to_string(),
    }))
}

/// 解析余额响应，提取 `balance_infos[0].total_balance` 与 `currency`。
fn parse_balance_response(body: &Value) -> Result<BalanceData, BalanceError> {
    let infos = body
        .get("balance_infos")
        .and_then(|v| v.as_array())
        .ok_or_else(|| BalanceError {
            code: "SHAPE".to_string(),
            transient: false,
            message: "余额接口返回结构异常".to_string(),
        })?;

    let info = infos.first().ok_or_else(|| BalanceError {
        code: "SHAPE".to_string(),
        transient: false,
        message: "余额接口返回结构异常".to_string(),
    })?;

    let total_balance = info
        .get("total_balance")
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .ok_or_else(|| BalanceError {
            code: "SHAPE".to_string(),
            transient: false,
            message: "余额接口返回结构异常".to_string(),
        })?;

    let currency = info
        .get("currency")
        .and_then(|v| v.as_str())
        .unwrap_or("CNY")
        .to_string();

    Ok(BalanceData {
        total_balance,
        currency,
    })
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/// 组装完整的余额+用量载荷（供 Tauri 命令调用）。
pub async fn get_balance_payload() -> BalancePayload {
    let cfg = crate::config::get_config();
    let api_key = cfg.api_key.trim().to_string();

    // 未配置 API Key：确定性失败，提示用户到设置界面填写。
    if api_key.is_empty() {
        return BalancePayload::err("NO_KEY", false, "未配置API-KEY");
    }

    match fetch_balance(&cfg.base_url, &api_key).await {
        Err(e) => BalancePayload::err(&e.code, e.transient, &e.message),
        Ok(data) => {
            // 小鲸鱼记账：记录一次余额观测（自动累计当日用量）。
            let ledger = crate::ledger::record_usage(data.total_balance);
            let is_peak = is_peak_time(chrono::Local::now().timestamp());
            BalancePayload::ok(data.total_balance, data.currency, ledger.today_usage, is_peak)
        }
    }
}
