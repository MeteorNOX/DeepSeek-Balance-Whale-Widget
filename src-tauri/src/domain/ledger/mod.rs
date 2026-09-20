//! 记账领域
//!
//! - `dto`：账本磁盘模型（`usage.json`）；
//! - `ledger_service`：记账规则（差额累计、跨天归档、历史裁剪）。

pub mod model;
pub mod service;
pub mod repository;
