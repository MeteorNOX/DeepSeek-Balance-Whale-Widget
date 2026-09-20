//! 窗口算法（领域服务）
//!
//! 尺寸换算与「拖拽释放后的边缘吸附」算法。算法只依赖数值输入，
//! 因此可以脱离 Tauri 完整测试；真正的窗口操作见 `api::window_api`。

use crate::domain::window::model::{SnapInput, SnapOutcome, SnapResult};
use crate::types::enums::{HorizontalAnchor, VerticalAnchor};

/// 挂件基准尺寸（scale 倍率作用于其上）。
pub const WIDGET_BASE: f64 = 250.0;
/// 挂件逻辑边长下限。
pub const WIDGET_MIN_SIZE: f64 = 122.0;
/// 挂件逻辑边长上限。
pub const WIDGET_MAX_SIZE: f64 = 625.0;
/// 创建窗口时固定的最大倍率（缩放由前端 CSS 处理，避免透明窗口调整导致闪屏）。
pub const WIDGET_CREATE_SCALE: f64 = 2.5;

/// 根据倍率计算挂件窗口的逻辑边长（正方形，钳制在上下限内）。
pub fn widget_size(scale: f64) -> f64 {
    (WIDGET_BASE * scale).clamp(WIDGET_MIN_SIZE, WIDGET_MAX_SIZE)
}

/// 未发生吸附时的结果（窗口不可读 / 工作区不可得时使用）。
pub fn no_snap() -> SnapResult {
    SnapResult {
        h: HorizontalAnchor::None.as_str().to_string(),
        v: VerticalAnchor::None.as_str().to_string(),
    }
}

/// 计算拖拽释放后的吸附位置。
///
/// - `snap_ratio > 0`：按工作区宽度的比例作为吸附阈值；
/// - `snap_ratio == 0`：退化为「四分之一区域」判定。
pub fn compute_snap(input: &SnapInput) -> SnapOutcome {
    let (wa_x, wa_y, wa_w, wa_h) = input.work_area;
    let (whale_left, whale_top, whale_width, whale_height) = input.whale;
    let (_, content_top, _, content_height) = input.content;
    let sf = input.scale_factor;

    let wl = (whale_left * sf).round() as i32;
    let wt = (whale_top * sf).round() as i32;
    let ww = (whale_width * sf).round() as i32;
    let wh = (whale_height * sf).round() as i32;
    let ct = (content_top * sf).round() as i32;
    let ch = (content_height * sf).round() as i32;
    let center_x = wl + ww / 2;
    // 顶边用内容块（气泡 + 鲸鱼整体）的上边：气泡画在鲸鱼上方，鲸鱼上边比它低一个
    // 气泡高度——只有连气泡一起贴顶，吸附后气泡才完整可见、鲸鱼才真正「贴在上方」。
    // 底边仍用鲸鱼下边（与内容块下边重合），触发手感与历史一致。
    let content_center_y = ct + ch / 2;

    let w = input.window_width;
    let h = input.window_height;

    let mut horizontal = HorizontalAnchor::None;
    let mut vertical = VerticalAnchor::None;
    let mut x = input.window_x;
    let mut y = input.window_y;

    if input.snap_ratio > 0.0 {
        let snap_distance = (wa_w as f64 * input.snap_ratio).round() as i32;
        if wl - wa_x <= snap_distance {
            horizontal = HorizontalAnchor::Left;
            x = wa_x;
        } else if (wa_x + wa_w as i32) - (wl + ww) <= snap_distance {
            horizontal = HorizontalAnchor::Right;
            x = wa_x + wa_w as i32 - w;
        }
        // 顶部：气泡顶边进入吸附距离即吸附；吸附后窗口顶边贴工作区顶边，
        // 内容块随 `dshwv-top` 锚到窗口上沿 —— 气泡完整可见，鲸鱼在气泡下方。
        if ct - wa_y <= snap_distance {
            vertical = VerticalAnchor::Top;
            y = wa_y;
        } else if (wa_y + wa_h as i32) - (wt + wh) <= snap_distance {
            vertical = VerticalAnchor::Bottom;
            y = wa_y + wa_h as i32 - h;
        }
    } else {
        if center_x < wa_x + wa_w as i32 / 4 {
            horizontal = HorizontalAnchor::Left;
            x = wa_x;
        } else if center_x > wa_x + (wa_w as i32 * 3) / 4 {
            horizontal = HorizontalAnchor::Right;
            x = wa_x + wa_w as i32 - w;
        }
        if content_center_y < wa_y + wa_h as i32 / 4 {
            vertical = VerticalAnchor::Top;
            y = wa_y;
        } else if content_center_y > wa_y + (wa_h as i32 * 3) / 4 {
            vertical = VerticalAnchor::Bottom;
            y = wa_y + wa_h as i32 - h;
        }
    }

    SnapOutcome {
        result: SnapResult {
            h: horizontal.as_str().to_string(),
            v: vertical.as_str().to_string(),
        },
        x,
        y,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 工作区：1920×1080 @ (0,0)，窗口 625×625，鲸鱼与窗口同尺寸（缩放 1.0）。
    ///
    /// `content` 与 `whale` 取同一矩形：把「气泡在鲸鱼上方」这一段差异隔离掉，
    /// 这些用例只验证阈值与目标位置本身。
    fn base_input(ratio: f64) -> SnapInput {
        SnapInput {
            window_x: 0,
            window_y: 0,
            window_width: 625,
            window_height: 625,
            work_area: (0, 0, 1920, 1080),
            whale: (0.0, 0.0, 625.0, 625.0),
            content: (0.0, 0.0, 625.0, 625.0),
            scale_factor: 1.0,
            snap_ratio: ratio,
        }
    }

    /// 真实构图（缩放 1.5，屏幕 1920×1080 物理）：窗口位于 `(window_x, window_y)` 物理坐标，
    /// 窗口 625×625 逻辑；内容块 375×375 逻辑锚在窗口右下角（窗口内偏移 250）；
    /// 鲸鱼 222.9×222.9 逻辑贴在内容块右下角，上边比内容块上边低 152.1 逻辑（≈228 物理）。
    ///
    /// 两个矩形都按**屏幕逻辑坐标**给出，与前端 `getBoundingClientRect()` + `window.screenX/Y`
    /// 的测量口径一致。
    fn scaled_input_at(ratio: f64, window_x: i32, window_y: i32) -> SnapInput {
        let sf = 1.5;
        let ox = window_x as f64 / sf;
        let oy = window_y as f64 / sf;
        SnapInput {
            window_x,
            window_y,
            window_width: 938,
            window_height: 938,
            work_area: (0, 0, 1920, 1080),
            whale: (ox + 402.1, oy + 402.1, 222.9, 222.9),
            content: (ox + 250.0, oy + 250.0, 375.0, 375.0),
            scale_factor: sf,
            snap_ratio: ratio,
        }
    }

    #[test]
    fn widget_size_is_clamped() {
        assert_eq!(widget_size(1.0), 250.0);
        assert_eq!(widget_size(2.5), 625.0);
        // 超出上限 / 下限时被钳制。
        assert_eq!(widget_size(10.0), WIDGET_MAX_SIZE);
        assert_eq!(widget_size(0.1), WIDGET_MIN_SIZE);
    }

    /// 比例模式：贴近左/上边缘时吸附，且在阈值外不动。
    #[test]
    fn ratio_mode_snaps_near_edges() {
        // 阈值 0.05 * 1920 = 96px。
        let mut input = base_input(0.05);
        input.window_x = 50;
        input.window_y = 50;
        input.whale = (50.0, 50.0, 625.0, 625.0);
        input.content = input.whale;
        let outcome = compute_snap(&input);
        assert_eq!(outcome.result.h, "left");
        assert_eq!(outcome.result.v, "top");
        assert_eq!((outcome.x, outcome.y), (0, 0));

        // 远离边缘：不吸附，位置保持。
        let mut far = base_input(0.05);
        far.window_x = 600;
        far.window_y = 200;
        far.whale = (600.0, 200.0, 625.0, 625.0);
        far.content = far.whale;
        let outcome = compute_snap(&far);
        assert_eq!(outcome.result.h, "none");
        assert_eq!(outcome.result.v, "none");
        assert_eq!((outcome.x, outcome.y), (600, 200));
    }

    /// 比例模式：贴近右/下边缘时吸附到工作区内侧。
    #[test]
    fn ratio_mode_snaps_to_right_and_bottom() {
        let mut input = base_input(0.05);
        input.window_x = 1290;
        input.window_y = 450;
        input.whale = (1290.0, 450.0, 625.0, 625.0);
        input.content = input.whale;
        let outcome = compute_snap(&input);
        assert_eq!(outcome.result.h, "right");
        assert_eq!(outcome.result.v, "bottom");
        // 右/下吸附后窗口右下角贴合工作区：1920-625=1295，1080-625=455。
        assert_eq!((outcome.x, outcome.y), (1295, 455));
    }

    /// 阈值 0（未设置）：退化为四分之一区域判定。
    #[test]
    fn zero_ratio_uses_quarter_rule() {
        let mut input = base_input(0.0);
        // 中心 x = 300 < 1920/4 = 480 → 左；中心 y = 250 < 1080/4 = 270 → 上。
        input.window_x = 100;
        input.window_y = 100;
        input.whale = (100.0, 100.0, 400.0, 300.0);
        input.content = input.whale;
        let outcome = compute_snap(&input);
        assert_eq!(outcome.result.h, "left");
        assert_eq!(outcome.result.v, "top");
        assert_eq!((outcome.x, outcome.y), (0, 0));

        // 中心落在「中段」（270 ≤ y ≤ 810 且 480 ≤ x ≤ 1440）时不做任何吸附。
        let mut middle = base_input(0.0);
        middle.window_x = 700;
        middle.window_y = 400;
        middle.whale = (700.0, 400.0, 400.0, 300.0);
        middle.content = middle.whale;
        let outcome = compute_snap(&middle);
        assert_eq!(outcome.result.h, "none");
        assert_eq!(outcome.result.v, "none");
        assert_eq!((outcome.x, outcome.y), (700, 400));

        // 中心靠右 / 靠下 → 右 / 下。
        let mut right = base_input(0.0);
        right.window_x = 1500;
        right.window_y = 800;
        right.whale = (1500.0, 800.0, 400.0, 300.0);
        right.content = right.whale;
        let outcome = compute_snap(&right);
        assert_eq!(outcome.result.h, "right");
        assert_eq!(outcome.result.v, "bottom");
        assert_eq!((outcome.x, outcome.y), (1920 - 625, 1080 - 625));
    }

    /// 缩放因子参与换算：逻辑坐标按实际 DPI 放大后再判定。
    #[test]
    fn scale_factor_is_applied() {
        let mut input = base_input(0.05);
        input.scale_factor = 2.0;
        input.window_width = 1250;
        input.window_height = 1250;
        input.whale = (250.0, 0.0, 625.0, 625.0);
        input.content = input.whale;
        // 物理 whal_left = 500 > 96 → 不吸附左侧。
        let outcome = compute_snap(&input);
        assert_eq!(outcome.result.h, "none");
    }

    /// 顶部吸附按「内容块上边」判定：气泡画在鲸鱼上方，必须连气泡一起贴顶。
    ///
    /// 这是本次修复的核心：窗口被拖到屏幕上方时，鲸鱼上边往往还在屏幕外/贴边，
    /// 而气泡已经越界——按鲸鱼上边判定会漏掉吸附，按气泡上边判定才能把窗口拉回来，
    /// 使气泡完整落在工作区内、鲸鱼落在气泡下方。
    #[test]
    fn top_snap_uses_bubble_top_edge() {
        // 窗口顶边越出工作区 300px：气泡上边物理 = 75 ≤ 96（阈值）→ 吸附。
        // 此时鲸鱼上边在 303 物理处，按旧口径（鲸鱼上边）根本不会触发。
        let outcome = compute_snap(&scaled_input_at(0.05, 0, -300));
        assert_eq!(outcome.result.v, "top");
        assert_eq!(outcome.y, 0, "窗口顶边贴工作区顶边");

        // 吸附后：气泡上边 = 375 物理（完整可见），鲸鱼上边 = 603 物理，
        // 两者相差 228 物理 px —— 这段就是「为气泡预留的区域」。
        let content_top = (250.0_f64 * 1.5).round() as i32;
        let whale_top = (402.1_f64 * 1.5).round() as i32;
        assert_eq!(content_top, 375);
        assert!(whale_top + (222.9_f64 * 1.5) as i32 <= 1080, "鲸鱼必须完整落在工作区内");
        assert!(
            whale_top - content_top > 200,
            "鲸鱼上边比气泡上边低一个气泡高度，这段就是为气泡预留的区域"
        );

        // 仅仅「位置偏高」但气泡还没到顶边时不吸附（阈值 96 物理 px）。
        assert_eq!(compute_snap(&scaled_input_at(0.05, 0, 0)).result.v, "none");

        // 鲸鱼上边贴顶（气泡整体越界）同样触发吸附——这正是修复前会「弹回中部」的场景。
        assert_eq!(
            compute_snap(&scaled_input_at(0.05, 0, -520)).result.v,
            "top"
        );
    }

    /// 四分之一区域模式同样按内容块（气泡 + 鲸鱼整体）居中判定顶部。
    #[test]
    fn quarter_rule_top_uses_content_block() {
        // 窗口顶边越界 420px：内容块中心物理 = (-30 + 187.5) × 1.5 = 236 < 270 → 顶部。
        let input = scaled_input_at(0.0, 0, -420);
        assert_eq!(compute_snap(&input).result.v, "top");
        assert_eq!(compute_snap(&input).y, 0);

        // 再往下一点（中心 296 > 270）就不吸附。
        assert_eq!(compute_snap(&scaled_input_at(0.0, 0, -360)).result.v, "none");
    }

    #[test]
    fn no_snap_returns_none_anchors() {
        let result = no_snap();
        assert_eq!(result.h, "none");
        assert_eq!(result.v, "none");
    }

    /// 分辨率 / DPI 无关性：吸附只依赖「工作区 + 窗口尺寸 + 实际内容矩形」，
    /// 算法里没有任何写死的像素值，因此不同电脑的屏幕与缩放比下结论一致。
    ///
    /// 每组都验两件事：把窗口推到屏幕上沿之上 → 吸到顶部（y = 工作区上沿）；
    /// 停在右下角 → 吸到右/下（窗口右下角贴合工作区）。
    #[test]
    fn snap_is_resolution_and_dpi_agnostic() {
        // (工作区物理宽, 高, 缩放因子)：涵盖小屏、主流 1080p、125%/150% 缩放与 4K。
        let cases = [
            (1366u32, 768u32, 1.0_f64),
            (1920, 1080, 1.0),
            (1920, 1080, 1.25),
            (2560, 1600, 1.5),
            (3840, 2160, 2.0),
        ];
        for (wa_w, wa_h, sf) in cases {
            // 窗口按最大倍率创建：逻辑 625 → 物理 625 * sf（与真实实现一致）。
            let w_px = (WIDGET_CREATE_SCALE * WIDGET_BASE * sf).round() as i32;
            let wa_w = wa_w as i32;
            let wa_h = wa_h as i32;

            // 内容块锚在窗口右下角（拖拽中的实际布局）：逻辑 250×250，
            // 因此它的右边/下边与窗口的右边/下边重合。
            let content = |wx_px: i32, wy_px: i32| {
                (
                    (wx_px + w_px) as f64 / sf - WIDGET_BASE,
                    (wy_px + w_px) as f64 / sf - WIDGET_BASE,
                    WIDGET_BASE,
                    WIDGET_BASE,
                )
            };
            // 鲸鱼贴在内容块右下角：宽高 148.6，上边比内容块上边低 101.375（逻辑）。
            let whale = |c: (f64, f64, f64, f64)| (c.0 + 101.375, c.1 + 101.375, 148.6, 148.6);

            // A. 推到屏幕上沿之上：顶部吸附，窗口顶边贴工作区顶边。
            let wy_px = -(400.0 * sf).round() as i32;
            let c = content(0, wy_px);
            let input = SnapInput {
                window_x: 0,
                window_y: wy_px,
                window_width: w_px,
                window_height: w_px,
                work_area: (0, 0, wa_w as u32, wa_h as u32),
                whale: whale(c),
                content: c,
                scale_factor: sf,
                snap_ratio: 0.05,
            };
            let outcome = compute_snap(&input);
            assert_eq!(
                outcome.result.v, "top",
                "分辨率 {wa_w}×{wa_h} @{sf}x：推到上沿之上必须吸到顶部"
            );
            assert_eq!(outcome.y, 0, "分辨率 {wa_w}×{wa_h} @{sf}x：顶边贴工作区上沿");

            // B. 停在右下角：窗口右下角贴合工作区。
            let (wx_px, wy_px) = (wa_w - w_px, wa_h - w_px);
            let c = content(wx_px, wy_px);
            let input = SnapInput {
                window_x: wx_px,
                window_y: wy_px,
                window_width: w_px,
                window_height: w_px,
                work_area: (0, 0, wa_w as u32, wa_h as u32),
                whale: whale(c),
                content: c,
                scale_factor: sf,
                snap_ratio: 0.05,
            };
            let outcome = compute_snap(&input);
            assert_eq!(
                (outcome.result.h.as_str(), outcome.result.v.as_str()),
                ("right", "bottom"),
                "分辨率 {wa_w}×{wa_h} @{sf}x：右下角必须吸到右/下"
            );
            assert_eq!(
                (outcome.x, outcome.y),
                (wa_w - w_px, wa_h - w_px),
                "分辨率 {wa_w}×{wa_h} @{sf}x：右下角贴合工作区"
            );
        }
    }
}
