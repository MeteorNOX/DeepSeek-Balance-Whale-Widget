//! 版本检查结果 DTO

use serde::Serialize;

/// 版本检查结果（前端读取 currentVersion / latestVersion / upToDate）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    /// 当前应用版本。
    pub current_version: String,
    /// 远端返回的最新版本。
    pub latest_version: String,
    /// 当前版本是否已是最新。
    pub up_to_date: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端契约：字段名固定为 currentVersion / latestVersion / upToDate。
    #[test]
    fn update_result_is_wire_compatible() {
        let result = UpdateCheckResult {
            current_version: "1.0.0".to_string(),
            latest_version: "2.0.0".to_string(),
            up_to_date: false,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"currentVersion\":\"1.0.0\""), "{}", json);
        assert!(json.contains("\"latestVersion\":\"2.0.0\""), "{}", json);
        assert!(json.contains("\"upToDate\":false"), "{}", json);
    }
}
