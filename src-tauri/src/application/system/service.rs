//! 系统用例
//!
//! 开机自启、版本检查、打开外部链接与数据目录。
//!
//! 这些能力都属于宿主环境：本层只依赖端口（`domain::config::repository::AutostartRepository`、
//! `domain::update::repository::UpdateRepository`、`domain::system::repository::SystemHost`），
//! 真实实现（注册表 / HTTP / explorer）在 `infrastructure`。

use std::fs;

use crate::application::registry;
use crate::domain::update::model::UpdateCheckResult;
use crate::domain::update::service::update_service as update_rules;
use crate::types::exception::{AppError, AppResult};

/// 设置开机自启，并把系统真实结果同步回配置。
pub fn set_autostart(enabled: bool) -> AppResult<bool> {
    let result = registry::autostart().set_enabled(enabled)?;
    let _ = registry::config().mutate(Box::new(move |c| c.autostart = result));
    Ok(result)
}

/// 检查更新：请求远端版本清单并与当前版本比较。
pub async fn check_update() -> AppResult<UpdateCheckResult> {
    let latest = registry::update_client().latest_version().await?;
    Ok(update_rules::build_result(
        env!("CARGO_PKG_VERSION"),
        &latest,
    ))
}

/// 用系统默认浏览器打开外部链接。
pub fn open_external(url: &str) -> AppResult<()> {
    registry::system_host().open_external(url)
}

/// 应用数据目录的绝对路径（配置界面的「配置文件」项只读展示）。
pub fn data_dir() -> String {
    registry::system_host().data_dir().display().to_string()
}

/// 用系统文件管理器打开应用数据目录。
pub fn open_data_dir() -> AppResult<()> {
    let dir = registry::system_host().data_dir();
    fs::create_dir_all(&dir).map_err(|e| AppError::io(format!("创建数据目录失败: {}", e)))?;
    registry::system_host().open_directory(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 空链接必须被拒绝（避免误开系统目录）。
    #[test]
    fn blank_url_is_rejected() {
        crate::install_test_repositories();
        assert_eq!(open_external("").unwrap_err().message(), "链接为空");
    }

    /// 「配置文件」项展示的必须是数据目录本身（绝对路径，且不是某个文件）。
    #[test]
    fn data_dir_points_to_data_root() {
        crate::install_test_repositories();
        let dir = registry::system_host().data_dir();
        assert_eq!(data_dir(), dir.display().to_string());
        assert!(dir.is_absolute(), "展示路径必须是绝对路径：{}", data_dir());
        assert!(
            dir.extension().is_none(),
            "展示的必须是目录而不是文件：{}",
            data_dir()
        );
    }
}
