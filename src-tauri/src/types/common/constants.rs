//! 全局常量
//!
//! 这里的字符串是与**前端**、**操作系统**之间的契约（窗口标识、事件名、
//! 菜单项 id、注册表项名），任何改动都必须同步修改前端与本文件。

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

/// 挂件窗口 label。
pub const WIDGET_WINDOW_LABEL: &str = "widget";
/// 配置窗口 label。
pub const CONFIG_WINDOW_LABEL: &str = "config";

// ---------------------------------------------------------------------------
// 事件（Rust → 前端）
// ---------------------------------------------------------------------------

/// 挂件显示配置变更：挂件窗口实时应用新设置。
pub const EVENT_WIDGET_CONFIG_CHANGED: &str = "widget-config-changed";
/// 台词配置变更。
pub const EVENT_DIALOGUE_CHANGED: &str = "dialogue-changed";
/// 模块化气泡配置变更：挂件窗口实时应用新的气泡内容。
pub const EVENT_BUBBLE_CHANGED: &str = "bubble-changed";
/// 请求前端刷新余额（API Key / 请求地址 / 显示币种变化）。
///
/// 载荷是 `bool`，含义是「已显示的余额是否仍然有效」：
/// - `true`：**余额数据源（当前启用供应商）已变化**，前端必须立刻作废已显示的余额与
///   今日已用——切到一个未连通的供应商时要显示「--」，绝不能继续显示上一个供应商的数字；
/// - `false`：只需重新拉取（显示币种 / 用量口径变化等），已有数值仍属于同一数据源。
pub const EVENT_BALANCE_REFRESH_REQUESTED: &str = "balance-refresh-requested";
/// 挂件图片资源变更。
pub const EVENT_WIDGET_IMAGE_CHANGED: &str = "widget-image-changed";
/// 抠图模型下载进度（0–100）。
pub const EVENT_MATTING_DOWNLOAD_PROGRESS: &str = "matting-model-download-progress";
/// 退出前置通知：请前端释放渲染资源（音效上下文、动画与定时器）。
pub const EVENT_APP_QUIT: &str = "app-quit";
/// 桌宠显示 / 隐藏前置通知：请前端立即清空或恢复渲染内容。
///
/// 透明 WebView2 窗口被隐藏时，合成层可能继续展示上一帧（观感上像「逐渐消失」），
/// 因此隐藏前先让前端清空内容、显示前先恢复内容，使显隐在视觉上都是瞬时的。
pub const EVENT_WIDGET_VISIBILITY: &str = "widget-visibility";

// ---------------------------------------------------------------------------
// 菜单
// ---------------------------------------------------------------------------

/// 托盘图标 id。
pub const TRAY_ID: &str = "main-tray";
/// 托盘菜单项：打开配置。
pub const MENU_OPEN_CONFIG: &str = "open_config";
/// 托盘菜单项：显示桌宠（勾选项，勾选 = 显示，未勾选 = 隐藏）。
pub const MENU_SHOW_WIDGET: &str = "show_widget";
/// 托盘菜单项：退出。
pub const MENU_QUIT: &str = "quit";
/// 挂件右键菜单项：喂养（打开充值页）。
pub const MENU_FEED: &str = "menu_feed";
/// 挂件右键菜单项：打开配置。
pub const MENU_CONFIG: &str = "menu_config";
/// 挂件右键菜单项：隐藏桌宠（只隐藏窗口，后台服务照常运行）。
pub const MENU_HIDE_WIDGET: &str = "menu_hide_widget";
/// 挂件右键菜单项：退出程序（释放资源后直接退出）。
pub const MENU_QUIT_APP: &str = "menu_quit_app";
/// 充值页地址（右键菜单「喂养」）。
pub const TOP_UP_URL: &str = "https://platform.deepseek.com/top_up";

// ---------------------------------------------------------------------------
// 系统与启动
// ---------------------------------------------------------------------------

/// 开机自启注册表项名（`HKCU\...\Run` 下的值名）。
pub const AUTOSTART_APP_NAME: &str = "DSW小鲸鱼";
/// 开机自启启动参数：用于识别「由系统自启拉起」。
pub const AUTOSTART_FLAG: &str = "--autostart";
/// 退出宽限期（毫秒）：广播退出事件后，等渲染进程释放音频 / 动画资源再销毁窗口。
pub const QUIT_CLEANUP_GRACE_MS: u64 = 250;
/// 显隐宽限期（毫秒）：通知前端清空 / 恢复内容后，等其画出这一帧再显示或隐藏窗口，
/// 保证「直接消失、直接显示」，不残留上一帧画面。
pub const VISIBILITY_PAINT_GRACE_MS: u64 = 40;
