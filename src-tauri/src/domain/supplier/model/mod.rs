//! 供应商数据传输对象
//!
//! 与 `<数据目录>/supplier/` 的磁盘布局一一对应：
//! - [`index`]：`index.json` 全量索引缓存（不含密钥）；
//! - [`active`]：`<scope>/active.json` 该列表的当前启用项；
//! - [`profile`]：`<scope>/<slug>/profile.json` 展示信息（名称 / 备注 / 分类 / 排序等）；
//! - [`credential`]：`<scope>/<slug>/credential.json` API 密钥；
//! - [`endpoint`]：`<scope>/<slug>/endpoint.json` 请求地址与协议；
//! - [`usage_history`]：`<scope>/<slug>/usage_history.json` 按日聚合的历史用量。
//!   它是账单与用量图表的**唯一数据源**，因此只有 `balance` 列表的供应商才落盘；
//!   客户端列表（claude / codex / 自定义）只做模型路由，不写该文件；
//! - [`routing`]：`<scope>/<slug>/routing.json` 面向该 scope 对应客户端的模型路由。
//!
//! 另有两个**不落盘**的前端契约模型：
//! - [`usage_report`]：用量报表（在线优先 / 本地兜底的最终结果）；
//! - [`connection_test`]：连通性测试结果。
//!
//! `scope` 既是一级目录名，也是「这个列表属于谁」的唯一标识：
//! `balance` 为保留字（余额配置列表），其余 scope 名即客户端 id（可动态扩展）。
//!
//! 所有落盘结构体的字段名即磁盘键名（snake_case）：磁盘格式与前端契约（camelCase）
//! 分离，前端字段名的调整由 `api` 层转换，不得动摇磁盘结构。不落盘的前端契约模型
//! （报表 / 连通性结果）则直接使用 camelCase。

//! 目录约定（见 `1.md`）：`aggregate/` 聚合根、`entity/` 实体、`valobj/` 值对象与常量。
pub mod aggregate;
pub mod entity;
pub mod valobj;

pub use aggregate::{index};
pub use entity::{active, credential, endpoint, profile, routing};
pub use valobj::{
    connection_test, model_catalog, usage_history, usage_query, usage_report, usage_snapshot,
};

pub use active::ScopeActive;
pub use connection_test::ConnectionTestResult;
pub use credential::SupplierCredential;
pub use endpoint::{SupplierEndpoint, DEFAULT_API_FORMAT, DEFAULT_AUTH_FIELD};
pub use index::{SupplierIndex, SupplierIndexEntry, INDEX_VERSION};
pub use model_catalog::ModelCatalogEntry;
pub use profile::SupplierProfile;
pub use routing::SupplierRouting;
#[allow(unused_imports)]
pub use usage_history::{DailyUsage, ModelUsage, SupplierUsageHistory};
pub use usage_query::{
    is_reserved_placeholder, SupplierUsageQuery, TimeWindow, UsageExtract, API_KEY_PLACEHOLDERS,
    DATE_PLACEHOLDER, DEFAULT_AUTH_TYPE, DEFAULT_METHOD, DEFAULT_SCALE, END_PLACEHOLDER,
    MONTH_NUM_PLACEHOLDER, MONTH_PLACEHOLDER, START_PLACEHOLDER, TIMESTAMP_PLACEHOLDER,
    TOKEN_SOURCES, TOKEN_SOURCE_API_KEY, TOKEN_SOURCE_USAGE_TOKEN, TZ_PLACEHOLDER,
    USAGE_TOKEN_PLACEHOLDERS, WILDCARD_SEGMENT, WINDOWS, WINDOW_DAY, WINDOW_MONTH,
    YEAR_PLACEHOLDER,
};
pub use usage_report::{UsageHour, UsageModel, UsagePoint, UsageReport};
pub use usage_snapshot::UsageSnapshot;
