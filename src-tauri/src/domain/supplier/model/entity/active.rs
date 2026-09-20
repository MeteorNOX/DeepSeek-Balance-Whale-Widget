//! 列表当前启用项 DTO（`active.json`）
//!
//! 每个 scope 目录下各有一份：它记录「这个列表当前启用哪个供应商」，
//! 是真实状态而非可推导数据（同一供应商可以被多个列表同时启用，也可能一个都不启用）。

use serde::{Deserialize, Serialize};

/// scope 的当前启用项标记（`active.json`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ScopeActive {
    /// 当前启用的供应商标识；空串表示未启用。
    pub active_slug: String,
}
