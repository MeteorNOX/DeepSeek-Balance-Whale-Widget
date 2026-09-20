//! 供应商用例的入参对象
//!
//! 命令层把前端线缆 DTO 转成这里的对象后再调用用例；对象本身不承载业务逻辑。

use crate::domain::supplier::model::{
    SupplierCredential, SupplierEndpoint, SupplierProfile, SupplierRouting,
};

/// 保存请求（用例输入）：命令层把前端线缆 DTO 逐字段转成领域 DTO 后传入。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SupplierSaveInput {
    /// 目标列表（scope）。
    pub scope: String,
    /// 标识：空串表示新建；非空时视为编辑目标，或新建时前端建议的 slug 基名。
    pub slug: String,
    /// 展示信息（`slug` / `created_at` / `order` 由用例与存储层决定，传入值会被覆盖）。
    pub profile: SupplierProfile,
    /// API 密钥。
    pub credential: SupplierCredential,
    /// 请求地址。
    pub endpoint: SupplierEndpoint,
    /// 模型路由（仅客户端列表适用，余额配置列表会忽略它）。
    pub routing: Option<SupplierRouting>,
}
