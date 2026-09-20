//! 音效用例
//!
//! 音效文件的挑选与读取（转 Data URL 供前端解码播放），以及音效组的增删查改。

use crate::domain::audio::model::{AudioClip, AudioGroup, ResolvedAudioGroup};
use crate::types::enums::AudioMode;
use crate::types::exception::AppResult;
use crate::types::utils::base64 as b64;
use crate::types::utils::fs;
use crate::application::registry;

/// 打开系统文件对话框选择音频文件，返回所选文件路径（未选择返回 None）。
pub fn pick_file() -> Option<String> {
    registry::asset_picker()
        .pick_audio()
        .map(|path| path.to_string_lossy().to_string())
}

/// 列出全部自定义音效组（供下拉选择与管理）。
pub fn list_groups() -> Vec<AudioGroup> {
    registry::audio().list_groups()
}

/// 读取单个音效组定义。
pub fn read_group(name: &str) -> AppResult<AudioGroup> {
    registry::audio().read_group(name)
}

/// 解析音效组为可直接播放的形式（含音频文件绝对路径与裁剪 / 变速参数）。
pub fn resolve_group(name: &str) -> AppResult<ResolvedAudioGroup> {
    registry::audio().resolve_group(name)
}

/// 保存（新建或覆盖）音效组。
///
/// `mode` 为前端原始字符串，支持「仅按下 / 仅松开 / 按下+松开」三种取值，
/// 非法值回落为最保守的「仅按下」（见 `AudioMode::parse`）。
pub fn save_group(
    name: &str,
    mode: &str,
    press_src: Option<String>,
    release_src: Option<String>,
    press: Option<AudioClip>,
    release: Option<AudioClip>,
) -> AppResult<AudioGroup> {
    registry::audio().save_group(
        name,
        AudioMode::parse(mode),
        press_src,
        release_src,
        press,
        release,
    )
    .map_err(|err| {
        log::error!("保存音效组失败（{}）：{}", name, err);
        err
    })
}

/// 删除自定义音效组：移除该组的全部音频文件。
pub fn delete_group(name: &str) -> AppResult<()> {
    registry::audio().delete_group(name).map_err(|err| {
        log::error!("删除音效组失败（{}）：{}", name, err);
        err
    })
}

/// 读取本地音频文件并返回 base64 Data URL，供前端解码 / 播放。
pub fn read_audio_file_data_url(path: &str) -> AppResult<String> {
    let bytes = fs::read_bytes(std::path::Path::new(path), "音频文件")?;
    Ok(b64::audio_data_url(path, &bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 音频 Data URL 必须带正确的 MIME（前端据此解码）。
    #[test]
    fn audio_file_is_exposed_as_data_url() {
        let path = std::env::temp_dir().join(format!("dsw-app-audio-{}", std::process::id()));
        let path_str = path.to_string_lossy().to_string();
        std::fs::write(&path, b"AUDIO").unwrap();

        let url = read_audio_file_data_url(&path_str).expect("读取应成功");
        assert!(
            url.starts_with("data:application/octet-stream;base64,"),
            "{}",
            url
        );

        let _ = std::fs::remove_file(&path);
    }

    /// 文件不存在时给出与历史一致的错误文案。
    #[test]
    fn missing_audio_file_reports_read_failure() {
        let err = read_audio_file_data_url("不存在的文件-xyz.mp3").unwrap_err();
        assert!(
            err.message().starts_with("读取音频文件失败："),
            "{}",
            err.message()
        );
    }

    /// 模式字符串解析：三种取值可用，非法值回落仅按下，历史 single 兼容。
    #[test]
    fn mode_string_is_normalized() {
        let dual = AudioMode::parse("dual");
        assert!(dual.needs_press() && dual.needs_release());

        let release = AudioMode::parse("release");
        assert!(release.needs_release() && !release.needs_press());

        let press = AudioMode::parse("press");
        assert!(press.needs_press() && !press.needs_release());

        assert!(AudioMode::parse("single").needs_press(), "历史取值兼容");
        assert!(!AudioMode::parse("").needs_release(), "非法值回落仅按下");
    }
}
