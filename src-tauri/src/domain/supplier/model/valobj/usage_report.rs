//! 用量报表 DTO（**线上面向前端的契约，不落盘**）
//!
//! 报表是「在线优先 → 本地兜底」的最终结果：界面不需要知道数据是从远端接口还是
//! 本地账本取到的，只需要拿到可画的点与来源标记。
//!
//! 因为不落盘，字段名直接采用前端契约（camelCase），与 [`BalancePayload`] 的做法一致；
//! 磁盘结构（如 `usage_history.json`）仍是 snake_case，两者不得互相牵动。
//!
//! [`BalancePayload`]: crate::domain::balance::model::BalancePayload

use serde::Serialize;

/// 用量报表：在线优先、本地兜底的最终结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// 数据来源：`remote`（在线）或 `local`（本地记账兜底）。
    pub source: String,
    /// 在线失败原因；`source == "local"` 时非空，供界面提示。
    pub remote_error: String,
    /// 当前余额（在线取到，或本地最近一次观测值兜底）。
    pub balance: Option<f64>,
    /// 余额币种（空串表示未知，界面按 CNY 处理）。
    pub currency: String,
    /// 今日已用。
    pub today_usage: f64,
    /// 按日聚合的用量序列（升序，日期 `YYYY-MM-DD`）。
    pub points: Vec<UsagePoint>,
    /// 按小时聚合的用量序列（升序，仅今天 / 昨天这类单日窗口才有内容）。
    pub hourly: Vec<UsageHour>,
}

/// 单日用量点。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePoint {
    /// 日期（`YYYY-MM-DD`）。
    pub date: String,
    /// 该日用量（优先在线值，无在线值时用本地记账值）。
    pub usage: f64,
    /// 该日数值来源：`remote` / `local`。
    pub source: String,
    /// 该日**按模型拆分**的明细（按模型名升序；本地记账兜底时为空数组）。
    ///
    /// 金额柱状图的 tooltip 逐模型金额、模型 Token 柱状图的三维度，都从这里取。
    /// 界面会先按所选时间段把点位聚合起来再出图，因此模型维度必须跟着**每个点位**
    /// 一起给，不能只在报表顶层给一份区间合计。
    pub models: Vec<UsageModel>,
}

/// 单个模型在一个时间桶里的用量（金额与三类 Token 同源同桶，前端一次取全）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModel {
    /// 模型名（官方口径原文，如 `deepseek-flash`）。
    pub model: String,
    /// 该桶内的金额。
    pub cost: f64,
    /// 输入（命中缓存）Token 数。
    pub hit: f64,
    /// 输入（未命中缓存）Token 数。
    pub miss: f64,
    /// 输出 Token 数。
    pub out: f64,
}

/// 单小时用量点（界面「今天 / 昨天」按小时画柱状图时消费）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHour {
    /// 日期（`YYYY-MM-DD`）。
    pub date: String,
    /// 小时（0–23，本地时区）。
    pub hour: u32,
    /// 该小时用量。
    pub usage: f64,
    /// 该小时**按模型拆分**的明细（按模型名升序）。
    pub models: Vec<UsageModel>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 线上契约字段名必须是 camelCase（前端直接消费），且不落盘。
    #[test]
    fn report_serializes_camel_case() {
        let report = UsageReport {
            source: "local".to_string(),
            remote_error: "用量接口请求失败: HTTP 500".to_string(),
            balance: Some(12.5),
            currency: "CNY".to_string(),
            today_usage: 1.5,
            points: vec![UsagePoint {
                date: "2026-01-01".to_string(),
                usage: 1.5,
                source: "local".to_string(),
                models: vec![UsageModel {
                    model: "deepseek-flash".to_string(),
                    cost: 1.5,
                    hit: 100.0,
                    miss: 20.0,
                    out: 5.0,
                }],
            }],
            hourly: vec![UsageHour {
                date: "2026-01-01".to_string(),
                hour: 9,
                usage: 0.5,
                models: Vec::new(),
            }],
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"remoteError\""), "{}", json);
        assert!(json.contains("\"todayUsage\":1.5"), "{}", json);
        assert!(json.contains("\"date\":\"2026-01-01\""), "{}", json);
        assert!(json.contains("\"hour\":9"), "{}", json);
        // 按模型明细同样走 camelCase：前端直接消费这些字段名。
        assert!(json.contains("\"model\":\"deepseek-flash\""), "{}", json);
        assert!(json.contains("\"hit\":100.0"), "{}", json);
        assert!(!json.contains("remote_error"), "{}", json);
    }
}
