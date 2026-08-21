//! 系统服务模块（开机自启）
//!
//! 使用 `auto-launch` 跨平台库管理开机自启：
//! - Windows：写入注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`；
//! - 其他平台分别使用 launchd / XDG autostart。
//! 逻辑借鉴 cc-switch 的 `auto_launch.rs`。

use auto_launch::{AutoLaunch, AutoLaunchBuilder};

const APP_NAME: &str = "DSW小鲸鱼";

/// 构建 AutoLaunch 实例（使用当前可执行文件路径）。
fn build_auto_launch() -> Result<AutoLaunch, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("无法获取应用路径: {e}"))?;
    AutoLaunchBuilder::new()
        .set_app_name(APP_NAME)
        .set_app_path(&exe_path.to_string_lossy())
        .set_args(&["--autostart"])
        .build()
        .map_err(|e| format!("创建开机自启配置失败: {e}"))
}

/// 设置开机自启状态。
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    let auto_launch = build_auto_launch()?;
    if enabled {
        auto_launch.enable().map_err(|e| format!("启用开机自启失败: {e}"))?;
    } else {
        auto_launch.disable().map_err(|e| format!("禁用开机自启失败: {e}"))?;
    }
    Ok(enabled)
}
