//! 余额领域
//!
//! - `dto`：余额 / 用量的对外载荷模型（前端挂件据此渲染可用额度、今日已用、峰谷状态）。
//!
//! 本领域只有对外数据模型，**没有独立的领域规则**：
//! 记账规则属于 `domain::ledger`、峰谷判定属于 `domain::pricing`、
//! 远端交互属于 `infrastructure::http::usage_client`（按供应商配置声明式查询），
//! 三者的编排属于用例 `application::usage::service` 与
//! `application::balance::service`。

pub mod model;
pub mod repository;
