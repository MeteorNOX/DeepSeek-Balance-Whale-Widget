//! 版本检查数据传输对象

//! 目录约定（见 `1.md`）：`aggregate/` 聚合根、`entity/` 实体、`valobj/` 值对象与常量。
pub mod valobj;

pub use valobj::{update_check_result};

pub use update_check_result::UpdateCheckResult;
