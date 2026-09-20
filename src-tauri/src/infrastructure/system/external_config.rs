//! 外部链接
//!
//! 打开外部链接：Windows 下经 explorer 打开，规避 shell 特殊字符问题。
//!
//! 客户端配置文件（`~/.claude/settings.json`、`~/.codex/*`）的读写已迁至
//! `infrastructure::system::client_config`（合并式写入 + `.bak` 备份），本模块只负责外部链接。

use std::path::Path;

use crate::types::exception::{AppError, AppResult};

/// 用系统默认浏览器打开外部链接（Windows 下经 explorer 打开）。
pub fn open_external(url: &str) -> AppResult<()> {
    if url.trim().is_empty() {
        return Err(AppError::invalid("链接为空"));
    }
    std::process::Command::new("explorer")
        .arg(url)
        .spawn()
        .map_err(|e| AppError::io(format!("打开浏览器失败: {}", e)))?;
    Ok(())
}

/// 用系统文件管理器打开已存在的目录（Windows 下经 explorer 打开）。
///
/// 目录不存在时直接报错：explorer 对不存在的路径会静默打开「此电脑」，
/// 用户看到的现象是「点了打开却跳到了别处」，因此这里必须先行拦截。
pub fn open_directory(dir: &Path) -> AppResult<()> {
    if !dir.is_dir() {
        return Err(AppError::invalid("目录不存在"));
    }
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map_err(|e| AppError::io(format!("打开文件夹失败: {}", e)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 空链接必须被拒绝（避免 explorer 打开「我的电脑」）。
    #[test]
    fn open_external_rejects_blank_url() {
        assert_eq!(open_external("").unwrap_err().message(), "链接为空");
        assert_eq!(open_external("   ").unwrap_err().message(), "链接为空");
    }

    /// 目录不存在必须被拒绝（否则 explorer 会跳到「此电脑」）。
    #[test]
    fn open_directory_rejects_missing_path() {
        let missing = std::env::temp_dir().join("dsw-not-exist-DIR-xyz");
        assert_eq!(
            open_directory(&missing).unwrap_err().message(),
            "目录不存在"
        );
    }
}
