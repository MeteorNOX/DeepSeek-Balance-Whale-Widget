//! 自定义音效命令
//!
//! 负责音效文件选择 / 读取，以及音效组的创建、编辑与查询。
//! 音效文件统一存放在 `<数据目录>/audio/<音效组名>/`。

use crate::application::audio;
use crate::domain::audio::model::{AudioClip, AudioGroup, ResolvedAudioGroup};
use crate::types::exception::{guard, IntoWire};

/// 打开系统文件对话框选择音频文件，返回所选文件路径（未选择返回 None）。
#[tauri::command]
pub fn pick_audio_file() -> Option<String> {
    audio::service::pick_file()
}

/// 读取本地音频文件并返回 base64 Data URL，供前端解码 / 播放。
#[tauri::command]
pub fn read_audio_file(path: String) -> Result<String, String> {
    guard::catch(|| audio::service::read_audio_file_data_url(&path)).into_wire()
}

/// 列出全部自定义音效组（供下拉选择与管理）。
#[tauri::command]
pub fn list_audio_groups() -> Vec<AudioGroup> {
    audio::service::list_groups()
}

/// 读取单个音效组定义。
#[tauri::command]
pub fn read_audio_group(name: String) -> Result<AudioGroup, String> {
    guard::catch(|| audio::service::read_group(&name)).into_wire()
}

/// 解析音效组为可直接播放的形式（含音频文件绝对路径与裁剪 / 变速参数）。
#[tauri::command]
pub fn resolve_audio_group(name: String) -> Result<ResolvedAudioGroup, String> {
    guard::catch(|| audio::service::resolve_group(&name)).into_wire()
}

/// 删除自定义音效组：移除该组的全部音频文件。
#[tauri::command]
pub fn delete_audio_group(name: String) -> Result<(), String> {
    guard::catch(|| audio::service::delete_group(&name)).into_wire()
}

/// 保存（新建或覆盖）音效组：复制上传的音频文件到组目录并写入编辑参数。
#[tauri::command]
pub fn save_audio_group(
    name: String,
    mode: String,
    press_src: Option<String>,
    release_src: Option<String>,
    press: Option<AudioClip>,
    release: Option<AudioClip>,
) -> Result<AudioGroup, String> {
    guard::catch(|| {
        audio::service::save_group(&name, &mode, press_src, release_src, press, release)
    })
    .into_wire()
}
