//! 音效组领域规则
//!
//! 只包含**与存储无关**的规则：组名合法性、片段参数值域、模式归一化。
//! 文件读写见 `infrastructure::repository::audio::audio_store`。

use crate::domain::audio::model::{AudioClip, AudioGroup};
use crate::types::enums::AudioMode;
use crate::types::exception::{AppError, AppResult};

/// 音效组名长度上限。
pub const MAX_NAME_LEN: usize = 32;
/// 允许的倍速下限。
pub const RATE_MIN: f64 = 0.1;
/// 允许的倍速上限。
pub const RATE_MAX: f64 = 2.0;
/// 内置音效 id：仅存在于前端资源，不落盘，因此既不可删除也不可被重名覆盖。
pub const PRESET_IDS: [&str; 2] = ["duck", "dingdong"];

/// 校验音效组名：去首尾空白，禁止路径分隔符 / `..` / 冒号，限制长度。
pub fn sanitize_group(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(AppError::invalid("音效名称不能为空"));
    }
    if n.chars().count() > MAX_NAME_LEN {
        return Err(AppError::invalid(format!(
            "音效名称过长（上限 {} 个字符）",
            MAX_NAME_LEN
        )));
    }
    if n.contains('/') || n.contains('\\') || n.contains(':') || n == "." || n == ".." {
        return Err(AppError::invalid("音效名称包含非法字符"));
    }
    Ok(n.to_string())
}

/// 是否为内置音效 id。
pub fn is_preset(id: &str) -> bool {
    PRESET_IDS.contains(&id)
}

/// 归一化片段参数（倍速钳制到 0.1–2.0，裁剪区间取非负）。
pub fn normalize_clip(mut clip: AudioClip) -> AudioClip {
    if !clip.rate.is_finite() || clip.rate < RATE_MIN || clip.rate > RATE_MAX {
        clip.rate = crate::domain::audio::model::default_rate();
    }
    // 保留一位小数，与前端 0.1 步长一致。
    clip.rate = (clip.rate * 10.0).round() / 10.0;
    if !clip.start.is_finite() || clip.start < 0.0 {
        clip.start = 0.0;
    }
    if !clip.end.is_finite() || clip.end < 0.0 {
        clip.end = 0.0;
    }
    if clip.end > 0.0 && clip.end < clip.start {
        clip.end = clip.start;
    }
    clip
}

/// 归一化音效组：模式取值收敛，片段参数逐个钳制，并按模式裁掉未启用的槽位。
///
/// 「模式 = 启用的槽位」是硬约束：仅按下模式即使 meta.json 里残留 `release`
/// 字段也会被丢弃，避免出现「配置里有文件引用、播放逻辑却不认」的错位状态。
pub fn normalize_group(mut group: AudioGroup) -> AudioGroup {
    let mode = AudioMode::parse(&group.mode);
    group.mode = mode.as_str().to_string();
    group.press = if mode.needs_press() {
        group.press.map(normalize_clip)
    } else {
        None
    };
    group.release = if mode.needs_release() {
        group.release.map(normalize_clip)
    } else {
        None
    };
    group
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(start: f64, end: f64, rate: f64) -> AudioClip {
        AudioClip {
            file: "press.mp3".to_string(),
            start,
            end,
            rate,
        }
    }

    #[test]
    fn sanitize_rejects_illegal_names_and_trims() {
        assert!(sanitize_group("").is_err());
        assert!(sanitize_group("   ").is_err());
        assert!(sanitize_group("a/b").is_err());
        assert!(sanitize_group("a\\b").is_err());
        assert!(sanitize_group("a:b").is_err());
        assert!(sanitize_group("..").is_err());
        assert!(sanitize_group(&"超".repeat(MAX_NAME_LEN + 1)).is_err());
        assert_eq!(sanitize_group("  我的音效 ").unwrap(), "我的音效");
    }

    /// 错误文案是前端可见契约，保持与历史一致。
    #[test]
    fn sanitize_messages_are_unchanged() {
        assert_eq!(
            sanitize_group("").unwrap_err().message(),
            "音效名称不能为空"
        );
        assert_eq!(
            sanitize_group("a/b").unwrap_err().message(),
            "音效名称包含非法字符"
        );
        assert_eq!(
            sanitize_group(&"超".repeat(MAX_NAME_LEN + 1))
                .unwrap_err()
                .message(),
            "音效名称过长（上限 32 个字符）"
        );
    }

    #[test]
    fn clip_values_are_clamped() {
        let normalized = normalize_clip(clip(-1.0, 0.0, 5.0));
        assert_eq!(normalized.rate, 1.0, "超出范围应回落默认倍速");
        assert_eq!(normalized.start, 0.0, "负起点应归零");

        // 倍速保留一位小数。
        assert_eq!(normalize_clip(clip(0.0, 0.0, 1.26)).rate, 1.3);
        // 终点早于起点时收敛到起点。
        assert_eq!(normalize_clip(clip(2.0, 1.0, 1.0)).end, 2.0);
    }

    /// 三种模式各自的槽位裁剪规则（模式是「启用哪些槽位」的唯一事实来源）。
    #[test]
    fn group_slots_are_trimmed_by_mode() {
        let both = |mode: &str| AudioGroup {
            name: "甲".into(),
            mode: mode.into(),
            press: Some(clip(0.0, 0.0, 1.0)),
            release: Some(clip(0.0, 0.0, 1.0)),
        };

        // 仅按下：丢弃松开槽位。
        let press = normalize_group(both("press"));
        assert_eq!(press.mode, "press");
        assert!(press.press.is_some() && press.release.is_none());

        // 仅松开：丢弃按下槽位。
        let release = normalize_group(both("release"));
        assert_eq!(release.mode, "release");
        assert!(release.press.is_none() && release.release.is_some());

        // 组合：两个槽位都保留。
        let dual = normalize_group(both("dual"));
        assert_eq!(dual.mode, "dual");
        assert!(dual.press.is_some() && dual.release.is_some());

        // 历史取值 single 与非法值都收敛为仅按下。
        let legacy = normalize_group(both("single"));
        assert_eq!(legacy.mode, "press");
        assert!(legacy.press.is_some() && legacy.release.is_none());

        let unknown = normalize_group(both("乱七八糟"));
        assert_eq!(unknown.mode, "press");
        assert!(unknown.release.is_none());
    }

    #[test]
    fn preset_ids_are_protected() {
        assert!(is_preset("duck"));
        assert!(is_preset("dingdong"));
        assert!(!is_preset("我的音效"));
    }
}
