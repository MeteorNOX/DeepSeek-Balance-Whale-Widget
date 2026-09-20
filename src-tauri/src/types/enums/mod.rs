//! 枚举模块
//!
//! 全系统的枚举类型按**业务场景**分文件维护，避免魔法字符串散落各处。
//! 每个枚举都提供两类接口：
//! - `as_str()`：对外（磁盘 / 前端）的稳定取值；
//! - `parse()`：容错解析（非法值给出 `None` 或回落默认值）。
//!
//! | 文件 | 枚举 | 业务场景 |
//! | --- | --- | --- |
//! | [`currency`] | `Currency` | 余额显示币种 |
//! | [`dialogue`] | `DialogueMode` | 台词播放模式 |
//! | [`audio`] | `AudioMode` | 音效组模式（单 / 双音效） |
//! | [`widget`] | `WidgetState` | 挂件图片状态 |
//! | [`window`] | `HorizontalAnchor` / `VerticalAnchor` | 挂件窗口吸附锚点 |
//! | [`pricing`] | `PeakPeriod` / `DateKind` | 峰谷时段与日期类型 |
//! | [`error`] | `ErrorCode` | 统一异常码 |
//!
//! **`as_str` 的返回值是磁盘 / 前端契约，禁止随意修改。**

pub mod audio;
pub mod currency;
pub mod dialogue;
pub mod error;
pub mod pricing;
pub mod widget;
pub mod window;

pub use audio::AudioMode;
pub use currency::Currency;
pub use dialogue::DialogueMode;
pub use error::ErrorCode;
pub use pricing::{DateKind, PeakPeriod};
pub use widget::WidgetState;
pub use window::{HorizontalAnchor, VerticalAnchor};
