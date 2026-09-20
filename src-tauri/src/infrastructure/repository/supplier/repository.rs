//! SupplierRepository / UsageHistoryRepository / ModelCatalogRepository / UsageGateway 的实现
//!
//! 只做一件事：把领域层的仓储 trait 委派给本层的落盘实现（`<store>`）与远端客户端。

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
use crate::domain::supplier::repository::{
    ModelCatalogRepository, SupplierRepository, UsageGateway, UsageHistoryRepository,
};

/// 生产实现：直接落盘到便携数据目录。
pub struct SupplierRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static SUPPLIER_REPOSITORY: SupplierRepositoryImpl = SupplierRepositoryImpl;

impl SupplierRepository for SupplierRepositoryImpl {
    fn list_suppliers(&self, scope: &str) -> AppResult<Vec<SupplierIndexEntry>> {
        crate::infrastructure::repository::supplier::supplier_store::list_suppliers(scope)
    }

    fn list_slugs(&self, scope: &str) -> Vec<String> {
        crate::infrastructure::repository::supplier::supplier_store::list_slugs(scope)
    }

    fn read_profile(&self, scope: &str, slug: &str) -> AppResult<SupplierProfile> {
        crate::infrastructure::repository::supplier::supplier_store::read_profile(scope, slug)
    }

    fn save_profile(&self, scope: &str, profile: &SupplierProfile) -> AppResult<SupplierProfile> {
        crate::infrastructure::repository::supplier::supplier_store::save_profile(scope, profile)
    }

    fn read_credential(&self, scope: &str, slug: &str) -> AppResult<SupplierCredential> {
        crate::infrastructure::repository::supplier::supplier_store::read_credential(scope, slug)
    }

    fn save_credential(&self, scope: &str, slug: &str, credential: &SupplierCredential) -> AppResult<()> {
        crate::infrastructure::repository::supplier::supplier_store::save_credential(scope, slug, credential)
    }

    fn read_endpoint(&self, scope: &str, slug: &str) -> AppResult<SupplierEndpoint> {
        crate::infrastructure::repository::supplier::supplier_store::read_endpoint(scope, slug)
    }

    fn save_endpoint(&self, scope: &str, slug: &str, endpoint: &SupplierEndpoint) -> AppResult<()> {
        crate::infrastructure::repository::supplier::supplier_store::save_endpoint(scope, slug, endpoint)
    }

    fn read_routing(&self, scope: &str, slug: &str) -> AppResult<SupplierRouting> {
        crate::infrastructure::repository::supplier::supplier_store::read_routing(scope, slug)
    }

    fn save_routing(&self, scope: &str, slug: &str, routing: &SupplierRouting) -> AppResult<()> {
        crate::infrastructure::repository::supplier::supplier_store::save_routing(scope, slug, routing)
    }

    fn read_active(&self, scope: &str) -> AppResult<Option<String>> {
        crate::infrastructure::repository::supplier::supplier_store::read_active(scope)
    }

    fn set_active(&self, scope: &str, slug: &str) -> AppResult<()> {
        crate::infrastructure::repository::supplier::supplier_store::set_active(scope, slug)
    }

    fn delete_supplier(&self, scope: &str, slug: &str) -> AppResult<()> {
        crate::infrastructure::repository::supplier::supplier_store::delete_supplier(scope, slug)
    }

    fn read_common_config(&self, scope: &str) -> AppResult<String> {
        crate::infrastructure::repository::supplier::supplier_store::read_common_config(scope)
    }

    fn save_common_config(&self, scope: &str, snippet: &str) -> AppResult<()> {
        crate::infrastructure::repository::supplier::supplier_store::save_common_config(scope, snippet)
    }

    fn migrate_legacy_config(&self, legacy: &AppConfig) -> AppResult<Option<SupplierProfile>> {
        crate::infrastructure::repository::supplier::supplier_store::migrate_legacy_config(legacy)
    }
}

/// 生产实现：直接落盘到便携数据目录。
pub struct UsageHistoryRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static USAGE_HISTORY_REPOSITORY: UsageHistoryRepositoryImpl = UsageHistoryRepositoryImpl;

impl UsageHistoryRepository for UsageHistoryRepositoryImpl {
    fn read_usage_history(&self, scope: &str, slug: &str) -> AppResult<SupplierUsageHistory> {
        crate::infrastructure::repository::supplier::supplier_store::read_usage_history(scope, slug)
    }

    fn save_usage_history(&self, scope: &str, slug: &str, history: &SupplierUsageHistory) -> AppResult<()> {
        crate::infrastructure::repository::supplier::supplier_store::save_usage_history(scope, slug, history)
    }

    fn usage_history_exists(&self, scope: &str, slug: &str) -> AppResult<bool> {
        crate::infrastructure::repository::supplier::supplier_store::usage_history_exists(scope, slug)
    }

    fn cleanup_usage_files(&self) -> AppResult<usize> {
        crate::infrastructure::repository::supplier::supplier_store::cleanup_usage_files()
    }
}

/// 生产实现：远端模型列表接口。
pub struct ModelCatalogRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static MODEL_CATALOG_REPOSITORY: ModelCatalogRepositoryImpl = ModelCatalogRepositoryImpl;

impl ModelCatalogRepository for ModelCatalogRepositoryImpl {
    fn fetch_models<'a>(
        &'a self,
        base_url: &'a str,
        api_key: &'a str,
        api_format: &'a str,
        is_full_url: bool,
        models_url: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = AppResult<Vec<String>>> + Send + 'a>> {
        Box::pin(crate::infrastructure::http::model_client::fetch_models(
            base_url,
            api_key,
            api_format,
            is_full_url,
            models_url,
        ))
    }
}

/// 生产实现：声明式在线用量接口。
pub struct UsageGatewayImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static USAGE_GATEWAY: UsageGatewayImpl = UsageGatewayImpl;

impl UsageGateway for UsageGatewayImpl {
    fn render_url(
        &self,
        template: &str,
        credential: &SupplierCredential,
        query: &SupplierUsageQuery,
        now: DateTime<Local>,
        window: TimeWindow,
    ) -> AppResult<String> {
        crate::infrastructure::http::usage_client::render_url(template, credential, query, now, window)
    }

    fn fetch_usage<'a>(
        &'a self,
        endpoint: &'a SupplierEndpoint,
        credential: &'a SupplierCredential,
        query: &'a SupplierUsageQuery,
    ) -> Pin<Box<dyn Future<Output = AppResult<UsageSnapshot>> + Send + 'a>> {
        Box::pin(crate::infrastructure::http::usage_client::fetch_usage(
            endpoint, credential, query,
        ))
    }

    fn fetch_usage_in_window<'a>(
        &'a self,
        endpoint: &'a SupplierEndpoint,
        credential: &'a SupplierCredential,
        query: &'a SupplierUsageQuery,
        window: TimeWindow,
    ) -> Pin<Box<dyn Future<Output = AppResult<UsageSnapshot>> + Send + 'a>> {
        Box::pin(crate::infrastructure::http::usage_client::fetch_usage_in_window(
            endpoint, credential, query, window,
        ))
    }

    fn probe<'a>(
        &'a self,
        endpoint: &'a SupplierEndpoint,
    ) -> Pin<Box<dyn Future<Output = AppResult<u16>> + Send + 'a>> {
        Box::pin(crate::infrastructure::http::usage_client::probe(endpoint))
    }
}
