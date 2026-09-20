//! system 领域的端口抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这个 trait，代码里不出现任何路径拼装与进程启动细节。

use std::path::{Path, PathBuf};

use crate::types::exception::AppResult;

/// 宿主环境端口：便携数据目录与系统默认程序。
pub trait SystemHost: Send + Sync {
    /// 见 `paths::app_data_dir`。
    fn data_dir(&self) -> PathBuf;

    /// 见 `external_config::open_external`。
    fn open_external(&self, url: &str) -> AppResult<()>;

    /// 见 `external_config::open_directory`。
    fn open_directory(&self, dir: &Path) -> AppResult<()>;
}
