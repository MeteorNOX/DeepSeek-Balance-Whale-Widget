//! supplier 用例
//!
//! - `service`：编排（供应商增删查改 / 应用 / 预览 / 旧配置迁移）；
//! - `command`：入参对象（保存请求）；
//! - `result`：出参对象（卡片 / 详情 / 保存结果）。

pub mod command;
pub mod result;
pub mod service;
