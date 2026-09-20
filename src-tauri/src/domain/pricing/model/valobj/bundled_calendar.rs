//! 内置节假日兜底数据（离线基线）
//!
//! 定位：**只是兜底，不是主数据源**。正常运行路径是「本地缓存 → 第三方接口」，
//! 只有首次运行且接口全部不可用（断网、限流、接口下线）时才会用到这里的表，
//! 因此它随版本发布冻结，只保证发布时已知的年份。
//!
//! 维护方式：国务院办公厅公布新一年安排后追加一条年份记录即可；**不要**在这里
//! 做任何年份推算（推算出的假期必然错）。数据来源为历年国办发明电通知，
//! 与 `frontend/js/holiday-calendar.js` 无关（前端不再持有任何硬编码日历）。

use chrono::NaiveDate;

use super::holiday_calendar::{AdjustedWorkday, HolidayCalendar, HolidayRange};

/// 内置数据覆盖的年份。
pub const BUNDLED_YEARS: [i32; 3] = [2024, 2025, 2026];

/// 兜底数据来源标识。
pub const SOURCE_BUNDLED: &str = "bundled";

/// 解析内置字面量（编译期常量，必然合法）。
fn date(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").expect("内置节假日字面量必然合法")
}

/// 取某年的内置兜底日历；未收录的年份返回 `None`。
pub fn bundled_calendar(year: i32) -> Option<HolidayCalendar> {
    // 覆盖范围只以 [`BUNDLED_YEARS`] 为准，避免「常量说覆盖了、match 里其实没有」。
    if !BUNDLED_YEARS.contains(&year) {
        return None;
    }
    let (holidays, workdays): (Vec<(&str, &str, &str)>, Vec<(&str, &str)>) = match year {
        // 2024 年（国办发明电〔2023〕7 号）
        2024 => (
            vec![
                ("元旦", "2024-01-01", "2024-01-01"),
                ("春节", "2024-02-10", "2024-02-17"),
                ("清明节", "2024-04-04", "2024-04-06"),
                ("劳动节", "2024-05-01", "2024-05-05"),
                ("端午节", "2024-06-10", "2024-06-10"),
                ("中秋节", "2024-09-15", "2024-09-17"),
                ("国庆节", "2024-10-01", "2024-10-07"),
            ],
            vec![
                ("2024-02-04", "春节前补班"),
                ("2024-02-18", "春节后补班"),
                ("2024-04-07", "清明后补班"),
                ("2024-04-28", "劳动节前补班"),
                ("2024-05-11", "劳动节后补班"),
                ("2024-09-14", "中秋前补班"),
                ("2024-09-29", "国庆前补班"),
                ("2024-10-12", "国庆后补班"),
            ],
        ),
        // 2025 年（国办发明电〔2024〕12 号；中秋与国庆合并放假）
        2025 => (
            vec![
                ("元旦", "2025-01-01", "2025-01-01"),
                ("春节", "2025-01-28", "2025-02-04"),
                ("清明节", "2025-04-04", "2025-04-06"),
                ("劳动节", "2025-05-01", "2025-05-05"),
                ("端午节", "2025-05-31", "2025-06-02"),
                ("国庆节·中秋节", "2025-10-01", "2025-10-08"),
            ],
            vec![
                ("2025-01-26", "春节前补班"),
                ("2025-02-08", "春节后补班"),
                ("2025-04-27", "劳动节前补班"),
                ("2025-09-28", "国庆前补班"),
                ("2025-10-11", "国庆后补班"),
            ],
        ),
        // 2026 年（国办发明电〔2025〕7 号）
        2026 => (
            vec![
                ("元旦", "2026-01-01", "2026-01-03"),
                ("春节", "2026-02-15", "2026-02-23"),
                ("清明节", "2026-04-04", "2026-04-06"),
                ("劳动节", "2026-05-01", "2026-05-05"),
                ("端午节", "2026-06-19", "2026-06-21"),
                ("中秋节", "2026-09-25", "2026-09-27"),
                ("国庆节", "2026-10-01", "2026-10-07"),
            ],
            vec![
                ("2026-01-04", "元旦后补班"),
                ("2026-02-14", "春节前补班"),
                ("2026-02-28", "春节后补班"),
                ("2026-05-09", "劳动节后补班"),
                ("2026-09-20", "国庆前补班"),
                ("2026-10-10", "国庆后补班"),
            ],
        ),
        _ => return None,
    };

    Some(HolidayCalendar::new(
        year,
        SOURCE_BUNDLED,
        0,
        holidays
            .into_iter()
            .map(|(name, begin, end)| HolidayRange::new(name, date(begin), date(end)))
            .collect(),
        workdays
            .into_iter()
            .map(|(day, name)| AdjustedWorkday::new(date(day), name))
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::enums::DateKind;
    use chrono::Datelike;

    /// 内置表必须完整（否则一旦离线就会退化成「全年都是工作日」）。
    #[test]
    fn every_bundled_year_is_complete() {
        for year in BUNDLED_YEARS {
            let calendar = bundled_calendar(year).expect("内置年份必须有数据");
            assert!(calendar.is_complete(), "{} 年内置数据不完整", year);
            assert!(
                !calendar.is_fresh(2_000_000_000, year),
                "内置数据没有抓取时间，必须永远被视为待刷新"
            );
            // 补班日必须落在周末（否则说明表里写错了日子）。
            for day in &calendar.adjusted_workdays {
                assert!(
                    matches!(
                        day.date.weekday(),
                        chrono::Weekday::Sat | chrono::Weekday::Sun
                    ),
                    "{} {} 不是周末，不可能是调休上班日",
                    year,
                    day.date
                );
            }
            // 补班日不得落在放假区间内。
            for day in &calendar.adjusted_workdays {
                assert!(
                    !calendar.is_holiday(day.date),
                    "{} 同时被标为放假与补班",
                    day.date
                );
            }
        }
        assert!(bundled_calendar(2023).is_none(), "未收录年份返回 None");
    }

    /// 官方通知的关键日期逐条核对（内置表是离线时的唯一依据，不能错）。
    #[test]
    fn bundled_days_match_official_notices() {
        let cases: [(i32, &str, DateKind); 12] = [
            // 2024：春节 2/10 起放假，2/4 与 2/18 补班，除夕 2/9 不放假。
            (2024, "2024-02-09", DateKind::Workday),
            (2024, "2024-02-10", DateKind::Holiday),
            (2024, "2024-02-18", DateKind::AdjustedWorkday),
            // 2025：春节 1/28（除夕）起放假，1/26 补班，10/1–10/8 合并放假。
            (2025, "2025-01-26", DateKind::AdjustedWorkday),
            (2025, "2025-01-28", DateKind::Holiday),
            (2025, "2025-10-08", DateKind::Holiday),
            // 2026：元旦 1/1–1/3 放假、1/4 补班；春节 2/15–2/23；国庆 9/20 与 10/10 补班。
            (2026, "2026-01-04", DateKind::AdjustedWorkday),
            (2026, "2026-01-05", DateKind::Workday),
            (2026, "2026-02-14", DateKind::AdjustedWorkday),
            (2026, "2026-02-23", DateKind::Holiday),
            (2026, "2026-09-20", DateKind::AdjustedWorkday),
            (2026, "2026-10-10", DateKind::AdjustedWorkday),
        ];
        for (year, text, want) in cases {
            let calendar = bundled_calendar(year).expect("内置年份必须有数据");
            let day = date(text);
            assert_eq!(calendar.kind_of(day), want, "{} 的日期类型不符", text);
        }
    }

    /// 补班日不得享有高峰段（本次口径修正的核心）。
    #[test]
    fn bundled_adjusted_workdays_are_off_peak_days() {
        for year in BUNDLED_YEARS {
            let calendar = bundled_calendar(year).unwrap();
            for day in &calendar.adjusted_workdays {
                assert!(
                    !calendar.has_peak_hours(day.date),
                    "{} 的补班日 {} 属于谷价时段",
                    year,
                    day.date
                );
            }
        }
    }
}
