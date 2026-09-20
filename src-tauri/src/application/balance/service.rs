//! 余额用例
//!
//! 编排：取余额配置列表的当前启用供应商 → 观测余额（在线优先 / 本地兜底）
//! → 汇率换算 → 组装载荷。
//!
//! 数据源是 `supplier/balance/active.json` 指向的供应商，而不是旧配置里的
//! `api_key` / `base_url`：换供应商只改启用项，展示链路无需重新配置。
//!
//! 峰谷提示是 DeepSeek 独有的概念：只有请求地址仍指向 DeepSeek 时才计算，
//! 切换为其它供应商后该提示自动消失。

use crate::application::pricing::service as calendar_use_case;
use crate::application::usage;
use crate::domain::balance::model::BalancePayload;
use crate::domain::config::model::AppConfig;
use crate::domain::supplier::service::supplier_service::{self, BALANCE_SCOPE};
use crate::types::enums::Currency;
use crate::types::enums::ErrorCode;
use crate::types::exception::AppError;
use crate::application::registry;

/// 组装完整的余额 + 用量载荷。
pub async fn get_balance_payload() -> BalancePayload {
    let cfg = registry::config().get();

    // 余额配置列表未启用任何供应商：确定性失败，提示用户去配置。
    let active = match registry::supplier().read_active(BALANCE_SCOPE) {
        Ok(active) => active,
        Err(err) => return BalancePayload::from_error(&err),
    };
    let Some(slug) = active else {
        return no_supplier_payload();
    };

    payload_for(&cfg, BALANCE_SCOPE, &slug).await
}

/// 组装**指定供应商**的余额 + 用量载荷。
///
/// 供模块化气泡的「余额 / 今日已用」模块按用户选定的供应商取数
/// （不传供应商时回落到当前启用项，即 [`get_balance_payload`]）。
pub async fn get_supplier_balance_payload(scope: &str, slug: &str) -> BalancePayload {
    let scope = scope.trim();
    let slug = slug.trim();
    if scope.is_empty() || slug.is_empty() {
        return get_balance_payload().await;
    }
    let cfg = registry::config().get();
    payload_for(&cfg, scope, slug).await
}

/// 取数主体：观测余额 → 汇率换算 → 组装载荷。
async fn payload_for(cfg: &AppConfig, scope: &str, slug: &str) -> BalancePayload {
    let report = match usage::service::observe_balance(scope, slug).await {
        Ok(report) => report,
        Err(err) => return BalancePayload::from_error(&err),
    };

    // 在线与本地都拿不到余额 → 失败载荷，错误文案优先用在线失败原因。
    let Some(total_balance) = report.balance else {
        let message = if report.remote_error.is_empty() {
            "余额查询失败"
        } else {
            report.remote_error.as_str()
        };
        return BalancePayload::from_error(&AppError::new(ErrorCode::External, message));
    };

    // 币种：在线未提供时按 CNY 处理（界面既有约定）。
    let currency = if report.currency.is_empty() {
        "CNY".to_string()
    } else {
        report.currency
    };
    let display_currency = Currency::parse_loose_or_default(&cfg.widget.display_currency);
    let (display_currency, rate) = if display_currency.as_str() == currency {
        (display_currency.as_str().to_string(), 1.0)
    } else {
        match registry::exchange_rate()
            .rate(&currency, display_currency.as_str())
            .await
        {
            Ok(rate) => (display_currency.as_str().to_string(), rate),
            Err(e) => {
                log::warn!("获取汇率失败，回退原始币种 {}: {}", currency, e);
                (currency.clone(), 1.0)
            }
        }
    };

    // 峰谷提示只属于 DeepSeek 的计价规则：先把「数据源是否支持峰谷」算出来，
    // 供挂件决定是否整行展示峰谷提示；`is_peak` 只在支持时为真。
    let peak_supported = match registry::supplier().read_endpoint(scope, slug) {
        Ok(endpoint) => supplier_service::is_deepseek_endpoint(&endpoint.base_url),
        Err(err) => {
            // 峰谷只是提示，读不到请求地址不应影响余额展示。
            log::warn!("读取供应商请求地址失败，峰谷按不支持处理：{}", err);
            false
        }
    };
    let is_peak = peak_flag(peak_supported, calendar_use_case::is_peak_now());

    BalancePayload::ok(
        total_balance,
        currency,
        report.today_usage,
        is_peak,
        peak_supported,
        display_currency,
        rate,
    )
}

/// 是否处于峰时段：仅当数据源支持峰谷计价（DeepSeek）时才有峰谷概念。
///
/// 抽出纯函数是为了让「切换供应商后峰谷提示消失」这条规则可被单测覆盖（不触网）。
/// 判定用当天的节假日日历（同步读缓存/内置兜底，不联网），口径与前端完全一致。
fn peak_flag(peak_supported: bool, is_peak: bool) -> bool {
    peak_supported && is_peak
}

/// 未配置余额供应商时的失败载荷。
fn no_supplier_payload() -> BalancePayload {
    BalancePayload::from_error(&AppError::new(ErrorCode::NoApiKey, "尚未配置余额供应商"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未配置余额供应商时必须返回确定性失败载荷，且字段齐全。
    #[test]
    fn missing_supplier_payload_is_deterministic() {
        let payload = no_supplier_payload();
        assert!(!payload.ok);
        assert_eq!(payload.error.as_deref(), Some("尚未配置余额供应商"));
        assert_eq!(payload.display_currency, "CNY");
        assert_eq!(payload.rate, 1.0);
        assert!(payload.total_balance.is_none());
        assert!(payload.today_usage.is_none());
        assert!(payload.currency.is_none());
        assert!(!payload.is_peak);
        assert!(!payload.peak_supported, "无数据源时不应展示峰谷提示");
    }

    /// 峰谷只在「数据源支持峰谷计价」且「当前处于高峰时段」时成立。
    #[test]
    fn peak_flag_requires_supported_source() {
        assert!(peak_flag(true, true), "支持峰谷 + 高峰时段 → true");
        assert!(!peak_flag(true, false), "支持峰谷 + 空闲时段 → false");
        assert!(
            !peak_flag(false, true),
            "不支持峰谷的数据源在高时段也必须为 false"
        );
        assert!(!peak_flag(false, false));
    }

    /// 供应商标识决定「是否支持峰谷」：只有 DeepSeek 端点算支持。
    #[test]
    fn peak_supported_is_deepseek_only() {
        for base_url in [
            "https://api.deepseek.com/anthropic",
            "https://api.deepseek.com",
        ] {
            assert!(
                supplier_service::is_deepseek_endpoint(base_url),
                "「{}」应被识别为 DeepSeek",
                base_url
            );
        }
        for base_url in [
            "https://api.moonshot.cn/v1",
            "https://api-inference.modelscope.cn/v1",
            "https://proxy.example.com",
            "",
        ] {
            assert!(
                !supplier_service::is_deepseek_endpoint(base_url),
                "「{}」不是 DeepSeek，峰谷提示必须整行去掉",
                base_url
            );
        }
    }
}
