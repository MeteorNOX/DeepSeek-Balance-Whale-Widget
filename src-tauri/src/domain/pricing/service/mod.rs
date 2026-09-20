//! pricing 领域服务（纯业务规则，不依赖 Tauri / 文件系统 / 网络）
//!
//! - [`holiday_service`]：节假日日历的装配与缓存判定规则；
//! - [`pricing_service`]：峰谷时段判定规则。

pub mod holiday_service;
pub mod pricing_service;
