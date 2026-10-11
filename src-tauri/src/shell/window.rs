//! 原生窗口宿主
//!
//! 挂件窗口与配置窗口的创建、复用，以及窗口几何 / 工作区相关的读取。
//!
//! # 多显示器与混合 DPI
//!
//! 所有窗口位置一律以**物理像素**（Win32 屏幕绝对坐标）计算与落盘：
//!
//! - 物理坐标全局唯一，不随任何一块显示器的缩放变化；
//! - 逻辑坐标只对「某一块」显示器成立，跨屏复用必然错位。
//!
//! 初始放置走 [`crate::domain::window::service::window_service`] 的纯函数：
//! 先按持久化落点（或主屏右下角）选屏 → 按**那块屏**的缩放换算窗口物理尺寸 →
//! 夹进它的工作区 → 落位后再读回真实几何做一次闭环复核。

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::application::config;
use crate::application::registry;
use crate::domain::config::model::WidgetPosition;
use crate::domain::window::model::{DisplayLayout, WidgetGeometry};
use crate::domain::window::service::window_service::{
    clamp_window_keeping_content_visible, default_position, pick_display, widget_size,
    WIDGET_CREATE_SCALE,
};
use crate::shell::tray;
use crate::types::common::constants::{
    CONFIG_WINDOW_LABEL, EVENT_APP_QUIT, EVENT_WIDGET_VISIBILITY, QUIT_CLEANUP_GRACE_MS,
    VISIBILITY_PAINT_GRACE_MS, WIDGET_WINDOW_LABEL,
};
use crate::types::enums::{HorizontalAnchor, VerticalAnchor};

/// 读取挂件窗口当前物理几何信息。
pub fn current_geometry(window: &WebviewWindow) -> WidgetGeometry {
    let (x, y) = window
        .outer_position()
        .map(|p| (p.x, p.y))
        .unwrap_or((0, 0));
    let (width, height) = window
        .outer_size()
        .map(|s| (s.width, s.height))
        .unwrap_or((0, 0));
    WidgetGeometry {
        x,
        y,
        width,
        height,
    }
}

/// 获取显示器工作区（排除任务栏），返回 (x, y, width, height) 物理坐标。
pub fn work_area(window: &WebviewWindow) -> Option<(i32, i32, u32, u32)> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let wa = monitor.work_area();
    Some((wa.position.x, wa.position.y, wa.size.width, wa.size.height))
}

/// 某个显示器的布局（物理工作区 + 缩放因子）。
pub fn display_layout(monitor: &tauri::window::Monitor) -> DisplayLayout {
    let wa = monitor.work_area();
    DisplayLayout::new(
        (wa.position.x, wa.position.y, wa.size.width, wa.size.height),
        monitor.scale_factor(),
    )
}

/// 当前所有显示器的布局（顺序与 `available_monitors` 一致）。
pub fn display_layouts(app: &AppHandle) -> Vec<DisplayLayout> {
    app.available_monitors()
        .map(|list| list.iter().map(display_layout).collect())
        .unwrap_or_default()
}

/// 主显示器在 [`display_layouts`] 结果中的下标（找不到时回落 0）。
///
/// 用「工作区相同」来匹配：`DisplayLayout` 不持有显示器句柄，而工作区在多屏下唯一。
pub(crate) fn primary_display_index(app: &AppHandle, displays: &[DisplayLayout]) -> usize {
    let Some(primary) = app.primary_monitor().ok().flatten() else {
        return 0;
    };
    let wa = primary.work_area();
    let target = DisplayLayout::new(
        (wa.position.x, wa.position.y, wa.size.width, wa.size.height),
        1.0,
    );
    displays
        .iter()
        .position(|d| d.work_area == target.work_area)
        .unwrap_or(0)
}

/// 读取持久化落点并折算为物理像素。
///
/// 历史配置存的是「主屏逻辑坐标」（当时按主屏缩放写盘），因此 `unit` 为空时按主屏缩放
/// 折回物理，保证老用户升级后宠物停在与升级前同一位置；`unit = physical` 时原样使用。
fn saved_position_physical(
    cfg: &crate::domain::config::model::AppConfig,
    primary_sf: f64,
) -> Option<(i32, i32)> {
    let position = cfg.widget_position.as_ref()?;
    if !position.x.is_finite() || !position.y.is_finite() {
        return None;
    }
    match position.unit.as_str() {
        // 历史数据：主屏逻辑坐标，按主屏缩放折回物理。
        WidgetPosition::UNIT_LEGACY_LOGICAL => {
            let primary = DisplayLayout::new((0, 0, 0, 0), primary_sf);
            Some(primary.to_physical(position.x, position.y))
        }
        // 物理口径（规范化已把无法识别的取值也归到这里）：按字面像素使用。
        _ => Some((position.x.round() as i32, position.y.round() as i32)),
    }
}

/// 解析持久化锚点（非法值回落默认锚点）。
pub(crate) fn saved_anchors(
    cfg: &crate::domain::config::model::AppConfig,
) -> (HorizontalAnchor, VerticalAnchor) {
    match cfg.widget_position.as_ref() {
        Some(position) => (
            HorizontalAnchor::parse(&position.h).unwrap_or(HorizontalAnchor::DEFAULT),
            VerticalAnchor::parse(&position.v).unwrap_or(VerticalAnchor::DEFAULT),
        ),
        None => (HorizontalAnchor::DEFAULT, VerticalAnchor::DEFAULT),
    }
}

/// 目标显示器的物理窗口边长（625 逻辑 × 该屏缩放）。
fn physical_size(display: &DisplayLayout) -> (i32, i32) {
    let side = (widget_size(WIDGET_CREATE_SCALE) * display.scale_factor).round() as i32;
    (side, side)
}

/// 内容块（宠物本体 + 气泡）的物理边长：250 逻辑 × 显示倍率 × 该屏缩放。
///
/// 窗口比内容块大得多，多出的透明留白是贴边吸附的行程，因此位置约束只认内容块。
fn content_size(display: &DisplayLayout, widget_scale: f64) -> (i32, i32) {
    let side = (widget_size(widget_scale) * display.scale_factor).round() as i32;
    (side, side)
}

/// 按物理坐标落位，并做一次**闭环复核**：读回真实窗口几何与所在显示器，若内容块仍越出
/// 该屏工作区（Windows 可能对越界坐标做自己的修正）则再夹一次。
///
/// 返回最终生效的物理位置。全程输出 DPI 坐标日志，便于现场排查混合 DPI 问题。
fn apply_physical_position(
    window: &WebviewWindow,
    desired: (i32, i32),
    anchors: (HorizontalAnchor, VerticalAnchor),
    content_px: (i32, i32),
) -> (i32, i32) {
    let _ = window.set_position(Position::Physical(PhysicalPosition::new(
        desired.0, desired.1,
    )));

    let Some(monitor) = window.current_monitor().ok().flatten() else {
        log::warn!(
            "窗口落位：无法读取所在显示器，按请求值 ({} , {}) 使用",
            desired.0,
            desired.1
        );
        return desired;
    };
    let display = display_layout(&monitor);
    let geometry = current_geometry(window);
    let size = (geometry.width as i32, geometry.height as i32);
    let actual = (geometry.x, geometry.y);

    let clamped = clamp_window_keeping_content_visible(&display, size, content_px, actual, anchors);
    let applied = if clamped != actual {
        log::info!(
            "窗口落位复核：实际位置 {:?} 让内容块越出工作区 {:?}（scale {} / dpi {}），已夹回 {:?}",
            actual,
            display.work_area,
            display.scale_factor,
            display.dpi(),
            clamped
        );
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(
            clamped.0, clamped.1,
        )));
        clamped
    } else {
        actual
    };

    log::info!(
        "窗口落位：请求 {:?} → 实际 {:?}，窗口 {:?}，显示器工作区 {:?}（scale {} / dpi {}）",
        desired,
        applied,
        size,
        display.work_area,
        display.scale_factor,
        display.dpi()
    );
    applied
}

/// 创建或显示配置窗口。
///
/// 打开配置界面即视为「用户需要看到桌宠」：先强制显示桌宠并写回配置，
/// 这样无论从桌面快捷方式还是托盘进入，都不会出现「找不到桌宠」的死角。
pub fn ensure_config_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let _ = set_widget_visible(app, true);

    if let Some(window) = app.get_webview_window(CONFIG_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(
        app,
        CONFIG_WINDOW_LABEL,
        WebviewUrl::App("html/config.html".into()),
    )
    .title("小鲸鱼设置")
    .transparent(true)
    .inner_size(600.0, 720.0)
    .min_inner_size(520.0, 600.0)
    .resizable(true)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    let _ = window.show();
    let _ = window.set_focus();
    Ok(window)
}

/// 创建挂件窗口：无边框、透明、置顶、不占任务栏，初始停靠某一块显示器的工作区右下角。
///
/// 放置规则（全部物理像素，见本模块头部说明）：
/// 1. 有持久化落点 → 以落点所在显示器为目标；否则以主显示器为目标；
/// 2. 按**目标显示器**的缩放换算窗口物理尺寸，并把落点夹进它的工作区；
/// 3. 建窗后立刻按物理坐标落位，再读回真实几何做闭环复核。
///
/// `visible` 来自持久化的隐藏状态：隐藏时窗口创建即不可见，避免启动瞬间闪现。
pub fn create_widget_window(app: &AppHandle, visible: bool) -> Result<WebviewWindow, String> {
    let cfg = registry::config().get();
    // 固定为最大尺寸，缩放由前端 CSS 处理（避免调整透明窗口导致闪屏）。
    let size = widget_size(WIDGET_CREATE_SCALE);

    let displays = display_layouts(app);
    let primary_sf = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let primary_index = primary_display_index(app, &displays);
    let anchors = saved_anchors(&cfg);
    let saved = saved_position_physical(&cfg, primary_sf);

    let target_index = saved
        .and_then(|point| pick_display(point, &displays))
        .unwrap_or(primary_index);
    let target = displays.get(target_index).copied().unwrap_or_else(|| {
        // 读不到任何显示器（极早期或远程会话）：退回主屏缩放下的一个安全值，
        // 后续的闭环复核会按真实工作区再夹一次。
        DisplayLayout::new((0, 0, 1920, 1080), primary_sf)
    });
    let size_px = physical_size(&target);
    let content_px = content_size(&target, cfg.widget.scale);
    let desired = match saved {
        // 有持久化落点：只要求内容块可见，允许窗口留白越界（顶部吸附的正常形态）。
        Some(point) => {
            clamp_window_keeping_content_visible(&target, size_px, content_px, point, anchors)
        }
        None => default_position(&target, size_px, anchors),
    };

    log::info!(
        "挂件放置：显示器 {} 块（主屏下标 {}），目标下标 {}，工作区 {:?}（scale {} / dpi {}），\
         窗口物理尺寸 {:?}，内容块 {:?}，持久化落点 {:?} → 期望 {:?}",
        displays.len(),
        primary_index,
        target_index,
        target.work_area,
        target.scale_factor,
        target.dpi(),
        size_px,
        content_px,
        saved,
        desired
    );

    let mut builder = WebviewWindowBuilder::new(
        app,
        WIDGET_WINDOW_LABEL,
        WebviewUrl::App("html/widget.html".into()),
    )
    .title("小鲸鱼")
    .transparent(true)
    .shadow(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(visible)
    .inner_size(size, size);

    // 给构建器一个「目标屏逻辑坐标」的初值，避免首帧出现在别处；
    // 权威落位在 build 之后用物理坐标完成（逻辑坐标只对目标屏成立，不能跨屏复用）。
    let hint = target.to_logical(desired);
    builder = builder.position(hint.0, hint.1);

    let window = builder.build().map_err(|e| e.to_string())?;
    apply_physical_position(&window, desired, anchors, content_px);
    Ok(window)
}

/// 显示 / 隐藏桌宠：写入配置 + 切换窗口可见性 + 同步托盘勾选，三处一次完成。
///
/// 只改变可视化组件，后台服务（余额查询、记账、托盘）始终运行。
/// 所有入口（右键菜单「隐藏桌宠」/ 托盘「显示桌宠」/ 打开配置强制显示）都走这里，
/// 保证界面状态、磁盘配置与托盘勾选永不漂移。
pub fn set_widget_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    config::service::set_widget_hidden(!visible).map_err(|e| e.message().to_string())?;
    apply_widget_visibility(app, visible);
    let _ = tray::sync_show_widget_item(app, visible);
    Ok(())
}

/// 仅切换窗口可见性（不写配置）。
///
/// 隐藏 / 显示都要求「直接消失、直接显示」：先通知前端清空（或恢复）渲染内容，
/// 留出一帧的时间让它画完，再切换窗口可见性；否则透明 WebView2 窗口在隐藏瞬间
/// 仍会显示上一帧，观感上像渐隐动画。
///
/// 启动时的初始可见性不走这里（由窗口构建参数与 `set_widget_visible` 的持久化状态决定）。
pub fn apply_widget_visibility(app: &AppHandle, visible: bool) {
    let _ = app.emit(EVENT_WIDGET_VISIBILITY, visible);
    let handle = app.clone();
    // 在独立线程等待一帧，避免阻塞主线程的消息循环。
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(VISIBILITY_PAINT_GRACE_MS));
        if let Some(window) = handle.get_webview_window(WIDGET_WINDOW_LABEL) {
            if visible {
                let _ = window.show();
            } else {
                let _ = window.hide();
            }
        }
    });
}

/// 退出程序：先清空画面并释放渲染资源，再终止全部进程。
///
/// 1) 先通知前端清空桌宠内容，让它「直接消失」（否则销毁瞬间仍会残留上一帧，看着像渐隐）；
/// 2) 等这一帧画完，再广播退出事件，让前端停掉音效、关闭音频上下文、清理定时器；
/// 3) 留出一段极短的宽限期，等渲染进程执行完释放动作（不影响用户体感）；
/// 4) 销毁窗口释放 WebView / GPU 资源（前端 `beforeunload` 兜底再清一次）；
/// 5) 退出事件循环，主进程与 WebView2 子进程随之结束，不留后台残留。
pub fn quit_app(app: &AppHandle) {
    let _ = app.emit(EVENT_WIDGET_VISIBILITY, false);
    let handle = app.clone();
    // 在独立线程等待宽限期，避免阻塞主线程的消息循环（否则前端收不到退出事件）。
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(VISIBILITY_PAINT_GRACE_MS));
        let _ = handle.emit(EVENT_APP_QUIT, ());
        std::thread::sleep(std::time::Duration::from_millis(QUIT_CLEANUP_GRACE_MS));
        for label in [WIDGET_WINDOW_LABEL, CONFIG_WINDOW_LABEL] {
            if let Some(window) = handle.get_webview_window(label) {
                let _ = window.destroy();
            }
        }
        handle.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::config::model::AppConfig;

    fn with_position(x: f64, y: f64, unit: &str) -> AppConfig {
        let mut cfg = AppConfig::default();
        cfg.widget_position = Some(WidgetPosition {
            x,
            y,
            h: "right".to_string(),
            v: "none".to_string(),
            unit: unit.to_string(),
            facing: crate::types::enums::Facing::DEFAULT.as_str().to_string(),
        });
        cfg
    }

    /// 历史配置（`unit` 为空）= 主屏逻辑坐标：必须按**主屏缩放**折回物理，
    /// 这样老用户升级后宠物停在升级前同一位置，不会因为口径变化跳位。
    #[test]
    fn legacy_logical_position_migrates_with_primary_scale() {
        // 主屏 100%：逻辑坐标就是物理坐标。
        let cfg = with_position(1295.0, 407.0, WidgetPosition::UNIT_LEGACY_LOGICAL);
        assert_eq!(saved_position_physical(&cfg, 1.0), Some((1295, 407)));

        // 主屏 150%：旧实现写盘的是逻辑坐标 1295/407，物理落点是 1943/611。
        assert_eq!(
            saved_position_physical(&cfg, 1.5),
            Some((1943, 611)),
            "按主屏缩放折算回物理，与升级前实际落点一致"
        );
    }

    /// 物理口径与未知口径都按字面像素使用（规范化已把未知值归入物理口径）。
    #[test]
    fn physical_and_unknown_units_are_used_literally() {
        for unit in [WidgetPosition::UNIT_PHYSICAL, "some-future-space"] {
            let cfg = with_position(1943.0, 611.0, unit);
            assert_eq!(
                saved_position_physical(&cfg, 1.5),
                Some((1943, 611)),
                "unit = {unit} 时不应再乘任何缩放因子"
            );
        }
    }

    /// 无持久化落点 / 非法坐标 → 交由默认放置逻辑处理。
    #[test]
    fn missing_or_invalid_position_falls_back_to_default() {
        assert_eq!(saved_position_physical(&AppConfig::default(), 1.5), None);
        let cfg = with_position(f64::NAN, 0.0, WidgetPosition::UNIT_PHYSICAL);
        assert_eq!(saved_position_physical(&cfg, 1.5), None);
    }

    /// 锚点解析：非法值回落默认锚点，合法值原样保留（决定装不下时保住哪条边）。
    #[test]
    fn anchors_fall_back_to_defaults() {
        let cfg = with_position(0.0, 0.0, WidgetPosition::UNIT_PHYSICAL);
        assert_eq!(
            saved_anchors(&cfg),
            (HorizontalAnchor::Right, VerticalAnchor::None)
        );

        let mut cfg = with_position(0.0, 0.0, WidgetPosition::UNIT_PHYSICAL);
        if let Some(position) = cfg.widget_position.as_mut() {
            position.h = "left".to_string();
            position.v = "top".to_string();
        }
        assert_eq!(
            saved_anchors(&cfg),
            (HorizontalAnchor::Left, VerticalAnchor::Top)
        );

        let mut cfg = with_position(0.0, 0.0, WidgetPosition::UNIT_PHYSICAL);
        if let Some(position) = cfg.widget_position.as_mut() {
            position.h = "middle".to_string();
            position.v = "middle".to_string();
        }
        assert_eq!(
            saved_anchors(&cfg),
            (HorizontalAnchor::DEFAULT, VerticalAnchor::DEFAULT)
        );
    }

    /// 物理窗口边长按目标屏缩放换算（625 逻辑）。
    #[test]
    fn physical_window_size_follows_target_scale() {
        for (sf, expected) in [(1.0, 625), (1.25, 781), (1.5, 938), (2.0, 1250)] {
            let display = DisplayLayout::new((0, 0, 1920, 1080), sf);
            assert_eq!(physical_size(&display), (expected, expected), "@{sf}x");
        }
    }
}
