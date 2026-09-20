//! AssetPicker 的实现
//!
//! 只做一件事：把领域层的端口 trait 委派给本层的系统对话框实现。

use std::path::PathBuf;

use crate::domain::asset::repository::AssetPicker;

/// 生产实现：系统文件对话框（`rfd`）。
pub struct AssetPickerImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static ASSET_PICKER: AssetPickerImpl = AssetPickerImpl;

impl AssetPicker for AssetPickerImpl {
    fn pick_audio(&self) -> Option<PathBuf> {
        crate::infrastructure::system::file_dialog::pick_audio_file().map(PathBuf::from)
    }

    fn pick_image(&self) -> Option<PathBuf> {
        crate::infrastructure::system::file_dialog::pick_image_file()
    }

    fn pick_font(&self) -> Option<PathBuf> {
        crate::infrastructure::system::file_dialog::pick_font_file()
    }

    fn pick_media(&self) -> Option<PathBuf> {
        crate::infrastructure::system::file_dialog::pick_media_file()
    }
}
