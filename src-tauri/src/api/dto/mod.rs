//! 线缆 DTO（对外契约）
//!
//! 只属于 `api` 层：这里的结构就是前端看到字段名的唯一来源（一律 camelCase），
//! 与领域模型（磁盘 snake_case）、应用层入参出参对象严格分离，转换只在各子模块内完成。
//! 按接口模块拆分：`supplier`（供应商与客户端配置）、`model`（模型列表）、
//! `calendar`（峰谷日历 / 节假日数据）。

pub mod calendar;
pub mod model;
pub mod supplier;
