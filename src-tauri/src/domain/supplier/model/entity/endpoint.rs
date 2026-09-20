//! 供应商请求地址 DTO（`endpoint.json`）

use serde::{Deserialize, Serialize};

/// 默认 API 协议格式：旧配置的 `base_url` 面向 Claude，即 Anthropic 协议。
pub const DEFAULT_API_FORMAT: &str = "anthropic";

/// 默认认证字段：Anthropic 协议使用 `x-api-key` 请求头。
pub const DEFAULT_AUTH_FIELD: &str = "x-api-key";

/// 供应商请求地址与协议配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SupplierEndpoint {
    /// 请求根地址（已去掉尾部斜杠）。
    pub base_url: String,
    /// `base_url` 是否为可直接请求的完整 URL（为真时不再拼接端点路径）。
    pub full_url: bool,
    /// API 协议格式（`anthropic` / `openai` / …，白名单见 `supplier_service`）。
    pub api_format: String,
    /// 认证字段（请求头名，白名单见 `supplier_service`）。
    pub auth_field: String,
    /// 候选端点（按优先级排列，命中即用，顺序不可排序）。
    pub endpoint_candidates: Vec<String>,
}

impl Default for SupplierEndpoint {
    /// 缺失字段的兜底值即「Anthropic 协议的官方形态」，保证半成品配置仍可用。
    fn default() -> Self {
        Self {
            base_url: String::new(),
            full_url: false,
            api_format: DEFAULT_API_FORMAT.to_string(),
            auth_field: DEFAULT_AUTH_FIELD.to_string(),
            endpoint_candidates: Vec::new(),
        }
    }
}
