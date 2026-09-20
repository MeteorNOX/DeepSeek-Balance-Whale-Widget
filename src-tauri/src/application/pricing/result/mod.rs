//! pricing 用例的出入参对象
//!
//! 只放轻量数据结构，不承载业务逻辑：`service` 负责编排，`result` 只描述结果。

use crate::domain::pricing::model::valobj::holiday_calendar::HolidayCalendar;

/// 一段放假区间的展示信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HolidayRangeView {
    /// 节日名。
    pub name: String,
    /// 放假首日（`YYYY-MM-DD`）。
    pub begin: String,
    /// 放假末日（`YYYY-MM-DD`）。
    pub end: String,
}

/// 某一年节假日日历的对外视图（前端按日期集合判定峰谷）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarView {
    /// 年份。
    pub year: i32,
    /// 国家/地区代码。
    pub country: String,
    /// 数据来源：`free:<源名>`（内置免费源）/ `bundled`（内置兜底）/ `none`。
    pub source: String,
    /// 抓取时间（epoch 秒；0 表示内置兜底）。
    pub fetched_at: i64,
    /// 数据是否完整（残缺数据仍可用于判定，但会被标记出来）。
    pub complete: bool,
    /// 缓存是否仍然新鲜（新鲜则不会触发接口请求）。
    pub fresh: bool,
    /// 放假日期（`YYYY-MM-DD`，已展开区间，升序）。
    pub holidays: Vec<String>,
    /// 调休上班日（`YYYY-MM-DD`，升序）。
    pub adjusted_workdays: Vec<String>,
    /// 放假区间（含节日名，供界面与调试查看；判定只用到 `holidays` / `adjusted_workdays`）。
    pub ranges: Vec<HolidayRangeView>,
}

impl CalendarView {
    /// 由领域日历构建视图；`fresh` 由调用方按当前时间判定后传入。
    pub fn from_calendar(calendar: &HolidayCalendar, fresh: bool) -> Self {
        Self {
            year: calendar.year,
            country: calendar.country.clone(),
            source: calendar.source.clone(),
            fetched_at: calendar.fetched_at,
            complete: calendar.is_complete(),
            fresh,
            holidays: calendar
                .holiday_dates()
                .into_iter()
                .map(|date| date.format("%Y-%m-%d").to_string())
                .collect(),
            adjusted_workdays: calendar
                .adjusted_workdays
                .iter()
                .map(|day| day.date.format("%Y-%m-%d").to_string())
                .collect(),
            ranges: calendar
                .holidays
                .iter()
                .map(|range| HolidayRangeView {
                    name: range.name.clone(),
                    begin: range.begin.format("%Y-%m-%d").to_string(),
                    end: range.end.format("%Y-%m-%d").to_string(),
                })
                .collect(),
        }
    }
}

/// 一次「确保已有该年数据」的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarRefresh {
    /// 最终可用的日历视图。
    pub view: CalendarView,
    /// 本次是否真的调用了第三方接口。
    pub fetched: bool,
    /// 说明：`cache`（命中缓存）/ `fetched`（已拉取）/ `failed:<原因>`（拉取失败，回退到旧数据）。
    pub outcome: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::pricing::model::valobj::bundled_calendar::bundled_calendar;

    /// 视图必须把「区间」展开成逐日集合（前端按日期判定，避免重复实现区间逻辑）。
    #[test]
    fn view_expands_ranges_and_lists_workdays() {
        let calendar = bundled_calendar(2026).unwrap();
        let view = CalendarView::from_calendar(&calendar, true);
        assert_eq!(view.year, 2026);
        assert_eq!(view.country, "CN");
        assert!(view.complete && view.fresh);
        assert_eq!(view.holidays.len(), 33);
        assert_eq!(view.holidays[0], "2026-01-01");
        assert!(view.holidays.contains(&"2026-02-23".to_string()));
        assert_eq!(view.adjusted_workdays.len(), 6);
        assert!(view.adjusted_workdays.contains(&"2026-09-20".to_string()));
        assert_eq!(view.ranges.len(), 7);
        assert_eq!(view.ranges[1].name, "春节");
        assert_eq!(view.ranges[1].begin, "2026-02-15");
    }
}
