//! 音效组模式枚举
//!
//! 模式决定该音效组**启用哪些槽位**，是 meta.json 与播放逻辑的唯一事实来源：
//! - `Press`：仅按键按下音效；
//! - `Release`：仅按键松开音效；
//! - `Dual`：按下 + 松开组合音效。
//!
//! 槽位与模式必须始终一致（`Press` 只有 `press`、`Release` 只有 `release`、
//! `Dual` 两者都有），由 `domain::audio::service::audio_service::normalize_group` 与
//! `infrastructure::repository::audio::audio_store::save_group` 共同保证。

/// 音效组模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioMode {
    /// 仅按下音效。
    Press,
    /// 仅松开音效。
    Release,
    /// 按下 + 松开组合音效。
    Dual,
}

impl AudioMode {
    /// 模式标识（磁盘与前端取值）。
    pub fn as_str(self) -> &'static str {
        match self {
            AudioMode::Press => "press",
            AudioMode::Release => "release",
            AudioMode::Dual => "dual",
        }
    }

    /// 解析模式。
    ///
    /// 历史数据里「仅按下」写作 `single`，此处按别名兼容；非法值一律回落
    /// 到最保守的「仅按下」，避免整份音效配置读不出来。
    pub fn parse(mode: &str) -> Self {
        match mode {
            "dual" => AudioMode::Dual,
            "release" => AudioMode::Release,
            _ => AudioMode::Press,
        }
    }

    /// 是否需要「按下」槽位。
    pub fn needs_press(self) -> bool {
        matches!(self, AudioMode::Press | AudioMode::Dual)
    }

    /// 是否需要「松开」槽位。
    pub fn needs_release(self) -> bool {
        matches!(self, AudioMode::Release | AudioMode::Dual)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 三种模式各自的槽位需求：仅按下 / 仅松开 / 按下+松开。
    #[test]
    fn modes_declare_required_slots() {
        assert!(AudioMode::Press.needs_press());
        assert!(!AudioMode::Press.needs_release());

        assert!(!AudioMode::Release.needs_press());
        assert!(AudioMode::Release.needs_release());

        assert!(AudioMode::Dual.needs_press() && AudioMode::Dual.needs_release());
    }

    /// 磁盘取值稳定；历史 `single` 兼容为「仅按下」；非法值回落仅按下。
    #[test]
    fn audio_mode_parsing_keeps_legacy_compatibility() {
        assert_eq!(AudioMode::parse("press"), AudioMode::Press);
        assert_eq!(AudioMode::parse("single"), AudioMode::Press, "历史取值兼容");
        assert_eq!(AudioMode::parse("release"), AudioMode::Release);
        assert_eq!(AudioMode::parse("dual"), AudioMode::Dual);

        for other in ["", "DUAL", "unknown", "双音效"] {
            assert_eq!(AudioMode::parse(other), AudioMode::Press, "{}", other);
        }

        assert_eq!(AudioMode::Press.as_str(), "press");
        assert_eq!(AudioMode::Release.as_str(), "release");
        assert_eq!(AudioMode::Dual.as_str(), "dual");
    }
}
