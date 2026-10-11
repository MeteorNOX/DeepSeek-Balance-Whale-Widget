//! 挂件位置配置 DTO

use serde::{Deserialize, Serialize};

/// 挂件位置配置：**物理像素**（屏幕绝对坐标）+ 水平/垂直吸附锚点。
///
/// 为什么是物理坐标：逻辑坐标只对「某一块」显示器成立（物理 ÷ 该屏缩放），
/// 跨屏复用必然错位——这正是「混合 DPI 双屏下宠物落到屏外」的根因。
/// 物理坐标全局唯一，重装/换屏/改缩放后语义不变。
///
/// `h` / `v` 保持字符串：历史数据可能写入任意值，规范化时会兜底为默认锚点，
/// 不能因非法取值导致整份配置反序列化失败。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetPosition {
    /// 挂件左上角 X（`unit = physical` 时是物理像素）。
    pub x: f64,
    /// 挂件左上角 Y（`unit = physical` 时是物理像素）。
    pub y: f64,
    /// 水平方向：`left` / `right` / `none`。
    pub h: String,
    /// 垂直方向：`top` / `bottom` / `none`。
    ///
    /// `top` 表示内容贴窗口上沿（顶部吸附时为气泡预留空间），其余取值都是
    /// 「贴窗口下沿」的默认锚定；老配置没有该字段时按默认锚定处理。
    #[serde(default = "default_v")]
    pub v: String,
    /// 坐标口径：`physical` = 物理像素（当前写入值）；空串 = 历史数据（主屏逻辑坐标）。
    ///
    /// 老配置缺该字段时保持空串，读取方按「主屏逻辑坐标 × 主屏缩放」折算成物理坐标，
    /// 保证升级后宠物停在与升级前同一位置。
    #[serde(default)]
    pub unit: String,
    /// 桌宠朝向：`left` / `right`。
    ///
    /// 与 `h`（吸附锚点）语义无关：朝向由桌宠所在显示器工作区的物理中心决定
    /// （左半区朝右、右半区朝左）。老配置缺该字段时按默认朝向，随下次落库补齐。
    #[serde(default = "default_facing")]
    pub facing: String,
}

impl WidgetPosition {
    /// 坐标口径：物理像素（屏幕绝对坐标）。
    pub const UNIT_PHYSICAL: &'static str = "physical";
    /// 坐标口径：历史遗留的主屏逻辑坐标（仅老配置会读到）。
    pub const UNIT_LEGACY_LOGICAL: &'static str = "";

    /// 是否已是物理像素口径。
    pub fn is_physical(&self) -> bool {
        self.unit == Self::UNIT_PHYSICAL
    }
}

/// 垂直锚点缺省值（贴窗口下沿，即历史行为）。
fn default_v() -> String {
    crate::types::enums::VerticalAnchor::DEFAULT
        .as_str()
        .to_string()
}

/// 朝向缺省值（老配置没有该字段时）。
fn default_facing() -> String {
    crate::types::enums::Facing::DEFAULT.as_str().to_string()
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
            unit: Self::UNIT_PHYSICAL.to_string(),
            facing: default_facing(),
        }
    }
}
