//! BubbleRepository 的实现
//!
//! 只做一件事：把领域层的仓储 trait 委派给本层的落盘实现（`<store>`）。

use crate::types::exception::AppResult;
use crate::domain::bubble::model::entity::bubble_config::BubbleConfig;
use crate::domain::bubble::repository::BubbleRepository;

/// 生产实现：直接落盘到便携数据目录。
pub struct BubbleRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static BUBBLE_REPOSITORY: BubbleRepositoryImpl = BubbleRepositoryImpl;

impl BubbleRepository for BubbleRepositoryImpl {
    fn group_exists(&self, name: &str) -> bool {
        crate::infrastructure::repository::bubble::bubble_store::group_exists(name)
    }

    fn list_groups(&self) -> Vec<String> {
        crate::infrastructure::repository::bubble::bubble_store::list_groups()
    }

    fn read_group(&self, name: &str) -> AppResult<BubbleConfig> {
        crate::infrastructure::repository::bubble::bubble_store::read_group(name)
    }

    fn save_group(&self, name: &str, bubble: &BubbleConfig) -> AppResult<BubbleConfig> {
        crate::infrastructure::repository::bubble::bubble_store::save_group(name, bubble)
    }

    fn delete_group(&self, name: &str) -> AppResult<()> {
        crate::infrastructure::repository::bubble::bubble_store::delete_group(name)
    }

    fn save_media(&self, source: &str, bytes: &[u8]) -> AppResult<String> {
        crate::infrastructure::repository::bubble::bubble_store::save_media(source, bytes)
    }

    fn read_media(&self, name: &str) -> AppResult<Vec<u8>> {
        crate::infrastructure::repository::bubble::bubble_store::read_media(name)
    }

    fn save_font(&self, source: &str, bytes: &[u8]) -> AppResult<String> {
        crate::infrastructure::repository::bubble::bubble_store::save_font(source, bytes)
    }

    fn read_font(&self, name: &str) -> AppResult<Vec<u8>> {
        crate::infrastructure::repository::bubble::bubble_store::read_font(name)
    }

    fn list_fonts(&self) -> Vec<String> {
        crate::infrastructure::repository::bubble::bubble_store::list_fonts()
    }
}
