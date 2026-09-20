//! 峰谷时段定价规则
//!
//! # 规则
//!
//! 高峰时段为**北京时间** 09:00–12:00 与 14:00–18:00，且只有「高峰日」才有这两个
//! 时段；其余时刻一律谷价。高峰日的口径见
//! [`DateKind::has_peak_hours`](crate::types::enums::DateKind::has_peak_hours)：
//!
//! - 周一至周五、且不在法定节假日放假区间内 → 高峰日；
//! - 法定节假日（即便落在周一至周五）→ 全天谷价；
//! - 周六日（**包括被调休为上班日的周六日**）→ 全天谷价。
//!
//! 判定只依赖「时间戳 + 该年的节假日日历」，日历由调用方按年份取好：
//! 领域层不认识缓存、接口或内置兜底，见 `holiday_service`。

use chrono::{NaiveDate, Timelike};

use crate::domain::pricing::model::valobj::holiday_calendar::weekday_kind;
use crate::domain::pricing::model::valobj::holiday_calendar::HolidayCalendar;
use crate::types::enums::PeakPeriod;

/// 高峰时段（北京时间，小时区间左闭右开）。
const PEAK_HOURS: [(u32, u32); 2] = [(9, 12), (14, 18)];

/// 北京时间相对 UTC 的偏移秒数。
const BEIJING_OFFSET_SECONDS: i32 = 8 * 3600;

/// 把 epoch 秒转换为北京时间。
pub fn beijing_time(time_sec: i64) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    let offset = chrono::FixedOffset::east_opt(BEIJING_OFFSET_SECONDS)
        .unwrap_or_else(|| chrono::FixedOffset::east_opt(0).expect("零偏移必然可用"));
    chrono::DateTime::<chrono::Utc>::from_timestamp(time_sec, 0).map(|t| t.with_timezone(&offset))
}

/// 给定 epoch 秒所处的峰谷时段（不依赖系统时区）。
///
/// `calendar` 必须是**该时间戳所在年份**的日历；若拿到的日历年份不匹配
/// （跨年期间的边界情形），则退化为纯自然周规则，避免用错年份的放假表。
pub fn peak_period_of(time_sec: i64, calendar: &HolidayCalendar) -> PeakPeriod {
    let Some(beijing) = beijing_time(time_sec) else {
        return PeakPeriod::Off;
    };
    let date = beijing.date_naive();
    if !has_peak_hours(date, calendar) {
        return PeakPeriod::Off;
    }
    let hour = beijing.hour();
    if PEAK_HOURS
        .iter()
        .any(|(start, end)| hour >= *start && hour < *end)
    {
        PeakPeriod::Peak
    } else {
        PeakPeriod::Off
    }
}

/// 给定 epoch 秒是否处于高峰时段。
pub fn is_peak_time(time_sec: i64, calendar: &HolidayCalendar) -> bool {
    peak_period_of(time_sec, calendar).is_peak()
}

/// 该日期是否适用高峰时段（日历年份不匹配时退回自然周规则）。
pub fn has_peak_hours(date: NaiveDate, calendar: &HolidayCalendar) -> bool {
    if calendar.covers(date) {
        calendar.has_peak_hours(date)
    } else {
        weekday_kind(date).has_peak_hours()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::pricing::model::valobj::bundled_calendar::bundled_calendar;

    /// 构造北京时间对应的时间戳（避免测试依赖运行机器的时区）。
    fn beijing_ts(rfc3339: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .expect("测试用时间字面量应合法")
            .timestamp()
    }

    fn calendar_2026() -> HolidayCalendar {
        bundled_calendar(2026).expect("内置必须覆盖 2026")
    }

    /// 普通工作日的高峰窗口边界（12:00 / 14:00 / 18:00 均为右开边界）。
    #[test]
    fn workday_peak_window_boundaries() {
        let cal = calendar_2026();
        // 2026-09-15 是周二。
        assert!(!is_peak_time(beijing_ts("2026-09-15T08:59:59+08:00"), &cal));
        assert!(is_peak_time(beijing_ts("2026-09-15T09:00:00+08:00"), &cal));
        assert!(is_peak_time(beijing_ts("2026-09-15T11:59:59+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2026-09-15T12:00:00+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2026-09-15T13:59:59+08:00"), &cal));
        assert!(is_peak_time(beijing_ts("2026-09-15T14:00:00+08:00"), &cal));
        assert!(is_peak_time(beijing_ts("2026-09-15T17:59:59+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2026-09-15T18:00:00+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2026-09-15T23:30:00+08:00"), &cal));
    }

    /// 周六日全天谷价 —— **包括被调休为上班日的周六日**（本次口径修正）。
    #[test]
    fn weekends_are_off_peak_even_when_adjusted_to_workdays() {
        let cal = calendar_2026();
        // 2026-09-19 周六、2026-09-13 周日（未调休）。
        assert!(!is_peak_time(beijing_ts("2026-09-19T10:00:00+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2026-09-13T15:00:00+08:00"), &cal));
        // 2026-09-20 周日、2026-10-10 周六：官方调休上班日，仍按谷价计。
        assert!(!is_peak_time(beijing_ts("2026-09-20T10:00:00+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2026-09-20T15:00:00+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2026-10-10T17:00:00+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2026-02-14T09:30:00+08:00"), &cal));
    }

    /// 法定节假日放假区间内全天谷价，节前节后工作日立即恢复。
    #[test]
    fn holidays_are_off_peak() {
        let cal = calendar_2026();
        assert!(!is_peak_time(beijing_ts("2026-02-15T09:00:00+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2026-02-16T10:00:00+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2026-02-18T15:00:00+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2026-02-23T14:30:00+08:00"), &cal));
        assert!(is_peak_time(beijing_ts("2026-02-13T09:00:00+08:00"), &cal));
        assert!(is_peak_time(beijing_ts("2026-02-24T09:00:00+08:00"), &cal));
        // 国庆假期中的周一（10-05）同样谷价。
        assert!(!is_peak_time(beijing_ts("2026-10-05T10:00:00+08:00"), &cal));
    }

    /// 判定与运行机器的系统时区无关：同一时刻在不同本地时区下都按北京时间算。
    #[test]
    fn judgement_is_beijing_based_not_local() {
        let cal = calendar_2026();
        let ts = beijing_ts("2026-09-15T10:00:00+08:00");
        assert!(is_peak_time(ts, &cal));
        let utc = chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0).unwrap();
        assert_eq!(utc.format("%H").to_string(), "02", "北京 10:00 = UTC 02:00");
        assert!(is_peak_time(utc.timestamp(), &cal));
    }

    /// 非法时间戳不 panic，按谷价处理。
    #[test]
    fn invalid_timestamp_falls_back_to_off() {
        let cal = calendar_2026();
        assert_eq!(peak_period_of(i64::MAX, &cal), PeakPeriod::Off);
        assert_eq!(peak_period_of(i64::MIN, &cal), PeakPeriod::Off);
    }

    /// 日历年份不匹配时退化为纯自然周规则（跨年边界不许用错放假表）。
    #[test]
    fn mismatched_calendar_falls_back_to_weekday_rule() {
        let cal = calendar_2026();
        // 用 2026 的日历判定 2027 的日期：周二仍为高峰，周六仍为谷。
        assert!(is_peak_time(beijing_ts("2027-03-02T10:00:00+08:00"), &cal));
        assert!(!is_peak_time(beijing_ts("2027-03-06T10:00:00+08:00"), &cal));
    }

    /// 高峰钟点常量：口径唯一（前端只做同一套常量的本地推算）。
    #[test]
    fn peak_hours_are_stable() {
        assert_eq!(PEAK_HOURS, [(9, 12), (14, 18)]);
        // 12 与 18 是右开端点，9 与 14 是左闭端点。
        let (start, end) = PEAK_HOURS[0];
        assert_eq!((start, end), (9, 12));
    }
}
