//! 峰谷日历用例（编排）
//!
//! 三件事：
//! 1. [`calendar_for`]：**同步**取某年的日历，供每秒都在跑的峰谷判定使用（绝不联网）；
//! 2. [`ensure_year`]：按需拉取并写缓存 —— 缓存缺失 / 过期 / 残缺时才调用第三方接口；
//! 3. [`ensure_years_around`]：启动与跨年时准备好「当前年 + 次年」。
//!
//! 缓存与接口都在 `domain::pricing::repository` 的端口后面，本层只做编排与节流：
//! 同一个进程内，某年数据拉取失败后 10 分钟内不再重试，避免把免费接口打成限流。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::application::pricing::result::{CalendarRefresh, CalendarView};
use crate::application::registry;
use crate::domain::pricing::model::valobj::holiday_calendar::HolidayCalendar;
use crate::domain::pricing::service::{holiday_service, pricing_service};
use crate::types::exception::AppResult;

/// 同一年的最小重试间隔（秒）：失败之后不要反复打扰免费接口。
const MIN_RETRY_INTERVAL_SEC: i64 = 600;

/// 进程内「上次尝试拉取」的时间表（`year -> epoch 秒`）。
fn attempts() -> &'static Mutex<HashMap<i32, i64>> {
    static CELL: OnceLock<Mutex<HashMap<i32, i64>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 当前 epoch 秒。
fn now_sec() -> i64 {
    chrono::Utc::now().timestamp()
}

/// 当前北京时间的年份。
pub fn current_year() -> i32 {
    pricing_service::beijing_time(now_sec())
        .map(|t| chrono::Datelike::year(&t))
        .unwrap_or(1970)
}

/// 同步取某年的日历：缓存 → 内置兜底 → 空白（不退化为联网）。
pub fn calendar_for(year: i32) -> HolidayCalendar {
    let cached = registry::holiday_store().read_year(year);
    holiday_service::usable_calendar(year, cached)
}

/// 当前时刻是否处于高峰时段。
pub fn is_peak_now() -> bool {
    pricing_service::is_peak_time(now_sec(), &calendar_for(current_year()))
}

/// 同步取某年的日历视图（不触发任何网络请求）。
pub fn view_for(year: i32) -> CalendarView {
    let calendar = calendar_for(year);
    let fresh = calendar.is_fresh(now_sec(), current_year());
    CalendarView::from_calendar(&calendar, fresh)
}

/// 按需准备某年数据：新鲜就直接用缓存，否则拉取并写缓存。
///
/// 失败**不会**返回 Err：调用方（判定链路）永远应该拿到「能用的日历」，
/// 拉取失败的原因通过 [`CalendarRefresh::outcome`] 记录（日志与排查用）。
pub async fn ensure_year(year: i32) -> CalendarRefresh {
    let cached = registry::holiday_store().read_year(year);
    let today = current_year();
    let now = now_sec();

    if !holiday_service::needs_refresh(cached.as_ref(), today, now) {
        let calendar = holiday_service::usable_calendar(year, cached);
        return CalendarRefresh {
            view: CalendarView::from_calendar(&calendar, true),
            fetched: false,
            outcome: "cache".to_string(),
        };
    }

    // 节流：同一年在最小重试间隔内不重复请求接口。
    if throttled(year, now) {
        let calendar = holiday_service::usable_calendar(year, cached);
        return CalendarRefresh {
            view: CalendarView::from_calendar(&calendar, false),
            fetched: false,
            outcome: "throttled".to_string(),
        };
    }

    match fetch_and_store(year).await {
        Ok(calendar) => CalendarRefresh {
            view: CalendarView::from_calendar(&calendar, true),
            fetched: true,
            outcome: "fetched".to_string(),
        },
        Err(err) => {
            record_attempt(year, now);
            let calendar = holiday_service::usable_calendar(year, cached);
            CalendarRefresh {
                view: CalendarView::from_calendar(&calendar, false),
                fetched: false,
                outcome: format!("failed:{}", err.message()),
            }
        }
    }
}

/// 准备「当前年 + 次年」两年的数据（跨年倒计时需要次年的安排）。
pub async fn ensure_years_around() -> Vec<CalendarRefresh> {
    let year = current_year();
    let mut out = Vec::new();
    for target in holiday_service::years_to_prepare(year) {
        out.push(ensure_year(target).await);
    }
    out
}

/// 拉取某年数据并写入缓存。
async fn fetch_and_store(year: i32) -> AppResult<HolidayCalendar> {
    let calendar = registry::holiday_source().fetch_year(year).await?;
    record_attempt(year, now_sec());
    // 缓存写失败不影响本次判定，只记日志（下次仍会重新拉取）。
    if let Err(err) = registry::holiday_store().write_year(&calendar) {
        log::warn!("写入节假日缓存失败（不影响本次判定）：{}", err.message());
    } else {
        log::info!(
            "已更新 {} 年节假日缓存：来源 {}，{} 个假期段 / {} 个补班日",
            year,
            calendar.source,
            calendar.cluster_count(),
            calendar.adjusted_workdays.len()
        );
    }
    Ok(calendar)
}

/// 是否处于重试冷却期。
fn throttled(year: i32, now: i64) -> bool {
    let table = attempts().lock().unwrap_or_else(|e| e.into_inner());
    match table.get(&year) {
        Some(last) => now.saturating_sub(*last) < MIN_RETRY_INTERVAL_SEC,
        None => false,
    }
}

/// 记录一次拉取尝试（失败也记，用于节流）。
fn record_attempt(year: i32, now: i64) {
    let mut table = attempts().lock().unwrap_or_else(|e| e.into_inner());
    table.insert(year, now);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同步视图不联网、不 panic，且必然拿到一份可用日历。
    #[test]
    fn view_for_always_returns_usable_calendar() {
        let view = view_for(2026);
        assert_eq!(view.year, 2026);
        assert!(!view.source.is_empty());
        // 2026 年要么来自缓存（真实运行过），要么来自内置兜底，两者都必须完整。
        assert!(view.complete, "2026 年数据必须完整：{:?}", view.source);
        assert!(view.holidays.contains(&"2026-02-17".to_string()));

        // 未收录且无缓存的年份：空白日历（判定退化为自然周规则），不得 panic。
        let unknown = view_for(1999);
        assert!(unknown.holidays.is_empty());
        assert!(!unknown.complete);
    }

    /// 峰谷判定链路：只读缓存/兜底，不产生任何网络请求。
    #[test]
    fn peak_judgement_uses_local_calendar_only() {
        let year = current_year();
        let calendar = calendar_for(year);
        let now = now_sec();
        // 同一次调用内结果稳定（纯计算）。
        assert_eq!(
            pricing_service::is_peak_time(now, &calendar),
            pricing_service::is_peak_time(now, &calendar)
        );
        assert_eq!(is_peak_now(), pricing_service::is_peak_time(now, &calendar));
    }

    /// 节流表：记录后进入冷却期。
    #[test]
    fn attempts_are_throttled() {
        let year = 2999;
        assert!(!throttled(year, now_sec()));
        record_attempt(year, now_sec());
        assert!(throttled(year, now_sec()));
        assert!(!throttled(year, now_sec() + MIN_RETRY_INTERVAL_SEC + 1));
        attempts()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&year);
    }

}
