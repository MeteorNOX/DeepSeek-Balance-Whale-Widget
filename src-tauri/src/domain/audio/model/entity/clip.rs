//! 音效片段 DTO

use serde::{Deserialize, Serialize};

/// 单个音效片段的编辑参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioClip {
    /// 音频文件名（相对音效组目录）。
    pub file: String,
    /// 裁剪起点（秒）。
    #[serde(default)]
    pub start: f64,
    /// 裁剪终点（秒）；未设置时播放到文件末尾。
    #[serde(default)]
    pub end: f64,
    /// 播放倍速（0.1–2.0）。
    #[serde(default = "default_rate")]
    pub rate: f64,
}

/// 播放倍速默认值。
pub(crate) fn default_rate() -> f64 {
    1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缺省字段必须回落默认值（前端只提交发生变化的字段）。
    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let clip: AudioClip = serde_json::from_str(r#"{"file":"press.mp3"}"#).unwrap();
        assert_eq!(clip.file, "press.mp3");
        assert_eq!(clip.start, 0.0);
        assert_eq!(clip.end, 0.0);
        assert_eq!(clip.rate, 1.0);
    }

    /// 字段名是前端契约（camelCase）。
    #[test]
    fn clip_serializes_camel_case() {
        let clip = AudioClip {
            file: "press.mp3".to_string(),
            start: 0.5,
            end: 1.5,
            rate: 1.2,
        };
        let json = serde_json::to_string(&clip).unwrap();
        assert!(json.contains("\"file\":\"press.mp3\""), "{}", json);
        assert!(json.contains("\"rate\":1.2"), "{}", json);
        assert!(json.contains("\"end\":1.5"), "{}", json);
    }
}
