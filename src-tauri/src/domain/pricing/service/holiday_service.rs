//! 节假日日历装配规则（领域规则，纯计算）
//!
//! 回答两个问题，两个问题都不碰 IO：
//! 1. **手上这份日历够不够用**——[`usable_calendar`]：缓存 → 内置兜底 → 空白；
//! 2. **要不要去拉最新的**——[`needs_refresh`]：缓存缺失、过期或残缺时为真。
//!
//! 第三方接口每晚只该被调用极少次数，因此这里的判断必须确定且可测。

use crate::domain::pricing::model::valobj::bundled_calendar::bundled_calendar;
use crate::domain::pricing::model::valobj::holiday_calendar::HolidayCalendar;

/// 同步判定用日历：本地缓存 → 内置兜底 → 空白日历。
///
/// 峰谷判定（每秒钟都在跑）绝不能等网络，因此这里只做「手上有什么就用什么」：
/// - 缓存里有这一年的数据（哪怕已过期或不完整）→ 直接用，总比没有强；
/// - 否则用内置兜底（覆盖发布时的年份）；
/// - 都没有则返回空白日历，判定退化为纯自然周规则。
pub fn usable_calendar(year: i32, cached: Option<HolidayCalendar>) -> HolidayCalendar {
    match cached {
        Some(calendar) if calendar.has_data() => calendar,
        _ => bundled_calendar(year).unwrap_or_else(|| HolidayCalendar::empty(year, "none")),
    }
}

/// 是否需要向第三方接口拉取该年份的数据。
///
/// 满足以下任一条即需要刷新，否则直接复用缓存（这是「缓存优先、接口按需」的全部规则）：
/// - 没有缓存；
/// - 缓存数据不完整（残缺的年度安排会算错峰谷）；
/// - 缓存已过期（当前年 30 天、未来年 7 天、历史年永久，见 [`HolidayCalendar::is_fresh`]）。
pub fn needs_refresh(cached: Option<&HolidayCalendar>, current_year: i32, now_sec: i64) -> bool {
    match cached {
        Some(calendar) => !calendar.is_fresh(now_sec, current_year),
        None => true,
    }
}

/// 需要预先准备好的年份：当前年与下一年。
///
/// - 当前年：判定今天的峰谷要用；
/// - 下一年：跨年倒计时（如 12 月 31 日 18:00 找下一个高峰）要用。
pub fn years_to_prepare(current_year: i32) -> [i32; 2] {
    [current_year, current_year + 1]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::pricing::model::valobj::bundled_calendar::SOURCE_BUNDLED;
    use crate::domain::pricing::model::valobj::holiday_calendar::{
        HolidayRange, TTL_CURRENT_YEAR_SEC,
    };
    use chrono::NaiveDate;

    fn date(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    /// 有缓存就用缓存（即使过期），没有才用内置兜底，都没有才空白。
    #[test]
    fn usable_calendar_prefers_cache_then_bundled() {
        let mut cached = bundled_calendar(2026).unwrap();
        cached.source = "free:test".to_string();
        let picked = usable_calendar(2026, Some(cached.clone()));
        assert_eq!(picked.source, "free:test", "有缓存必须优先用缓存");

        // 空缓存（有文件但没数据）视为没有缓存。
        let empty = HolidayCalendar::empty(2026, "free:test");
        let fallback = usable_calendar(2026, Some(empty));
        assert_eq!(fallback.source, SOURCE_BUNDLED, "空缓存应回落到内置兜底");

        // 未收录的年份：空白日历，判定退化为自然周规则。
        let unknown = usable_calendar(2035, None);
        assert_eq!(unknown.source, "none");
        assert!(!unknown.has_data());
        assert!(unknown.has_peak_hours(date("2035-03-06")), "周三仍有高峰");
        assert!(!unknown.has_peak_hours(date("2035-03-10")), "周六无高峰");
    }

    /// 刷新判定：缺失 / 残缺 / 过期都要拉，完整且新鲜则复用自己的缓存。
    #[test]
    fn refresh_only_when_missing_incomplete_or_stale() {
        let now = 1_780_000_000;
        let mut cached = bundled_calendar(2026).unwrap();
        cached.fetched_at = now;

        assert!(needs_refresh(None, 2026, now), "没有缓存必须拉取");
        assert!(
            !needs_refresh(Some(&cached), 2026, now),
            "完整且未过期时不应打扰接口"
        );
        assert!(
            needs_refresh(Some(&cached), 2026, now + TTL_CURRENT_YEAR_SEC),
            "超过 TTL 必须刷新"
        );

        // 残缺数据：即便刚抓过也要重拉。
        let partial = HolidayCalendar::new(
            2026,
            "free:test",
            now,
            vec![HolidayRange::new(
                "元旦",
                date("2026-01-01"),
                date("2026-01-03"),
            )],
            Vec::new(),
        );
        assert!(!partial.is_complete());
        assert!(
            needs_refresh(Some(&partial), 2026, now),
            "残缺数据必须重新拉取"
        );

        // 历史年份：完整且永不过期 → 不再请求接口。
        let mut past = bundled_calendar(2024).unwrap();
        past.fetched_at = now;
        assert!(!needs_refresh(
            Some(&past),
            2026,
            now + 10 * 365 * 86_400
        ));
    }

    /// 需要准备的年份恒为「当前年 + 次年」。
    #[test]
    fn prepares_current_and_next_year() {
        assert_eq!(years_to_prepare(2026), [2026, 2027]);
    }
}
