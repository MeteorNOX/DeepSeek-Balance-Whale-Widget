//! 应用相关命令
//!
//! 开机自启设置、数据目录路径与打开。音效相关命令见 `api::audio_api`。

use crate::application::system;
use crate::types::exception::{guard, IntoWire};

/// 设置开机自启，并把结果同步回配置。
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    guard::catch(|| system::service::set_autostart(enabled)).into_wire()
}

/// 应用数据目录的绝对路径（配置界面「配置文件」项只读展示）。
#[tauri::command]
pub fn get_data_dir() -> String {
    system::service::data_dir()
}

/// 用系统文件管理器打开应用数据目录。
#[tauri::command]
pub fn open_data_dir() -> Result<(), String> {
    guard::catch(system::service::open_data_dir).into_wire()
}
