//! 台词播放模式枚举

/// 台词播放模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogueMode {
    /// 轮播。
    Carousel,
    /// 随机。
    Random,
}

impl DialogueMode {
    /// 默认模式。
    pub const DEFAULT: DialogueMode = DialogueMode::Random;

    /// 模式标识（前端取值）。
    pub fn as_str(self) -> &'static str {
        match self {
            DialogueMode::Carousel => "carousel",
            DialogueMode::Random => "random",
        }
    }

    /// 解析模式（严格匹配，与历史配置规范化一致）。
    pub fn parse(mode: &str) -> Option<Self> {
        match mode {
            "carousel" => Some(DialogueMode::Carousel),
            "random" => Some(DialogueMode::Random),
            _ => None,
        }
    }

    /// 解析模式，非法值回落默认模式。
    pub fn parse_or_default(mode: &str) -> Self {
        Self::parse(mode).unwrap_or(Self::DEFAULT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 播放模式：仅两种合法取值，其余回落随机（与历史一致）。
    #[test]
    fn dialogue_mode_parsing_matches_legacy_behavior() {
        assert_eq!(
            DialogueMode::parse("carousel"),
            Some(DialogueMode::Carousel)
        );
        assert_eq!(DialogueMode::parse("random"), Some(DialogueMode::Random));
        assert_eq!(DialogueMode::parse("Carousel"), None);
        assert_eq!(DialogueMode::parse_or_default("乱写"), DialogueMode::Random);
    }
}
