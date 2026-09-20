//! 应用配置数据传输对象
//!
//! 按配置项职责拆分：
//! - [`app_config`]：顶层配置（`config.json` 根结构）；
//! - [`model_config`] / [`model_entry`]：模型组与单个模型项；
//! - [`widget_config`]：挂件显示配置；
//! - [`dialogue_config`]：台词管理配置；
//! - [`bubble_config`]：模块化气泡配置（模块化气泡的自定义内容）；
//! - [`widget_position`]：挂件位置与朝向；
//! - [`defaults`]：全部默认常量与默认值函数。

//! 目录约定（见 `1.md`）：`aggregate/` 聚合根、`entity/` 实体、`valobj/` 值对象与常量。
pub mod aggregate;
pub mod entity;
pub mod valobj;

pub use aggregate::{app_config};
pub use entity::{widget_config, dialogue_config, model_config};
pub use valobj::{model_entry, widget_position, defaults};

pub use app_config::AppConfig;

pub use dialogue_config::DialogueConfig;
pub use widget_config::WidgetConfig;
pub use widget_position::WidgetPosition;
pub(super) use defaults::{
    default_blink_interval_max_sec, default_blink_interval_min_sec, default_bubble_block_size,
    default_exhausted_balance_threshold, DEFAULT_BASE_URL, DEFAULT_CODEX_BASE_URL, DEFAULT_COLOR,
    DEFAULT_THEME, THEMES,
};
