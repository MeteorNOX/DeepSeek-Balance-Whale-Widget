//! 音效组 DTO
//!
//! 同时是 `<数据目录>/audio/<组名>/meta.json` 的磁盘格式与前端读取格式。

use serde::{Deserialize, Serialize};

use super::super::clip::AudioClip;

/// 一个音效组的完整定义（`meta.json`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioGroup {
    /// 音效组名称（即子文件夹名）。
    pub name: String,
    /// `single`（仅按下）/ `dual`（按下 + 松开）。
    pub mode: String,
    /// 按下音效（单音效模式同样使用该字段）。
    #[serde(default)]
    pub press: Option<AudioClip>,
    /// 松开音效（仅双音效模式）。
    #[serde(default)]
    pub release: Option<AudioClip>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 磁盘格式：`mode` / `press` / `release` 为固定键名，缺失时按可选项处理。
    #[test]
    fn group_matches_disk_format() {
        let json = r#"{"name":"我的音效","mode":"dual","press":{"file":"press.mp3"},"release":{"file":"release.mp3"}}"#;
        let group: AudioGroup = serde_json::from_str(json).unwrap();
        assert_eq!(group.name, "我的音效");
        assert_eq!(group.mode, "dual");
        assert!(group.press.is_some() && group.release.is_some());

        // 缺少可选字段时不应解析失败。
        let minimal: AudioGroup = serde_json::from_str(r#"{"name":"甲","mode":"single"}"#).unwrap();
        assert!(minimal.press.is_none());
        assert!(minimal.release.is_none());
    }
}
