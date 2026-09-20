//! 边缘吸附 DTO
//!
//! [`SnapResult`] 是前端契约（camelCase，取值 `left` / `right` / `none`）；
//! [`SnapInput`] / [`SnapOutcome`] 仅进程内使用，不参与序列化。
//!
//! 算法见 [`crate::domain::window::service::window_service`]。

use serde::Serialize;

/// 吸附结果：水平/垂直锚点（供前端决定是否镜像翻转）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapResult {
    /// 水平方向吸附结果：`left` / `right` / `none`。
    pub h: String,
    /// 垂直方向吸附结果：`top` / `bottom` / `none`。
    pub v: String,
}

/// 吸附计算输入（窗口与工作区为物理像素，`whale` 为逻辑像素）。
#[derive(Debug, Clone, Copy)]
pub struct SnapInput {
    /// 窗口左上角 X（物理）。
    pub window_x: i32,
    /// 窗口左上角 Y（物理）。
    pub window_y: i32,
    /// 窗口宽度（物理）。
    pub window_width: i32,
    /// 窗口高度（物理）。
    pub window_height: i32,
    /// 工作区（物理）：(x, y, width, height)。
    pub work_area: (i32, i32, u32, u32),
    /// 鲸鱼实际矩形（逻辑）：(left, top, width, height)。**水平**方向按它判定——
    /// 左右吸附会把鲸鱼镜像到内容块的外侧，鲸鱼左右边即内容块的左右边。
    pub whale: (f64, f64, f64, f64),
    /// 内容块（气泡 + 鲸鱼整体）的实际矩形（逻辑）：(left, top, width, height)。
    ///
    /// **垂直**方向按它判定：气泡画在鲸鱼上方，鲸鱼上边比气泡上边低一个气泡高度，
    /// 用鲸鱼上边判定会导致「拖到屏幕顶部」要么不触发、要么吸附后气泡被屏幕裁掉。
    pub content: (f64, f64, f64, f64),
    /// 窗口缩放因子。
    pub scale_factor: f64,
    /// 边缘吸附阈值（占工作区宽度比例，0 表示未设置）。
    pub snap_ratio: f64,
}

/// 吸附计算结果。
#[derive(Debug, Clone)]
pub struct SnapOutcome {
    /// 返回给前端的锚点结果。
    pub result: SnapResult,
    /// 目标窗口位置 X（物理像素）。
    pub x: i32,
    /// 目标窗口位置 Y（物理像素）。
    pub y: i32,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端契约：锚点字段为 `h` / `v`，取值为固定小写字符串。
    #[test]
    fn snap_result_is_wire_compatible() {
        let snap = SnapResult {
            h: "left".to_string(),
            v: "none".to_string(),
        };
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"h\":\"left\""), "{}", json);
        assert!(json.contains("\"v\":\"none\""), "{}", json);
    }
}
