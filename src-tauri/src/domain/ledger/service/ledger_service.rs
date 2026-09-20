//! 记账规则（领域服务）
//!
//! 复刻原 DSH 插件 `.dshw-usage.json` 的记账逻辑：
//! - 每次观测到余额后，用「余额下降的正差值」累计当天用量；
//! - 余额上升（充值）不扣减，只更新基准；
//! - 跨天自动归零，并把前一天用量归档进 `history`（保留最近 30 天）。
//!
//! 本模块只包含**纯规则**（无文件读写）。其中 [`usage_delta`] 是当前唯一被生产路径
//! 消费的规则：供应商用量历史（`domain::supplier`）用它累计「本地离线兜底」的当日用量。
//!
//! 整套「全局账本」规则（[`apply_observation`] 等）**已被供应商用量历史取代**：
//! 新体系里每个供应商各有一份 `usage_history.json`，旧账本 `usage.json` 不再写入，
//! 只在旧配置迁移时读出来导入一次。规则与测试保留下来，一是继续作为差值记账的
//! 回归基线，二是万一需要回退旧版本时口径仍然一致。

use chrono::Local;

use crate::domain::ledger::model::UsageLedger;

/// 历史归档保留天数。
///
/// 仅旧全局账本使用；用量图表走供应商用量历史（保留 [`HISTORY_DAY_LIMIT`] 天）。
///
/// 旧账本写入路径已下线（供应商体系落地后不再写入 `usage.json`，只在旧配置迁移时
/// 读出来导入一次），本常量与 [`apply_observation`] 一样**只由回归测试消费**，
/// 因此保留 `#[allow(dead_code)]`：删掉它们会同时删掉差值记账的回归基线。
///
/// [`HISTORY_DAY_LIMIT`]: crate::domain::supplier::service::supplier_service::HISTORY_DAY_LIMIT
#[allow(dead_code)]
pub const HISTORY_LIMIT: usize = 30;

/// 返回当天日期键（本地时区）。
pub fn today_key() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// 记录一次余额观测（纯计算，不落盘）。
///
/// # 逻辑
/// 1. 跨天：归档昨日 `today_usage`，重置 `date` / `last_balance` / `today_usage`；
/// 2. 同日：余额下降时把差值累加进 `today_usage`；无论升降都更新 `last_balance`；
/// 3. 历史归档仅保留最近 [`HISTORY_LIMIT`] 天。
///
/// 旧账本写入路径已下线且**不再有生产调用点**（生产路径改用 [`usage_delta`] +
/// 供应商用量历史），本函数只由回归测试消费，故保留 `#[allow(dead_code)]`。
#[allow(dead_code)]
pub fn apply_observation(ledger: &mut UsageLedger, current_balance: f64, today: &str) {
    if ledger.date != today {
        // 跨天归档：只有存在有效当日用量时才写入历史。
        if ledger.today_usage > 0.0 {
            ledger
                .history
                .insert(ledger.date.clone(), ledger.today_usage);
        }
        ledger.date = today.to_string();
        ledger.last_balance = Some(current_balance);
        ledger.today_usage = 0.0;
    } else if ledger.last_balance.is_some() {
        // 同日：余额下降的部分计为用量，余额上升（充值）只更新基准。
        ledger.today_usage += usage_delta(ledger.last_balance, current_balance);
        ledger.last_balance = Some(current_balance);
    } else {
        // 首次观测：仅建立基准。
        ledger.last_balance = Some(current_balance);
    }

    trim_history(ledger);
}

/// 余额差值记账：只有余额下降的部分计为用量（充值不产生负用量）。
///
/// `last_balance` 为 `None`（首次观测）或余额未下降时返回 0.0。
///
/// 独立成纯函数是因为用量统计链路的「本地离线兜底」同样依赖它：
/// 供应商用量历史（`domain::supplier`）用同一个口径累计当天的本地用量，
/// 两处必须完全一致，否则新旧数据的含义会出现偏差。
pub fn usage_delta(last_balance: Option<f64>, current_balance: f64) -> f64 {
    match last_balance {
        Some(prev) if current_balance < prev => prev - current_balance,
        _ => 0.0,
    }
}

/// 历史仅保留最近 [`HISTORY_LIMIT`] 天（BTreeMap 键有序，从最旧开始删）。
fn trim_history(ledger: &mut UsageLedger) {
    while ledger.history.len() > HISTORY_LIMIT {
        if let Some(oldest) = ledger.history.keys().next().cloned() {
            ledger.history.remove(&oldest);
        } else {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn ledger_on(date: &str, balance: f64) -> UsageLedger {
        UsageLedger {
            date: date.to_string(),
            last_balance: Some(balance),
            today_usage: 0.0,
            history: BTreeMap::new(),
        }
    }

    /// 首次观测只建立基准，不计用量。
    #[test]
    fn first_observation_only_sets_baseline() {
        let mut ledger = UsageLedger {
            date: "2026-01-01".to_string(),
            last_balance: None,
            today_usage: 0.0,
            history: BTreeMap::new(),
        };
        apply_observation(&mut ledger, 100.0, "2026-01-01");
        assert_eq!(ledger.last_balance, Some(100.0));
        assert_eq!(ledger.today_usage, 0.0);
    }

    /// 同日余额下降累计为用量；余额上升（充值）只更新基准，不倒扣。
    #[test]
    fn same_day_usage_accumulates_on_drop_only() {
        let mut ledger = ledger_on("2026-01-01", 100.0);

        apply_observation(&mut ledger, 90.0, "2026-01-01");
        assert_eq!(ledger.today_usage, 10.0);

        // 余额上升：充值不计负用量。
        apply_observation(&mut ledger, 200.0, "2026-01-01");
        assert_eq!(ledger.today_usage, 10.0, "充值不应产生负用量");
        assert_eq!(ledger.last_balance, Some(200.0));

        // 再次下降：从新基准继续累计。
        apply_observation(&mut ledger, 195.0, "2026-01-01");
        assert_eq!(ledger.today_usage, 15.0);
    }

    /// 跨天：昨日用量归档，当日归零且首次观测不计用量。
    #[test]
    fn day_rollover_archives_and_resets() {
        let mut ledger = ledger_on("2026-01-01", 100.0);
        apply_observation(&mut ledger, 80.0, "2026-01-01");
        assert_eq!(ledger.today_usage, 20.0);

        apply_observation(&mut ledger, 80.0, "2026-01-02");
        assert_eq!(ledger.date, "2026-01-02");
        assert_eq!(
            ledger.history.get("2026-01-01"),
            Some(&20.0),
            "昨日用量应归档"
        );
        assert_eq!(ledger.today_usage, 0.0, "跨天后当日用量归零");

        // 跨天后的首次观测不产生用量。
        apply_observation(&mut ledger, 70.0, "2026-01-02");
        assert_eq!(ledger.today_usage, 10.0);
    }

    /// 当日无用量时跨天不写入历史，避免归档一堆 0。
    #[test]
    fn rollover_without_usage_does_not_archive() {
        let mut ledger = ledger_on("2026-01-01", 50.0);
        apply_observation(&mut ledger, 50.0, "2026-01-02");
        assert!(ledger.history.is_empty(), "无用量不应产生历史记录");
    }

    /// 差值记账的纯规则：只在余额下降时产生用量，其余一律 0。
    #[test]
    fn usage_delta_only_counts_balance_drops() {
        assert_eq!(usage_delta(None, 100.0), 0.0, "首次观测只建立基准");
        assert_eq!(usage_delta(Some(100.0), 90.0), 10.0);
        assert_eq!(usage_delta(Some(100.0), 200.0), 0.0, "充值不产生负用量");
        assert_eq!(usage_delta(Some(100.0), 100.0), 0.0, "余额不变不计用量");
    }

    /// 历史归档只保留最近 30 天，超出后删除最旧。
    #[test]
    fn history_is_trimmed_to_limit() {
        let mut ledger = ledger_on("2026-01-01", 100.0);
        for day in 1..=40 {
            ledger
                .history
                .insert(format!("2026-01-{:02}", day), day as f64);
        }
        // 触发一次跨天（无当日用量 → 不新增归档，仅执行裁剪）。
        apply_observation(&mut ledger, 100.0, "2026-02-20");

        assert_eq!(ledger.history.len(), HISTORY_LIMIT);
        assert!(
            !ledger.history.contains_key("2026-01-10"),
            "最旧的记录应被删除"
        );
        assert!(
            ledger.history.contains_key("2026-01-11"),
            "最近 30 天应完整保留"
        );
        assert!(ledger.history.contains_key("2026-01-40"));
    }
}
