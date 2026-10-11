//! 窗口数据传输对象
//!
//! - [`geometry`]：窗口几何（返回给前端做状态同步）；
//! - [`layout`]：显示器布局（工作区 + 缩放因子）与坐标系换算；
//! - [`snap`]：吸附输入 / 输出与锚点结果。

//! 目录约定（见 `1.md`）：`aggregate/` 聚合根、`entity/` 实体、`valobj/` 值对象与常量。
pub mod valobj;

pub use valobj::{geometry, layout, snap};

pub use geometry::WidgetGeometry;
pub use layout::DisplayLayout;
pub use snap::{SnapInput, SnapOutcome, SnapResult};
