//! ConfigRepository / AutostartRepository 的实现
//!
//! 只做一件事：把领域层的仓储 trait 委派给本层的落盘实现（`<store>`）与系统启动项。

use crate::types::exception::AppResult;
use crate::domain::config::model::AppConfig;
use crate::domain::config::repository::{AutostartRepository, ConfigRepository};

/// 生产实现：直接落盘到便携数据目录。
pub struct ConfigRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static CONFIG_REPOSITORY: ConfigRepositoryImpl = ConfigRepositoryImpl;

impl ConfigRepository for ConfigRepositoryImpl {
    fn get(&self) -> AppConfig {
        crate::infrastructure::repository::config::config_store::get_config()
    }

    fn update(&self, new_cfg: AppConfig) -> AppResult<AppConfig> {
        crate::infrastructure::repository::config::config_store::update_config(new_cfg)
    }

    fn mutate(&self, mutator: Box<dyn FnOnce(&mut AppConfig)>) -> AppResult<AppConfig> {
        crate::infrastructure::repository::config::config_store::mutate_config(mutator)
    }
}

/// 生产实现：系统启动项（Windows 注册表，见 `system::autostart`）。
pub struct AutostartRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static AUTOSTART_REPOSITORY: AutostartRepositoryImpl = AutostartRepositoryImpl;

impl AutostartRepository for AutostartRepositoryImpl {
    fn is_enabled(&self) -> AppResult<bool> {
        crate::infrastructure::system::autostart::is_autostart_enabled()
    }

    fn set_enabled(&self, enabled: bool) -> AppResult<bool> {
        crate::infrastructure::system::autostart::set_autostart(enabled)
    }
}
