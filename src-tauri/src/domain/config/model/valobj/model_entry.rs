//! 单个模型系列配置 DTO

use serde::{Deserialize, Serialize};

/// 单个模型系列的配置：模型名称 + 上下文窗口大小。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// 模型名称（用户可自定义，如 `deepseek-chat`）。
    pub name: String,
    /// 上下文窗口大小（token 数）。
    pub context_window: u32,
}

impl ModelEntry {
    /// 构造单个模型项。
    pub(crate) fn new(name: &str, context_window: u32) -> Self {
        Self {
            name: name.to_string(),
            context_window,
        }
    }
}
