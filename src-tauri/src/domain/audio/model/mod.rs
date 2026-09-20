//! 音效组数据传输对象
//!
//! - [`clip`]：单个音效片段的编辑参数；
//! - [`group`]：音效组定义（`meta.json` 磁盘格式）；
//! - [`resolved`]：可直接播放的运行时形式（含音频文件绝对路径）。

//! 目录约定（见 `1.md`）：`aggregate/` 聚合根、`entity/` 实体、`valobj/` 值对象与常量。
pub mod entity;
pub mod valobj;

pub use entity::{clip, group};
pub use valobj::{resolved};

pub(crate) use clip::default_rate;
pub use clip::AudioClip;
pub use group::AudioGroup;
pub use resolved::{ResolvedAudioGroup, ResolvedClip};
