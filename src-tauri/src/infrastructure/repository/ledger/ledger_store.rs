//! 记账账本持久化
//!
//! 读写旧版全局账本 `usage.json`（记账规则本身位于 `domain::ledger`）。
//!
//! **本模块只保留读取能力**：新架构下用量落在
//! `<数据目录>/supplier/<scope>/<slug>/usage_history.json`（见 `supplier_store`），
//! 旧账本不再被写入，仅在旧配置迁移时读出来一次性导入。

use std::fs;

use crate::domain::ledger::model::UsageLedger;
use crate::infrastructure::system::paths;

/// 从磁盘读取账本；缺失/损坏时返回默认账本。
///
/// 供旧账本导入复用（`application::supplier::service`）：旧帐本缺失或损坏
/// 都不该阻断迁移，因此这里一律回退默认账本而不是报错。
pub fn read_ledger() -> UsageLedger {
    let path = paths::ledger_path();
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<UsageLedger>(&content).unwrap_or_default(),
        Err(_) => UsageLedger::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 账本文件的磁盘键名是历史契约（snake_case），不可随 DTO 改成 camelCase，
    /// 否则老用户的 `usage.json` 会整体读不出来。
    #[test]
    fn ledger_json_keeps_legacy_snake_case_keys() {
        let ledger = UsageLedger {
            last_balance: Some(12.5),
            today_usage: 1.25,
            ..UsageLedger::default()
        };

        let json = serde_json::to_string(&ledger).unwrap();
        assert!(json.contains("\"last_balance\""), "{}", json);
        assert!(json.contains("\"today_usage\""), "{}", json);
        assert!(json.contains("\"date\""), "{}", json);
        assert!(json.contains("\"history\""), "{}", json);

        // 历史文件必须能反序列化回来。
        let legacy = r#"{"date":"2026-01-01","last_balance":10.0,"today_usage":2.0,"history":{"2025-12-31":1.0}}"#;
        let restored: UsageLedger = serde_json::from_str(legacy).unwrap();
        assert_eq!(restored.last_balance, Some(10.0));
        assert_eq!(restored.history.get("2025-12-31"), Some(&1.0));
    }

    /// 损坏的账本不应导致读取失败，而是回落到默认账本。
    #[test]
    fn broken_ledger_falls_back_to_default() {
        let parsed: Option<UsageLedger> = serde_json::from_str("not-json").ok();
        assert!(parsed.is_none(), "非法 JSON 应解析失败并由调用方兜底");
    }

    /// 旧账本读取是「缺失即空账本」的语义（供迁移判断是否有数据可导入）。
    #[test]
    fn ledger_path_is_the_legacy_usage_json() {
        assert_eq!(paths::ledger_path().file_name().unwrap(), "usage.json");
        assert!(paths::ledger_path().starts_with(paths::app_data_dir()));
    }
}
