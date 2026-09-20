//! 供应商模型路由 DTO（`routing.json`）
//!
//! 客户端由所属 scope 目录确定（`<scope>/<slug>/routing.json`），因此一个供应商目录
//! 只可能属于一个客户端，无需再把客户端标识编进文件名。
//!
//! 「按客户端约定键名」的字段共同描述「要写进客户端配置文件的什么值」，
//! 键名与取值范围一律由客户端注册表（`domain::client::service::client_service`）登记，
//! 渲染时再翻译成目标文件的具体字段：
//! - `model_map` / `display_map` 的键 = [`ClientModelSlot`] 的 `key`
//!   （前者是「实际请求模型」，后者是「菜单显示名」）；
//! - `switches` 的键 = [`ClientSwitch`] 的 `key`；
//! - `options` 的键 = [`ClientOption`] 的 `key`；
//! - `model_catalog` 只在「模型映射」式客户端（Codex）上有意义。
//!
//! [`ClientModelSlot`]: crate::domain::client::service::client_service::ClientModelSlot
//! [`ClientSwitch`]: crate::domain::client::service::client_service::ClientSwitch
//! [`ClientOption`]: crate::domain::client::service::client_service::ClientOption

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::super::model_catalog::ModelCatalogEntry;

/// 面向某客户端的模型路由配置。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SupplierRouting {
    /// 客户端标识（与 scope 目录名一致，以目录名为准）。
    pub client_id: String,
    /// 模型映射：模型角色 → 供应商实际模型名（可带 `[1M]` 能力标记）。
    pub model_map: BTreeMap<String, String>,
    /// 菜单显示名：模型角色 → `/model` 菜单里展示的名字（空 = 不写该键）。
    pub display_map: BTreeMap<String, String>,
    /// 上下文窗口（token 数；0 表示沿用客户端默认）。
    pub context_window: u32,
    /// 自动压缩阈值（token 数；0 表示不写该键）。
    ///
    /// 只有 Codex 消费它：勾选「支持1M」时随 1M 窗口一起写入
    /// `model_auto_compact_token_limit`。
    pub compact_token_limit: u32,
    /// 模型目录（Codex 的 `model_catalog_json` 内容来源；其它客户端恒为空）。
    pub model_catalog: Vec<ModelCatalogEntry>,
    /// 额外开关（键与含义由客户端约定，如「流式」「思考模式」）。
    pub switches: BTreeMap<String, bool>,
    /// 枚举型选项：键与取值由客户端注册表的 `ClientOption` 约定（如 codex 的 `reasoning_effort`）。
    pub options: BTreeMap<String, String>,
}
