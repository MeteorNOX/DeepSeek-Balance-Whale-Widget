//! 余额/用量载荷 DTO

use serde::Serialize;

use crate::types::exception::AppError;

/// 余额/用量载荷。
///
/// 失败时不返回错误码，只返回可展示的 `error` 文案（与原实现一致）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalancePayload {
    /// 本次请求是否成功。
    pub ok: bool,
    /// 当前余额；失败时为空。
    pub total_balance: Option<f64>,
    /// 余额币种；失败时为空。
    pub currency: Option<String>,
    /// 显示币种；失败时为 CNY。
    pub display_currency: String,
    /// 原始币种 → 显示币种的汇率；失败时为 1。
    pub rate: f64,
    /// 今日累计用量；失败时为空。
    pub today_usage: Option<f64>,
    /// 当前是否处于峰时段。
    pub is_peak: bool,
    /// 当前数据源是否支持峰谷计价（目前仅 DeepSeek）。
    ///
    /// 峰谷时段是 DeepSeek 的计价规则，切换到其它供应商后挂件必须整行去掉峰谷提示；
    /// 而 `is_peak == false` 无法区分「DeepSeek 的空闲时段」与「非 DeepSeek 供应商」，
    /// 因此单独给出这一位。
    pub peak_supported: bool,
    /// 失败时返回的错误文案。
    pub error: Option<String>,
}

impl BalancePayload {
    /// 构造成功载荷。
    pub fn ok(
        total_balance: f64,
        currency: String,
        today_usage: f64,
        is_peak: bool,
        peak_supported: bool,
        display_currency: String,
        rate: f64,
    ) -> Self {
        Self {
            ok: true,
            total_balance: Some(total_balance),
            currency: Some(currency),
            today_usage: Some(today_usage),
            is_peak,
            peak_supported,
            display_currency,
            rate,
            error: None,
        }
    }

    /// 由统一错误构造失败载荷（错误分类记入日志，前端只看到文案）。
    pub fn from_error(err: &AppError) -> Self {
        log::warn!(
            "余额查询失败[{}]（瞬时失败={}）：{}",
            err.code().as_str(),
            err.is_transient(),
            err.message()
        );
        Self {
            ok: false,
            total_balance: None,
            currency: None,
            today_usage: None,
            is_peak: false,
            // 失败时不展示峰谷提示：拿不到数据源就无法确认它是否按峰谷计价。
            peak_supported: false,
            display_currency: "CNY".to_string(),
            rate: 1.0,
            error: Some(err.message().to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::enums::ErrorCode;

    #[test]
    fn success_payload_serializes_camel_case() {
        let payload = BalancePayload::ok(12.5, "CNY".into(), 1.5, true, true, "USD".into(), 7.1);
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"totalBalance\":12.5"), "{}", json);
        assert!(json.contains("\"displayCurrency\":\"USD\""), "{}", json);
        assert!(json.contains("\"todayUsage\":1.5"), "{}", json);
        assert!(json.contains("\"isPeak\":true"), "{}", json);
        assert!(json.contains("\"peakSupported\":true"), "{}", json);
        assert!(json.contains("\"error\":null"), "{}", json);
    }

    /// 失败载荷：字段齐全、默认值固定、错误文案来自统一错误。
    #[test]
    fn error_payload_keeps_wire_defaults() {
        let payload =
            BalancePayload::from_error(&AppError::new(ErrorCode::NoApiKey, "未配置API-KEY"));
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"ok\":false"), "{}", json);
        assert!(json.contains("\"displayCurrency\":\"CNY\""), "{}", json);
        assert!(json.contains("\"rate\":1.0"), "{}", json);
        assert!(json.contains("\"error\":\"未配置API-KEY\""), "{}", json);
    }
}
