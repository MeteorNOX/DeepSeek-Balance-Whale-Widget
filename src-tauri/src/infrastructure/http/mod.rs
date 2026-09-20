//! HTTP 客户端
//!
//! 所有远端交互集中在此：**在线用量查询**（含连通性探测）、汇率接口、版本清单、
//! 模型列表（`/v1/models`）、**节假日数据源**（峰谷日历的权威数据）。
//! 网络失败一律转换为 [`crate::types::exception::AppError`]，并按「是否可重试」
//! 标记 `transient`，供上层决定是否回退到最近一次成功值。
//!
//! 注意：原先「写死 DeepSeek 余额接口」的那个客户端已被 [`usage_client`]
//! 的声明式查询完全取代——供应商之间只有配置差异，不该有代码差异。

pub mod currency_client;
pub mod holiday_client;
pub mod model_client;
pub mod update_client;
pub mod usage_client;
