//! 峰谷日历用例
//!
//! 编排「缓存 → 第三方接口 → 内置兜底」的数据装配，并向 api 层提供「某年日历视图」。
//! 具体分工见 [`service`] 与 [`result`]。

pub mod result;
pub mod service;
