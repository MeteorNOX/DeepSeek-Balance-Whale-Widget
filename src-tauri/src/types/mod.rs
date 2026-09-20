//! 公共类型模块（Types）
//!
//! 收敛全系统的「横切资产」：全局常量、领域枚举、统一异常体系与通用工具。
//!
//! - `common`：与前端 / 操作系统约定的常量（窗口标识、事件名、菜单项）；
//! - `enums`：领域枚举（币种、播放模式、音效模式、图片状态、吸附锚点、峰谷时段）；
//! - `exception`：统一错误类型、错误码、全局异常捕获与统一返回；
//! - `utils`：与业务无关的纯工具（编码、文件、数值）。
//!
//! 本模块**不得**依赖任何业务分层（domain / infrastructure / application / api），
//! 以保证依赖方向始终自上而下。

pub mod common;
pub mod enums;
pub mod exception;
pub mod utils;
