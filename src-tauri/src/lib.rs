//! 应用入口：初始化横切能力、装配仓储、注册命令、创建窗口与系统托盘。
//!
//! # 分层结构
//!
//! ```text
//! api              接口层：Tauri 命令（参数解析 / 事件广播 / 统一返回）
//!   └── application  应用层：用例编排（只依赖 domain 的仓储 trait，不依赖 Tauri / 具体存储）
//!         ├── domain          领域层：每个限界上下文一个子目录，内含
//!         │                   model/（aggregate / entity / valobj）、service/、repository/（trait）
//!         └── infrastructure  基础设施层：实现 domain 的仓储 trait（文件 / HTTP / 注册表 / 推理）
//! types                        公共类型层：常量 / 枚举 / 统一异常 / 通用工具
//! shell                        宿主外壳层：Tauri 窗口与系统托盘（非界面渲染）
//! ```
//!
//! 依赖方向严格为 `api -> application -> domain <- infrastructure`，
//! 装配（把 `infrastructure` 的实现注入 `application::registry`）只发生在组合根 [`run`]。
//! `infrastructure` 之外没有模块直接使用 `infrastructure` 的具体类型。

mod api;
mod application;
mod domain;
mod infrastructure;
mod shell;
mod types;

use tauri::Manager;

use types::common::constants::{
    AUTOSTART_FLAG, CONFIG_WINDOW_LABEL, MENU_CONFIG, MENU_FEED, MENU_HIDE_WIDGET, MENU_QUIT_APP,
    TOP_UP_URL,
};

/// 组合根装配：把基础设施的仓储实现注入应用层（幂等，启动时调用一次）。
///
/// 这是整个工程里唯一「同时认识 domain trait 与 infrastructure 实现」的地方，
/// 依赖倒置的接缝就在这一处。
fn install_repositories() {
    application::registry::install(application::registry::Repositories {
        config: &infrastructure::repository::config::repository::CONFIG_REPOSITORY,
        bubble: &infrastructure::repository::bubble::repository::BUBBLE_REPOSITORY,
        supplier: &infrastructure::repository::supplier::repository::SUPPLIER_REPOSITORY,
        usage_history: &infrastructure::repository::supplier::repository::USAGE_HISTORY_REPOSITORY,
        ledger: &infrastructure::repository::ledger::repository::LEDGER_REPOSITORY,
        pic: &infrastructure::repository::widget_image::repository::PIC_REPOSITORY,
        audio: &infrastructure::repository::audio::repository::AUDIO_REPOSITORY,
        autostart: &infrastructure::repository::config::repository::AUTOSTART_REPOSITORY,
        asset_picker: &infrastructure::repository::asset::repository::ASSET_PICKER,
        client_config: &infrastructure::repository::client::repository::CLIENT_CONFIG_REPOSITORY,
        matting: &infrastructure::repository::widget_image::repository::MATTING_REPOSITORY,
        model_catalog: &infrastructure::repository::supplier::repository::MODEL_CATALOG_REPOSITORY,
        usage_gateway: &infrastructure::repository::supplier::repository::USAGE_GATEWAY,
        exchange_rate: &infrastructure::repository::balance::repository::EXCHANGE_RATE_REPOSITORY,
        holiday_store: &infrastructure::repository::pricing::HOLIDAY_STORE,
        holiday_source: &infrastructure::http::holiday_client::HOLIDAY_SOURCE,
        update_client: &infrastructure::repository::update::repository::UPDATE_REPOSITORY,
        system_host: &infrastructure::repository::system::repository::SYSTEM_HOST,
    });
}

/// 单元测试用的装配入口：应用层用例测试需要真实仓储才能跑通落盘路径。
#[cfg(test)]
pub(crate) fn install_test_repositories() {
    install_repositories();
}

/// 应用启动入口：初始化日志、全局异常捕获、数据目录，并注册事件循环。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    // 全局异常捕获：任何未捕获的 panic 都会落到统一日志（必须在业务代码之前安装）。
    types::exception::guard::install_panic_hook();

    // 初始化数据目录：解析便携路径、迁移旧版数据并校验可写性；
    // 必须早于任何配置读写（窗口创建会立即读取配置）。
    infrastructure::system::paths::init_storage();

    // 装配仓储：应用层从这里拿到 domain 的仓储 trait 实现（必须在任何用例之前）。
    install_repositories();

    // 旧配置迁移：把 config.json 里的 API Key / 请求地址迁移为供应商，保证老用户升级后
    // 余额展示与两个客户端的既有配置立即有数据源（幂等：index.json 是迁移哨兵，
    // 因此无条件调用即可）。失败只记日志，不阻断启动。
    match application::supplier::service::migrate_legacy_config() {
        Ok(Some(profile)) => log::info!("启动时已迁移旧配置为供应商：{}", profile.slug),
        Ok(None) => {}
        Err(err) => log::error!("迁移旧配置失败（不影响启动）：{}", err),
    }

    // 清理用量相关的历史文件：在线用量来源已改为**内置**（按供应商目录名匹配，
    // 不再落盘、不再由用户编辑），因此旧的 `usage_query.json` 一律删除；
    // 客户端列表只做模型路由，其 `usage_history.json` 也不再需要。
    // 幂等且只删文件，失败只记日志。
    match application::supplier::service::cleanup_usage_files() {
        Ok(0) => {}
        Ok(count) => log::info!("已清理 {} 个过期的用量配置文件", count),
        Err(err) => log::error!("清理用量配置文件失败（不影响启动）：{}", err),
    }

    let is_autostart = std::env::args().any(|a| a == AUTOSTART_FLAG);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已存在实例：以配置窗口为入口唤醒（打开配置即强制显示桌宠，
            // 与快捷方式 / 托盘入口行为一致）；配置窗口尚未创建时退化为直接唤回桌宠。
            if app.get_webview_window(CONFIG_WINDOW_LABEL).is_some() {
                let _ = shell::window::ensure_config_window(app);
            } else {
                let _ = shell::window::set_widget_visible(app, true);
            }
        }))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == CONFIG_WINDOW_LABEL {
                    // 配置窗口关闭即隐藏复用，避免反复创建 WebView2 导致白屏/内存泄漏。
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // 创建挂件窗口：初始可见性由持久化的隐藏状态决定
            // （隐藏时后台服务照常运行，用户可从托盘「显示桌宠」唤回）。
            let widget_visible = !application::registry::config().get().widget.hidden;
            let widget = shell::window::create_widget_window(app.handle(), widget_visible)?;
            if widget_visible {
                let _ = widget.show();
            }

            // 系统托盘（含「显示桌宠」勾选项）。
            shell::tray::setup_tray(app.handle())?;

            // 桌宠右键菜单：喂养 → 充值页；打开配置 → 配置窗口（同时强制显示桌宠）；
            // 隐藏桌宠 → 只隐藏窗口、后台不中断；退出程序 → 释放资源后直接退出。
            app.on_menu_event(|app_handle, event| match event.id.as_ref() {
                MENU_FEED => {
                    let _ = application::system::service::open_external(TOP_UP_URL);
                }
                MENU_CONFIG => {
                    let _ = shell::window::ensure_config_window(app_handle);
                }
                MENU_HIDE_WIDGET => {
                    let _ = shell::window::set_widget_visible(app_handle, false);
                }
                MENU_QUIT_APP => {
                    shell::window::quit_app(app_handle);
                }
                _ => {}
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api::config_api::get_config,
            api::config_api::save_config,
            api::config_api::save_widget_config,
            api::config_api::save_dialogue,
            api::config_api::set_currency,
            api::config_api::set_token_usage,
            api::config_api::reset_config,
            api::balance_api::get_balance,
            api::balance_api::get_supplier_balance,
            api::bubble_api::save_bubble,
            api::bubble_api::list_bubble_groups,
            api::bubble_api::switch_bubble_group,
            api::bubble_api::save_bubble_group,
            api::bubble_api::write_bubble_group,
            api::bubble_api::delete_bubble_group,
            api::bubble_api::pick_bubble_media,
            api::bubble_api::read_bubble_media,
            api::bubble_api::pick_bubble_font,
            api::bubble_api::read_bubble_font,
            api::bubble_api::list_bubble_fonts,
            api::supplier_api::list_supplier_clients,
            api::supplier_api::list_suppliers,
            api::supplier_api::get_supplier,
            api::supplier_api::save_supplier,
            api::supplier_api::delete_supplier,
            api::supplier_api::apply_supplier,
            api::supplier_api::test_supplier,
            api::supplier_api::get_supplier_usage,
            api::supplier_api::get_supplier_usage_cached,
            api::supplier_api::refresh_supplier_usage,
            api::supplier_api::preview_supplier_config,
            api::supplier_api::read_client_config,
            api::supplier_api::get_common_config,
            api::supplier_api::save_common_config,
            api::supplier_api::extract_common_config,
            api::model_api::fetch_models,
            api::pricing_api::get_holiday_calendar,
            api::pricing_api::refresh_holiday_calendar,
            api::app_api::set_autostart,
            api::app_api::get_data_dir,
            api::app_api::open_data_dir,
            api::audio_api::pick_audio_file,
            api::audio_api::read_audio_file,
            api::audio_api::list_audio_groups,
            api::audio_api::read_audio_group,
            api::audio_api::resolve_audio_group,
            api::audio_api::save_audio_group,
            api::audio_api::delete_audio_group,
            api::window_api::set_window_position,
            api::window_api::set_ignore_cursor_events,
            api::window_api::get_cursor_position,
            api::window_api::snap_window,
            api::window_api::show_context_menu,
            api::update_api::check_update,
            api::update_api::open_external,
            api::widget_image_api::list_widget_groups,
            api::widget_image_api::save_widget_image,
            api::widget_image_api::delete_widget_group,
            api::widget_image_api::read_widget_image,
            api::widget_image_api::widget_group_states,
            api::widget_image_api::read_widget_group_meta,
            api::widget_image_api::pick_image_file,
            api::widget_image_api::remove_background,
            api::widget_image_api::matting_model_ready,
            api::widget_image_api::download_matting_model,
        ])
        .build(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");

    app.run(move |app, event| {
        // 事件循环就绪后再创建配置窗口，避免在 setup 阶段与透明挂件窗口并发初始化导致白屏。
        if let tauri::RunEvent::Ready = event {
            if application::registry::config().get().api_key.is_empty() || !is_autostart {
                let _ = shell::window::ensure_config_window(app);
            }

            // 峰谷日历：后台按需准备「当前年 + 次年」数据。
            // 缓存新鲜时只读文件、不联网；缺失/过期/残缺才请求第三方接口，
            // 失败只记日志（判定链路会回退到内置兜底数据）。
            tauri::async_runtime::spawn(async {
                for refresh in application::pricing::service::ensure_years_around().await {
                    log::info!(
                        "峰谷日历 {} 年：{}（来源 {}）",
                        refresh.view.year,
                        refresh.outcome,
                        refresh.view.source
                    );
                }
            });
        }
    });
}
