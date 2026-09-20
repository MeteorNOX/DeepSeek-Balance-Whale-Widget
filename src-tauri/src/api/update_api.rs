//! 版本检查与外部链接命令

use crate::application::system;
use crate::domain::update::model::UpdateCheckResult;
use crate::types::exception::{guard, IntoWire};

/// 检查更新：请求远端版本清单，与当前版本字符串比较。
#[tauri::command]
pub async fn check_update() -> Result<UpdateCheckResult, String> {
    system::service::check_update().await.into_wire()
}

/// 用系统默认浏览器打开外部链接（Windows 下经 explorer 打开，规避 shell 特殊字符问题）。
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    guard::catch(|| system::service::open_external(&url)).into_wire()
}
