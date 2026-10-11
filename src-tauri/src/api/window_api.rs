//! 窗口相关命令
//!
//! 挂件窗口的移动、吸附与鼠标穿透控制，以及光标位置读取。
//! 吸附算法本身位于 `domain::window`，编排位于 `application::window::service`。
//!
//! 所有位置在进出本模块时都折算成**物理像素**：逻辑坐标只对某一块显示器成立，
//! 跨屏复用会错位（混合 DPI 下宠物落到屏外的根因，见 `issue.md`）。

use tauri::{AppHandle, PhysicalPosition, Position, WebviewWindow};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

use crate::api::dto::monitor::{
    MonitorDto, MonitorReportDto, PersistedPositionDto, WidgetGeometryDto,
};
use crate::application::config;
use crate::application::window;
use crate::domain::config::model::WidgetPosition;
use crate::domain::window::model::{DisplayLayout, SnapResult};
use crate::domain::window::service::window_service::{
    clamp_window_keeping_content_visible, facing_for, no_snap, pet_center_x, pick_display,
    widget_size,
};
use crate::shell::window::{
    current_geometry, display_layout, display_layouts, saved_anchors, work_area,
};
use crate::types::common::constants::{MENU_CONFIG, MENU_FEED, MENU_HIDE_WIDGET, MENU_QUIT_APP};
use crate::types::enums::{Facing, HorizontalAnchor, VerticalAnchor};
use crate::types::exception::{guard, AppError, AppResult, IntoWire};
use crate::types::utils::num::round2;

/// 拖拽过程中把挂件窗口移动到指定的「逻辑屏幕坐标」（前端指针事件坐标系），
/// 返回桌宠**朝向**（由所在显示器工作区的物理中心决定，见 [`facing_for`]）。
///
/// 逻辑坐标只对**窗口当前所在的那块显示器**成立，因此这里按窗口自身缩放换算成
/// 物理像素后再约束到「该点所在显示器」：即便在混合 DPI 的多屏之间来回拖动、
/// 或换算出现取整误差，宠物本体也不会被丢到看不见、点不到的地方。
///
/// 约束口径是**零留白**：只要求内容块（宠物本体 + 气泡）完整落在工作区内，
/// 不再额外内缩。因此——
/// - 屏幕中部：约束不会触发，落点就是指针位置，不存在任何「意外偏移」；
/// - 拖到边缘：内容块正好贴住工作区边界（底部即任务栏上沿），严丝合缝。
///
/// 也不做任何「按区域自动吸附」：吸附只发生在松手时、且只在进入配置页设定的
/// 吸附距离内（见 [`snap_window`]）。
#[tauri::command]
pub fn set_window_position(app: AppHandle, window: WebviewWindow, x: f64, y: f64) -> String {
    let sf = window.scale_factor().unwrap_or(1.0);
    let raw = DisplayLayout::new((0, 0, 0, 0), sf).to_physical(x, y);

    let displays = display_layouts(&app);
    let index = pick_display(raw, &displays).unwrap_or(0);
    let cfg = crate::application::registry::config().get();
    let anchors = saved_anchors(&cfg);
    let size = window
        .outer_size()
        .map(|s| (s.width as i32, s.height as i32))
        .unwrap_or((0, 0));
    // 内容块物理边长：250 逻辑 × 显示倍率 × 该屏缩放。
    let content = (widget_size(cfg.widget.scale) * sf).round() as i32;
    let placed = match displays.get(index) {
        Some(display) => {
            clamp_window_keeping_content_visible(display, size, (content, content), raw, anchors)
        }
        None => raw,
    };

    let _ = window.set_position(Position::Physical(PhysicalPosition::new(
        placed.0, placed.1,
    )));

    match displays.get(index) {
        Some(display) => facing_for(pet_center_x(placed.0, size.0, content, anchors.0), display)
            .as_str()
            .to_string(),
        None => Facing::DEFAULT.as_str().to_string(),
    }
}

/// 显示器 / DPI 诊断报告（只读）。
///
/// 多显示器 + 混合缩放现场排查用：返回每块显示器的物理工作区 / 缩放 / 有效 DPI，
/// 以及挂件窗口的物理几何、所在显示器与「是否完整落在工作区内」的结论。
#[tauri::command]
pub fn get_monitor_report(app: AppHandle, window: WebviewWindow) -> MonitorReportDto {
    let displays = display_layouts(&app);
    let primary_index = crate::shell::window::primary_display_index(&app, &displays);
    let geometry = current_geometry(&window);
    let display = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| display_layout(&m));

    let widget_display_index = display
        .as_ref()
        .and_then(|d| displays.iter().position(|x| x.work_area == d.work_area))
        .or_else(|| pick_display((geometry.x, geometry.y), &displays));
    let inside_work_area = match display.as_ref() {
        Some(d) => {
            geometry.x >= d.left()
                && geometry.y >= d.top()
                && geometry.x + geometry.width as i32 <= d.right()
                && geometry.y + geometry.height as i32 <= d.bottom()
        }
        None => false,
    };

    let persisted = crate::application::registry::config()
        .get()
        .widget_position
        .map(|p| PersistedPositionDto {
            x: p.x,
            y: p.y,
            unit: p.unit,
            h: p.h,
            v: p.v,
            facing: p.facing,
        });

    // 朝向以「窗口当前几何 + 所在屏幕物理中心」现算，与拖拽路径同一套算法。
    let cfg = crate::application::registry::config().get();
    let anchors = saved_anchors(&cfg);
    let sf = display.as_ref().map(|d| d.scale_factor).unwrap_or(1.0);
    let content = (widget_size(cfg.widget.scale) * sf).round() as i32;
    let facing = match display.as_ref() {
        Some(d) => facing_for(
            pet_center_x(geometry.x, geometry.width as i32, content, anchors.0),
            d,
        )
        .as_str()
        .to_string(),
        None => Facing::DEFAULT.as_str().to_string(),
    };

    MonitorReportDto {
        monitors: displays.iter().map(MonitorDto::from).collect(),
        primary_index,
        widget: WidgetGeometryDto::new(&geometry, display.as_ref()),
        widget_display_index,
        inside_work_area,
        facing,
        persisted,
    }
}

/// 开关挂件窗口的整窗鼠标穿透。
#[tauri::command]
pub fn set_ignore_cursor_events(window: WebviewWindow, ignore: bool) {
    let _ = window.set_ignore_cursor_events(ignore);
}

/// 读取全局光标位置，换算为**相对窗口客户区左上角**的物理像素偏移。
///
/// 这里刻意返回「相对窗口」而不是屏幕坐标：前端 `window.screenX/Y` 是渲染进程侧的
/// CSS 像素，在缩放倍率不为 1 的显示器上与「物理坐标 ÷ 缩放因子」并不落在同一个
/// 坐标系里，跨屏后光标→客户区的换算会整体偏移（表现为鲸鱼点不动、拖不动、副屏
/// 判定区偏移）。改成在这里做一次纯物理像素的减法，前端再除以自己的
/// `devicePixelRatio`，换算所用数据就只有一份来源（见 `issue.md`）。
#[tauri::command]
pub fn get_cursor_position(window: WebviewWindow) -> (f64, f64) {
    let mut point = POINT { x: 0, y: 0 };
    unsafe {
        let _ = GetCursorPos(&mut point);
    }
    // 无边框窗口客户区左上角即窗口左上角；inner 读不到时退化为 outer。
    let origin = window
        .inner_position()
        .or_else(|_| window.outer_position())
        .map(|p| (p.x, p.y))
        .unwrap_or((0, 0));
    ((point.x - origin.0) as f64, (point.y - origin.1) as f64)
}

/// 拖拽释放后按实际内容矩形吸附到屏幕边缘。
///
/// 前两个矩形都由前端测量后传入（**视口坐标**，逻辑像素，即 `getBoundingClientRect()`
/// 的原值）：
/// - `whale_*`：鲸鱼本体矩形，决定左右吸附；
/// - `content_*`：内容块（气泡 + 鲸鱼整体）矩形，决定上下吸附——气泡画在鲸鱼上方，
///   顶部吸附必须连气泡一起贴顶，否则气泡会被屏幕裁掉。
///
/// 视口坐标在这里才加上**后端自己读到的窗口位置**换算成屏幕坐标。前端不换算是有意为之：
/// `window.screenX/Y` 是渲染进程侧的同步值，刚发出的移动还没同步回来时仍是旧值，
/// 用它吸附会在松手瞬间吸到错误的方向（用户看到的「弹回中部」）。
///
/// 窗口几何不可读时返回 `none`，不影响前端状态机。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn snap_window(
    window: WebviewWindow,
    whale_left: f64,
    whale_top: f64,
    whale_width: f64,
    whale_height: f64,
    content_left: f64,
    content_top: f64,
    content_width: f64,
    content_height: f64,
) -> SnapResult {
    guard::catch(|| {
        snap_window_inner(
            &window,
            (whale_left, whale_top, whale_width, whale_height),
            (content_left, content_top, content_width, content_height),
        )
    })
    .unwrap_or_else(|err| {
        log::warn!("窗口吸附失败：{}", err);
        no_snap()
    })
}

/// 右键菜单：构建原生菜单并在光标处弹出（定位与边缘检测由系统处理）。
#[tauri::command]
pub fn show_context_menu(window: WebviewWindow) -> Result<(), String> {
    guard::catch(|| show_context_menu_inner(&window)).into_wire()
}

/// 吸附主体：读取窗口几何与工作区 → 计算吸附 → 应用位置 → 记录位置。
///
/// 传入的两个矩形是**视口坐标**，这里先按「窗口左上角在屏幕上的逻辑坐标」平移到
/// 屏幕坐标系，再交给领域算法。
///
/// 落点一律再夹一次到工作区：吸附本身只处理「贴边」，若窗口在混合 DPI 下被拖到
/// 工作区之外（例如跨屏拖动），这一步保证它不会停在屏外。
fn snap_window_inner(
    window: &WebviewWindow,
    whale: (f64, f64, f64, f64),
    content: (f64, f64, f64, f64),
) -> AppResult<SnapResult> {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return Ok(no_snap());
    };
    let Some(work_area) = work_area(window) else {
        return Ok(no_snap());
    };

    let sf = window.scale_factor().unwrap_or(1.0);
    // 无边框窗口：视口左上角就是窗口左上角（物理像素 → 逻辑像素）。
    let origin_x = position.x as f64 / sf;
    let origin_y = position.y as f64 / sf;
    let to_screen =
        |rect: (f64, f64, f64, f64)| (rect.0 + origin_x, rect.1 + origin_y, rect.2, rect.3);

    let outcome = window::service::resolve_snap(
        (
            position.x,
            position.y,
            size.width as i32,
            size.height as i32,
        ),
        work_area,
        to_screen(whale),
        to_screen(content),
        sf,
    );

    // 吸附后内容块的锚定方向就是结果的 h/v，夹取时按它决定「内容块贴窗口哪一边」。
    let display = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| display_layout(&m))
        .unwrap_or_else(|| {
            DisplayLayout::new((work_area.0, work_area.1, work_area.2, work_area.3), sf)
        });
    let anchors = (
        HorizontalAnchor::parse(&outcome.result.h).unwrap_or(HorizontalAnchor::None),
        VerticalAnchor::parse(&outcome.result.v).unwrap_or(VerticalAnchor::None),
    );
    // 只约束内容块（宠物本体 + 气泡）落在工作区内：窗口的透明留白越界是顶部 /
    // 左侧吸附的正常形态，整体夹取会把吸附行程吃掉。
    let content_px = (
        (content.2 * sf).round() as i32,
        (content.3 * sf).round() as i32,
    );
    let target = clamp_window_keeping_content_visible(
        &display,
        (size.width as i32, size.height as i32),
        content_px,
        (outcome.x, outcome.y),
        anchors,
    );
    if target != (outcome.x, outcome.y) {
        log::info!(
            "吸附落点越出工作区 {:?}，已夹回 {:?}（scale {} / dpi {}）",
            (outcome.x, outcome.y),
            target,
            display.scale_factor,
            display.dpi()
        );
    }

    let _ = window.set_position(Position::Physical(PhysicalPosition::new(
        target.0, target.1,
    )));

    // 朝向与吸附无关：按「最终落位 + 所在屏幕物理中心」现算，随位置一起落库，
    // 重启后宠物朝向与落点保持一致。
    let mut result = outcome.result;
    result.facing = facing_for(
        pet_center_x(target.0, size.width as i32, content_px.0, anchors.0),
        &display,
    )
    .as_str()
    .to_string();

    // 位置落库失败不影响本次吸附结果。
    let anchors = (result.h.clone(), result.v.clone());
    if let Err(err) = save_current_widget_position(window, anchors, result.facing.clone()) {
        log::warn!("保存挂件吸附位置失败: {}", err);
    }

    Ok(result)
}

/// 读取当前窗口几何并**按物理像素**写入配置（含水平/垂直锚点与朝向）。
///
/// 物理坐标全局唯一：换屏、改缩放、重启后语义都不变（逻辑坐标会随缩放漂移）。
fn save_current_widget_position(
    window: &WebviewWindow,
    anchors: (String, String),
    facing: String,
) -> AppResult<()> {
    let geometry = current_geometry(window);
    config::service::save_widget_position(WidgetPosition {
        x: round2(geometry.x as f64),
        y: round2(geometry.y as f64),
        h: anchors.0,
        v: anchors.1,
        unit: WidgetPosition::UNIT_PHYSICAL.to_string(),
        facing,
    })
}

/// 菜单构建与弹出。
fn show_context_menu_inner(window: &WebviewWindow) -> AppResult<()> {
    use tauri::menu::{Menu, MenuItem};

    let feed = MenuItem::with_id(window, MENU_FEED, "喂养", true, None::<&str>)
        .map_err(|e| AppError::external(e.to_string()))?;
    let config = MenuItem::with_id(window, MENU_CONFIG, "打开配置", true, None::<&str>)
        .map_err(|e| AppError::external(e.to_string()))?;
    let hide = MenuItem::with_id(window, MENU_HIDE_WIDGET, "隐藏桌宠", true, None::<&str>)
        .map_err(|e| AppError::external(e.to_string()))?;
    let quit = MenuItem::with_id(window, MENU_QUIT_APP, "退出程序", true, None::<&str>)
        .map_err(|e| AppError::external(e.to_string()))?;
    let menu = Menu::with_items(window, &[&feed, &config, &hide, &quit])
        .map_err(|e| AppError::external(e.to_string()))?;

    window
        .popup_menu(&menu)
        .map_err(|e| AppError::external(e.to_string()))
}
