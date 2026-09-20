//! AudioRepository 的实现
//!
//! 只做一件事：把领域层的仓储 trait 委派给本层的落盘实现（`<store>`）。

use crate::types::exception::AppResult;
use crate::domain::audio::model::{AudioClip, AudioGroup, ResolvedAudioGroup};
use crate::types::enums::AudioMode;
use crate::domain::audio::repository::AudioRepository;

/// 生产实现：直接落盘到便携数据目录。
pub struct AudioRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static AUDIO_REPOSITORY: AudioRepositoryImpl = AudioRepositoryImpl;

impl AudioRepository for AudioRepositoryImpl {
    fn list_groups(&self) -> Vec<AudioGroup> {
        crate::infrastructure::repository::audio::audio_store::list_groups()
    }

    fn read_group(&self, name: &str) -> AppResult<AudioGroup> {
        crate::infrastructure::repository::audio::audio_store::read_group(name)
    }

    fn resolve_group(&self, name: &str) -> AppResult<ResolvedAudioGroup> {
        crate::infrastructure::repository::audio::audio_store::resolve_group(name)
    }

    fn save_group(&self, name: &str, mode: AudioMode, press_src: Option<String>, release_src: Option<String>, press: Option<AudioClip>, release: Option<AudioClip>) -> AppResult<AudioGroup> {
        crate::infrastructure::repository::audio::audio_store::save_group(name, mode, press_src, release_src, press, release)
    }

    fn delete_group(&self, name: &str) -> AppResult<()> {
        crate::infrastructure::repository::audio::audio_store::delete_group(name)
    }
}
