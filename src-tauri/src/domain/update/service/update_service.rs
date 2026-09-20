//! 版本检查规则（领域服务）
//!
//! 版本比较是**精确字符串比较**（与历史行为一致，不做语义化版本解析）：
//! 只要远端清单里的版本号与当前编译版本不完全相同，就提示有新版本。

use crate::domain::update::model::UpdateCheckResult;

/// 当前版本是否已是最新。
pub fn is_up_to_date(current: &str, latest: &str) -> bool {
    current == latest
}

/// 组装版本检查结果。
pub fn build_result(current: &str, latest: &str) -> UpdateCheckResult {
    UpdateCheckResult {
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        up_to_date: is_up_to_date(current, latest),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_versions_are_up_to_date() {
        assert!(is_up_to_date("1.0.0", "1.0.0"));
        let result = build_result("1.0.0", "1.0.0");
        assert!(result.up_to_date);
        assert_eq!(result.current_version, "1.0.0");
        assert_eq!(result.latest_version, "1.0.0");
    }

    /// 精确比较（不做语义化解析）：前缀、尾部空白、大小写差异都视为「有新版本」。
    #[test]
    fn comparison_is_exact_string_equality() {
        assert!(!is_up_to_date("1.0.0", "1.0.1"));
        assert!(!is_up_to_date("1.0.0", "1.0"));
        assert!(!is_up_to_date("1.0.0", "1.0.0 "));
        assert!(!is_up_to_date("1.0.0", "V1.0.0"));
        // 远端返回更高版本时同样只需要「不相等」即可判定。
        let result = build_result("1.0.0", "2.0.0");
        assert!(!result.up_to_date);
        assert_eq!(result.latest_version, "2.0.0");
    }
}
