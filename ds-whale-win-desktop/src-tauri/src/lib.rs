//! 应用入口：注册命令、创建窗口（挂件窗口 + 配置窗口）与系统托盘。
//!
//! 模块划分：
//! - `config`  配置持久化
//! - `balance` API 请求（余额/用量）
//! - `ledger`  记账数据存储
//! - `autostart` 系统服务（开机自启）

mod autostart;
mod balance;
mod claude_config;
mod codex_config;
mod config;
mod ledger;
mod update;

use config::{AppConfig, DialogueConfig, WidgetConfig};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, Position,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};

/// 挂件窗口 label。
const WIDGET_LABEL: &str = "widget";
/// 配置窗口 label。
const CONFIG_LABEL: &str = "config";

/// 挂件基准尺寸（scale 倍率作用于其上，最终钳制在 122–625 逻辑像素内）。
const WIDGET_BASE: f64 = 250.0;

/// 根据倍率计算挂件窗口的逻辑边长（正方形）。
fn widget_size(scale: f64) -> f64 {
    (WIDGET_BASE * scale).clamp(122.0, 625.0)
}

/// 挂件窗口当前的物理几何信息（返回给前端用于状态同步）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WidgetGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// 吸附结果：水平/垂直锚点（供前端决定是否镜像翻转）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapResult {
    h: String,
    v: String,
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 读取完整应用配置。
#[tauri::command]
fn get_config() -> AppConfig {
    config::get_config()
}

/// 保存完整应用配置（写盘 + 刷新缓存）。
#[tauri::command]
fn save_config(cfg: AppConfig) -> Result<AppConfig, String> {
    let saved = config::update_config(cfg)?;
    if let Err(e) = claude_config::write_claude_settings(&saved) {
        log::error!("写入 Claude 配置失败: {}", e);
    }
    if let Err(e) = codex_config::write_codex_settings(&saved) {
        log::error!("写入 Codex 配置失败: {}", e);
    }
    Ok(saved)
}

/// 快速保存挂件显示配置（汉堡菜单实时调整时使用）。
#[tauri::command]
fn save_widget_config(app: AppHandle, widget: WidgetConfig) -> Result<WidgetConfig, String> {
    let cfg = config::mutate_config(|c| c.widget = widget)?;
    // 广播给挂件窗口，使其实时应用来自配置窗口的显示设置。
    let _ = app.emit("widget-config-changed", &cfg.widget);
    Ok(cfg.widget)
}

/// 保存台词管理配置（写盘 + 广播给挂件窗口）。
#[tauri::command]
fn save_dialogue(app: AppHandle, dialogue: DialogueConfig) -> Result<DialogueConfig, String> {
    let cfg = config::mutate_config(|c| c.dialogue = dialogue)?;
    let _ = app.emit("dialogue-changed", &cfg.dialogue);
    Ok(cfg.dialogue)
}

/// 查询余额 + 今日已用（异步，内部完成小鲸鱼记账）。
#[tauri::command]
async fn get_balance() -> balance::BalancePayload {
    balance::get_balance_payload().await
}

/// 设置开机自启，并把结果同步回配置。
#[tauri::command]
fn set_autostart(enabled: bool) -> Result<bool, String> {
    let result = autostart::set_autostart(enabled)?;
    let _ = config::mutate_config(|c| c.autostart = result);
    Ok(result)
}

/// 查询当前开机自启状态（读配置缓存）。
#[tauri::command]
fn get_autostart() -> bool {
    config::get_config().autostart
}

/// 打开（或创建）配置窗口。
#[tauri::command]
fn open_config(app: AppHandle) -> Result<(), String> {
    ensure_config_window(&app)?;
    Ok(())
}

/// 打开系统文件对话框选择自定义音效，返回所选文件路径（未选择返回 None）。
#[tauri::command]
fn pick_audio_file() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("选择自定义音效")
        .add_filter(
            "音频文件",
            &["wav", "flac", "alac", "ape", "mp3", "aac", "wma", "ogg", "m4a", "opus", "caf"],
        )
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// 读取本地音频文件并返回 base64 Data URL，供前端直接播放（绕开资产协议作用域限制）。
#[tauri::command]
fn read_audio_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" | "alac" => "audio/mp4",
        "aac" => "audio/aac",
        "wma" => "audio/x-ms-wma",
        "ape" => "audio/ape",
        "caf" => "audio/x-caf",
        _ => "application/octet-stream",
    };
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// 一键重启程序：使用 Tauri 内置的重启能力（spawn 新实例后退出当前实例，
/// 已正确处理 single-instance 竞态）。
#[tauri::command]
fn restart_app(app: AppHandle) {
    tauri::process::restart(&app.env());
}

/// 退出程序。
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// 拖拽过程中把挂件窗口移动到指定的「逻辑屏幕坐标」。
///
/// 前端传入的是 `PointerEvent.screenX/Y`（CSS 逻辑像素），此处乘以缩放因子
/// 转成物理像素后再设置窗口位置，避免高分屏下拖拽跟手漂移。
#[tauri::command]
fn set_window_position(window: WebviewWindow, x: f64, y: f64) {
    let sf = window.scale_factor().unwrap_or(1.0);
    let px = (x * sf).round() as i32;
    let py = (y * sf).round() as i32;
    let _ = window.set_position(Position::Physical(PhysicalPosition::new(px, py)));
}

/// 拖拽释放后按「四分之一区域」吸附到屏幕边缘。
#[tauri::command]
fn snap_window(window: WebviewWindow) -> SnapResult {
    let mut result = SnapResult {
        h: "none".to_string(),
        v: "none".to_string(),
    };

    let (pos, size) = match (window.outer_position(), window.outer_size()) {
        (Ok(p), Ok(s)) => (p, s),
        _ => return result,
    };

    let Some((wa_x, wa_y, wa_w, wa_h)) = work_area(&window) else {
        return result;
    };

    let w = size.width as i32;
    let h = size.height as i32;
    let center_x = pos.x + w / 2;
    let center_y = pos.y + h / 2;

    let mut x = pos.x;
    let mut y = pos.y;

    // 水平四分之一吸附：中心点位于左 1/4 → 贴左；右 1/4 → 贴右。
    if center_x < wa_x + wa_w as i32 / 4 {
        result.h = "left".to_string();
        x = wa_x;
    } else if center_x > wa_x + (wa_w as i32 * 3) / 4 {
        result.h = "right".to_string();
        x = wa_x + wa_w as i32 - w;
    }

    // 垂直四分之一吸附：上 1/4 → 贴顶；下 3/4 → 贴底。
    if center_y < wa_y + wa_h as i32 / 4 {
        result.v = "top".to_string();
        y = wa_y;
    } else if center_y > wa_y + (wa_h as i32 * 3) / 4 {
        result.v = "bottom".to_string();
        y = wa_y + wa_h as i32 - h;
    }

    let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    result
}

/// 按倍率缩放挂件窗口：以右下角为唯一锚点，通过单次 SetWindowPos 原子调整位置与尺寸，避免闪屏抖动。
#[tauri::command]
fn resize_widget(window: WebviewWindow, scale: f64) -> WidgetGeometry {
    let new_logical = widget_size(scale);
    let sf = window.scale_factor().unwrap_or(1.0);
    let new_physical = (new_logical * sf).round() as i32;

    // 先读取缩放前的原始位置与尺寸，右下角固定点基于旧尺寸计算。
    if let (Ok(old_pos), Ok(old_size)) = (window.outer_position(), window.outer_size()) {
        let fixed_x = old_pos.x + old_size.width as i32;
        let fixed_y = old_pos.y + old_size.height as i32;
        let mut new_x = fixed_x - new_physical;
        let mut new_y = fixed_y - new_physical;

        // 钳制到工作区，防止缩放后溢出屏幕。
        if let Some((wa_x, wa_y, wa_w, wa_h)) = work_area(&window) {
            let max_x = (wa_x + wa_w as i32 - new_physical).max(wa_x);
            let max_y = (wa_y + wa_h as i32 - new_physical).max(wa_y);
            new_x = new_x.clamp(wa_x, max_x);
            new_y = new_y.clamp(wa_y, max_y);
        }

        // 获取原生 HWND 并单次原子设置位置 + 尺寸。
        if let Ok(handle) = window.window_handle() {
            if let RawWindowHandle::Win32(h) = handle.as_raw() {
                let hwnd = HWND(h.hwnd.get() as *mut _);
                unsafe {
                    let _ = SetWindowPos(
                        hwnd,
                        None,
                        new_x,
                        new_y,
                        new_physical,
                        new_physical,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                }
            }
        }
    }

    current_geometry(&window)
}

/// 获取挂件窗口当前物理几何信息。
#[tauri::command]
fn get_widget_geometry(window: WebviewWindow) -> WidgetGeometry {
    current_geometry(&window)
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

/// 读取挂件窗口当前物理几何信息。
fn current_geometry(window: &WebviewWindow) -> WidgetGeometry {
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

/// 获取主显示器工作区（排除任务栏），返回 (x, y, width, height) 物理坐标。
fn work_area(window: &WebviewWindow) -> Option<(i32, i32, u32, u32)> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let wa = monitor.work_area();
    let pos = wa.position;
    let size = wa.size;
    Some((pos.x, pos.y, size.width, size.height))
}

/// 创建或显示配置窗口。
fn ensure_config_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(CONFIG_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(
        app,
        CONFIG_LABEL,
        WebviewUrl::App("config.html".into()),
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
fn create_widget_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let scale = config::get_config().widget.scale;
    let size = widget_size(scale);

    let mut builder = WebviewWindowBuilder::new(app, WIDGET_LABEL, WebviewUrl::App("widget.html".into()))
        .title("小鲸鱼")
        .transparent(true)
        .shadow(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(size, size);

    // 初始定位：屏幕右下角。`WebviewWindowBuilder::position` 使用逻辑像素，
    // 而工作区坐标为物理像素，需除以缩放因子换算回逻辑坐标。
    if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let wa = monitor.work_area();
        let sf = monitor.scale_factor();
        let wa_x = wa.position.x as f64 / sf;
        let wa_y = wa.position.y as f64 / sf;
        let wa_w = wa.size.width as f64 / sf;
        let wa_h = wa.size.height as f64 / sf;
        builder = builder.position(wa_x + wa_w - size, wa_y + wa_h - size);
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    Ok(window)
}

/// 构建系统托盘：打开配置 / 退出。
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open_config", "打开配置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open_config" => { let _ = ensure_config_window(app); }
            "quit" => { app.exit(0); }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    let is_autostart = std::env::args().any(|a| a == "--autostart");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已存在实例：唤醒挂件窗口即可（单实例守护）。
            if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
                let _ = window.show();
            }
            if let Some(window) = app.get_webview_window(CONFIG_LABEL) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == CONFIG_LABEL {
                    // 配置窗口关闭即隐藏复用，避免反复创建 WebView2 导致白屏/内存泄漏。
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // 创建挂件窗口（默认显示在右下角）。
            let widget = create_widget_window(app.handle())?;
            let _ = widget.show();

            // 系统托盘。
            setup_tray(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            save_widget_config,
            save_dialogue,
            get_balance,
            set_autostart,
            get_autostart,
            open_config,
            pick_audio_file,
            read_audio_file,
            restart_app,
            quit_app,
            set_window_position,
            snap_window,
            resize_widget,
            get_widget_geometry,
            update::check_update,
            update::open_external,
        ])
        .build(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");

    app.run(move |app, event| {
        // 事件循环就绪后再创建配置窗口，避免在 setup 阶段与透明挂件窗口并发初始化导致白屏。
        if let tauri::RunEvent::Ready = event {
            if config::get_config().api_key.is_empty() || !is_autostart {
                let _ = ensure_config_window(app);
            }
        }
    });
}
