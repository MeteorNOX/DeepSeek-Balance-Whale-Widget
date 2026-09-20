//! audio 领域的仓储抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这些 trait，代码里不出现任何文件 / 网络 / 框架细节。

use crate::types::exception::AppResult;
use crate::domain::audio::model::{AudioClip, AudioGroup, ResolvedAudioGroup};
use crate::types::enums::AudioMode;

/// 音效仓储：音效组元数据与可播放的运行时形式。
pub trait AudioRepository: Send + Sync {
    /// 见 `audio_store::list_groups`。
    fn list_groups(&self) -> Vec<AudioGroup>;

    /// 见 `audio_store::read_group`。
    fn read_group(&self, name: &str) -> AppResult<AudioGroup>;

    /// 见 `audio_store::resolve_group`。
    fn resolve_group(&self, name: &str) -> AppResult<ResolvedAudioGroup>;

    /// 见 `audio_store::save_group`。
    fn save_group(&self, name: &str, mode: AudioMode, press_src: Option<String>, release_src: Option<String>, press: Option<AudioClip>, release: Option<AudioClip>) -> AppResult<AudioGroup>;

    /// 见 `audio_store::delete_group`。
    fn delete_group(&self, name: &str) -> AppResult<()>;
}
