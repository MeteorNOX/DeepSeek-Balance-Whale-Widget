//! bubble 领域的仓储抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这些 trait，代码里不出现任何文件 / 网络 / 框架细节。

use crate::types::exception::AppResult;
use crate::domain::bubble::model::entity::bubble_config::BubbleConfig;

/// 模块化气泡仓储：气泡组文件与气泡媒体 / 字体资源。
pub trait BubbleRepository: Send + Sync {
    /// 见 `bubble_store::group_exists`。
    fn group_exists(&self, name: &str) -> bool;

    /// 见 `bubble_store::list_groups`。
    fn list_groups(&self) -> Vec<String>;

    /// 见 `bubble_store::read_group`。
    fn read_group(&self, name: &str) -> AppResult<BubbleConfig>;

    /// 见 `bubble_store::save_group`。
    fn save_group(&self, name: &str, bubble: &BubbleConfig) -> AppResult<BubbleConfig>;

    /// 见 `bubble_store::delete_group`。
    fn delete_group(&self, name: &str) -> AppResult<()>;

    /// 见 `bubble_store::save_media`。
    fn save_media(&self, source: &str, bytes: &[u8]) -> AppResult<String>;

    /// 见 `bubble_store::read_media`。
    fn read_media(&self, name: &str) -> AppResult<Vec<u8>>;

    /// 见 `bubble_store::save_font`。
    fn save_font(&self, source: &str, bytes: &[u8]) -> AppResult<String>;

    /// 见 `bubble_store::read_font`。
    fn read_font(&self, name: &str) -> AppResult<Vec<u8>>;

    /// 见 `bubble_store::list_fonts`。
    fn list_fonts(&self) -> Vec<String>;
}
