//! config 领域的仓储抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这些 trait，代码里不出现任何文件 / 网络 / 框架细节。

use crate::types::exception::AppResult;
use crate::domain::config::model::AppConfig;

/// 应用配置仓储：整份配置的读取与原子写。
pub trait ConfigRepository: Send + Sync {
    /// 见 `config_store::get_config`。
    fn get(&self) -> AppConfig;

    /// 见 `config_store::update_config`。
    fn update(&self, new_cfg: AppConfig) -> AppResult<AppConfig>;

    /// 见 `config_store::mutate_config`。
    fn mutate(&self, mutator: Box<dyn FnOnce(&mut AppConfig)>) -> AppResult<AppConfig>;
}

/// 开机自启仓储：读写系统启动项（Windows 走注册表，见实现处）。
///
/// 「是否开机自启」是配置项，系统启动项是它的落地点，因此归在 config 领域。
pub trait AutostartRepository: Send + Sync {
    /// 见 `autostart::is_autostart_enabled`。
    fn is_enabled(&self) -> AppResult<bool>;

    /// 见 `autostart::set_autostart`：返回设置后的**系统真实状态**。
    fn set_enabled(&self, enabled: bool) -> AppResult<bool>;
}
