//! 模型组配置 DTO

use serde::{Deserialize, Serialize};

use super::super::model_entry::ModelEntry;

/// Haiku / Sonnet / Opus 三个系列的默认调用模型配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    /// 主模型（默认调用模型，映射 ANTHROPIC_MODEL / Codex model）。
    pub primary: ModelEntry,
    /// 快速轻量档（Haiku）。
    pub haiku: ModelEntry,
    /// 均衡档（Sonnet）。
    pub sonnet: ModelEntry,
    /// 旗舰推理档（Opus）。
    pub opus: ModelEntry,
}

impl Default for ModelConfig {
    /// 返回 Claude / Codex 共用的默认模型配置。
    fn default() -> Self {
        Self {
            primary: ModelEntry::new("deepseek-v4-flash", 1_000_000),
            haiku: ModelEntry::new("deepseek-v4-flash", 1_000_000),
            sonnet: ModelEntry::new("deepseek-v4-flash", 1_000_000),
            opus: ModelEntry::new("deepseek-v4-flash", 1_000_000),
        }
    }
}
