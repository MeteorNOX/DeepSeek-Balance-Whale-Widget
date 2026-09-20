//! 异常模块（全局统一异常体系）
//!
//! 全系统只使用一个错误类型 [`AppError`]，跨层传递一律使用 [`AppResult`]：
//!
//! - [`error::AppError`]：统一错误，`Display` 输出**就是**前端看到的文案，
//!   因此所有历史错误文本逐字保留，前端契约不变；
//! - [`guard`]：全局 panic 钩子与命令级 panic 守卫（避免单点异常拖垮进程）；
//! - [`wire::IntoWire`]：统一返回机制，把应用层结果转换为命令出参。
//!
//! 错误码枚举 [`crate::types::enums::ErrorCode`] 与其它枚举统一维护在
//! `types::enums` 下，本模块只负责「错误对象」与「异常处理机制」。

pub mod error;
pub mod guard;
pub mod wire;

pub use error::{AppError, AppResult};
pub use wire::IntoWire;
