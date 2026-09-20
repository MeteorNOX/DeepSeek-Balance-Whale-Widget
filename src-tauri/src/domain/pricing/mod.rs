//! 峰谷时段定价领域
//!
//! 职责：回答「此刻是高峰还是谷价」，以及支撑它的**节假日日历**（法定节假日放假
//! 区间 + 调休上班日）。
//!
//! 分层：
//! - `model/valobj/holiday_calendar`：日历值对象（放假区间、调休日、完整性、新鲜度）；
//! - `model/valobj/bundled_calendar`：内置兜底数据（离线基线，随版本发布冻结）；
//! - `repository`：缓存端口 + 远端数据源端口（依赖倒置，实现见 `infrastructure`）；
//! - `service/holiday_service`：缓存优先、按需拉取的装配规则；
//! - `service/pricing_service`：峰谷判定规则本身（只依赖时间戳与日历）。
//!
//! 峰谷时段这一「取值」是枚举 `PeakPeriod`，日期类型是 `DateKind`，按约定统一
//! 收敛在 `types::enums`，因此本领域只有规则、没有独立的 `dto`。

pub mod model;
pub mod repository;
pub mod service;
