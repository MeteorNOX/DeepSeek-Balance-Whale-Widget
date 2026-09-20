//! 挂件图片状态枚举
//!
//! 状态与内置资源、前端状态机一一对应，**顺序不可调整**。

/// 挂件图片状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WidgetState {
    /// 正常。
    Main,
    /// 生气。
    Angry,
    /// 害羞。
    Shy,
    /// 失落。
    Disappointed,
    /// 被抚摸。
    Stroking,
    /// 疲惫。
    Exhausted,
    /// 半睁眼。
    HalfOpenEyes,
    /// 闭眼。
    CloseEyes,
    /// 半闭眼。
    HalfClosedEyes,
}

impl WidgetState {
    /// 全部状态（顺序即前端状态机与资源清单顺序）。
    pub const ALL: [WidgetState; 9] = [
        WidgetState::Main,
        WidgetState::Angry,
        WidgetState::Shy,
        WidgetState::Disappointed,
        WidgetState::Stroking,
        WidgetState::Exhausted,
        WidgetState::HalfOpenEyes,
        WidgetState::CloseEyes,
        WidgetState::HalfClosedEyes,
    ];

    /// 状态键（前端 `read_widget_image` 的 state 参数）。
    pub fn key(self) -> &'static str {
        match self {
            WidgetState::Main => "main",
            WidgetState::Angry => "angry",
            WidgetState::Shy => "shy",
            WidgetState::Disappointed => "disappointed",
            WidgetState::Stroking => "stroking",
            WidgetState::Exhausted => "exhausted",
            WidgetState::HalfOpenEyes => "half_open_eyes",
            WidgetState::CloseEyes => "close_eyes",
            WidgetState::HalfClosedEyes => "half_closed_eyes",
        }
    }

    /// 状态资源文件名（组目录内）。
    pub fn file_name(self) -> &'static str {
        match self {
            WidgetState::Main => "main.png",
            WidgetState::Angry => "angry.png",
            WidgetState::Shy => "shy.png",
            WidgetState::Disappointed => "disappointed.png",
            WidgetState::Stroking => "stroking.png",
            WidgetState::Exhausted => "exhausted.png",
            WidgetState::HalfOpenEyes => "half_open_eyes.png",
            WidgetState::CloseEyes => "close_eyes.png",
            WidgetState::HalfClosedEyes => "half_closed_eyes.png",
        }
    }

    /// 由状态键解析。
    pub fn parse(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.key() == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// 图片状态：键、文件名、顺序三者都是契约。
    #[test]
    fn widget_state_keys_and_files_are_stable() {
        assert_eq!(WidgetState::ALL.len(), 9);
        assert_eq!(WidgetState::Main.key(), "main");
        assert_eq!(WidgetState::Main.file_name(), "main.png");
        assert_eq!(WidgetState::HalfClosedEyes.key(), "half_closed_eyes");
        assert_eq!(
            WidgetState::HalfClosedEyes.file_name(),
            "half_closed_eyes.png"
        );
        assert_eq!(
            WidgetState::parse("close_eyes"),
            Some(WidgetState::CloseEyes)
        );
        assert_eq!(WidgetState::parse("unknown"), None);

        // 状态键与文件名不得重复（否则磁盘资源会互相覆盖）。
        let keys: BTreeSet<&str> = WidgetState::ALL.iter().map(|s| s.key()).collect();
        let files: BTreeSet<&str> = WidgetState::ALL.iter().map(|s| s.file_name()).collect();
        assert_eq!(keys.len(), 9);
        assert_eq!(files.len(), 9);
    }
}
