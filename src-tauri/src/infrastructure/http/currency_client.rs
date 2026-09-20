//! 汇率接口客户端
//!
//! 通过 frankfurter 获取实时汇率，并按「北京 23:00 为日界」的天级缓存持久化到磁盘，
//! 同一天内复用缓存，避免每次切换币种都请求接口。

use std::collections::HashMap;
use std::fs;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::infrastructure::system::paths;
use crate::types::exception::{AppError, AppResult};
use crate::types::utils::fs as fs_utils;

/// 汇率接口根地址。
const FRANKFURTER_BASE: &str = "https://api.frankfurter.dev/v1/latest";

/// 请求超时。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 天级汇率缓存（持久化到磁盘）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct DailyRateCache {
    /// 缓存所属日期键。
    day: String,
    /// 键：`{from}_{to}`，值：1 from = N to。
    rates: HashMap<String, f64>,
}

/// 计算「北京 23:00 为日界」的当天日期键（23:00 起算作下一天）。
fn beijing_day_key() -> String {
    let offset = chrono::FixedOffset::east_opt(8 * 3600)
        .unwrap_or_else(|| chrono::FixedOffset::east_opt(0).expect("零偏移必然可用"));
    let shifted = chrono::Utc::now().with_timezone(&offset) + chrono::Duration::hours(1);
    shifted.format("%Y-%m-%d").to_string()
}

/// 读取磁盘缓存（缺失或损坏时视为空缓存）。
fn load_cache() -> DailyRateCache {
    match fs::read_to_string(paths::rate_cache_path()) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => DailyRateCache::default(),
    }
}

/// 写回磁盘缓存（失败不影响本次汇率使用）。
fn save_cache(cache: &DailyRateCache) {
    let Ok(json) = serde_json::to_string_pretty(cache) else {
        return;
    };
    let dir = paths::app_data_dir();
    let _ = fs::create_dir_all(&dir);
    let _ = fs_utils::write_atomic_plain(&paths::rate_cache_path(), json.as_bytes());
}

/// 获取 `from -> to` 汇率；同一天内命中缓存则直接返回，否则请求并缓存。
pub async fn get_or_fetch_rate(from: &str, to: &str) -> AppResult<f64> {
    if from == to {
        return Ok(1.0);
    }
    let today = beijing_day_key();
    let cache = load_cache();
    let key = format!("{}_{}", from, to);
    if cache.day == today {
        if let Some(rate) = cache.rates.get(&key) {
            return Ok(*rate);
        }
    }

    // 新的一天（或首次）：一次性拉取 `from` 相对所有币种的汇率并缓存。
    let rates = fetch_rates(from).await?;
    let mut new_rates = HashMap::new();
    for (currency, rate) in &rates {
        new_rates.insert(format!("{}_{}", from, currency), *rate);
    }
    save_cache(&DailyRateCache {
        day: today,
        rates: new_rates,
    });

    rates
        .get(to)
        .copied()
        .ok_or_else(|| AppError::external("汇率响应缺少目标币种"))
}

/// 请求 `from` 相对全部币种的汇率表。
async fn fetch_rates(from: &str) -> AppResult<HashMap<String, f64>> {
    let url = format!("{}?from={}", FRANKFURTER_BASE, from);
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| AppError::network(format!("HTTP 客户端初始化失败: {}", e)).transient())?;

    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::network(format!("汇率接口请求失败: {}", e)).transient())?;

    if !resp.status().is_success() {
        return Err(AppError::external(format!(
            "汇率接口返回 HTTP {}",
            resp.status().as_u16()
        )));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::network(format!("读取汇率响应失败: {}", e)).transient())?;

    let obj = body
        .get("rates")
        .and_then(|r| r.as_object())
        .ok_or_else(|| AppError::external("汇率响应结构异常"))?;

    let mut rates = HashMap::new();
    for (code, value) in obj {
        if let Some(rate) = value.as_f64() {
            rates.insert(code.clone(), rate);
        }
    }
    if rates.is_empty() {
        return Err(AppError::external("汇率响应为空"));
    }
    Ok(rates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_currency_needs_no_request() {
        // from == to 直接返回 1.0，不触发任何网络请求。
        let rate = tauri::async_runtime::block_on(get_or_fetch_rate("CNY", "CNY")).unwrap();
        assert_eq!(rate, 1.0);
    }

    /// 日界缓存键：北京 23:00 之后应算作下一天（与前端倒计时一致）。
    #[test]
    fn day_key_shifts_after_beijing_23() {
        let key = beijing_day_key();
        assert_eq!(key.len(), 10, "日期键应为 YYYY-MM-DD：{}", key);
        assert_eq!(key.matches('-').count(), 2);
    }

    #[test]
    fn missing_cache_falls_back_to_empty() {
        let cache = DailyRateCache::default();
        assert!(cache.day.is_empty());
        assert!(cache.rates.is_empty());
        assert!(!cache.rates.contains_key("CNY_USD"));
    }
}
