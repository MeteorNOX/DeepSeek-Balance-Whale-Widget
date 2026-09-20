//! 应用层（Application）
//!
//! 编排领域规则与基础设施，实现一个个**用例**（Use Case）。
//!
//! 关键约束：本层**不依赖 Tauri**，也**不依赖 `infrastructure`** ——
//! 需要落盘 / 联网 / 系统对话框时，一律经由 [`registry`] 取 `domain` 里的
//! 仓储与端口 trait，实现由组合根（`lib.rs`）注入。
//! - 返回「发生了什么」的描述（如 [`config::result::ConfigSaveOutcome`]），
//!   事件广播由 `api` 层完成；
//! - 需要进度反馈的用例以回调形式表达（如模型下载进度）。
//!
//! 每个用例目录内的分工：`service` 是编排，`command` / `query` / `result`
//! 只放轻量的入参出参对象（不承载业务逻辑）。
//!
//! 这样用例既可以在命令层被调用，也可以被测试直接驱动。

pub mod audio;
pub mod balance;
pub mod bubble;
pub mod config;
pub mod model;
pub mod pricing;
pub mod routing;
pub mod supplier;
pub mod system;
pub mod usage;
pub mod widget_image;
pub mod window;
pub mod registry;
