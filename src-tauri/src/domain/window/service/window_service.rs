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

/// 内容矩形（气泡 + 鲸鱼整体）在窗口内的位置与尺寸（逻辑像素，相对窗口左上角）。
///
/// 内容块基准 `WIDGET_BASE` 见方、锚在窗口右下角（与前端布局一致）；窗口固定按
/// `WIDGET_CREATE_SCALE` 创建，因此偏移就是「窗口边长 − 内容边长」。
///
/// 可见性判据用内容块而不是鲸鱼本体：后端拿不到前端量到的鲸鱼精确比例，而鲸鱼贴在内容块
/// 右下角、一定被内容块包住，所以内容块可见就保证鲸鱼可见——偏保守，但不会把鲸鱼留在屏外。
pub fn widget_content_keep(scale: f64) -> (f64, f64, f64, f64) {
    let window = widget_size(WIDGET_CREATE_SCALE);
    let side = (WIDGET_BASE * scale).clamp(0.0, window);
    (window - side, window - side, side, side)
}

/// 逻辑矩形 → 物理矩形（按倍率 `sf` 换算），供钳制与可见性判据共用。
pub fn to_physical_keep(sf: f64, rect: (f64, f64, f64, f64)) -> (i32, i32, i32, i32) {
    (
        (rect.0 * sf).round() as i32,
        (rect.1 * sf).round() as i32,
        (rect.2 * sf).round() as i32,
        (rect.3 * sf).round() as i32,
    )
}

/// 一处显示器的工作区与缩放因子（物理坐标）。
///
/// 领域层不认识 Tauri 的 `Monitor`，由 `shell` 层转换后传入。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// 该显示器的缩放因子（DPI / 96）。
    pub scale_factor: f64,
}

/// 未发生吸附时的结果（窗口不可读 / 工作区不可得时使用）。
pub fn no_snap() -> SnapResult {
    SnapResult {
        h: HorizontalAnchor::None.as_str().to_string(),
        v: VerticalAnchor::None.as_str().to_string(),
    }
}

/// 把窗口位置钳制到「内容矩形始终完整可见」的最近工作区内。
///
/// 判据刻意不是「把整个窗口限制在屏幕内」，而是**内容矩形（鲸鱼本体）必须完整落在
/// 某个工作区内**，原因有两条：
/// 1. 挂件窗口固定按最大倍率创建（625 逻辑 px），鲸鱼只占右下角一小块，窗口大半是
///    透明的——按整窗限制会让挂件无法贴边摆放，也挡住跨屏拖动；
/// 2. 鲸鱼是唯一可交互的区域（拖拽、点击、右键菜单都只认它）。它一旦出屏，鼠标就
///    再也点不到，整窗鼠标穿透又让用户没有任何入口能把它救回来——只能手改配置文件。
///
/// 多个工作区时取「所需位移最小」的那个，因此跨屏拖动仍然自由：鲸鱼在哪个显示器
/// 附近，就按哪个显示器的边界约束；落在显示器之间的空档时，回到最近的一个。
///
/// 返回物理像素坐标。
///
/// - `keep`：内容矩形相对窗口左上角的偏移与尺寸（物理像素）；
/// - `work_areas`：各显示器工作区（物理坐标，排除任务栏）；
/// - 内容尺寸非正或工作区列表为空时原样返回——没有依据就不做钳制。
pub fn clamp_window_position(
    x: i32,
    y: i32,
    keep: (i32, i32, i32, i32),
    work_areas: &[(i32, i32, u32, u32)],
) -> (i32, i32) {
    let (kx, ky, kw, kh) = keep;
    if kw <= 0 || kh <= 0 || work_areas.is_empty() {
        return (x, y);
    }

    // 内容矩形当前在屏幕上的位置。
    let keep_left = x.saturating_add(kx);
    let keep_top = y.saturating_add(ky);

    let mut best_dist = i64::MAX;
    let mut best_pos = (x, y);
    for &(ax, ay, aw, ah) in work_areas {
        let aw = aw.min(i32::MAX as u32) as i32;
        let ah = ah.min(i32::MAX as u32) as i32;
        // 工作区比内容矩形还小时（极端倍率 + 小屏）退化为贴左上角，
        // 否则区间反转会让 clamp 直接 panic。
        let max_left = ax.saturating_add(aw).saturating_sub(kw).max(ax);
        let max_top = ay.saturating_add(ah).saturating_sub(kh).max(ay);

        let cx = keep_left.clamp(ax, max_left);
        let cy = keep_top.clamp(ay, max_top);
        let dist = (cx - keep_left).abs() as i64 + (cy - keep_top).abs() as i64;
        if dist < best_dist {
            best_dist = dist;
            best_pos = (cx.saturating_sub(kx), cy.saturating_sub(ky));
        }
    }

    best_pos
}

/// 计算挂件窗口创建时的物理左上角；读不到显示器时返回 `None`。
///
/// `saved` 是配置里存的**逻辑坐标**（`None` 表示从未保存过）。逻辑坐标要乘缩放因子才是
/// 物理坐标，而乘的是哪块屏的因子并没有被存下来，因此这里逐块显示器试算，取第一块
/// 「试算后内容矩形完整落在其工作区内」的；都还原不出来（改过分辨率 / 缩放、拔过显示器）
/// 就退回 `primary` 工作区的右下角（`primary` 为 `None` 时用第一块）。
///
/// 返回前统一过 [`clamp_window_position`]，所以无论走哪条分支，内容矩形都一定完整可见。
pub fn initial_widget_position(
    saved: Option<(f64, f64)>,
    window_size: f64,
    content: (f64, f64, f64, f64),
    monitors: &[MonitorArea],
    primary: Option<MonitorArea>,
) -> Option<(i32, i32)> {
    if monitors.is_empty() {
        return None;
    }
    let areas: Vec<(i32, i32, u32, u32)> = monitors
        .iter()
        .map(|m| (m.x, m.y, m.width, m.height))
        .collect();

    let (x, y, keep) = match saved.and_then(|(sx, sy)| restore_saved(sx, sy, content, monitors)) {
        Some((x, y, sf)) => (x, y, to_physical_keep(sf, content)),
        None => {
            let anchor = primary.unwrap_or(monitors[0]);
            let sf = anchor.scale_factor;
            // 窗口按固定逻辑边长创建，落在这块屏上的物理边长就是 size × sf。
            let edge = (window_size * sf).round() as i32;
            let aw = anchor.width.min(i32::MAX as u32) as i32;
            let ah = anchor.height.min(i32::MAX as u32) as i32;
            (
                anchor.x.saturating_add(aw).saturating_sub(edge),
                anchor.y.saturating_add(ah).saturating_sub(edge),
                to_physical_keep(sf, content),
            )
        }
    };

    Some(clamp_window_position(x, y, keep, &areas))
}

/// 把存档的逻辑坐标还原成物理坐标：`逻辑 × 该屏缩放因子`，取第一块还原后内容矩形完整可见的
/// 显示器，并连同该屏的缩放因子一起返回（后续换算必须用同一个）。
fn restore_saved(
    saved_x: f64,
    saved_y: f64,
    content: (f64, f64, f64, f64),
    monitors: &[MonitorArea],
) -> Option<(i32, i32, f64)> {
    if !saved_x.is_finite() || !saved_y.is_finite() {
        return None;
    }
    monitors.iter().find_map(|m| {
        let sf = m.scale_factor;
        let x = (saved_x * sf).round() as i32;
        let y = (saved_y * sf).round() as i32;
        let keep = to_physical_keep(sf, content);
        let area = (m.x, m.y, m.width, m.height);
        content_is_visible(x, y, keep, area).then_some((x, y, sf))
    })
}

/// 内容矩形是否完整落在给定工作区内（判据与 [`clamp_window_position`] 一致）。
fn content_is_visible(
    x: i32,
    y: i32,
    keep: (i32, i32, i32, i32),
    area: (i32, i32, u32, u32),
) -> bool {
    let (ax, ay, aw, ah) = area;
    let (kx, ky, kw, kh) = keep;
    if kw <= 0 || kh <= 0 {
        return false;
    }
    let left = x.saturating_add(kx);
    let top = y.saturating_add(ky);
    let right = ax.saturating_add(aw.min(i32::MAX as u32) as i32);
    let bottom = ay.saturating_add(ah.min(i32::MAX as u32) as i32);
    left >= ax && top >= ay && left.saturating_add(kw) <= right && top.saturating_add(kh) <= bottom
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

    /// 内容矩形（鲸鱼）在窗口内的位置：窗口 625 逻辑，鲸鱼贴右下角，
    /// 右/下边与窗口右/下边重合。偏移 402 + 尺寸 223 = 625，与真实布局同量级。
    const KEEP: (i32, i32, i32, i32) = (402, 402, 223, 223);

    /// 单屏 1920×1080 工作区。
    fn one_screen() -> Vec<(i32, i32, u32, u32)> {
        vec![(0, 0, 1920, 1080)]
    }

    /// 内容矩形完全在工作区内时位置不动——钳制不能干扰正常拖动。
    #[test]
    fn clamp_keeps_position_when_content_visible() {
        // 内容矩形落在 (1402, 902)–(1625, 1125)…下边越界，故需上移。
        assert_eq!(
            clamp_window_position(1000, 500, KEEP, &one_screen()),
            (1000, 455),
            "只有越界的那个轴被纠正：下边超出 1080，上移 45 后鲸鱼底边贴 1080"
        );
        // 完全落在工作区内：原样返回。
        assert_eq!(clamp_window_position(200, 100, KEEP, &one_screen()), (200, 100));
    }

    /// 拖到右下角之外：窗口被拉回，鲸鱼右下边贴工作区右下角。
    #[test]
    fn clamp_pulls_back_from_right_and_bottom() {
        // x 方向：鲸鱼右边 2402 超出 1920，左移到 1697 → 窗口 x = 1295 = 1920 - 625。
        assert_eq!(clamp_window_position(2000, 400, KEEP, &one_screen()).0, 1295);
        // y 方向同理：1080 - 625 = 455。
        assert_eq!(clamp_window_position(400, 2000, KEEP, &one_screen()).1, 455);
    }

    /// 拖到左上角之外：只把鲸鱼拉回来，透明部分允许留在屏外。
    ///
    /// 这是「不能按整窗限制」的直接体现——鲸鱼左边仍在屏内（102）时窗口 x 保持 -300，
    /// 挂件因此可以自然贴边，而不是被硬推到 0。
    #[test]
    fn clamp_allows_transparent_margin_off_screen() {
        let (x, y) = clamp_window_position(-300, -500, KEEP, &one_screen());
        assert_eq!(x, -300, "鲸鱼左边 = -300 + 402 = 102 仍在屏内，不该移动 x");
        assert_eq!(y, -402, "鲸鱼上边 -98 越界，下移到 0 → 窗口 y = -402");
        // 复核：钳制后鲸鱼确实完整可见。
        assert!(x + KEEP.0 >= 0 && y + KEEP.1 >= 0);
        assert!(x + KEEP.0 + KEEP.2 <= 1920 && y + KEEP.1 + KEEP.3 <= 1080);
    }

    /// 多屏：取「所需位移最小」的工作区，跨屏拖动不受阻，落在空档时回到最近的一块。
    #[test]
    fn clamp_picks_nearest_work_area() {
        // 主屏 1920×1080 在原点；副屏同为 1920×1080，但**上移 200**，
        // 于是 x > 1920 且 y > 880 的区域是两块屏之间的空档。
        let areas = vec![(0, 0, 1920, 1080), (1920, -200, 1920, 1080)];

        // A. 鲸鱼拖到副屏中部：留在副屏（只上移，不跨回主屏）。
        let (x, y) = clamp_window_position(2098, 598, KEEP, &areas);
        assert_eq!((x, y), (2098, 255), "鲸鱼被留在副屏，y 拉回副屏下边界");
        assert!(
            x + KEEP.0 >= 1920 && y + KEEP.1 + KEEP.3 <= -200 + 1080,
            "鲸鱼完整落在副屏内"
        );

        // B. 鲸鱼拖到主屏右下角之外：回主屏，而不是被吸去副屏。
        let (x, y) = clamp_window_position(1298, 1598, KEEP, &areas);
        assert_eq!((x, y), (1295, 455), "位移更小的一侧胜出：贴主屏右下角");
    }

    /// 极端倍率：内容矩形比工作区还大时不 panic，退化为贴工作区左上角。
    #[test]
    fn clamp_survives_oversized_content() {
        assert_eq!(
            clamp_window_position(500, 500, (0, 0, 3000, 3000), &one_screen()),
            (0, 0)
        );
    }

    /// 无依据时不钳制：缺内容尺寸（前端测量失败）或读不到显示器时原样返回。
    #[test]
    fn clamp_is_noop_without_enough_info() {
        assert_eq!(clamp_window_position(50, 60, KEEP, &[]), (50, 60));
        assert_eq!(
            clamp_window_position(50, 60, (0, 0, 0, 0), &one_screen()),
            (50, 60)
        );
    }

    /// 内容矩形随倍率伸缩，且始终落在窗口内、右下角与窗口右下角重合。
    ///
    /// 倍率 1.5 的取值与 `scaled_input_at` 里的内容块（375 逻辑、偏移 250）互为印证。
    #[test]
    fn content_keep_tracks_scale() {
        assert_eq!(widget_content_keep(1.0), (375.0, 375.0, 250.0, 250.0));
        assert_eq!(widget_content_keep(1.5), (250.0, 250.0, 375.0, 375.0));
        assert_eq!(widget_content_keep(0.6), (475.0, 475.0, 150.0, 150.0));
        // 窗口创建倍率：内容铺满整个窗口。
        assert_eq!(widget_content_keep(WIDGET_CREATE_SCALE), (0.0, 0.0, 625.0, 625.0));
        // 越界倍率被钳制，不会算出负偏移或超出窗口的尺寸。
        for scale in [0.1, 0.6, 1.0, 1.5, 2.5, 10.0] {
            let (kx, ky, kw, kh) = widget_content_keep(scale);
            assert!(kx >= 0.0 && ky >= 0.0);
            assert!(kx + kw <= WIDGET_MAX_SIZE && ky + kh <= WIDGET_MAX_SIZE);
        }
    }

    /// 这台机器实测的双屏布局：主屏 1920×1080（工作区高 1032，扣任务栏）@1.0，
    /// 副屏 2560×1600 @1.5 且上移 252px。
    fn mixed_dpi_monitors() -> (Vec<MonitorArea>, MonitorArea) {
        let primary = MonitorArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1032,
            scale_factor: 1.0,
        };
        let external = MonitorArea {
            x: 1920,
            y: -252,
            width: 2560,
            height: 1528,
            scale_factor: 1.5,
        };
        (vec![primary, external], primary)
    }

    /// 单屏：默认摆放与修复前 `position(max_x, max_y)` 的结果逐像素一致。
    #[test]
    fn initial_position_matches_legacy_behaviour_on_single_screen() {
        let primary = MonitorArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale_factor: 1.0,
        };
        assert_eq!(
            initial_widget_position(
                None,
                widget_size(WIDGET_CREATE_SCALE),
                widget_content_keep(1.0),
                &[primary],
                Some(primary),
            ),
            // 1920 - 625 = 1295，1080 - 625 = 455。
            Some((1295, 455))
        );
    }

    /// 混合 DPI 双屏 + 无存档（首次运行）：必须落在主屏工作区右下角。
    ///
    /// 这是本次修复的核心回归用例。修复前把主屏的**逻辑**右下角交给窗口构造器，由窗口按
    /// 1.5× 换算成物理坐标 1943 —— 主屏只有 1920 宽，挂件整个被推到副屏下方，鲸鱼只剩
    /// 二十几个像素可见，而整窗鼠标穿透让用户没有任何入口能把它救回来。
    #[test]
    fn initial_position_without_saved_stays_on_primary() {
        let (monitors, primary) = mixed_dpi_monitors();
        let content = widget_content_keep(1.0);
        let (x, y) = initial_widget_position(
            None,
            widget_size(WIDGET_CREATE_SCALE),
            content,
            &monitors,
            Some(primary),
        )
        .unwrap();

        assert_eq!((x, y), (1295, 407), "主屏工作区右下角，未越到副屏");
        assert!(
            content_is_visible(x, y, to_physical_keep(1.0, content), (0, 0, 1920, 1032)),
            "内容必须完整落在主屏工作区内"
        );
    }

    /// 混合 DPI 双屏 + 存档在 1.5× 的副屏上：按副屏的缩放因子还原，跨屏位置不丢。
    #[test]
    fn initial_position_restores_saved_on_the_right_monitor() {
        let (monitors, primary) = mixed_dpi_monitors();
        let content = widget_content_keep(1.0);
        let (x, y) = initial_widget_position(
            Some((1810.0, -202.0)),
            widget_size(WIDGET_CREATE_SCALE),
            content,
            &monitors,
            Some(primary),
        )
        .unwrap();

        // 存档是逻辑坐标：×1.0 还原不出可见位置（会落到主屏右侧之外），×1.5 才对得上副屏。
        assert_eq!((x, y), (2715, -303));
        assert!(
            content_is_visible(x, y, to_physical_keep(1.5, content), (1920, -252, 2560, 1528)),
            "内容必须完整落在副屏工作区内"
        );
    }

    /// 存档位置在任何一块屏上都还原不出可见结果时（换过分辨率 / 拔过显示器），
    /// 退回主屏右下角，而不是把挂件留在屏外。
    #[test]
    fn initial_position_falls_back_when_saved_is_unreachable() {
        let (monitors, primary) = mixed_dpi_monitors();
        assert_eq!(
            initial_widget_position(
                Some((9000.0, 9000.0)),
                widget_size(WIDGET_CREATE_SCALE),
                widget_content_keep(1.0),
                &monitors,
                Some(primary),
            ),
            Some((1295, 407))
        );
    }

    /// 读不到任何显示器时不猜位置，交由系统默认（返回 `None`）。
    #[test]
    fn initial_position_without_monitors_is_none() {
        assert_eq!(
            initial_widget_position(None, widget_size(WIDGET_CREATE_SCALE), widget_content_keep(1.0), &[], None),
            None
        );
    }
}
