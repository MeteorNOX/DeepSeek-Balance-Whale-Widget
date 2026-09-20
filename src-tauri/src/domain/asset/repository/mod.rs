//! asset 领域的端口抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这个 trait，代码里不出现任何系统对话框细节。

use std::path::PathBuf;

/// 素材选择端口：打开系统文件对话框挑一个本地文件（用户取消时返回 `None`）。
pub trait AssetPicker: Send + Sync {
    /// 见 `file_dialog::pick_audio_file`。
    fn pick_audio(&self) -> Option<PathBuf>;

    /// 见 `file_dialog::pick_image_file`。
    fn pick_image(&self) -> Option<PathBuf>;

    /// 见 `file_dialog::pick_font_file`。
    fn pick_font(&self) -> Option<PathBuf>;

    /// 见 `file_dialog::pick_media_file`。
    fn pick_media(&self) -> Option<PathBuf>;
}
