//! 客户端领域
//!
//! - `model`：渲染客户端配置文件用到的值对象（渲染输入 / 渲染结果 / 写入结果）；
//! - `client_service`：客户端注册表（UI 标签页、logo 与配置文件归属的唯一登记处）。
//!
//! 客户端真实配置文件的解析与落盘属于基础设施（`infrastructure::system::client_config`），
//! 领域层只以 [`repository::ClientConfigRepository`] 声明该能力。

pub mod model;
pub mod repository;
pub mod service;
