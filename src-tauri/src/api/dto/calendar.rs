//! 峰谷日历的线缆 DTO（camelCase）
//!
//! 前端拿到的是**展开后的日期集合**（`holidays` / `adjustedWorkdays`），
//! 这样每秒倒计时判定只需要一次 O(1) 查表，不必在 JS 里再实现一遍区间逻辑。

use serde::Serialize;

use crate::application::pricing::result::{CalendarRefresh, CalendarView, HolidayRangeView};

/// 一段放假区间（展示用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayRangeDto {
    /// 节日名。
    pub name: String,
    /// 放假首日（`YYYY-MM-DD`）。
    pub begin: String,
    /// 放假末日（`YYYY-MM-DD`）。
    pub end: String,
}

impl From<HolidayRangeView> for HolidayRangeDto {
    fn from(view: HolidayRangeView) -> Self {
        Self {
            name: view.name,
            begin: view.begin,
            end: view.end,
        }
    }
}

/// 某一年节假日日历。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayCalendarDto {
    /// 年份。
    pub year: i32,
    /// 国家/地区代码。
    pub country: String,
    /// 数据来源：`free:<源名>`（内置免费源）/ `bundled`（内置兜底）/ `none`。
    pub source: String,
    /// 抓取时间（epoch 秒；0 表示内置兜底）。
    pub fetched_at: i64,
    /// 数据是否完整。
    pub complete: bool,
    /// 缓存是否新鲜（新鲜时不会触发接口请求）。
    pub fresh: bool,
    /// 放假日期（`YYYY-MM-DD`，升序）。
    pub holidays: Vec<String>,
    /// 调休上班日（`YYYY-MM-DD`，升序）。
    pub adjusted_workdays: Vec<String>,
    /// 放假区间（含节日名）。
    pub ranges: Vec<HolidayRangeDto>,
}

impl From<CalendarView> for HolidayCalendarDto {
    fn from(view: CalendarView) -> Self {
        Self {
            year: view.year,
            country: view.country,
            source: view.source,
            fetched_at: view.fetched_at,
            complete: view.complete,
            fresh: view.fresh,
            holidays: view.holidays,
            adjusted_workdays: view.adjusted_workdays,
            ranges: view.ranges.into_iter().map(HolidayRangeDto::from).collect(),
        }
    }
}

/// 「确保已有该年数据」的结果（含是否真的联网、失败原因）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayRefreshDto {
    /// 当前可用的日历。
    pub calendar: HolidayCalendarDto,
    /// 本次是否调用了第三方接口。
    pub fetched: bool,
    /// 结果说明：`cache` / `fetched` / `throttled` / `failed:<原因>`。
    pub outcome: String,
    /// 服务端当前年份（前端据此判断是否需要准备次年数据）。
    pub current_year: i32,
}

impl HolidayRefreshDto {
    /// 由用例结果构建。
    pub fn from_refresh(refresh: CalendarRefresh, current_year: i32) -> Self {
        Self {
            calendar: HolidayCalendarDto::from(refresh.view),
            fetched: refresh.fetched,
            outcome: refresh.outcome,
            current_year,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::pricing::model::valobj::bundled_calendar::bundled_calendar;

    /// 字段名是前端契约（camelCase）。
    #[test]
    fn dto_is_camel_case() {
        let view = CalendarView::from_calendar(&bundled_calendar(2026).unwrap(), true);
        let dto = HolidayCalendarDto::from(view);
        let json = serde_json::to_string(&dto).unwrap();
        for key in [
            "\"year\"",
            "\"country\"",
            "\"source\"",
            "\"fetchedAt\"",
            "\"complete\"",
            "\"fresh\"",
            "\"holidays\"",
            "\"adjustedWorkdays\"",
            "\"ranges\"",
        ] {
            assert!(json.contains(key), "缺少字段 {}：{}", key, json);
        }

        let refresh = HolidayRefreshDto::from_refresh(
            CalendarRefresh {
                view: CalendarView::from_calendar(&bundled_calendar(2026).unwrap(), false),
                fetched: true,
                outcome: "fetched".to_string(),
            },
            2026,
        );
        let json = serde_json::to_string(&refresh).unwrap();
        for key in ["\"calendar\"", "\"fetched\"", "\"outcome\"", "\"currentYear\""] {
            assert!(json.contains(key), "缺少字段 {}：{}", key, json);
        }
    }
}
