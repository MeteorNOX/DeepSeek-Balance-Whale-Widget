//! 台词管理配置 DTO

use serde::{Deserialize, Serialize};

use super::super::defaults::*;

/// 台词管理配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogueConfig {
    /// 台词列表。
    #[serde(default = "default_dialogue_lines")]
    pub lines: Vec<String>,
    /// 播放模式：`carousel`（轮播）/ `random`（随机）。
    #[serde(default = "default_dialogue_mode")]
    pub mode: String,
    /// 每句台词基础间隔（分钟）。
    #[serde(default = "default_dialogue_interval")]
    pub interval_min: u32,
    /// 波动幅度（0–100，步长 1%）。
    #[serde(default)]
    pub jitter: u32,
}

impl Default for DialogueConfig {
    /// 返回台词管理默认配置。
    fn default() -> Self {
        Self {
            lines: default_dialogue_lines(),
            mode: default_dialogue_mode(),
            interval_min: default_dialogue_interval(),
            jitter: 0,
        }
    }
}
