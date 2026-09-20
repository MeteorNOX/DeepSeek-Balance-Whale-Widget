//! 系统托盘
//!
//! 构建系统托盘菜单：显示桌宠（勾选项）/ 打开配置 / 退出。
//!
//! 「显示桌宠」是桌宠被隐藏后唯一的找回入口，因此勾选状态必须与真实可见性
//! 严格一致：任何可见性变化都通过 `window::set_widget_visible` 回写配置，
//! 再由本模块重建菜单同步勾选。

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Wry,
};

use super::window;
use crate::types::common::constants::{MENU_OPEN_CONFIG, MENU_QUIT, MENU_SHOW_WIDGET, TRAY_ID};
use crate::application::registry;

/// 构建托盘菜单；`widget_visible` 决定「显示桌宠」是否打勾。
fn build_menu(app: &AppHandle, widget_visible: bool) -> tauri::Result<Menu<Wry>> {
    let show = CheckMenuItem::with_id(
        app,
        MENU_SHOW_WIDGET,
        "显示桌宠",
        true,
        widget_visible,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, MENU_OPEN_CONFIG, "打开配置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &open, &quit])
}

/// 构建系统托盘：显示桌宠 / 打开配置 / 退出。
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let visible = !registry::config().get().widget.hidden;
    let menu = build_menu(app, visible)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SHOW_WIDGET => {
                // 勾选项语义是「显示桌宠」：当前隐藏则本次点击为显示，反之隐藏。
                let show = registry::config().get().widget.hidden;
                let _ = window::set_widget_visible(app, show);
            }
            MENU_OPEN_CONFIG => {
                let _ = window::ensure_config_window(app);
            }
            // 退出：直接释放资源并退出（不做二次确认）。
            MENU_QUIT => window::quit_app(app),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// 同步托盘「显示桌宠」勾选状态。
///
/// 通过重建菜单实现，避免长期持有菜单项句柄（勾选语义与配置是一一对应的）。
pub fn sync_show_widget_item(app: &AppHandle, widget_visible: bool) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let menu = build_menu(app, widget_visible)?;
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}
