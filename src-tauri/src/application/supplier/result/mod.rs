//! 供应商用例的出参对象
//!
//! 只承载「查出 / 保存了什么」，不含业务逻辑；线缆转换（camelCase）在 `api/dto`。

use crate::domain::supplier::model::{
    SupplierCredential, SupplierEndpoint, SupplierProfile, SupplierRouting,
};

/// 列表卡片数据：展示信息 + 请求地址 + 启用状态（不含密钥）。
#[derive(Debug, Clone, PartialEq)]
pub struct SupplierCard {
    /// 所属列表（已归一化的 scope）。
    pub scope: String,
    /// 展示信息（`profile.json`）。
    pub profile: SupplierProfile,
    /// 请求地址（`endpoint.json`）。
    pub endpoint: SupplierEndpoint,
    /// 是否为该列表的当前启用项。
    pub active: bool,
}

/// 供应商完整详情（编辑弹窗预填；含密钥，只在本地进程内传递）。
#[derive(Debug, Clone, PartialEq)]
pub struct SupplierDetail {
    /// 所属列表（已归一化的 scope）。
    pub scope: String,
    /// 展示信息。
    pub profile: SupplierProfile,
    /// API 密钥。
    pub credential: SupplierCredential,
    /// 请求地址。
    pub endpoint: SupplierEndpoint,
    /// 模型路由；余额配置列表恒为 `None`。
    pub routing: Option<SupplierRouting>,
    /// 是否为该列表的当前启用项。
    pub active: bool,
}

/// 保存结果。
#[derive(Debug, Clone, PartialEq)]
pub struct SupplierSaveOutcome {
    /// 保存后回读的详情（即磁盘现状，已归一化）。
    pub detail: SupplierDetail,
    /// 改动的是余额配置列表的当前启用项、且密钥或请求地址发生变化：
    /// `true` 表示命令层需要通知前端重新拉取余额。
    pub balance_source_changed: bool,
}
