//! 应用配置领域
//!
//! - `dto`：配置数据模型（`config.json` 与前端契约）；
//! - `config_service`：配置规范化规则（旧数据迁移、非法值兜底）。

pub mod service;
pub mod model;
pub mod repository;
