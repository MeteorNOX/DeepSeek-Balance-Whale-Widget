//! SystemHost 的实现
//!
//! 只做一件事：把领域层的端口 trait 委派给本层的路径与外部程序实现。

use std::path::{Path, PathBuf};

use crate::domain::system::repository::SystemHost;
use crate::types::exception::AppResult;

/// 生产实现：便携数据目录 + 系统默认程序。
pub struct SystemHostImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static SYSTEM_HOST: SystemHostImpl = SystemHostImpl;

impl SystemHost for SystemHostImpl {
    fn data_dir(&self) -> PathBuf {
        crate::infrastructure::system::paths::app_data_dir()
    }

    fn open_external(&self, url: &str) -> AppResult<()> {
        crate::infrastructure::system::external_config::open_external(url)
    }

    fn open_directory(&self, dir: &Path) -> AppResult<()> {
        crate::infrastructure::system::external_config::open_directory(dir)
    }
}
