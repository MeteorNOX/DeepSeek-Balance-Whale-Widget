//! 模型列表用例的入参对象
//!
//! 全部来自界面草稿，不承载业务逻辑；领域规则在
//! `domain::supplier::service::model_service`。

/// 取模型列表入参（全部来自界面草稿，不落盘）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelFetchInput {
    /// 请求地址（供应商根地址，或 `full_url` 为真时的完整请求地址）。
    pub base_url: String,
    /// API 密钥。
    pub api_key: String,
    /// API 协议格式（决定鉴权头：Anthropic 用 `x-api-key`，其余用 Bearer）。
    pub api_format: String,
    /// `base_url` 是否为完整请求地址。
    pub full_url: bool,
    /// 预设里显式声明的模型列表地址（非空时只试它）。
    pub models_url: String,
}
