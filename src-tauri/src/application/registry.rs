//! 依赖装配（组合根注入）
//!
//! 应用层只依赖 `domain` 里的仓储 / 端口 trait；具体实现由**组合根**（`lib.rs`）在启动时
//! 注入一次。这样应用层代码里不会出现任何基础设施类型，替换存储实现（测试替身、
//! 未来的其它落盘方式）都不必改业务代码 —— 这正是依赖倒置要解决的问题。
//!
//! 未装配时访问仓储会 panic：装配是启动的第一件事，漏装属于编码错误，
//! 静默兜底只会让线上出现「配置读不到却查不出原因」的怪现象。
//!
//! # 两类扩展点
//! - **落盘仓储**：`ConfigRepository` / `BubbleRepository` / … 读写便携数据目录；
//! - **外部端口**：`AssetPicker`（选文件）、`ClientConfigRepository`（写客户端配置）、
//!   `MattingRepository`（抠图推理）、`ModelCatalogRepository` / `UsageGateway`
//!   （供应商接口）、`ExchangeRateRepository`（汇率）、`UpdateRepository`（版本清单）、
//!   `AutostartRepository`（开机自启）、`SystemHost`（数据目录与外部程序）。
//!   它们都不是「存储」，但同样是「应用层需要、由基础设施提供」的能力。

use std::sync::OnceLock;

use crate::domain::asset::repository::AssetPicker;
use crate::domain::audio::repository::AudioRepository;
use crate::domain::balance::repository::ExchangeRateRepository;
use crate::domain::bubble::repository::BubbleRepository;
use crate::domain::client::repository::ClientConfigRepository;
use crate::domain::config::repository::{AutostartRepository, ConfigRepository};
use crate::domain::ledger::repository::LedgerRepository;
use crate::domain::pricing::repository::{HolidayCacheRepository, HolidaySource};
use crate::domain::supplier::repository::{
    ModelCatalogRepository, SupplierRepository, UsageGateway, UsageHistoryRepository,
};
use crate::domain::system::repository::SystemHost;
use crate::domain::update::repository::UpdateRepository;
use crate::domain::widget_image::repository::{MattingRepository, PicRepository};

/// 组合根注入的仓储实现集合。
pub struct Repositories {
    /// 应用配置仓储（`config.json`）。
    pub config: &'static dyn ConfigRepository,
    /// 模块化气泡仓储（气泡组与媒体 / 字体资源）。
    pub bubble: &'static dyn BubbleRepository,
    /// 供应商仓储（供应商目录与档案 / 密钥 / 地址 / 路由）。
    pub supplier: &'static dyn SupplierRepository,
    /// 历史用量仓储（按日聚合的用量落盘）。
    pub usage_history: &'static dyn UsageHistoryRepository,
    /// 本地记账账本仓储。
    pub ledger: &'static dyn LedgerRepository,
    /// 挂件图片仓储。
    pub pic: &'static dyn PicRepository,
    /// 音效仓储。
    pub audio: &'static dyn AudioRepository,
    /// 开机自启仓储（系统启动项）。
    pub autostart: &'static dyn AutostartRepository,
    /// 素材选择端口（系统文件对话框）。
    pub asset_picker: &'static dyn AssetPicker,
    /// 客户端配置文件网关。
    pub client_config: &'static dyn ClientConfigRepository,
    /// 智能抠图端口（本地模型推理）。
    pub matting: &'static dyn MattingRepository,
    /// 模型列表端口（供应商 `/v1/models`）。
    pub model_catalog: &'static dyn ModelCatalogRepository,
    /// 在线用量端口（声明式查询）。
    pub usage_gateway: &'static dyn UsageGateway,
    /// 汇率端口。
    pub exchange_rate: &'static dyn ExchangeRateRepository,
    /// 节假日缓存仓储（峰谷日历的本地 JSON 缓存）。
    pub holiday_store: &'static dyn HolidayCacheRepository,
    /// 节假日数据源端口（第三方权威接口）。
    pub holiday_source: &'static dyn HolidaySource,
    /// 版本清单端口（检查更新）。
    pub update_client: &'static dyn UpdateRepository,
    /// 宿主环境端口（数据目录与系统默认程序）。
    pub system_host: &'static dyn SystemHost,
}

static CONFIG: OnceLock<&'static dyn ConfigRepository> = OnceLock::new();
static BUBBLE: OnceLock<&'static dyn BubbleRepository> = OnceLock::new();
static SUPPLIER: OnceLock<&'static dyn SupplierRepository> = OnceLock::new();
static USAGE_HISTORY: OnceLock<&'static dyn UsageHistoryRepository> = OnceLock::new();
static LEDGER: OnceLock<&'static dyn LedgerRepository> = OnceLock::new();
static PIC: OnceLock<&'static dyn PicRepository> = OnceLock::new();
static AUDIO: OnceLock<&'static dyn AudioRepository> = OnceLock::new();
static AUTOSTART: OnceLock<&'static dyn AutostartRepository> = OnceLock::new();
static ASSET_PICKER: OnceLock<&'static dyn AssetPicker> = OnceLock::new();
static CLIENT_CONFIG: OnceLock<&'static dyn ClientConfigRepository> = OnceLock::new();
static MATTING: OnceLock<&'static dyn MattingRepository> = OnceLock::new();
static MODEL_CATALOG: OnceLock<&'static dyn ModelCatalogRepository> = OnceLock::new();
static USAGE_GATEWAY: OnceLock<&'static dyn UsageGateway> = OnceLock::new();
static EXCHANGE_RATE: OnceLock<&'static dyn ExchangeRateRepository> = OnceLock::new();
static HOLIDAY_STORE: OnceLock<&'static dyn HolidayCacheRepository> = OnceLock::new();
static HOLIDAY_SOURCE: OnceLock<&'static dyn HolidaySource> = OnceLock::new();
static UPDATE_CLIENT: OnceLock<&'static dyn UpdateRepository> = OnceLock::new();
static SYSTEM_HOST: OnceLock<&'static dyn SystemHost> = OnceLock::new();

/// 装配全部仓储与端口（幂等：重复调用只生效一次）。
pub fn install(repos: Repositories) {
    let _ = CONFIG.set(repos.config);
    let _ = BUBBLE.set(repos.bubble);
    let _ = SUPPLIER.set(repos.supplier);
    let _ = USAGE_HISTORY.set(repos.usage_history);
    let _ = LEDGER.set(repos.ledger);
    let _ = PIC.set(repos.pic);
    let _ = AUDIO.set(repos.audio);
    let _ = AUTOSTART.set(repos.autostart);
    let _ = ASSET_PICKER.set(repos.asset_picker);
    let _ = CLIENT_CONFIG.set(repos.client_config);
    let _ = MATTING.set(repos.matting);
    let _ = MODEL_CATALOG.set(repos.model_catalog);
    let _ = USAGE_GATEWAY.set(repos.usage_gateway);
    let _ = EXCHANGE_RATE.set(repos.exchange_rate);
    let _ = HOLIDAY_STORE.set(repos.holiday_store);
    let _ = HOLIDAY_SOURCE.set(repos.holiday_source);
    let _ = UPDATE_CLIENT.set(repos.update_client);
    let _ = SYSTEM_HOST.set(repos.system_host);
}

/// 应用配置仓储。
pub fn config() -> &'static dyn ConfigRepository {
    *CONFIG.get().expect("应用配置仓储未装配：组合根需调用 install")
}

/// 模块化气泡仓储。
pub fn bubble() -> &'static dyn BubbleRepository {
    *BUBBLE.get().expect("气泡仓储未装配：组合根需调用 install")
}

/// 供应商仓储。
pub fn supplier() -> &'static dyn SupplierRepository {
    *SUPPLIER.get().expect("供应商仓储未装配：组合根需调用 install")
}

/// 历史用量仓储。
pub fn usage_history() -> &'static dyn UsageHistoryRepository {
    *USAGE_HISTORY.get().expect("历史用量仓储未装配：组合根需调用 install")
}

/// 本地记账账本仓储。
pub fn ledger() -> &'static dyn LedgerRepository {
    *LEDGER.get().expect("账本仓储未装配：组合根需调用 install")
}

/// 挂件图片仓储。
pub fn pic() -> &'static dyn PicRepository {
    *PIC.get().expect("图片仓储未装配：组合根需调用 install")
}

/// 音效仓储。
pub fn audio() -> &'static dyn AudioRepository {
    *AUDIO.get().expect("音效仓储未装配：组合根需调用 install")
}

/// 开机自启仓储。
pub fn autostart() -> &'static dyn AutostartRepository {
    *AUTOSTART.get().expect("开机自启仓储未装配：组合根需调用 install")
}

/// 素材选择端口。
pub fn asset_picker() -> &'static dyn AssetPicker {
    *ASSET_PICKER.get().expect("素材选择端口未装配：组合根需调用 install")
}

/// 客户端配置文件网关。
pub fn client_config() -> &'static dyn ClientConfigRepository {
    *CLIENT_CONFIG.get().expect("客户端配置网关未装配：组合根需调用 install")
}

/// 智能抠图端口。
pub fn matting() -> &'static dyn MattingRepository {
    *MATTING.get().expect("抠图端口未装配：组合根需调用 install")
}

/// 模型列表端口。
pub fn model_catalog() -> &'static dyn ModelCatalogRepository {
    *MODEL_CATALOG.get().expect("模型列表端口未装配：组合根需调用 install")
}

/// 在线用量端口。
pub fn usage_gateway() -> &'static dyn UsageGateway {
    *USAGE_GATEWAY.get().expect("在线用量端口未装配：组合根需调用 install")
}

/// 汇率端口。
pub fn exchange_rate() -> &'static dyn ExchangeRateRepository {
    *EXCHANGE_RATE.get().expect("汇率端口未装配：组合根需调用 install")
}

/// 节假日缓存仓储。
pub fn holiday_store() -> &'static dyn HolidayCacheRepository {
    *HOLIDAY_STORE
        .get()
        .expect("节假日缓存仓储未装配：组合根需调用 install")
}

/// 节假日数据源端口。
pub fn holiday_source() -> &'static dyn HolidaySource {
    *HOLIDAY_SOURCE
        .get()
        .expect("节假日数据源端口未装配：组合根需调用 install")
}

/// 版本清单端口。
pub fn update_client() -> &'static dyn UpdateRepository {
    *UPDATE_CLIENT.get().expect("版本清单端口未装配：组合根需调用 install")
}

/// 宿主环境端口。
pub fn system_host() -> &'static dyn SystemHost {
    *SYSTEM_HOST.get().expect("宿主环境端口未装配：组合根需调用 install")
}
