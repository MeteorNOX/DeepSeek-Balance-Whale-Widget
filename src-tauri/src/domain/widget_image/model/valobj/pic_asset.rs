//! 状态资源条目 DTO

use serde::{Deserialize, Serialize};

/// 单个状态资源条目。
///
/// 与音频组元数据中片段对象的 `file` 字段规范一致：
/// 统一以相对组目录的文件名记录资源位置，便于整体迁移与校验。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PicAsset {
    /// 状态资源文件名（相对图片组目录，如 `main.png`）。
    pub file: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_round_trips() {
        let asset = PicAsset {
            file: "main.png".to_string(),
        };
        let json = serde_json::to_string(&asset).unwrap();
        assert!(json.contains("\"file\":\"main.png\""), "{}", json);
        assert_eq!(serde_json::from_str::<PicAsset>(&json).unwrap(), asset);
    }
}
