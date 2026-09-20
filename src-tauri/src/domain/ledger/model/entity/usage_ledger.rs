//! 记账账本 DTO
//!
//! 注意：字段名即磁盘键名（历史为 snake_case），**不可**添加 `rename_all`，
//! 否则老用户的账本会整体读不出来。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 记账账本结构（磁盘 JSON 结构）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageLedger {
    /// 当前记账日期（`YYYY-MM-DD`）。
    pub date: String,
    /// 最近一次观测到的余额（作为差值计算基准）。
    pub last_balance: Option<f64>,
    /// 当日累计用量（单位：元）。
    pub today_usage: f64,
    /// 历史归档：日期 -> 当日用量。
    pub history: BTreeMap<String, f64>,
}

impl Default for UsageLedger {
    /// 返回空账本默认值，并以当天日期初始化日期键。
    fn default() -> Self {
        Self {
            date: crate::domain::ledger::service::ledger_service::today_key(),
            last_balance: None,
            today_usage: 0.0,
            history: BTreeMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认账本的日期键必须是「今天」，且没有任何历史数据。
    #[test]
    fn default_ledger_starts_empty_today() {
        let ledger = UsageLedger::default();
        assert_eq!(
            ledger.date,
            crate::domain::ledger::service::ledger_service::today_key()
        );
        assert_eq!(ledger.date.len(), 10, "日期键应为 YYYY-MM-DD");
        assert!(ledger.last_balance.is_none());
        assert_eq!(ledger.today_usage, 0.0);
        assert!(ledger.history.is_empty());
    }

    /// 磁盘键名是历史契约（snake_case）。
    #[test]
    fn json_keys_are_snake_case() {
        let json = serde_json::to_string(&UsageLedger::default()).unwrap();
        for key in [
            "\"date\"",
            "\"last_balance\"",
            "\"today_usage\"",
            "\"history\"",
        ] {
            assert!(json.contains(key), "缺少字段 {}：{}", key, json);
        }
        // 历史账本必须能反序列化回来。
        let legacy = r#"{"date":"2026-01-01","last_balance":10.0,"today_usage":2.0,"history":{"2025-12-31":1.0}}"#;
        let restored: UsageLedger = serde_json::from_str(legacy).unwrap();
        assert_eq!(restored.last_balance, Some(10.0));
        assert_eq!(restored.history.get("2025-12-31"), Some(&1.0));
    }
}
