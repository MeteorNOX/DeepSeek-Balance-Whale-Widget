//! 可播放音效 DTO
//!
//! 「解析后」的运行时形式：把组内相对文件名换成音频文件绝对路径，
//! 供前端直接 `decode` / 播放。

use serde::Serialize;

/// 供前端直接播放的音效片段（含绝对路径）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedClip {
    /// 音频文件绝对路径。
    pub path: String,
    /// 组内文件名（相对音效组目录，供编辑时沿用既有资源）。
    pub file: String,
    /// 裁剪起点（秒）。
    pub start: f64,
    /// 裁剪终点（秒）。
    pub end: f64,
    /// 播放倍速。
    pub rate: f64,
}

/// 供前端直接播放的音效组信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAudioGroup {
    /// 音效组名称。
    pub name: String,
    /// 播放模式：`single` / `dual`。
    pub mode: String,
    /// 按下音效。
    pub press: Option<ResolvedClip>,
    /// 松开音效。
    pub release: Option<ResolvedClip>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端契约：`path` / `file` 必须同时下发（编辑时沿用组内资源）。
    #[test]
    fn resolved_group_serializes_camel_case() {
        let group = ResolvedAudioGroup {
            name: "甲".to_string(),
            mode: "single".to_string(),
            press: Some(ResolvedClip {
                path: "C:/data/audio/甲/press.mp3".to_string(),
                file: "press.mp3".to_string(),
                start: 0.0,
                end: 0.0,
                rate: 1.0,
            }),
            release: None,
        };
        let json = serde_json::to_string(&group).unwrap();
        assert!(
            json.contains("\"path\":\"C:/data/audio/甲/press.mp3\""),
            "{}",
            json
        );
        assert!(json.contains("\"file\":\"press.mp3\""), "{}", json);
        assert!(json.contains("\"release\":null"), "{}", json);
    }
}
