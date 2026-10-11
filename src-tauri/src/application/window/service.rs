//! 窗口用例
//!
//! 把「读配置 → 算吸附」这段编排收在应用层；
//! 真正的窗口读写（位置 / 穿透 / 菜单）由 `api::window_api` 完成。

use crate::application::registry;
use crate::domain::window::model::{SnapInput, SnapOutcome};
use crate::domain::window::service::window_service::{compute_snap, snap_distance_px};

/// 依据当前配置计算拖拽释放后的吸附结果。
///
/// - `window`：窗口左上角与尺寸（物理像素）；
/// - `work_area`：显示器工作区（物理像素）；
/// - `whale`：鲸鱼实际矩形（逻辑像素）——水平方向按它判定；
/// - `content`：内容块（气泡 + 鲸鱼整体）实际矩形（逻辑像素）——垂直方向按它判定。
///
/// 吸附阈值**只来自配置页**：配置了比例就按比例折算，从未设置过（0）则用配置页
/// 默认值。后端不再有「四分之一区域」这类隐式规则。
pub fn resolve_snap(
    window: (i32, i32, i32, i32),
    work_area: (i32, i32, u32, u32),
    whale: (f64, f64, f64, f64),
    content: (f64, f64, f64, f64),
    scale_factor: f64,
) -> SnapOutcome {
    let snap_ratio = registry::config().get().widget.snap_distance;
    compute_snap(&SnapInput {
        window_x: window.0,
        window_y: window.1,
        window_width: window.2,
        window_height: window.3,
        work_area,
        whale,
        content,
        scale_factor,
        snap_distance_px: snap_distance_px(snap_ratio, work_area.2),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未设置吸附比例（0）时按配置页默认值判定，不 panic 且结果合法。
    #[test]
    fn resolve_snap_with_configured_ratio_is_total() {
        let outcome = resolve_snap(
            (0, 0, 625, 625),
            (0, 0, 1920, 1080),
            (0.0, 0.0, 625.0, 625.0),
            (0.0, 0.0, 625.0, 625.0),
            1.0,
        );
        // 当前配置的吸附阈值来自真实配置文件，只需保证结果是合法取值。
        assert!(
            ["left", "right", "none"].contains(&outcome.result.h.as_str()),
            "水平锚点非法：{}",
            outcome.result.h
        );
        assert!(
            ["top", "bottom", "none"].contains(&outcome.result.v.as_str()),
            "垂直锚点非法：{}",
            outcome.result.v
        );
        assert!(
            ["left", "right"].contains(&outcome.result.facing.as_str()),
            "朝向非法：{}",
            outcome.result.facing
        );
    }
}
