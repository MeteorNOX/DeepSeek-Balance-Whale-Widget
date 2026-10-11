//! 原生窗口宿主
//!
//! 挂件窗口与配置窗口的创建、复用，以及窗口几何 / 工作区相关的读取。

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::application::config;
use crate::domain::config::model::WidgetPosition;
use crate::domain::window::model::WidgetGeometry;
use crate::domain::window::service::window_service::{
    initial_widget_position, widget_content_keep, widget_size, MonitorArea, WIDGET_CREATE_SCALE,
};
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

/// 获取**全部**显示器的工作区（排除任务栏），返回物理坐标列表。
///
/// 与只认当前显示器的 `work_area` 区分开：钳制挂件位置时必须以「所有」工作区为候选，
/// 否则跨屏拖动会被强行拉回当前屏。单显示器时列表只有一个元素，行为与 `work_area` 一致。
pub fn work_areas(window: &WebviewWindow) -> Vec<(i32, i32, u32, u32)> {
    let areas: Vec<(i32, i32, u32, u32)> = window
        .available_monitors()
        .map(|monitors| {
            monitors
                .iter()
                .map(|monitor| {
                    let wa = monitor.work_area();
                    (wa.position.x, wa.position.y, wa.size.width, wa.size.height)
                })
                .collect()
        })
        .unwrap_or_default();

    // 枚举失败时退回当前显示器，保证钳制仍有依据（也顺带覆盖了单屏场景）。
    if areas.is_empty() {
        return work_area(window).into_iter().collect();
    }
    areas
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

/// 创建挂件窗口：无边框、透明、置顶、不占任务栏，初始停靠屏幕右下角（或恢复上次位置）。
///
/// 窗口**先隐藏创建、定位完成后再显示**：位置要等窗口对象存在、能枚举显示器之后才算得出来
/// （见 [`place_widget_window`]），而窗口一旦显示就会停在系统给的默认位置上，让用户看到一次
/// 跳变。调用方在拿到返回值后还会再 `show()` 一次（幂等），这里按 `visible` 先显示即可。
///
/// `visible` 来自持久化的隐藏状态：隐藏时窗口创建即不可见，避免启动瞬间闪现。
pub fn create_widget_window(app: &AppHandle, visible: bool) -> Result<WebviewWindow, String> {
    let cfg = registry::config().get();
    // 固定为最大尺寸，缩放由前端 CSS 处理（避免调整透明窗口导致闪屏）。
    let size = widget_size(WIDGET_CREATE_SCALE);

    let window = WebviewWindowBuilder::new(
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
    .visible(false)
    .inner_size(size, size)
    .build()
    .map_err(|e| e.to_string())?;

    place_widget_window(&window, cfg.widget_position.as_ref(), cfg.widget.scale);

    if visible {
        let _ = window.show();
    }
    Ok(window)
}

/// 计算挂件窗口的初始位置并落地（物理像素）。
///
/// 这里必须用 `set_position(Physical)`，不能用构造器上的 `position()`：后者收的是**逻辑**
/// 坐标，再由窗口自己乘一个缩放因子换算成物理坐标，而乘的是哪块屏的因子取决于窗口创建 / 落到
/// 哪块屏，未必等于我们算坐标时假定的那块。混合 DPI 下会整体放大——1920 宽主屏（1.0×）算出的
/// 右下角 x=1295 落到 1.5× 副屏上渲染成物理 1943，窗口整个被推出屏外，鲸鱼只剩二十几个像素
/// 可见，而整窗鼠标穿透让用户没有任何入口能把它救回来（首次运行 / 无存档时踩到的就是这个坑）。
///
/// 「放哪儿」的决策全在 `domain::window` 里（可脱机测试），这里只负责把显示器信息喂进去。
fn place_widget_window(window: &WebviewWindow, saved: Option<&WidgetPosition>, scale: f64) {
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let areas: Vec<MonitorArea> = monitors
        .iter()
        .map(|monitor| {
            let wa = monitor.work_area();
            MonitorArea {
                x: wa.position.x,
                y: wa.position.y,
                width: wa.size.width,
                height: wa.size.height,
                scale_factor: monitor.scale_factor(),
            }
        })
        .collect();
    let primary = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| {
            let wa = monitor.work_area();
            MonitorArea {
                x: wa.position.x,
                y: wa.position.y,
                width: wa.size.width,
                height: wa.size.height,
                scale_factor: monitor.scale_factor(),
            }
        });

    let Some((x, y)) = initial_widget_position(
        saved.map(|position| (position.x, position.y)),
        widget_size(WIDGET_CREATE_SCALE),
        widget_content_keep(scale),
        &areas,
        primary,
    ) else {
        return;
    };

    let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
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
