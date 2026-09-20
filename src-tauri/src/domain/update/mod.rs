//! 版本检查领域
//!
//! - `dto`：版本检查结果模型（前端读取 currentVersion / latestVersion / upToDate）；
//! - `update_service`：版本比较规则（精确字符串比较，不做语义化解析）。
//!
//! 远端请求属于基础设施（`infrastructure::http::update_client`）。

pub mod model;
pub mod repository;
pub mod service;
