//! 供应商展示信息 DTO（`profile.json`）

use serde::{Deserialize, Serialize};

/// 供应商展示信息。
///
/// `slug` 与供应商目录名一一对应；读取时以目录名为准（目录是唯一事实来源），
/// 因此文件内的 `slug` 仅作为展示副本，允许被磁盘现状覆盖。
///
/// 「该供应商属于哪个列表」「哪个供应商当前启用」都不落在展示信息里：
/// 前者由 scope 目录名表达，后者由同级的 `active.json` 表达，
/// 因此同一个供应商可以在多个 scope 下各存一份互不影响的配置。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SupplierProfile {
    /// 供应商标识（即目录名，仅 `[a-z0-9-]`）。
    pub slug: String,
    /// 展示名称。
    pub name: String,
    /// 备注。
    pub note: String,
    /// 官网地址。
    pub homepage: String,
    /// API Key 获取页地址。
    pub api_key_url: String,
    /// 分类（如「官方」「第三方」「自定义」）。
    pub category: String,
    /// Logo 标识（emoji 或资源名，由前端解释）。
    pub logo: String,
    /// 创建时间（`YYYY-MM-DD HH:MM:SS`，本地时区）。
    pub created_at: String,
    /// 排序权重（升序，越小越靠前）。
    pub order: i64,
}
