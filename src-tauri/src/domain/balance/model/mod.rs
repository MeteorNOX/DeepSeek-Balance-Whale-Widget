//! 余额载荷数据传输对象
//!
//! 余额查询接口的唯一出参模型，前端挂件据此渲染
//! 「可用额度 / 今日已用 / 峰谷状态」。

//! 目录约定（见 `1.md`）：`aggregate/` 聚合根、`entity/` 实体、`valobj/` 值对象与常量。
pub mod valobj;

pub use valobj::{balance_payload};

pub use balance_payload::BalancePayload;
