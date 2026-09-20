//! 原生窗口宿主
//!
//! 挂件窗口与配置窗口的创建、复用，以及窗口几何 / 工作区相关的读取。

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::application::config;
use crate::domain::window::model::WidgetGeometry;
use crate::domain::window::service::window_service::{widget_size, WIDGET_CREATE_SCALE};
use crate::shell::tray;
use crate::application::registry;
use crate::types::common::constants::{
    CONFIG_WINDOW_LABEL, EVENT_APP_QUIT, EVENT_WIDGET_VISIBILITY, QUIT_CLEANUP_GRACE_MS,
    VISIBILITY_PAINT_GRACE_MS, WIDGET_WINDOW_LABEL,
};

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

/// 创建挂件窗口：无边框、透明、置顶、不占任务栏，初始停靠屏幕右下角。
///
/// `visible` 来自持久化的隐藏状态：隐藏时窗口创建即不可见，避免启动瞬间闪现。
pub fn create_widget_window(app: &AppHandle, visible: bool) -> Result<WebviewWindow, String> {
    let cfg = registry::config().get();
    // 固定为最大尺寸，缩放由前端 CSS 处理（避免调整透明窗口导致闪屏）。
    let size = widget_size(WIDGET_CREATE_SCALE);

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

    // 优先恢复已保存逻辑坐标，并钳制到工作区；无保存位置时回退右下角。
    if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let wa = monitor.work_area();
        let sf = monitor.scale_factor();
        let wa_x = wa.position.x as f64 / sf;
        let wa_y = wa.position.y as f64 / sf;
        let wa_w = wa.size.width as f64 / sf;
        let wa_h = wa.size.height as f64 / sf;
        let max_x = (wa_x + wa_w - size).max(wa_x);
        let max_y = (wa_y + wa_h - size).max(wa_y);

        let (x, y) = match cfg.widget_position.as_ref() {
            Some(position) => (position.x.clamp(wa_x, max_x), position.y.clamp(wa_y, max_y)),
            None => (max_x, max_y),
        };
        builder = builder.position(x, y);
    } else if let Some(position) = cfg.widget_position.as_ref() {
        builder = builder.position(position.x, position.y);
    }

    builder.build().map_err(|e| e.to_string())
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
