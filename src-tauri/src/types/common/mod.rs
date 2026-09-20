//! 公共模块
//!
//! 存放跨层复用的常量与共享定义。本模块**不得**依赖任何业务分层
//! （domain / infrastructure / application / api），以保证依赖方向单一。

pub mod constants;
