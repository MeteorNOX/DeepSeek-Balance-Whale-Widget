//! 节假日日历值对象
//!
//! 主题：把「某一年有哪些法定节假日、有哪些调休补班日」沉淀成一个可直接参与
//! 峰谷判定的值对象 —— 峰谷规则只依赖它，不关心数据来自缓存、内置兜底还是
//! 第三方接口。
//!
//! 三种日期信息的关系：
//! - `holidays`：法定节假日**放假区间**（可含节名，首尾按自然日闭区间）；
//! - `adjusted_workdays`：调休**上班日**（原本是周六日的补班日）；
//! - 两者之外的日期按自然周判定（周一至周五 / 周末）。
//!
//! 峰谷计价只关心「这一天是否适用高峰」，见 [`HolidayCalendar::has_peak_hours`]。

use chrono::{Datelike, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};

use crate::types::enums::DateKind;

/// 放假区间的最小天数（单日假期如「元旦」）。
const MIN_RANGE_DAYS: i64 = 1;

/// 当前年份缓存的存活时长：国务院通知一年内不会变，30 天足够且能吸收偶发修订。
pub const TTL_CURRENT_YEAR_SEC: i64 = 30 * 24 * 3600;

/// 未来年份缓存的存活时长：次年安排通常在上一年 11 月才公布，短 TTL 便于尽快补齐。
pub const TTL_FUTURE_YEAR_SEC: i64 = 7 * 24 * 3600;

/// 完整性下限：放假区间簇数（CN 通常 6–7 簇，2025 年中秋与国庆合并故为 6）。
pub const MIN_CLUSTERS: usize = 6;

/// 完整性下限：全年放假总天数（CN 近年为 27–33 天，取 20 作为「明显残缺」的门槛）。
pub const MIN_HOLIDAY_DAYS: usize = 20;

/// 一段法定节假日放假区间（含首尾）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HolidayRange {
    /// 节日名（如「春节」），仅用于展示与排查，可为空串。
    #[serde(default)]
    pub name: String,
    /// 放假首日（北京时间自然日）。
    pub begin: NaiveDate,
    /// 放假末日（含当天）。
    pub end: NaiveDate,
}

impl HolidayRange {
    /// 构造一段放假区间（首尾颠倒时自动纠正）。
    pub fn new(name: impl Into<String>, begin: NaiveDate, end: NaiveDate) -> Self {
        let (begin, end) = if begin <= end { (begin, end) } else { (end, begin) };
        Self {
            name: name.into(),
            begin,
            end,
        }
    }

    /// 本区间的天数（含首尾）。
    pub fn days(&self) -> i64 {
        (self.end - self.begin).num_days() + 1
    }

    /// 是否包含该日期。
    pub fn contains(&self, date: NaiveDate) -> bool {
        date >= self.begin && date <= self.end
    }

    /// 区间是否合法（非空且不小于最小天数）。
    pub fn is_valid(&self) -> bool {
        self.days() >= MIN_RANGE_DAYS
    }
}

/// 调休上班日（原本是周六日的补班日）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdjustedWorkday {
    /// 补班日期（北京时间自然日）。
    pub date: NaiveDate,
    /// 说明（如「春节前补班」），可为空串。
    #[serde(default)]
    pub name: String,
}

impl AdjustedWorkday {
    /// 构造一个调休上班日。
    pub fn new(date: NaiveDate, name: impl Into<String>) -> Self {
        Self {
            date,
            name: name.into(),
        }
    }
}

/// 一个国家/地区某一年的节假日日历。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct HolidayCalendar {
    /// 国家/地区代码（当前固定 `CN`）。
    #[serde(default = "default_country")]
    pub country: String,
    /// 年份。
    pub year: i32,
    /// 数据来源标识：`free:<源名>`（内置免费源）/ `bundled`（内置兜底）/ `none`。
    #[serde(default)]
    pub source: String,
    /// 抓取时间（epoch 秒；内置兜底为 0，表示「从未抓取过」）。
    #[serde(default)]
    pub fetched_at: i64,
    /// 放假区间（按首日升序，构造时归一化）。
    #[serde(default)]
    pub holidays: Vec<HolidayRange>,
    /// 调休上班日（按日期升序）。
    #[serde(default)]
    pub adjusted_workdays: Vec<AdjustedWorkday>,
}

/// 国家代码默认值（老缓存文件缺字段时兜底）。
fn default_country() -> String {
    "CN".to_string()
}

impl HolidayCalendar {
    /// 用原始数据构造：排序、去重、纠正非法区间。
    pub fn new(
        year: i32,
        source: impl Into<String>,
        fetched_at: i64,
        holidays: Vec<HolidayRange>,
        adjusted_workdays: Vec<AdjustedWorkday>,
    ) -> Self {
        let mut calendar = Self {
            country: default_country(),
            year,
            source: source.into(),
            fetched_at,
            holidays,
            adjusted_workdays,
        };
        calendar.normalize();
        calendar
    }

    /// 空白日历（该年没有任何数据，峰谷判定退化为纯自然周规则）。
    pub fn empty(year: i32, source: impl Into<String>) -> Self {
        Self::new(year, source, 0, Vec::new(), Vec::new())
    }

    /// 排序、去重、丢弃非法区间（接口偶发脏数据不该污染判定）。
    pub fn normalize(&mut self) {
        self.holidays.retain(HolidayRange::is_valid);
        self.holidays
            .sort_by(|a, b| (a.begin, a.end).cmp(&(b.begin, b.end)));
        self.holidays.dedup();

        self.adjusted_workdays.sort_by_key(|day| day.date);
        self.adjusted_workdays.dedup();
    }

    /// 该年是否完全没有数据（放假与补班都没有）。
    pub fn has_data(&self) -> bool {
        !self.holidays.is_empty() || !self.adjusted_workdays.is_empty()
    }

    /// 是否带有调休上班日（补班日）信息。
    ///
    /// 补班日都落在周六日，按现行峰谷口径本来就没有高峰段，因此缺了它**不影响峰谷判定**；
    /// 但它决定设置界面能否展示「X 天补班」，也决定多源抓取时的取舍
    /// （见 `infrastructure::http::holiday_client`）。
    pub fn has_adjusted_workdays(&self) -> bool {
        !self.adjusted_workdays.is_empty()
    }

    /// 放假日期集合（展开区间，按升序）。
    pub fn holiday_dates(&self) -> Vec<NaiveDate> {
        let mut out = Vec::new();
        for range in &self.holidays {
            let mut cursor = range.begin;
            while cursor <= range.end {
                out.push(cursor);
                match cursor.succ_opt() {
                    Some(next) => cursor = next,
                    None => break,
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// 全年放假总天数（重叠区间只计一次）。
    pub fn holiday_day_count(&self) -> usize {
        self.holiday_dates().len()
    }

    /// 放假区间簇数：首尾相接或相互重叠的区间视为同一簇。
    pub fn cluster_count(&self) -> usize {
        let mut count = 0;
        let mut current_end: Option<NaiveDate> = None;
        for range in &self.holidays {
            match current_end {
                // 与上一簇相接/重叠：并入同一簇。
                Some(end) if range.begin <= end.succ_opt().unwrap_or(end) => {
                    if range.end > end {
                        current_end = Some(range.end);
                    }
                }
                _ => {
                    count += 1;
                    current_end = Some(range.end);
                }
            }
        }
        count
    }

    /// 数据是否完整到足以「信以为真」。
    ///
    /// CN 的年度安排由国务院一次性公布，因此「只有零星几天」必然意味着
    /// 抓取/解析残缺（或该年度尚未公布），此时不应据它判定峰谷。
    pub fn is_complete(&self) -> bool {
        self.cluster_count() >= MIN_CLUSTERS && self.holiday_day_count() >= MIN_HOLIDAY_DAYS
    }

    /// 缓存是否仍然可用：数据完整、有抓取时间、且未超过该年份的 TTL。
    ///
    /// - 已过去的年份：官方安排不会再变，视为永久有效；
    /// - 当前年份：30 天；
    /// - 未来年份：7 天（次年通知通常 11 月才发布，短 TTL 便于尽快补齐）。
    pub fn is_fresh(&self, now_sec: i64, current_year: i32) -> bool {
        if !self.is_complete() || self.fetched_at <= 0 {
            return false;
        }
        self.age_sec(now_sec) < self.ttl_sec(current_year)
    }

    /// 距上次抓取过去了多久（时钟回拨时按 0 处理）。
    pub fn age_sec(&self, now_sec: i64) -> i64 {
        now_sec.saturating_sub(self.fetched_at).max(0)
    }

    /// 该日历适用的缓存存活时长。
    pub fn ttl_sec(&self, current_year: i32) -> i64 {
        if self.year > current_year {
            TTL_FUTURE_YEAR_SEC
        } else if self.year == current_year {
            TTL_CURRENT_YEAR_SEC
        } else {
            i64::MAX
        }
    }

    /// 是否覆盖该日期（按年份归属判断）。
    pub fn covers(&self, date: NaiveDate) -> bool {
        date.year() == self.year
    }

    /// 该日期是否落在放假区间内。
    pub fn is_holiday(&self, date: NaiveDate) -> bool {
        self.holidays.iter().any(|range| range.contains(date))
    }

    /// 该日期是否为调休上班日。
    pub fn is_adjusted_workday(&self, date: NaiveDate) -> bool {
        self.adjusted_workdays.iter().any(|day| day.date == date)
    }

    /// 判定日期类型：放假区间 → 调休上班日 → 周一至周五 → 周末。
    pub fn kind_of(&self, date: NaiveDate) -> DateKind {
        if self.is_holiday(date) {
            return DateKind::Holiday;
        }
        if self.is_adjusted_workday(date) {
            return DateKind::AdjustedWorkday;
        }
        weekday_kind(date)
    }

    /// 该日期是否适用工作日高峰时段。
    pub fn has_peak_hours(&self, date: NaiveDate) -> bool {
        self.kind_of(date).has_peak_hours()
    }
}

/// 只按自然周判定的日期类型（无节假日信息时的退化规则）。
pub fn weekday_kind(date: NaiveDate) -> DateKind {
    if matches!(
        date.weekday(),
        Weekday::Mon | Weekday::Tue | Weekday::Wed | Weekday::Thu | Weekday::Fri
    ) {
        DateKind::Workday
    } else {
        DateKind::Weekend
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").expect("测试用日期字面量应合法")
    }

    fn range(name: &str, begin: &str, end: &str) -> HolidayRange {
        HolidayRange::new(name, date(begin), date(end))
    }

    /// 2026 年官方安排（国办发明电〔2025〕7 号）——本文件全部用例的公共样本。
    fn calendar_2026() -> HolidayCalendar {
        HolidayCalendar::new(
            2026,
            "test",
            1_780_000_000,
            vec![
                range("元旦", "2026-01-01", "2026-01-03"),
                range("春节", "2026-02-15", "2026-02-23"),
                range("清明节", "2026-04-04", "2026-04-06"),
                range("劳动节", "2026-05-01", "2026-05-05"),
                range("端午节", "2026-06-19", "2026-06-21"),
                range("中秋节", "2026-09-25", "2026-09-27"),
                range("国庆节", "2026-10-01", "2026-10-07"),
            ],
            vec![
                AdjustedWorkday::new(date("2026-01-04"), "元旦后补班"),
                AdjustedWorkday::new(date("2026-02-14"), "春节前补班"),
                AdjustedWorkday::new(date("2026-09-20"), "国庆前补班"),
            ],
        )
    }

    /// 区间构造与归一化：首尾颠倒自动纠正，非法区间被丢弃，重复项去重。
    #[test]
    fn normalize_fixes_ranges_and_drops_invalid() {
        let mut calendar = HolidayCalendar::new(
            2026,
            "test",
            0,
            vec![
                range("五一", "2026-05-05", "2026-05-01"),
                range("五一", "2026-05-01", "2026-05-05"),
                HolidayRange {
                    name: "空区间".to_string(),
                    begin: date("2026-07-01"),
                    end: date("2026-06-30"),
                },
            ],
            Vec::new(),
        );
        calendar.normalize();
        assert_eq!(calendar.holidays.len(), 1, "颠倒值纠正后与重复项合并为一");
        assert_eq!(calendar.holidays[0].begin, date("2026-05-01"));
        assert_eq!(calendar.holidays[0].end, date("2026-05-05"));
    }

    /// 放假区间展开与簇数：2026 年 7 簇、共 33 天。
    #[test]
    fn expands_ranges_into_dates_and_clusters() {
        let calendar = calendar_2026();
        assert_eq!(calendar.cluster_count(), 7);
        assert_eq!(calendar.holiday_day_count(), 3 + 9 + 3 + 5 + 3 + 3 + 7);
        assert!(calendar.is_complete(), "完整的年度安排必须判定为完整");
    }

    /// 首尾相接的区间算同一簇（接口把长假拆成两段时不应被误判为两个节）。
    #[test]
    fn touching_ranges_merge_into_one_cluster() {
        let calendar = HolidayCalendar::new(
            2026,
            "test",
            0,
            vec![
                range("春节前半", "2026-02-15", "2026-02-19"),
                range("春节后半", "2026-02-20", "2026-02-23"),
            ],
            Vec::new(),
        );
        assert_eq!(calendar.cluster_count(), 1);
    }

    /// 残缺数据（只有零星几天）不得被当成完整日历。
    #[test]
    fn partial_data_is_incomplete() {
        let calendar = HolidayCalendar::new(
            2026,
            "test",
            1_780_000_000,
            vec![range("元旦", "2026-01-01", "2026-01-03")],
            Vec::new(),
        );
        assert!(!calendar.is_complete(), "只有 1 个节日必然是残缺数据");
        assert!(!calendar.is_fresh(1_780_000_100, 2026));
        assert!(calendar.has_data(), "但仍有可用数据（比什么都没有强）");
    }

    /// 新鲜度：当前年 30 天、未来年 7 天、历史年永久。
    #[test]
    fn freshness_follows_year_relative_ttl() {
        let now = 1_780_000_000;
        let mut calendar = calendar_2026();
        calendar.fetched_at = now;

        // 当前年份：30 天内有效，之后过期。
        assert!(calendar.is_fresh(now, 2026));
        assert!(calendar.is_fresh(now + TTL_CURRENT_YEAR_SEC - 1, 2026));
        assert!(!calendar.is_fresh(now + TTL_CURRENT_YEAR_SEC, 2026));

        // 未来年份：7 天后即过期（次年通知随时可能公布）。
        assert!(calendar.is_fresh(now + TTL_FUTURE_YEAR_SEC - 1, 2025));
        assert!(!calendar.is_fresh(now + TTL_FUTURE_YEAR_SEC, 2025));

        // 历史年份：永不过期。
        assert!(calendar.is_fresh(now + 10 * 365 * 24 * 3600, 2027));
    }

    /// 没有抓取时间（内置兜底）一律视为需要刷新。
    #[test]
    fn bundled_data_is_never_fresh() {
        let mut calendar = calendar_2026();
        calendar.fetched_at = 0;
        assert!(!calendar.is_fresh(1_780_000_000, 2026));
    }

    /// 时钟回拨不应导致「负数年龄」被判为过期。
    #[test]
    fn clock_skew_is_clamped() {
        let mut calendar = calendar_2026();
        calendar.fetched_at = 2_000_000_000;
        assert_eq!(calendar.age_sec(1_000_000_000), 0);
        assert!(calendar.is_fresh(1_000_000_000, 2026));
    }

    /// 日期类型判定：放假 / 调休 / 平日 / 周末，且只有平日有高峰。
    #[test]
    fn classifies_dates_and_peak_eligibility() {
        let calendar = calendar_2026();
        // 2026-02-17 是春节假期中的周二。
        assert_eq!(calendar.kind_of(date("2026-02-17")), DateKind::Holiday);
        // 2026-09-20 是周日补班日：要上班，但没有高峰段（谷价）。
        assert_eq!(
            calendar.kind_of(date("2026-09-20")),
            DateKind::AdjustedWorkday
        );
        assert!(!calendar.has_peak_hours(date("2026-09-20")));
        // 2026-09-15 是普通周二。
        assert!(calendar.has_peak_hours(date("2026-09-15")));
        // 2026-10-05 是国庆假期中的周一：放假优先于「周一」。
        assert_eq!(calendar.kind_of(date("2026-10-05")), DateKind::Holiday);
        // 2026-09-19 是普通周六。
        assert_eq!(calendar.kind_of(date("2026-09-19")), DateKind::Weekend);
    }

    /// 空白日历：只有自然周规则，且永远需要刷新。
    #[test]
    fn empty_calendar_degrades_to_weekday_rule() {
        let calendar = HolidayCalendar::empty(2030, "bundled");
        assert!(!calendar.has_data());
        assert!(!calendar.is_complete());
        assert!(calendar.has_peak_hours(date("2030-03-05")), "周二应有高峰");
        assert!(!calendar.has_peak_hours(date("2030-03-09")), "周六无高峰");
        assert!(calendar.covers(date("2030-03-05")));
        assert!(!calendar.covers(date("2031-03-05")));
    }
}
