//! 节假日日历的本地缓存读写
//!
//! 落盘位置：`<数据目录>/holiday/CN-<年份>.json`（见 `paths::holiday_cache_path`）。
//!
//! 为什么一年一个文件：
//! - 判定要按年份取数据，一年一文件就是「按 key 读」的最直接形式；
//! - 某一年数据坏了只影响那一年（删掉该文件即可重新拉取），不会互相污染；
//! - 文件小、可读、可人工核对（节假日数据出问题时排查成本最低）。
//!
//! 写盘一律走 `types::utils::fs::write_atomic`：断电/崩溃不会留下半写 JSON。

use std::fs;

use serde::{Deserialize, Serialize};

use crate::domain::pricing::model::valobj::holiday_calendar::HolidayCalendar;
use crate::domain::pricing::repository::HolidayCacheRepository;
use crate::infrastructure::system::paths;
use crate::types::exception::{AppError, AppResult};
use crate::types::utils::fs as fs_utils;

/// 缓存文件格式版本：结构变化时递增，旧文件按「不支持」处理并重新拉取。
pub const CACHE_SCHEMA_VERSION: u32 = 1;

/// 缓存文件根结构。
///
/// 比领域模型多一个 `schema_version`：读盘时先校验版本，避免把旧结构当新结构解析
/// 出一个「看起来正常其实字段错位」的日历。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheFile {
    schema_version: u32,
    #[serde(flatten)]
    calendar: HolidayCalendar,
}

/// 生产实现：读写便携数据目录下的节假日缓存。
pub struct HolidayStoreRepositoryImpl;

/// 全局唯一实例（组合根注入用）。
pub static HOLIDAY_STORE: HolidayStoreRepositoryImpl = HolidayStoreRepositoryImpl;

impl HolidayCacheRepository for HolidayStoreRepositoryImpl {
    /// 读取某年的缓存；缺失 / 版本不符 / 解析失败一律返回 `None`（由上层回落）。
    fn read_year(&self, year: i32) -> Option<HolidayCalendar> {
        let path = paths::holiday_cache_path(year);
        let text = fs::read_to_string(&path).ok()?;
        match serde_json::from_str::<CacheFile>(&text) {
            Ok(file) if file.schema_version == CACHE_SCHEMA_VERSION => {
                let mut calendar = file.calendar;
                calendar.country = paths::HOLIDAY_COUNTRY_CODE.to_string();
                calendar.year = year;
                calendar.normalize();
                Some(calendar)
            }
            Ok(file) => {
                log::warn!(
                    "节假日缓存版本不支持（文件 {}，当前 {}），将重新拉取：{}",
                    file.schema_version,
                    CACHE_SCHEMA_VERSION,
                    path.display()
                );
                None
            }
            Err(err) => {
                log::warn!("节假日缓存解析失败，将重新拉取：{}（{}）", path.display(), err);
                None
            }
        }
    }

    /// 写入某年的缓存（原子写；目录不存在时自动创建）。
    fn write_year(&self, calendar: &HolidayCalendar) -> AppResult<()> {
        let dir = paths::holiday_root();
        fs::create_dir_all(&dir)
            .map_err(|e| AppError::io(format!("创建节假日缓存目录失败：{}", e)))?;
        let file = CacheFile {
            schema_version: CACHE_SCHEMA_VERSION,
            calendar: calendar.clone(),
        };
        let text = serde_json::to_string_pretty(&file)
            .map_err(|e| AppError::io(format!("序列化节假日缓存失败：{}", e)))?;
        let path = paths::holiday_cache_path(calendar.year);
        fs_utils::write_atomic(
            &path,
            text.as_bytes(),
            |e| AppError::io(format!("写入节假日缓存失败：{}", e)),
            |e| AppError::io(format!("保存节假日缓存失败：{}", e)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::pricing::model::valobj::bundled_calendar::bundled_calendar;
    use crate::domain::pricing::model::valobj::holiday_calendar::{AdjustedWorkday, HolidayRange};
    use chrono::NaiveDate;

    fn date(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    /// 落盘 → 读回必须等价（含放假区间、补班日、来源与抓取时间）。
    #[test]
    fn round_trip_keeps_calendar_intact() {
        let dir = std::env::temp_dir().join(format!("dsw-holiday-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("CN-2026.json");

        let mut calendar = bundled_calendar(2026).unwrap();
        calendar.source = "free:test".to_string();
        calendar.fetched_at = 1_780_000_000;

        let file = CacheFile {
            schema_version: CACHE_SCHEMA_VERSION,
            calendar: calendar.clone(),
        };
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, serde_json::to_string_pretty(&file).unwrap()).unwrap();

        let read_back: CacheFile =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read_back.calendar, calendar);
        assert_eq!(read_back.schema_version, CACHE_SCHEMA_VERSION);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 结构版本不符 / 内容损坏 → 一律返回 None（触发重新拉取），而不是给出半个日历。
    #[test]
    fn broken_files_are_rejected() {
        let dir = std::env::temp_dir().join(format!("dsw-holiday-broken-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("CN-2026.json");

        fs::write(&path, "{ 不是 json").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(serde_json::from_str::<CacheFile>(&text).is_err(), "损坏文件必须解析失败");

        fs::write(&path, r#"{"schema_version":99,"year":2026,"holidays":[]}"#).unwrap();
        let file: CacheFile = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_ne!(file.schema_version, CACHE_SCHEMA_VERSION);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 真实数据目录写入：文件落在 `holiday/CN-<年份>.json`，内容可读回。
    ///
    /// 用 2098 这个不会与真实数据冲突的年份，避免测试覆盖/删除用户的真实缓存。
    #[test]
    fn writes_into_real_data_dir() {
        let store = &HOLIDAY_STORE;
        let path = paths::holiday_cache_path(2098);
        assert!(
            !path.exists(),
            "该用例要求 2098 年没有历史缓存：{}",
            path.display()
        );

        let mut calendar = synthetic_calendar(2098);
        calendar.source = "test:round-trip".to_string();
        calendar.fetched_at = 1_780_000_001;
        store.write_year(&calendar).expect("写入缓存应成功");

        assert!(path.exists(), "缓存文件必须落在数据目录下：{}", path.display());
        assert!(path.starts_with(paths::holiday_root()));
        assert_eq!(path.file_name().and_then(|s| s.to_str()), Some("CN-2098.json"));

        let read_back = store.read_year(2098).expect("刚写入的缓存必须能读回");
        assert_eq!(read_back.source, "test:round-trip");
        assert_eq!(read_back.fetched_at, 1_780_000_001);
        assert_eq!(read_back.country, "CN", "读回时国家代码按文件名归一");
        assert!(read_back.is_holiday(date("2098-02-02")));
        assert!(read_back.is_adjusted_workday(date("2098-02-10")));
        assert!(read_back.is_complete());

        // 收尾：删除本用例产生的缓存文件。
        let _ = fs::remove_file(&path);
    }

    /// 构造一份「结构完整」的合成日历（7 段放假 + 若干补班），供落盘用例使用。
    fn synthetic_calendar(year: i32) -> HolidayCalendar {
        let holidays = (1..=7)
            .map(|month| {
                HolidayRange::new(
                    format!("节日{}", month),
                    NaiveDate::from_ymd_opt(year, month, 1).unwrap(),
                    NaiveDate::from_ymd_opt(year, month, 4).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        let workdays = (1..=6)
            .map(|month| {
                AdjustedWorkday::new(
                    NaiveDate::from_ymd_opt(year, month, 10).unwrap(),
                    "合成补班",
                )
            })
            .collect::<Vec<_>>();
        HolidayCalendar::new(year, "test", 0, holidays, workdays)
    }

    /// 不存在的年份返回 None。
    #[test]
    fn missing_year_reads_none() {
        assert!(HOLIDAY_STORE.read_year(1970).is_none());
    }
}
