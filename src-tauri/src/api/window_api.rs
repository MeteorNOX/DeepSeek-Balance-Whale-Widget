//! 窗口相关命令
//!
//! 挂件窗口的移动、吸附与鼠标穿透控制，以及光标位置读取。
//! 吸附算法本身位于 `domain::window`，编排位于 `application::window::service`。

use tauri::{PhysicalPosition, Position, WebviewWindow};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

use crate::application::config;
use crate::application::window;
use crate::domain::config::model::WidgetPosition;
use crate::domain::window::model::SnapResult;
use crate::domain::window::service::window_service::no_snap;
use crate::shell::window::{current_geometry, work_area};
use crate::types::common::constants::{MENU_CONFIG, MENU_FEED, MENU_HIDE_WIDGET, MENU_QUIT_APP};
use crate::types::exception::{guard, AppError, AppResult, IntoWire};
use crate::types::utils::num::round2;

/// 拖拽过程中把挂件窗口移动到指定的「逻辑屏幕坐标」。
#[tauri::command]
pub fn set_window_position(window: WebviewWindow, x: f64, y: f64) {
    let sf = window.scale_factor().unwrap_or(1.0);
    let px = (x * sf).round() as i32;
    let py = (y * sf).round() as i32;
    let _ = window.set_position(Position::Physical(PhysicalPosition::new(px, py)));
}

/// 开关挂件窗口的整窗鼠标穿透。
#[tauri::command]
pub fn set_ignore_cursor_events(window: WebviewWindow, ignore: bool) {
    let _ = window.set_ignore_cursor_events(ignore);
}

/// 读取全局光标位置，按窗口缩放因子换算为逻辑屏幕坐标返回。
#[tauri::command]
pub fn get_cursor_position(window: WebviewWindow) -> (f64, f64) {
    let mut point = POINT { x: 0, y: 0 };
    unsafe {
        let _ = GetCursorPos(&mut point);
    }
    let sf = window.scale_factor().unwrap_or(1.0);
    (point.x as f64 / sf, point.y as f64 / sf)
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
    let to_screen = |rect: (f64, f64, f64, f64)| {
        (rect.0 + origin_x, rect.1 + origin_y, rect.2, rect.3)
    };

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

    let _ = window.set_position(Position::Physical(PhysicalPosition::new(
        outcome.x, outcome.y,
    )));

    // 位置落库失败不影响本次吸附结果。
    let anchors = (outcome.result.h.clone(), outcome.result.v.clone());
    if let Err(err) = save_current_widget_position(window, anchors) {
        log::warn!("保存挂件吸附位置失败: {}", err);
    }

    Ok(outcome.result)
}

/// 读取当前窗口几何并按逻辑坐标写入配置（含水平/垂直锚点）。
fn save_current_widget_position(window: &WebviewWindow, anchors: (String, String)) -> AppResult<()> {
    let geometry = current_geometry(window);
    let sf = window.scale_factor().unwrap_or(1.0);
    config::service::save_widget_position(WidgetPosition {
        x: round2(geometry.x as f64 / sf),
        y: round2(geometry.y as f64 / sf),
        h: anchors.0,
        v: anchors.1,
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
