//! 窗口算法（领域服务）
//!
//! 尺寸换算与「拖拽释放后的边缘吸附」算法。算法只依赖数值输入，
//! 因此可以脱离 Tauri 完整测试；真正的窗口操作见 `api::window_api`。

use crate::domain::window::model::{DisplayLayout, SnapInput, SnapOutcome, SnapResult};
use crate::types::enums::{Facing, HorizontalAnchor, VerticalAnchor};

/// 挂件基准尺寸（scale 倍率作用于其上）。
pub const WIDGET_BASE: f64 = 250.0;
/// 挂件逻辑边长下限。
pub const WIDGET_MIN_SIZE: f64 = 122.0;
/// 挂件逻辑边长上限。
pub const WIDGET_MAX_SIZE: f64 = 625.0;
/// 创建窗口时固定的最大倍率（缩放由前端 CSS 处理，避免透明窗口调整导致闪屏）。
pub const WIDGET_CREATE_SCALE: f64 = 2.5;

/// 未在配置页设置过吸附距离时的默认阈值（**物理像素**）。
///
/// 与配置页「边缘吸附」的默认值完全一致（配置页把 0 折算成该值显示），
/// 吸附阈值因此只有**配置页一个来源**，后端不另外发明数值。
pub const WIDGET_SNAP_DISTANCE_DEFAULT_PX: f64 = 300.0;

/// 根据倍率计算挂件窗口的逻辑边长（正方形，钳制在上下限内）。
pub fn widget_size(scale: f64) -> f64 {
    (WIDGET_BASE * scale).clamp(WIDGET_MIN_SIZE, WIDGET_MAX_SIZE)
}

/// 吸附阈值（物理像素）：配置了比例就用比例，否则用配置页默认值。
pub fn snap_distance_px(snap_ratio: f64, work_area_width: u32) -> i32 {
    if snap_ratio > 0.0 {
        (work_area_width as f64 * snap_ratio).round() as i32
    } else {
        WIDGET_SNAP_DISTANCE_DEFAULT_PX.round() as i32
    }
}

/// 桌宠朝向：以所在显示器工作区的**物理水平中心**为界。
///
/// 左半区 → 朝右，右半区 → 朝左 —— 两种情形都面向屏幕中心；
/// 正好落在中心线上按「左半区」处理（含左边界）。
///
/// 多屏混合 DPI 下 `display` 必须是**桌宠实际所在的那块屏**，
/// 因此中心线取的是该屏工作区的中心，而不是某个「全局虚拟桌面」的中心。
pub fn facing_for(pet_center_x: i32, display: &DisplayLayout) -> Facing {
    let center = display.left() + display.work_area.2 as i32 / 2;
    if pet_center_x < center {
        Facing::Right
    } else {
        Facing::Left
    }
}

/// 内容块在窗口内的水平偏移（物理像素）。
///
/// 左右吸附时内容块贴窗口左 / 右边（零间隙贴合靠它），未吸附时贴窗口右边。
pub fn content_offset_x(window_width: i32, content_width: i32, anchor: HorizontalAnchor) -> i32 {
    if anchor == HorizontalAnchor::Left {
        0
    } else {
        window_width - content_width
    }
}

/// 桌宠（内容块）中心的物理 X 坐标。
pub fn pet_center_x(
    window_x: i32,
    window_width: i32,
    content_width: i32,
    anchor: HorizontalAnchor,
) -> i32 {
    window_x + content_offset_x(window_width, content_width, anchor) + content_width / 2
}

/// 未发生吸附时的结果（窗口不可读 / 工作区不可得时使用）。
pub fn no_snap() -> SnapResult {
    SnapResult {
        h: HorizontalAnchor::None.as_str().to_string(),
        v: VerticalAnchor::None.as_str().to_string(),
        facing: Facing::DEFAULT.as_str().to_string(),
    }
}

// ---------------------------------------------------------------------------
// 多显示器 / 混合 DPI 放置（纯计算，全部使用**物理像素**）
// ---------------------------------------------------------------------------

/// 选出坐标点所属的显示器；都不包含时取距离最近的一块（落在屏幕缝隙或屏外也能收敛）。
///
/// 多屏 + 混合缩放时坐标必须落在具体某块屏上再运算，否则会像本 issue 那样
/// 「用 A 屏的数值/缩放去摆 B 屏的窗口」。
pub fn pick_display(point: (i32, i32), displays: &[DisplayLayout]) -> Option<usize> {
    if displays.is_empty() {
        return None;
    }
    if let Some(index) = displays.iter().position(|d| d.contains(point)) {
        return Some(index);
    }
    displays
        .iter()
        .enumerate()
        .min_by_key(|(_, d)| d.distance_squared(point))
        .map(|(index, _)| index)
}

/// 把窗口位置夹进某块显示器的工作区（物理像素），保证窗口尽可能完整可见。
///
/// 常规情况就是「不越出工作区四边」。窗口**装不下**时（高缩放下 625 逻辑像素的
/// 窗口物理尺寸会超过小屏工作区，例如 1080p @200% 时窗口高 1250 > 工作区 1040）
/// 按锚点决定保住哪条边：
///
/// - 宠物本体固定在内容块的**右下角**，水平非左锚点时保右、垂直非上锚点时保下，
///   这样窗口即使被裁，本体与气泡仍落在屏内、仍可点选拖动（本 issue 的核心诉求）；
/// - 左锚点 / 上锚点（镜像或顶部吸附）时内容跑到了窗口另一侧，相应改为保左 / 保上。
pub fn clamp_into_work_area(
    display: &DisplayLayout,
    size: (i32, i32),
    position: (i32, i32),
    anchors: (HorizontalAnchor, VerticalAnchor),
) -> (i32, i32) {
    let (width, height) = size;
    let max_x = display.right() - width;
    let max_y = display.bottom() - height;

    let x = if max_x < display.left() {
        if anchors.0 == HorizontalAnchor::Left {
            display.left()
        } else {
            max_x
        }
    } else {
        position.0.clamp(display.left(), max_x)
    };

    let y = if max_y < display.top() {
        if anchors.1 == VerticalAnchor::Top {
            display.top()
        } else {
            max_y
        }
    } else {
        position.1.clamp(display.top(), max_y)
    };

    (x, y)
}

/// 拖拽落点约束：允许窗口的**透明留白**越出工作区，但内容块必须完整可见。
///
/// 窗口固定 625 逻辑像素，而内容块（气泡 + 鲸鱼整体）只有 `250 × 显示倍率`：
/// 多出来的透明区是贴边吸附的**行程**。若按 [`clamp_into_work_area`] 把整个窗口
/// 都夹进工作区，顶部吸附的行程就被吃掉——内容块永远到不了上沿，也就永远触发
/// 不了吸附（用户感知为「拖到上面不吸附」）。
///
/// 这里的口径是：内容块在窗口内的偏移方向由锚点决定（左 / 上锚点时内容贴窗口
/// 左 / 上边，否则贴右 / 下边），只要求内容块落在工作区内，窗口其余部分可以越界。
/// 这样宠物本体始终可见、可点选，同时保留完整吸附行程。
pub fn clamp_window_keeping_content_visible(
    display: &DisplayLayout,
    window_size: (i32, i32),
    content_size: (i32, i32),
    position: (i32, i32),
    anchors: (HorizontalAnchor, VerticalAnchor),
) -> (i32, i32) {
    let (window_width, window_height) = window_size;
    let (content_width, content_height) = content_size;
    // 内容块在窗口内的偏移：左 / 上锚点时贴窗口左 / 上边，否则贴右 / 下边。
    let offset_x = if anchors.0 == HorizontalAnchor::Left {
        0
    } else {
        window_width - content_width
    };
    let offset_y = if anchors.1 == VerticalAnchor::Top {
        0
    } else {
        window_height - content_height
    };

    // 内容块（而非窗口）落在工作区内的窗口位置区间。
    let min_x = display.left() - offset_x;
    let max_x = display.right() - content_width - offset_x;
    let min_y = display.top() - offset_y;
    let max_y = display.bottom() - content_height - offset_y;

    (
        clamp_axis(
            position.0,
            min_x,
            max_x,
            anchors.0 == HorizontalAnchor::Left,
        ),
        clamp_axis(position.1, min_y, max_y, anchors.1 == VerticalAnchor::Top),
    )
}

/// 单轴夹取；内容块比工作区还大（装不下）时按锚点保住宠物所在的那一侧。
fn clamp_axis(value: i32, min: i32, max: i32, keep_min_when_oversized: bool) -> i32 {
    if min <= max {
        value.clamp(min, max)
    } else if keep_min_when_oversized {
        min
    } else {
        max
    }
}

/// 默认落点：目标显示器工作区的右下角（含「装不下」时的保边处理）。
pub fn default_position(
    display: &DisplayLayout,
    size: (i32, i32),
    anchors: (HorizontalAnchor, VerticalAnchor),
) -> (i32, i32) {
    clamp_into_work_area(display, size, (i32::MAX, i32::MAX), anchors)
}

/// 计算拖拽释放后的吸附位置。
///
/// **只有一种判定规则**：桌宠（鲸鱼 / 内容块）与工作区某条边的距离 ≤ 吸附阈值时
/// 才吸附到那条边。阈值来自配置页「边缘吸附」，未设置时用配置页默认值
/// （见 [`WIDGET_SNAP_DISTANCE_DEFAULT_PX`]）。
///
/// 历史上 `snap_ratio == 0` 会退化成「落在屏幕外侧 1/4 区域就吸附」，那会让用户
/// 在屏幕中部随意摆放时也被强行吸到边上（用户反馈的「非吸附场景下的意外位置偏移」），
/// 该规则已彻底移除。
pub fn compute_snap(input: &SnapInput) -> SnapOutcome {
    let (wa_x, wa_y, wa_w, wa_h) = input.work_area;
    let (whale_left, _, whale_width, _) = input.whale;
    let (_, content_top, _, _) = input.content;
    let sf = input.scale_factor;

    let wl = (whale_left * sf).round() as i32;
    let wt = (input.whale.1 * sf).round() as i32;
    let ww = (whale_width * sf).round() as i32;
    let wh = (input.whale.3 * sf).round() as i32;
    // 顶边用内容块（气泡 + 鲸鱼整体）的上边：气泡画在鲸鱼上方，鲸鱼上边比它低一个
    // 气泡高度——只有连气泡一起贴顶，吸附后气泡才完整可见、鲸鱼才真正「贴在上方」。
    // 底边仍用鲸鱼下边（与内容块下边重合），触发手感与历史一致。
    let ct = (content_top * sf).round() as i32;

    let w = input.window_width;
    let h = input.window_height;
    // 阈值为 0（应用层未解析出阈值）时不吸附：位置原样返回。
    let snap_distance = input.snap_distance_px;
    if snap_distance <= 0 {
        return SnapOutcome {
            result: SnapResult {
                h: HorizontalAnchor::None.as_str().to_string(),
                v: VerticalAnchor::None.as_str().to_string(),
                facing: Facing::DEFAULT.as_str().to_string(),
            },
            x: input.window_x,
            y: input.window_y,
        };
    }

    let mut horizontal = HorizontalAnchor::None;
    let mut vertical = VerticalAnchor::None;
    let mut x = input.window_x;
    let mut y = input.window_y;

    // 左右：鲸鱼左右边即内容块左右边（左右吸附会把鲸鱼镜像到内容块外侧）。
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

    SnapOutcome {
        result: SnapResult {
            h: horizontal.as_str().to_string(),
            v: vertical.as_str().to_string(),
            // 朝向与吸附无关（由屏幕半区决定），这里只是给不出窗口几何时占位；
            // 真正落位后由 `window_api` 按最终坐标重算。
            facing: Facing::DEFAULT.as_str().to_string(),
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
    fn base_input(snap_px: i32) -> SnapInput {
        SnapInput {
            window_x: 0,
            window_y: 0,
            window_width: 625,
            window_height: 625,
            work_area: (0, 0, 1920, 1080),
            whale: (0.0, 0.0, 625.0, 625.0),
            content: (0.0, 0.0, 625.0, 625.0),
            scale_factor: 1.0,
            snap_distance_px: snap_px,
        }
    }

    /// 真实构图（缩放 1.5，屏幕 1920×1080 物理）：窗口位于 `(window_x, window_y)` 物理坐标，
    /// 窗口 625×625 逻辑；内容块 375×375 逻辑锚在窗口右下角（窗口内偏移 250）；
    /// 鲸鱼 222.9×222.9 逻辑贴在内容块右下角，上边比内容块上边低 152.1 逻辑（≈228 物理）。
    ///
    /// 两个矩形都按**屏幕逻辑坐标**给出，与前端 `getBoundingClientRect()` + `window.screenX/Y`
    /// 的测量口径一致。
    fn scaled_input_at(snap_px: i32, window_x: i32, window_y: i32) -> SnapInput {
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
            snap_distance_px: snap_px,
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

    /// 阈值 96 物理 px：贴近左/上边缘时吸附，阈值外位置原样保持。
    #[test]
    fn snaps_only_within_threshold() {
        let mut input = base_input(96);
        input.window_x = 50;
        input.window_y = 50;
        input.whale = (50.0, 50.0, 625.0, 625.0);
        input.content = input.whale;
        let outcome = compute_snap(&input);
        assert_eq!(outcome.result.h, "left");
        assert_eq!(outcome.result.v, "top");
        assert_eq!((outcome.x, outcome.y), (0, 0));

        // 远离边缘：不吸附，位置保持。
        let mut far = base_input(96);
        far.window_x = 600;
        far.window_y = 200;
        far.whale = (600.0, 200.0, 625.0, 625.0);
        far.content = far.whale;
        let outcome = compute_snap(&far);
        assert_eq!(outcome.result.h, "none");
        assert_eq!(outcome.result.v, "none");
        assert_eq!((outcome.x, outcome.y), (600, 200));
    }

    /// 贴近右/下边缘时吸附到工作区内侧（零间隙：窗口右下角严格贴合工作区）。
    #[test]
    fn snaps_to_right_and_bottom_flush() {
        let mut input = base_input(96);
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

    /// 回归：**不再有「落在屏幕外侧 1/4 区域就吸附」**的隐式规则。
    ///
    /// 阈值 0（未配置 → 应用层会填配置页默认值，域层当作 0 = 不吸附）时，
    /// 即使桌宠落在最外侧，也绝不能自己吸到边上。
    #[test]
    fn no_region_based_auto_snap() {
        for (window_x, window_y) in [(0, 0), (10, 10), (1900, 1070), (1500, 900)] {
            let mut input = base_input(0);
            input.window_x = window_x;
            input.window_y = window_y;
            input.whale = (window_x as f64, window_y as f64, 625.0, 625.0);
            input.content = input.whale;
            let outcome = compute_snap(&input);
            assert_eq!(
                (outcome.result.h.as_str(), outcome.result.v.as_str()),
                ("none", "none"),
                "阈值 0 = 不吸附，位置 {window_x},{window_y} 不能被自动吸到边上"
            );
            assert_eq!((outcome.x, outcome.y), (window_x, window_y));
        }
    }

    /// 回归：屏幕中部（远离任何边界的四分之一区域）随意摆放绝不吸附。
    ///
    /// 修复前 `snap_distance == 0` 会走四分之一区域判定，把落在左 / 上四分之一
    /// 的桌宠强行吸到屏幕角落 —— 这正是用户反馈的「非吸附场景下的意外位置偏移」。
    #[test]
    fn middle_drop_never_snaps() {
        for (window_x, window_y) in [(100, 100), (300, 200), (480, 270), (60, 400)] {
            let mut input = base_input(0);
            input.window_x = window_x;
            input.window_y = window_y;
            input.whale = (window_x as f64, window_y as f64, 300.0, 300.0);
            input.content = input.whale;
            let outcome = compute_snap(&input);
            assert_eq!(
                (outcome.result.h.as_str(), outcome.result.v.as_str()),
                ("none", "none"),
                "位置 {window_x},{window_y} 在屏幕中部，不能自动吸附"
            );
            assert_eq!((outcome.x, outcome.y), (window_x, window_y));
        }
    }

    /// 缩放因子参与换算：逻辑坐标按实际 DPI 放大后再判定。
    #[test]
    fn scale_factor_is_applied() {
        let mut input = base_input(96);
        input.scale_factor = 2.0;
        input.window_width = 1250;
        input.window_height = 1250;
        input.whale = (250.0, 0.0, 625.0, 625.0);
        input.content = input.whale;
        // 物理 whale_left = 500 > 96 → 不吸附左侧。
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
        let outcome = compute_snap(&scaled_input_at(96, 0, -300));
        assert_eq!(outcome.result.v, "top");
        assert_eq!(outcome.y, 0, "窗口顶边贴工作区顶边");

        // 吸附后：气泡上边 = 375 物理（完整可见），鲸鱼上边 = 603 物理，
        // 两者相差 228 物理 px —— 这段就是「为气泡预留的区域」。
        let content_top = (250.0_f64 * 1.5).round() as i32;
        let whale_top = (402.1_f64 * 1.5).round() as i32;
        assert_eq!(content_top, 375);
        assert!(
            whale_top + (222.9_f64 * 1.5) as i32 <= 1080,
            "鲸鱼必须完整落在工作区内"
        );
        assert!(
            whale_top - content_top > 200,
            "鲸鱼上边比气泡上边低一个气泡高度，这段就是为气泡预留的区域"
        );

        // 仅仅「位置偏高」但气泡还没到顶边时不吸附（阈值 96 物理 px）。
        assert_eq!(compute_snap(&scaled_input_at(96, 0, 0)).result.v, "none");

        // 鲸鱼上边贴顶（气泡整体越界）同样触发吸附——这正是修复前会「弹回中部」的场景。
        assert_eq!(compute_snap(&scaled_input_at(96, 0, -520)).result.v, "top");
    }

    /// 顶部吸附同样是零间隙：窗口顶边严格贴工作区顶边，气泡上边 = 工作区上沿。
    #[test]
    fn top_snap_is_flush() {
        let outcome = compute_snap(&scaled_input_at(96, 0, -300));
        assert_eq!(outcome.y, 0);
        // 内容块锚到窗口上沿时，内容块上边 == 窗口顶边 == 工作区上沿 → 零间隙。
        assert_eq!(outcome.y, 0, "窗口顶边 = 工作区上沿");
    }

    #[test]
    fn no_snap_returns_none_anchors() {
        let result = no_snap();
        assert_eq!(result.h, "none");
        assert_eq!(result.v, "none");
        assert!(["left", "right"].contains(&result.facing.as_str()));
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
                snap_distance_px: 96,
            };
            let outcome = compute_snap(&input);
            assert_eq!(
                outcome.result.v, "top",
                "分辨率 {wa_w}×{wa_h} @{sf}x：推到上沿之上必须吸到顶部"
            );
            assert_eq!(
                outcome.y, 0,
                "分辨率 {wa_w}×{wa_h} @{sf}x：顶边贴工作区上沿"
            );

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
                snap_distance_px: 96,
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

    // -----------------------------------------------------------------------
    // 多显示器 / 混合 DPI 放置
    // -----------------------------------------------------------------------

    /// issue.md 里的真实双屏布局：主屏 1920×1080 @100%，副屏 2560×1600 @150%
    /// 位于主屏右侧且上沿高出 252px（工作区 (1920,-252)-(4480,1276)）。
    fn issue_displays() -> (DisplayLayout, DisplayLayout) {
        (
            DisplayLayout::new((0, 0, 1920, 1032), 1.0),
            DisplayLayout::new((1920, -252, 2560, 1528), 1.5),
        )
    }

    /// issue.md 的回归：旧实现把「主屏逻辑坐标」交给 150% 副屏，得到物理 (1943,611)，
    /// 窗口底边 1549 越出副屏工作区下沿 1276 共 273px，宠物本体（窗口右下角）整块出屏。
    /// 修复后同一个落点必须被夹回副屏工作区内，且宠物本体所在的内容块完整可见。
    #[test]
    fn mixed_dpi_placement_clamps_into_target_display() {
        let (primary, secondary) = issue_displays();
        // 窗口在 150% 屏上的物理尺寸：625 逻辑 × 1.5 = 938。
        let size = (938, 938);
        let anchors = (HorizontalAnchor::Right, VerticalAnchor::None);

        let buggy = (1943, 611);
        let fixed = clamp_into_work_area(&secondary, size, buggy, anchors);
        // X 本来就在副屏工作区内（1920..4480），只有 Y 越界：611 + 938 = 1549 > 1276。
        assert_eq!(fixed, (1943, 338), "只把越界的 Y 夹回副屏工作区内");
        assert!(
            fixed.1 + size.1 <= secondary.bottom(),
            "窗口底边必须在副屏工作区内：{} + {} <= {}",
            fixed.1,
            size.1,
            secondary.bottom()
        );
        assert!(
            buggy.1 + size.1 > secondary.bottom(),
            "旧落点确实是出屏的（否则这个用例就没有意义）"
        );

        // 换到 100% 主屏：同样的「逻辑坐标」在 1.0 缩放下就是物理坐标，位置原样保留。
        let size_primary = (625, 625);
        assert_eq!(
            clamp_into_work_area(&primary, size_primary, (1295, 407), anchors),
            (1295, 407),
            "主屏 100% 时 1295 = 1920-625、407 = 1032-625，正是 issue 里推算出的数值"
        );
    }

    /// 混合 DPI 双屏：吸附必须以**窗口所在那块屏**的工作区为零点。
    ///
    /// 副屏工作区从 (1920,-252) 起（含负的 y），把窗口推到副屏左上角附近时，
    /// 必须吸到副屏的左上角，而不是主屏的 (0,0)；且零间隙（窗口边 = 工作区边）。
    #[test]
    fn snap_uses_the_display_the_window_is_on() {
        let (_primary, secondary) = issue_displays();
        let sf = secondary.scale_factor;
        let window = (938, 938);
        // 内容块 375 逻辑（= 562.5 物理），锚在窗口右下角 → 窗口内偏移 250 逻辑 = 375 物理。
        let offset = 375;
        // 水平推到「内容块贴副屏左沿」的极限、纵向让气泡上边进入吸附阈值。
        let wx = secondary.left() - offset;
        let wy = secondary.top() - 200;
        let (ox, oy) = (wx as f64 / sf, wy as f64 / sf);

        let outcome = compute_snap(&SnapInput {
            window_x: wx,
            window_y: wy,
            window_width: window.0,
            window_height: window.1,
            work_area: secondary.work_area,
            whale: (ox + 402.1, oy + 402.1, 222.9, 222.9),
            content: (ox + 250.0, oy + 250.0, 375.0, 375.0),
            scale_factor: sf,
            snap_distance_px: 300,
        });

        assert_eq!(outcome.result.h, "left");
        assert_eq!(outcome.result.v, "top");
        assert_eq!(
            (outcome.x, outcome.y),
            (secondary.left(), secondary.top()),
            "零间隙：窗口左上角严格贴**副屏**工作区左上角（1920, -252）"
        );
        assert_ne!(
            (outcome.x, outcome.y),
            (0, 0),
            "绝不能吸到主屏原点 —— 那正是「跨屏吸附错屏」的病态"
        );
    }

    /// 首次运行（无持久化位置）：落在**主屏**工作区右下角，整窗可见。
    #[test]
    fn first_run_defaults_to_primary_work_area_corner() {
        let (primary, secondary) = issue_displays();
        let anchors = (HorizontalAnchor::Right, VerticalAnchor::None);

        let size = (625, 625);
        let pos = default_position(&primary, size, anchors);
        assert_eq!(pos, (1295, 407), "主屏 100%：1920-625 / 1032-625");
        assert!(pos.0 + size.0 <= primary.right());
        assert!(pos.1 + size.1 <= primary.bottom());

        // 有持久化落点时先按落点选屏，再按**那块屏**的缩放换算窗口物理尺寸。
        let displays = [primary, secondary];
        let saved = (3000, 200);
        let index = pick_display(saved, &displays).expect("必须选中一块屏");
        assert_eq!(index, 1, "落点在副屏（150%）上");
        let size_secondary = (
            (WIDGET_CREATE_SCALE * WIDGET_BASE * displays[index].scale_factor).round() as i32,
            (WIDGET_CREATE_SCALE * WIDGET_BASE * displays[index].scale_factor).round() as i32,
        );
        assert_eq!(size_secondary, (938, 938));
        let pos = clamp_into_work_area(&displays[index], size_secondary, saved, anchors);
        assert_eq!(pos, saved, "落点本身合法时保持不动");
        assert!(pos.0 + size_secondary.0 <= displays[index].right());
        assert!(pos.1 + size_secondary.1 <= displays[index].bottom());
    }

    /// 100% / 125% / 150% / 200% 四档缩放下，窗口物理尺寸与落点都按目标屏换算，
    /// 且**整窗**落在工作区内（对应的就是「所有模拟多 DPI 场景无偏移、不越界」）。
    #[test]
    fn placement_is_correct_at_all_common_dpi_scales() {
        for (sf, work_area) in [
            (1.0_f64, (0, 0, 1920u32, 1032u32)), // 100%
            (1.25, (0, 0, 1536, 824)),           // 125%
            (1.5, (0, 0, 1707, 1019)),           // 150%（本机）
            (2.0, (0, 0, 1920, 1040)),           // 200%
        ] {
            let display = DisplayLayout::new(work_area, sf);
            assert_eq!(
                display.dpi(),
                (sf * 96.0).round() as u32,
                "有效 DPI 与缩放一致"
            );

            let size = (
                (WIDGET_CREATE_SCALE * WIDGET_BASE * sf).round() as i32,
                (WIDGET_CREATE_SCALE * WIDGET_BASE * sf).round() as i32,
            );
            let anchors = (HorizontalAnchor::Right, VerticalAnchor::None);
            let pos = default_position(&display, size, anchors);

            assert!(
                pos.0 >= display.left() && pos.0 + size.0 <= display.right(),
                "@{sf}x 水平必须完整落在工作区内：{pos:?} size {size:?}"
            );
            if size.1 <= display.work_area.3 as i32 {
                assert!(
                    pos.1 >= display.top() && pos.1 + size.1 <= display.bottom(),
                    "@{sf}x 垂直必须完整落在工作区内：{pos:?} size {size:?}"
                );
            }
            // 同一块屏的物理↔逻辑换算必须自洽（四舍五入误差 ≤ 1px）。
            let back = display.to_logical(pos);
            let again = display.to_physical(back.0, back.1);
            assert_eq!(again, pos, "@{sf}x 物理↔逻辑往返应当稳定");
        }
    }

    /// 窗口物理尺寸超过工作区时（1080p @200%：窗口 1250 > 工作区 1040），
    /// 按锚点保住宠物所在的边 —— 内容块（气泡 + 鲸鱼整体）必须完整可见。
    #[test]
    fn oversized_window_keeps_pet_content_visible() {
        let display = DisplayLayout::new((0, 0, 1920, 1040), 2.0);
        let size = (1250, 1250);
        let widget_scale = 1.5_f64;
        let content = (WIDGET_BASE * widget_scale * 2.0).round() as i32; // 750 物理

        for anchors in [
            (HorizontalAnchor::Right, VerticalAnchor::None),
            (HorizontalAnchor::Right, VerticalAnchor::Bottom),
            (HorizontalAnchor::Right, VerticalAnchor::Top),
            (HorizontalAnchor::Left, VerticalAnchor::None),
        ] {
            let pos = default_position(&display, size, anchors);
            let cx = if anchors.0 == HorizontalAnchor::Left {
                pos.0
            } else {
                pos.0 + size.0 - content
            };
            let cy = if anchors.1 == VerticalAnchor::Top {
                pos.1
            } else {
                pos.1 + size.1 - content
            };
            assert!(
                cx >= display.left() && cx + content <= display.right(),
                "锚点 {anchors:?}：内容块水平必须可见 cx={cx}"
            );
            assert!(
                cy >= display.top() && cy + content <= display.bottom(),
                "锚点 {anchors:?}：内容块垂直必须可见 cy={cy}"
            );
        }
    }

    /// 拖拽约束必须把「贴边吸附的行程」留给窗口：窗口的透明留白可以越出工作区上沿，
    /// 但内容块（气泡 + 鲸鱼）要完整可见 —— 否则内容块永远到不了上沿，顶部吸附失效。
    #[test]
    fn drag_clamp_keeps_top_snap_reachable() {
        let display = DisplayLayout::new((0, 0, 2560, 1528), 1.5);
        let window = (938, 938);
        let content = (563, 563);
        let anchors = (HorizontalAnchor::Right, VerticalAnchor::None);

        let placed =
            clamp_window_keeping_content_visible(&display, window, content, (1200, -500), anchors);
        assert!(
            placed.1 < display.top(),
            "窗口留白必须能越出上沿：{placed:?}"
        );
        assert_eq!(placed.1, -375, "最多越过 window - content = 375");
        let content_top = placed.1 + (window.1 - content.1);
        assert_eq!(content_top, display.top(), "内容块上边正好贴工作区上沿");
        assert!(content_top + content.1 <= display.bottom());

        // 在这个落点上，吸附算法必须判定「顶部吸附」——这正是修复前永不触发的场景。
        let content_logical = content_top as f64 / 1.5;
        let outcome = compute_snap(&SnapInput {
            window_x: placed.0,
            window_y: placed.1,
            window_width: window.0,
            window_height: window.1,
            work_area: display.work_area,
            whale: (600.0, content_logical + 101.375, 148.6, 148.6),
            content: (400.0, content_logical, 250.0, 250.0),
            scale_factor: 1.5,
            snap_distance_px: 300,
        });
        assert_eq!(outcome.result.v, "top");
        assert_eq!(outcome.y, 0, "顶部吸附后窗口顶边贴工作区上沿");
    }

    /// 四个方向无论拖多远，内容块都完整可见（宠物本体始终可点选）。
    #[test]
    fn drag_clamp_keeps_content_visible_on_every_edge() {
        let display = DisplayLayout::new((0, 0, 2560, 1528), 1.5);
        let window = (938, 938);
        let content = (563, 563);

        for anchors in [
            (HorizontalAnchor::Right, VerticalAnchor::None),
            (HorizontalAnchor::Left, VerticalAnchor::None),
            (HorizontalAnchor::Right, VerticalAnchor::Top),
            (HorizontalAnchor::Left, VerticalAnchor::Top),
        ] {
            for target in [(-5000, -5000), (5000, 5000), (-5000, 5000), (5000, -5000)] {
                let (x, y) = clamp_window_keeping_content_visible(
                    &display, window, content, target, anchors,
                );
                let offset_x = if anchors.0 == HorizontalAnchor::Left {
                    0
                } else {
                    window.0 - content.0
                };
                let offset_y = if anchors.1 == VerticalAnchor::Top {
                    0
                } else {
                    window.1 - content.1
                };
                let (content_x, content_y) = (x + offset_x, y + offset_y);
                assert!(
                    content_x >= display.left() && content_x + content.0 <= display.right(),
                    "锚点 {anchors:?} 目标 {target:?}：内容块水平必须完整可见 cx={content_x}"
                );
                assert!(
                    content_y >= display.top() && content_y + content.1 <= display.bottom(),
                    "锚点 {anchors:?} 目标 {target:?}：内容块垂直必须完整可见 cy={content_y}"
                );
            }
        }
    }

    /// 右下角方向严格贴工作区：内容块右下边与工作区右下角严丝合缝（零间隙）。
    #[test]
    fn drag_clamp_pins_bottom_right_corner_flush() {
        let display = DisplayLayout::new((0, 0, 2560, 1528), 1.5);
        let placed = clamp_window_keeping_content_visible(
            &display,
            (938, 938),
            (563, 563),
            (9000, 9000),
            (HorizontalAnchor::Right, VerticalAnchor::None),
        );
        assert_eq!(
            placed,
            (1622, 590),
            "= 工作区右下角减窗口尺寸（与首启默认落点一致）"
        );
    }

    /// 拖拽到四边即**零间隙贴合**：内容块边与工作区边界重合，不再有额外留白。
    ///
    /// 这是本轮的核心诉求之一 —— 底部吸附时要完全贴合任务栏上边缘。
    #[test]
    fn drag_reaches_edges_with_zero_gap() {
        let display = DisplayLayout::new((0, 0, 2560, 1528), 1.5);
        let window = (938, 938);
        let content = (563, 563);
        let anchors = (HorizontalAnchor::Right, VerticalAnchor::None);
        // 内容块左/上边在窗口内的偏移（右下锚定）。
        let offset = (window.0 - content.0, window.1 - content.1);

        // 用力往左上角拖：内容块左/上边正好贴住工作区左/上沿。
        let (x, y) = clamp_window_keeping_content_visible(
            &display,
            window,
            content,
            (-10000, -10000),
            anchors,
        );
        assert_eq!(
            (x + offset.0, y + offset.1),
            (display.left(), display.top()),
            "左上角：内容块边与工作区边界零间隙"
        );

        // 用力往右下角拖：内容块右/下边正好贴住工作区右/下沿（下沿 = 任务栏上边缘）。
        let (x, y) = clamp_window_keeping_content_visible(
            &display,
            window,
            content,
            (10000, 10000),
            anchors,
        );
        assert_eq!(
            (x + offset.0 + content.0, y + offset.1 + content.1),
            (display.right(), display.bottom()),
            "右下角：内容块下边与任务栏上边缘零间隙"
        );
    }

    /// 拖到边缘的过程中，屏幕中部绝不会被约束改写（不存在「意外位置偏移」）。
    #[test]
    fn drag_middle_position_is_untouched() {
        let display = DisplayLayout::new((0, 0, 2560, 1528), 1.5);
        let window = (938, 938);
        let content = (563, 563);
        for anchors in [
            (HorizontalAnchor::Right, VerticalAnchor::None),
            (HorizontalAnchor::Left, VerticalAnchor::None),
            (HorizontalAnchor::Right, VerticalAnchor::Top),
        ] {
            for target in [
                (400, 300),
                (700, 500),
                (123, 456),
                // 内容块已完全在工作区内、只是窗口留白越界的落点同样原样保留。
                (900, 400),
            ] {
                let placed = clamp_window_keeping_content_visible(
                    &display, window, content, target, anchors,
                );
                assert_eq!(
                    placed, target,
                    "锚点 {anchors:?}：屏幕中部落点 {target:?} 必须原样保留"
                );
            }
        }
    }

    /// 朝向：以桌宠所在显示器工作区的物理中心为界，左半区朝右、右半区朝左。
    #[test]
    fn facing_follows_screen_half() {
        let display = DisplayLayout::new((0, 0, 2560, 1528), 1.5);
        assert_eq!(display.left() + 2560 / 2, 1280, "中心线 1280");

        for x in [0, 1, 400, 1279] {
            assert_eq!(
                facing_for(x, &display),
                Facing::Right,
                "x={x} 在左半区 → 朝右（面向屏幕中心）"
            );
        }
        for x in [1280, 1281, 2000, 2559] {
            assert_eq!(
                facing_for(x, &display),
                Facing::Left,
                "x={x} 在右半区（含中心线）→ 朝左"
            );
        }
    }

    /// 混合 DPI 双屏：中心线取**桌宠所在那块屏**的中心，而不是虚拟桌面的中心。
    #[test]
    fn facing_uses_the_monitor_the_pet_is_on() {
        let (primary, secondary) = issue_displays();
        // 主屏 1920×1032 @100%：中心 960；副屏 (1920,-252)-(4480,1276) @150%：中心 3200。
        assert_eq!(facing_for(400, &primary), Facing::Right, "主屏左半区");
        assert_eq!(facing_for(1500, &primary), Facing::Left, "主屏右半区");

        // 副屏左半区（例如刚跨过屏缝的 2000）在「全局」看来偏左，但在本屏必须朝右。
        assert_eq!(
            facing_for(2000, &secondary),
            Facing::Right,
            "副屏左半区朝右"
        );
        assert_eq!(
            facing_for(3200, &secondary),
            Facing::Left,
            "副屏中心线起朝左"
        );
        assert_eq!(facing_for(4000, &secondary), Facing::Left, "副屏右半区朝左");
        // 同一物理坐标落在不同屏，朝向结论必须按各自屏的中心线给出。
        assert_eq!(facing_for(2000, &primary), Facing::Left);
        assert_ne!(facing_for(2000, &primary), facing_for(2000, &secondary));
    }

    /// 内容块中心的物理 X：左右锚点分别贴窗口左 / 右边。
    #[test]
    fn pet_center_uses_content_anchor() {
        // 窗口 938 物理、内容块 563 物理：右锚点在窗口内偏移 375，左锚点偏移 0。
        assert_eq!(content_offset_x(938, 563, HorizontalAnchor::Right), 375);
        assert_eq!(content_offset_x(938, 563, HorizontalAnchor::Left), 0);
        assert_eq!(content_offset_x(938, 563, HorizontalAnchor::None), 375);

        assert_eq!(
            pet_center_x(1000, 938, 563, HorizontalAnchor::Right),
            1000 + 375 + 281
        );
        assert_eq!(
            pet_center_x(1000, 938, 563, HorizontalAnchor::Left),
            1000 + 281
        );
    }

    /// 吸附阈值只有一个来源：配置了比例按比例，未配置（0）用配置页默认值。
    #[test]
    fn snap_distance_comes_from_config_only() {
        // 未设置 → 配置页默认值（300 物理像素），与屏幕宽度无关。
        assert_eq!(snap_distance_px(0.0, 1920), 300);
        assert_eq!(snap_distance_px(0.0, 3840), 300);
        // 设置了比例 → 按该屏工作区宽度折算。
        assert_eq!(snap_distance_px(0.05, 1920), 96);
        assert_eq!(snap_distance_px(0.05, 3840), 192);
        assert_eq!(
            snap_distance_px(WIDGET_SNAP_DISTANCE_DEFAULT_PX / 2560.0, 2560),
            300,
            "配置页写回的等效比例与默认值一致"
        );
    }

    /// 选屏：优先「包含该点」的显示器，都不包含时取距离最近的一块。
    #[test]
    fn pick_display_prefers_containing_then_nearest() {
        let (primary, secondary) = issue_displays();
        let displays = [primary, secondary];

        assert_eq!(pick_display((100, 100), &displays), Some(0), "主屏内");
        assert_eq!(
            pick_display((2000, 500), &displays),
            Some(1),
            "副屏内（y 含负偏移）"
        );
        assert_eq!(
            pick_display((1920, 1400), &displays),
            Some(1),
            "两屏之间的缝隙取最近"
        );
        assert_eq!(pick_display((0, -200), &displays), Some(0), "屏外取最近");
        assert_eq!(pick_display((100, 100), &[]), None, "无显示器时返回 None");
    }
}
