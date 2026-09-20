//! 节假日数据源客户端
//!
//! 只负责「把某一年的节假日数据取回来并解析成 [`HolidayCalendar`]」，
//! 是否该取、取了要不要写缓存属于领域规则（`domain::pricing::service::holiday_service`）。
//!
//! # 数据源
//!
//! 全部为**内置免费源**：免注册、免 AppKey、不需要用户配置，按顺序尝试，成功即止：
//! - 程序世界 ApiZero：`https://v1.apizero.cn/api/holiday?year={year}`；
//! - 提莫小站：`https://timor.tech/api/holiday/year/{year}`；
//! - 免费节假日 API：`https://holiday.ailcc.com/api/holiday/year/{year}`；
//! - chinese-days 静态年文件：`https://cdn.jsdelivr.net/npm/chinese-days/dist/years/{year}.json`。
//!
//! 所有源都必须返回「放假区间 + 调休上班日」两类信息；解析结果先过
//! [`HolidayCalendar::is_complete`] 校验，残缺数据不会被当作成功——
//! 否则会把「只拉到元旦」的半天数据写进缓存，反而让判定长期出错。
//!
//! 两类信息齐全（即带补班日）的结果会被立即采用；只拿到放假区间的结果先留作兜底，
//! 继续尝试后面的源，全部如此才用兜底——补班日都落在周六日，按现行口径不影响峰谷
//! 判定，留作兜底只是为了保留更完整的数据。
//!
//! 说明：百度万年历接口（`opendata.baidu.com/api.php?resource_id=6018`）经实测
//! 已不再返回 `holiday` / `workday` 字段（仅剩元数据），故未纳入数据源；
//! 万维易源 894-4 需要 AppKey，与「用户零配置」的目标冲突，故已移除。

use std::time::Duration;

use chrono::NaiveDate;
use serde_json::Value;

use crate::domain::pricing::model::valobj::holiday_calendar::{
    AdjustedWorkday, HolidayCalendar, HolidayRange,
};
use crate::domain::pricing::repository::HolidaySource;
use crate::types::exception::{AppError, AppResult};

/// 单个数据源的请求超时：顺序尝试多个源，单个源不能拖太久。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// 免费数据源标识（写进日历的 `source`，用于排查「这份数据是谁给的」）。
const SOURCE_APIZERO: &str = "free:apizero";
const SOURCE_TIMOR: &str = "free:timor";
const SOURCE_AILCC: &str = "free:ailcc";
const SOURCE_CHINESE_DAYS: &str = "free:chinese-days";

/// 内置免费源（顺序即优先级）。
const FREE_SOURCES: [(&str, &str); 4] = [
    (SOURCE_APIZERO, "https://v1.apizero.cn/api/holiday?year={year}"),
    (SOURCE_TIMOR, "https://timor.tech/api/holiday/year/{year}"),
    (
        SOURCE_AILCC,
        "https://holiday.ailcc.com/api/holiday/year/{year}",
    ),
    (
        SOURCE_CHINESE_DAYS,
        "https://cdn.jsdelivr.net/npm/chinese-days/dist/years/{year}.json",
    ),
];

/// 生产实现：多源节假日数据源。
pub struct HolidaySourceImpl;

/// 全局唯一实例（组合根注入用）。
pub static HOLIDAY_SOURCE: HolidaySourceImpl = HolidaySourceImpl;

impl HolidaySource for HolidaySourceImpl {
    fn fetch_year(
        &self,
        year: i32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<HolidayCalendar>> + Send + 'static>>
    {
        Box::pin(async move { fetch_year(year).await })
    }
}

/// 按内置免费源链依次尝试（全部免注册、免 AppKey，用户无需配置）。
///
/// 判定「够不够好」的标准是**有没有补班日**：放假区间与补班日齐全才算完整结果，
/// 立即采用；只拿到放假区间的结果先留作兜底，继续尝试后面的源。
/// 所有源都只给放假区间时，仍用兜底结果（补班日缺失不影响峰谷判定）。
async fn fetch_year(year: i32) -> AppResult<HolidayCalendar> {
    let mut chain = SourceChain::default();

    for (source, template) in FREE_SOURCES {
        let url = template.replace("{year}", &year.to_string());
        match fetch_and_parse(source, year, &url).await {
            Ok(calendar) => {
                if let Some(complete) = chain.accept(calendar) {
                    return Ok(complete);
                }
            }
            Err(err) => chain.reject(source, &err),
        }
    }

    chain.finish(year)
}

/// 多源尝试过程中的候选与失败记录。
#[derive(Default)]
struct SourceChain {
    /// 首个「有放假区间但没有补班日」的结果（兜底）。
    fallback: Option<HolidayCalendar>,
    /// 各数据源的失败原因（用于聚合错误信息）。
    failures: Vec<String>,
}

impl SourceChain {
    /// 收下一个成功结果：带补班日即视为完整（返回 `Some`，调用方立刻结束）；
    /// 否则留作兜底并返回 `None`，让调用方继续尝试后面的源。
    fn accept(&mut self, calendar: HolidayCalendar) -> Option<HolidayCalendar> {
        if calendar.has_adjusted_workdays() {
            return Some(calendar);
        }
        if self.fallback.is_none() {
            self.fallback = Some(calendar);
        }
        None
    }

    /// 记下一次失败（不中断链）。
    fn reject(&mut self, label: &str, err: &AppError) {
        self.failures.push(format!("{}：{}", label, err.message()));
    }

    /// 收尾：所有源都试完，返回兜底结果或聚合错误。
    fn finish(self, year: i32) -> AppResult<HolidayCalendar> {
        match self.fallback {
            Some(calendar) => Ok(calendar),
            None => Err(AppError::external(format!(
                "{} 年节假日获取失败（{}）",
                year,
                self.failures.join("；")
            ))),
        }
    }
}

/// 请求单个免费源并按源类型解析。
async fn fetch_and_parse(source: &str, year: i32, url: &str) -> AppResult<HolidayCalendar> {
    let body = fetch_json(url).await?;
    let calendar = match source {
        SOURCE_APIZERO => parse_apizero_body(year, &body)?,
        SOURCE_CHINESE_DAYS => parse_chinese_days_body(year, &body)?,
        _ => parse_day_map_body(year, source, &body)?,
    };
    ensure_complete(calendar, source)
}

/// 完整性校验：残缺数据视为失败，交由下一个数据源处理。
fn ensure_complete(calendar: HolidayCalendar, source: &str) -> AppResult<HolidayCalendar> {
    if calendar.is_complete() {
        Ok(calendar)
    } else {
        Err(AppError::external(format!(
            "{} 返回的数据不完整（{} 个假期段 / {} 天放假）",
            source,
            calendar.cluster_count(),
            calendar.holiday_day_count()
        )))
    }
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

/// GET 一个 JSON 接口（统一超时与 UA）。
async fn fetch_json(url: &str) -> AppResult<Value> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| AppError::network(format!("HTTP 客户端初始化失败: {}", e)))?;
    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", "DS-Desktop-Whale/2.0")
        .send()
        .await
        .map_err(|e| AppError::network(format!("节假日接口请求失败: {}", e)))?;
    if !resp.status().is_success() {
        return Err(AppError::external(format!(
            "节假日接口返回 HTTP {}",
            resp.status().as_u16()
        )));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| AppError::network(format!("节假日接口响应解析失败: {}", e)))
}

// ---------------------------------------------------------------------------
// 解析（纯函数，可单测）
// ---------------------------------------------------------------------------

/// 把按天记录解析成「放假区间 + 调休上班日」。
///
/// 逐天记录（含节日名与 `holiday` 布尔）是最常见的接口形态，这里统一处理：
/// 连续且同名（或同属一个节日簇）的放假日合并为一段区间。
fn calendar_from_days(
    year: i32,
    source: &str,
    days: Vec<(NaiveDate, bool, String)>,
) -> HolidayCalendar {
    let mut holidays: Vec<(NaiveDate, String)> = Vec::new();
    let mut workdays: Vec<AdjustedWorkday> = Vec::new();
    for (date, is_off, name) in days {
        if is_off {
            holidays.push((date, name));
        } else {
            workdays.push(AdjustedWorkday::new(date, name));
        }
    }
    holidays.sort_by_key(|(date, _)| *date);
    holidays.dedup_by_key(|(date, _)| *date);
    workdays.sort_by_key(|day| day.date);
    workdays.dedup_by_key(|day| day.date);

    HolidayCalendar::new(
        year,
        source,
        now_sec(),
        merge_days_into_ranges(&holidays),
        workdays,
    )
}

/// 把「逐天放假记录」合并为连续区间（相邻日期且同一天不重复）。
fn merge_days_into_ranges(days: &[(NaiveDate, String)]) -> Vec<HolidayRange> {
    let mut ranges: Vec<HolidayRange> = Vec::new();
    let mut current: Option<(NaiveDate, NaiveDate, String)> = None;
    for (date, name) in days {
        match current.take() {
            Some((begin, end, label)) if *date == end.succ_opt().unwrap_or(end) => {
                current = Some((begin, *date, label));
            }
            Some((begin, end, label)) => {
                ranges.push(HolidayRange::new(label, begin, end));
                current = Some((*date, *date, name.clone()));
            }
            None => current = Some((*date, *date, name.clone())),
        }
    }
    if let Some((begin, end, label)) = current {
        ranges.push(HolidayRange::new(label, begin, end));
    }
    ranges
}

/// 解析 ApiZero（程序世界）全年响应：`data.list[].holiday[] / workday[]`。
fn parse_apizero_body(year: i32, body: &Value) -> AppResult<HolidayCalendar> {
    let list = body
        .pointer("/data/list")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::external("免费接口返回结构异常（缺少 data.list）"))?;

    let mut holidays = Vec::new();
    let mut workdays = Vec::new();
    for item in list {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        for key in ["holiday", "workday"] {
            let Some(days) = item.get(key).and_then(|v| v.as_array()) else {
                continue;
            };
            for day in days {
                let Some(text) = day.as_str() else { continue };
                let Some(date) = parse_iso_date(text) else { continue };
                if key == "holiday" {
                    holidays.push((date, name.clone()));
                } else {
                    workdays.push(AdjustedWorkday::new(date, name.clone()));
                }
            }
        }
    }
    if holidays.is_empty() {
        return Err(AppError::external("免费接口未返回任何放假日"));
    }
    holidays.sort_by_key(|(date, _)| *date);
    Ok(HolidayCalendar::new(
        year,
        SOURCE_APIZERO,
        now_sec(),
        merge_days_into_ranges(&holidays),
        workdays,
    ))
}

/// 解析「按日期为键」的全年响应（提莫小站 / 免费节假日 API 同构）：
/// `holiday: { "01-01": { holiday: true, name: "元旦", date: "2026-01-01" } }`。
fn parse_day_map_body(year: i32, source: &str, body: &Value) -> AppResult<HolidayCalendar> {
    let map = body
        .get("holiday")
        .and_then(|v| v.as_object())
        .ok_or_else(|| AppError::external("节假日接口返回结构异常（缺少 holiday 对象）"))?;

    let mut days = Vec::new();
    for (key, entry) in map {
        let is_off = entry
            .get("holiday")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        // 优先用接口给出的完整日期，缺失时用键（`MM-DD`）补上目标年份。
        let date = entry
            .get("date")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_date)
            .or_else(|| parse_month_day(key, year));
        let Some(date) = date else { continue };
        days.push((date, is_off, name));
    }
    if days.is_empty() {
        return Err(AppError::external("节假日接口未返回任何日期"));
    }
    Ok(calendar_from_days(year, source, days))
}

/// 解析 chinese-days 静态年文件：`holidays` / `workdays` 两张 `{日期: "英文,中文,序号"}` 表。
fn parse_chinese_days_body(year: i32, body: &Value) -> AppResult<HolidayCalendar> {
    let mut days = Vec::new();
    for (key, is_off) in [("holidays", true), ("workdays", false)] {
        let Some(map) = body.get(key).and_then(|v| v.as_object()) else {
            continue;
        };
        for (date, label) in map {
            let Some(date) = parse_iso_date(date) else {
                continue;
            };
            let name = label
                .as_str()
                .and_then(|text| text.split(',').nth(1))
                .unwrap_or_default()
                .to_string();
            days.push((date, is_off, name));
        }
    }
    if days.is_empty() {
        return Err(AppError::external("静态节假日文件未返回任何日期"));
    }
    Ok(calendar_from_days(year, SOURCE_CHINESE_DAYS, days))
}

/// 解析 `YYYY-MM-DD`。
fn parse_iso_date(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d").ok()
}

/// 按 `MM-DD` 键补齐目标年份。
fn parse_month_day(key: &str, year: i32) -> Option<NaiveDate> {
    let trimmed = key.trim();
    let (month, day) = trimmed.split_once('-')?;
    NaiveDate::from_ymd_opt(
        year,
        month.trim().parse::<u32>().ok()?,
        day.trim().parse::<u32>().ok()?,
    )
}

/// 当前 epoch 秒。
fn now_sec() -> i64 {
    chrono::Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn date(text: &str) -> NaiveDate {
        parse_iso_date(text).unwrap()
    }

    /// 多源取舍：带补班日的结果优先采用；只有放假区间的结果留作兜底。
    #[test]
    fn source_chain_prefers_results_with_adjusted_workdays() {
        let holidays_only = HolidayCalendar::new(
            2026,
            "holidays-only",
            1,
            vec![HolidayRange::new(
                "元旦",
                date("2026-01-01"),
                date("2026-01-03"),
            )],
            Vec::new(),
        );

        let mut chain = SourceChain::default();
        assert!(
            chain.accept(holidays_only.clone()).is_none(),
            "缺补班日的结果不该被立即采用"
        );
        let full = HolidayCalendar::new(
            2026,
            "full",
            1,
            Vec::new(),
            vec![AdjustedWorkday::new(date("2026-01-04"), "元旦后补班")],
        );
        let picked = chain.accept(full).expect("带补班日的结果必须被采用");
        assert_eq!(picked.source, "full");

        // 所有源都只给放假区间：兜底返回第一个成功结果。
        let mut chain = SourceChain::default();
        assert!(chain.accept(holidays_only).is_none());
        let fallback = chain.finish(2026).expect("兜底结果必须可用");
        assert_eq!(fallback.source, "holidays-only");

        // 一个都没成功：错误信息里要能看出试过哪些源。
        let mut chain = SourceChain::default();
        chain.reject("free:apizero", &AppError::network("连接超时".to_string()));
        let err = chain.finish(2026).unwrap_err();
        assert!(
            err.message().contains("2026") && err.message().contains("free:apizero"),
            "错误信息应含年份与已试过的源：{}",
            err.message()
        );
    }

    /// ApiZero 全年结构：放假与补班都能解析，且连续放假日合并成区间。
    #[test]
    fn parses_apizero_year() {
        let body = json!({
            "code": 0,
            "data": { "year": 2026, "list": [
                { "name": "元旦", "holiday": ["2026-01-01", "2026-01-02", "2026-01-03"], "workday": ["2026-01-04"], "days": 3 },
                { "name": "春节", "holiday": [
                    "2026-02-15","2026-02-16","2026-02-17","2026-02-18","2026-02-19",
                    "2026-02-20","2026-02-21","2026-02-22","2026-02-23"
                ], "workday": ["2026-02-14", "2026-02-28"], "days": 9 },
                { "name": "清明节", "holiday": ["2026-04-04","2026-04-05","2026-04-06"], "workday": [], "days": 3 },
                { "name": "劳动节", "holiday": ["2026-05-01","2026-05-02","2026-05-03","2026-05-04","2026-05-05"], "workday": ["2026-05-09"], "days": 5 },
                { "name": "端午节", "holiday": ["2026-06-19","2026-06-20","2026-06-21"], "workday": [], "days": 3 },
                { "name": "中秋节", "holiday": ["2026-09-25","2026-09-26","2026-09-27"], "workday": [], "days": 3 },
                { "name": "国庆节", "holiday": ["2026-10-01","2026-10-02","2026-10-03","2026-10-04","2026-10-05","2026-10-06","2026-10-07"], "workday": ["2026-09-20","2026-10-10"], "days": 7 }
            ] }
        });
        let calendar = parse_apizero_body(2026, &body).unwrap();
        assert!(calendar.is_complete());
        assert_eq!(calendar.source, SOURCE_APIZERO);
        assert_eq!(calendar.cluster_count(), 7);
        assert_eq!(calendar.holiday_day_count(), 33);
        assert_eq!(calendar.adjusted_workdays.len(), 6);
        assert!(calendar.is_holiday(date("2026-02-23")));
        assert!(calendar.is_adjusted_workday(date("2026-09-20")));
        assert!(calendar.fetched_at > 0, "解析时必须打上抓取时间");
    }

    /// 提莫 / 免费节假日 API 的「日期为键」结构：放假与补班都在同一个 map 里。
    #[test]
    fn parses_day_map_year() {
        let body = json!({
            "code": 0,
            "holiday": {
                "01-01": { "holiday": true, "name": "元旦", "wage": 3, "date": "2026-01-01" },
                "01-02": { "holiday": true, "name": "元旦", "wage": 2, "date": "2026-01-02" },
                "01-04": { "holiday": false, "name": "元旦后补班", "wage": 1, "date": "2026-01-04" }
            }
        });
        let calendar = parse_day_map_body(2026, SOURCE_TIMOR, &body).unwrap();
        assert_eq!(calendar.holidays.len(), 1, "连续两天应合并为一段区间");
        assert_eq!(calendar.holidays[0].begin, date("2026-01-01"));
        assert_eq!(calendar.holidays[0].end, date("2026-01-02"));
        assert_eq!(calendar.holidays[0].name, "元旦");
        assert_eq!(calendar.adjusted_workdays.len(), 1);
        assert_eq!(calendar.adjusted_workdays[0].date, date("2026-01-04"));
        assert!(
            !calendar.is_complete(),
            "样本只有元旦：完整性问题交给上层判断"
        );
    }

    /// chinese-days 静态年文件：`holidays` / `workdays` 两张表。
    #[test]
    fn parses_chinese_days_year() {
        let body = json!({
            "holidays": {
                "2026-01-01": "New Year's Day,元旦,1",
                "2026-01-02": "New Year's Day,元旦,1"
            },
            "workdays": { "2026-01-04": "New Year's Day,元旦,1" }
        });
        let calendar = parse_chinese_days_body(2026, &body).unwrap();
        assert_eq!(calendar.source, SOURCE_CHINESE_DAYS);
        assert_eq!(calendar.holidays.len(), 1);
        assert_eq!(calendar.holidays[0].name, "元旦");
        assert_eq!(calendar.adjusted_workdays[0].date, date("2026-01-04"));
    }

    /// 残缺数据不得被当作成功（否则会污染缓存）。
    #[test]
    fn incomplete_payloads_are_rejected() {
        let body = json!({
            "code": 0,
            "data": { "list": [
                { "name": "元旦", "holiday": ["2026-01-01"], "workday": [] }
            ] }
        });
        let calendar = parse_apizero_body(2026, &body).unwrap();
        assert!(!calendar.is_complete());
        let err = ensure_complete(calendar, SOURCE_APIZERO).unwrap_err();
        assert!(err.message().contains("不完整"), "{}", err.message());

        // 完全空的响应直接报错。
        assert!(parse_apizero_body(2026, &json!({ "data": { "list": [] } })).is_err());
    }

    /// 逐天记录合并成区间：连续日期合并、断开处切分。
    #[test]
    fn merges_consecutive_days() {
        let ranges = merge_days_into_ranges(&[
            (date("2026-01-01"), "元旦".to_string()),
            (date("2026-01-02"), "元旦".to_string()),
            (date("2026-01-03"), "元旦".to_string()),
            (date("2026-05-01"), "劳动节".to_string()),
        ]);
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].days(), 3);
        assert_eq!(ranges[1].days(), 1);
    }

    /// 内置免费源链必须完整：每一项都是 HTTPS，且都带 `{year}` 占位符。
    #[test]
    fn free_sources_are_keyless_and_templated() {
        assert!(FREE_SOURCES.len() >= 3, "内置源不少于三个，保证可降级");
        for (source, template) in FREE_SOURCES {
            assert!(source.starts_with("free:"), "源标识应带 free: 前缀：{}", source);
            assert!(template.starts_with("https://"), "必须走 HTTPS：{}", template);
            assert!(template.contains("{year}"), "必须含年份占位符：{}", template);
        }
    }
}
