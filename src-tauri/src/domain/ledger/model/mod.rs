//! 记账数据传输对象
//!
//! 账本磁盘模型（`usage.json`）。

//! 目录约定（见 `1.md`）：`aggregate/` 聚合根、`entity/` 实体、`valobj/` 值对象与常量。
pub mod entity;

pub use entity::{usage_ledger};

pub use usage_ledger::UsageLedger;
