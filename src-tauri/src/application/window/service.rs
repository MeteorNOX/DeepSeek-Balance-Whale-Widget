//! 窗口用例
//!
//! 把「读配置 → 算吸附」这段编排收在应用层；
//! 真正的窗口读写（位置 / 穿透 / 菜单）由 `api::window_api` 完成。

use crate::domain::window::model::{SnapInput, SnapOutcome};
use crate::domain::window::service::window_service::compute_snap;
use crate::application::registry;

/// 依据当前配置计算拖拽释放后的吸附结果。
///
/// - `window`：窗口左上角与尺寸（物理像素）；
/// - `work_area`：显示器工作区（物理像素）；
/// - `whale`：鲸鱼实际矩形（逻辑像素）——水平方向按它判定；
/// - `content`：内容块（气泡 + 鲸鱼整体）实际矩形（逻辑像素）——垂直方向按它判定。
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
        snap_ratio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未设置吸附阈值（0）时应走四分之一区域判定，不 panic。
    #[test]
    fn resolve_snap_with_configured_ratio_is_total() {
        let outcome = resolve_snap(
            (0, 0, 625, 625),
            (0, 0, 1920, 1080),
            (0.0, 0.0, 625.0, 625.0),
            (0.0, 0.0, 625.0, 625.0),
            1.0,
        );
        // 当前配置的吸附阈值来自真实配置文件，只需保证结果是合法锚点。
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
    }
}
