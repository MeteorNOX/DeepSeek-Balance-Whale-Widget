//! 挂件位置配置 DTO

use serde::{Deserialize, Serialize};

/// 挂件位置配置：逻辑坐标 + 水平/垂直吸附锚点。
///
/// `h` / `v` 保持字符串：历史数据可能写入任意值，规范化时会兜底为默认锚点，
/// 不能因非法取值导致整份配置反序列化失败。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetPosition {
    /// 挂件左上角逻辑 X 坐标。
    pub x: f64,
    /// 挂件左上角逻辑 Y 坐标。
    pub y: f64,
    /// 水平方向：`left` / `right` / `none`。
    pub h: String,
    /// 垂直方向：`top` / `bottom` / `none`。
    ///
    /// `top` 表示内容贴窗口上沿（顶部吸附时为气泡预留空间），其余取值都是
    /// 「贴窗口下沿」的默认锚定；老配置没有该字段时按默认锚定处理。
    #[serde(default = "default_v")]
    pub v: String,
}

/// 垂直锚点缺省值（贴窗口下沿，即历史行为）。
fn default_v() -> String {
    crate::types::enums::VerticalAnchor::DEFAULT
        .as_str()
        .to_string()
}

impl Default for WidgetPosition {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            h: crate::types::enums::HorizontalAnchor::DEFAULT
                .as_str()
                .to_string(),
            v: default_v(),
        }
    }
}
