//! supplier 领域的仓储抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这些 trait，代码里不出现任何文件 / 网络 / 框架细节。

use std::future::Future;
use std::pin::Pin;

use chrono::{DateTime, Local};

use crate::types::exception::AppResult;
use crate::domain::config::model::AppConfig;
use crate::domain::supplier::model::{
    SupplierCredential, SupplierEndpoint, SupplierIndexEntry, SupplierProfile, SupplierRouting,
    SupplierUsageQuery, TimeWindow, UsageSnapshot,
};
use crate::domain::supplier::model::SupplierUsageHistory;

/// 供应商仓储：目录索引、档案 / 密钥 / 地址 / 路由、启用项与客户端通用配置。
pub trait SupplierRepository: Send + Sync {
    /// 见 `supplier_store::list_suppliers`。
    fn list_suppliers(&self, scope: &str) -> AppResult<Vec<SupplierIndexEntry>>;

    /// 见 `supplier_store::list_slugs`。
    fn list_slugs(&self, scope: &str) -> Vec<String>;

    /// 见 `supplier_store::read_profile`。
    fn read_profile(&self, scope: &str, slug: &str) -> AppResult<SupplierProfile>;

    /// 见 `supplier_store::save_profile`。
    fn save_profile(&self, scope: &str, profile: &SupplierProfile) -> AppResult<SupplierProfile>;

    /// 见 `supplier_store::read_credential`。
    fn read_credential(&self, scope: &str, slug: &str) -> AppResult<SupplierCredential>;

    /// 见 `supplier_store::save_credential`。
    fn save_credential(&self, scope: &str, slug: &str, credential: &SupplierCredential) -> AppResult<()>;

    /// 见 `supplier_store::read_endpoint`。
    fn read_endpoint(&self, scope: &str, slug: &str) -> AppResult<SupplierEndpoint>;

    /// 见 `supplier_store::save_endpoint`。
    fn save_endpoint(&self, scope: &str, slug: &str, endpoint: &SupplierEndpoint) -> AppResult<()>;

    /// 见 `supplier_store::read_routing`。
    fn read_routing(&self, scope: &str, slug: &str) -> AppResult<SupplierRouting>;

    /// 见 `supplier_store::save_routing`。
    fn save_routing(&self, scope: &str, slug: &str, routing: &SupplierRouting) -> AppResult<()>;

    /// 见 `supplier_store::read_active`。
    fn read_active(&self, scope: &str) -> AppResult<Option<String>>;

    /// 见 `supplier_store::set_active`。
    fn set_active(&self, scope: &str, slug: &str) -> AppResult<()>;

    /// 见 `supplier_store::delete_supplier`。
    fn delete_supplier(&self, scope: &str, slug: &str) -> AppResult<()>;

    /// 见 `supplier_store::read_common_config`。
    fn read_common_config(&self, scope: &str) -> AppResult<String>;

    /// 见 `supplier_store::save_common_config`。
    fn save_common_config(&self, scope: &str, snippet: &str) -> AppResult<()>;

    /// 见 `supplier_store::migrate_legacy_config`。
    fn migrate_legacy_config(&self, legacy: &AppConfig) -> AppResult<Option<SupplierProfile>>;
}

/// 历史用量仓储：按日聚合的用量落盘（账单与用量图的唯一数据源）。
pub trait UsageHistoryRepository: Send + Sync {
    /// 见 `supplier_store::read_usage_history`。
    fn read_usage_history(&self, scope: &str, slug: &str) -> AppResult<SupplierUsageHistory>;

    /// 见 `supplier_store::save_usage_history`。
    fn save_usage_history(&self, scope: &str, slug: &str, history: &SupplierUsageHistory) -> AppResult<()>;

    /// 见 `supplier_store::usage_history_exists`。
    fn usage_history_exists(&self, scope: &str, slug: &str) -> AppResult<bool>;

    /// 见 `supplier_store::cleanup_usage_files`。
    fn cleanup_usage_files(&self) -> AppResult<usize>;
}

/// 模型列表端口：按界面草稿向供应商的模型接口取可用模型名。
///
/// 「候选地址怎么拼、鉴权头用哪个」都是领域规则（`model_service`），
/// 本端口只负责「发请求 + 读响应」这一步。
pub trait ModelCatalogRepository: Send + Sync {
    /// 见 `model_client::fetch_models`。
    fn fetch_models<'a>(
        &'a self,
        base_url: &'a str,
        api_key: &'a str,
        api_format: &'a str,
        is_full_url: bool,
        models_url: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = AppResult<Vec<String>>> + Send + 'a>>;
}

/// 在线用量端口：按供应商的声明式查询描述发起请求并解析响应。
///
/// 异步方法用装箱 `Future` 声明：仓储需要作为 `dyn` trait 对象注入，
/// 原生 `async fn` 在 trait 里不可 dyn 化。
pub trait UsageGateway: Send + Sync {
    /// 见 `usage_client::render_url`：把请求地址模板渲染成实际地址。
    ///
    /// 它是纯计算，但与 `fetch_*` 同属「在线用量协议」的一部分，
    /// 因此一并由本端口暴露，应用层无需知道模板规则落在哪一层。
    fn render_url(
        &self,
        template: &str,
        credential: &SupplierCredential,
        query: &SupplierUsageQuery,
        now: DateTime<Local>,
        window: TimeWindow,
    ) -> AppResult<String>;

    /// 见 `usage_client::fetch_usage`。
    fn fetch_usage<'a>(
        &'a self,
        endpoint: &'a SupplierEndpoint,
        credential: &'a SupplierCredential,
        query: &'a SupplierUsageQuery,
    ) -> Pin<Box<dyn Future<Output = AppResult<UsageSnapshot>> + Send + 'a>>;

    /// 见 `usage_client::fetch_usage_in_window`。
    fn fetch_usage_in_window<'a>(
        &'a self,
        endpoint: &'a SupplierEndpoint,
        credential: &'a SupplierCredential,
        query: &'a SupplierUsageQuery,
        window: TimeWindow,
    ) -> Pin<Box<dyn Future<Output = AppResult<UsageSnapshot>> + Send + 'a>>;

    /// 见 `usage_client::probe`：只探测请求地址可达性。
    fn probe<'a>(
        &'a self,
        endpoint: &'a SupplierEndpoint,
    ) -> Pin<Box<dyn Future<Output = AppResult<u16>> + Send + 'a>>;
}
