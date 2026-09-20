//! 峰谷日历命令
//!
//! 职责固定为「转交参数 → 调用用例 → 统一返回」：
//! - [`get_holiday_calendar`]：**同步**读本地数据（缓存 / 内置兜底），永不联网，
//!   供挂件启动时立刻拿到日历（倒计时每秒刷新，不能被网络拖住）；
//! - [`refresh_holiday_calendar`]：按需联网更新（缓存缺失 / 过期 / 残缺时才真的请求）。
//!
//! 两个命令都不返回 `Result`：用例是**全函数**——网络与文件错误一律收敛进
//! `outcome`（`failed:<原因>`）并回退到本地数据，前端永远能拿到一份可用日历，
//! 因此不需要 `guard::catch`（那里没有可失败的返回值）。

use crate::api::dto::calendar::{HolidayCalendarDto, HolidayRefreshDto};
use crate::application::pricing::service as holiday_use_case;

/// 读取某年的节假日日历（同步、离线）。
///
/// `year` 缺省时用当前北京时间的年份。
#[tauri::command]
pub fn get_holiday_calendar(year: Option<i32>) -> HolidayCalendarDto {
    let year = year.unwrap_or_else(holiday_use_case::current_year);
    HolidayCalendarDto::from(holiday_use_case::view_for(year))
}

/// 确保某年数据已就绪（必要时联网拉取并写入缓存）。
///
/// 完全自动：缓存完整且未过期时**不产生任何网络请求**，只有缺失 / 过期 / 残缺
/// 才会去请求内置免费源。调用方无需（也无法）指定数据源或强制刷新。
///
/// 无论成败都会返回一份**可用**的日历；失败原因放在 `outcome` 里，
/// 但不会因此拿不到数据。
#[tauri::command]
pub async fn refresh_holiday_calendar(year: Option<i32>) -> HolidayRefreshDto {
    let year = year.unwrap_or_else(holiday_use_case::current_year);
    let current_year = holiday_use_case::current_year();
    let outcome = holiday_use_case::ensure_year(year).await;
    HolidayRefreshDto::from_refresh(outcome, current_year)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同步命令必须离线可用且可重复调用（不能 panic，也不该依赖注册表未装配）。
    #[test]
    fn read_only_command_is_callable() {
        crate::install_test_repositories();
        let dto = get_holiday_calendar(Some(2026));
        assert_eq!(dto.year, 2026);
        assert!(!dto.source.is_empty());
        assert!(dto.holidays.contains(&"2026-02-17".to_string()));
        assert!(dto.adjusted_workdays.contains(&"2026-09-20".to_string()));

        // 缺省年份 = 当前年份。
        let current = get_holiday_calendar(None);
        assert_eq!(current.year, holiday_use_case::current_year());
    }
}
