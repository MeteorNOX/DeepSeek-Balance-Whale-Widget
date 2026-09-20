//! pricing 领域值对象
//!
//! 使用方一律走完整路径（`valobj::holiday_calendar::HolidayCalendar` 等），
//! 因此这里不做二次转出，避免出现「两套名字指向同一个类型」。

pub mod bundled_calendar;
pub mod holiday_calendar;
