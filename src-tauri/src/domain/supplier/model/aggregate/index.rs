//! 供应商索引 DTO（`index.json`）
//!
//! 索引是「列表 / 排序」的读取入口，因此**只收录不含密钥的信息**：
//! 即使索引被监看，也不泄露任何 API Key。
//!
//! 索引是覆盖全部 scope 的全量缓存，因此 `(scope, slug)` 才是条目的唯一标识：
//! 同一个供应商在余额配置列表与某个客户端列表下会各有一条。

use serde::{Deserialize, Serialize};

use super::super::profile::SupplierProfile;

/// 索引结构版本：磁盘结构变化时递增，供后续兼容读取。
pub const INDEX_VERSION: u32 = 2;

/// 供应商索引。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SupplierIndex {
    /// 索引结构版本。
    pub version: u32,
    /// 供应商条目（先按 scope、再按 `order` / 名称排序）。
    pub suppliers: Vec<SupplierIndexEntry>,
}

impl Default for SupplierIndex {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            suppliers: Vec::new(),
        }
    }
}

/// 索引条目：列表展示所需的全部字段，不含密钥。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SupplierIndexEntry {
    /// 所属列表（即 scope 目录名；`balance` 为余额配置列表，其余为客户端标识）。
    pub scope: String,
    /// 供应商标识（目录名）。
    pub slug: String,
    /// 展示名称。
    pub name: String,
    /// 分类。
    pub category: String,
    /// Logo 标识。
    pub logo: String,
    /// 排序权重。
    pub order: i64,
    /// 是否是该 scope 的当前启用项。
    pub active: bool,
}

impl SupplierIndexEntry {
    /// 由展示信息 + 所属 scope 投影出索引条目：索引只是 `profile.json` 的裁剪视图，
    /// 任何字段新增都应先落在 profile 上。
    ///
    /// `scope` 与 `active` 都来自目录结构（scope 目录名与 `active.json`），
    /// 无法从 profile 推导，因此必须由存储层显式传入。
    pub fn new(scope: &str, profile: &SupplierProfile, active: bool) -> Self {
        Self {
            scope: scope.to_string(),
            slug: profile.slug.clone(),
            name: profile.name.clone(),
            category: profile.category.clone(),
            logo: profile.logo.clone(),
            order: profile.order,
            active,
        }
    }
}
