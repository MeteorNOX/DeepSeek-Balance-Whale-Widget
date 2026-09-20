//! 系统文件对话框
//!
//! 与系统 UI 交互的入口集中在此，便于应用层在不依赖窗口实现的前提下复用。

use std::path::PathBuf;

/// 打开系统文件对话框选择音频文件，返回所选文件路径（未选择返回 None）。
pub fn pick_audio_file() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("选择音频文件")
        .add_filter(
            "音频文件",
            &[
                "wav", "flac", "alac", "ape", "mp3", "aac", "wma", "ogg", "m4a", "opus", "caf",
            ],
        )
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// 打开系统文件对话框选择图片文件，返回所选文件路径（未选择返回 None）。
pub fn pick_image_file() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_title("选择图片")
        .add_filter("图片", &["png", "jpg", "jpeg", "gif", "bmp", "webp"])
        .pick_file()
}

/// 打开系统文件对话框选择字体文件，返回所选文件路径（未选择返回 None）。
///
/// 覆盖 ttf / otf / woff / woff2 四种主流格式（浏览器可用的集合）。
pub fn pick_font_file() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_title("选择字体文件")
        .add_filter("字体文件", &["ttf", "otf", "woff", "woff2"])
        .pick_file()
}

/// 打开系统文件对话框选择气泡媒体（图片 / 动图），返回所选文件路径。
///
/// 过滤器按「静图 / 动图 / 专业格式」分组，便于用户在对话框里快速切换；
/// 所有扩展名都会在保存阶段再校验一次，非法格式不会落盘。
pub fn pick_media_file() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_title("选择图片 / 动图")
        .add_filter(
            "图片与动图",
            &[
                "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "avif", "apng", "mng",
                "tif", "tiff", "heic", "heif", "raw", "psd",
            ],
        )
        .add_filter("动图", &["gif", "apng", "mng", "webp"])
        .pick_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 对话框是阻塞式系统调用，测试只校验其签名契约（返回可选项）。
    #[test]
    fn pickers_are_optional_by_design() {
        // 通过函数指针断言返回类型，避免测试误触发真实对话框。
        let audio: fn() -> Option<String> = pick_audio_file;
        let image: fn() -> Option<PathBuf> = pick_image_file;
        let font: fn() -> Option<PathBuf> = pick_font_file;
        let media: fn() -> Option<PathBuf> = pick_media_file;
        let _ = (audio, image, font, media);
    }
}
