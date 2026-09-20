//! 图片组元数据 DTO
//!
//! 图片组元数据（`pic/<组名>/meta.json`），结构规范与音频组 `meta.json` 对齐。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::super::pic_asset::PicAsset;

/// 图片组元数据（`meta.json`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PicGroupMeta {
    /// 图片组名称（即子文件夹名）。
    pub name: String,
    /// 状态键 → 资源定义（按状态键排序，保证写盘结果稳定）。
    #[serde(default)]
    pub states: BTreeMap<String, PicAsset>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 磁盘格式：`name` + `states`，且状态表按 JSON 对象存储。
    #[test]
    fn meta_matches_audio_group_convention() {
        let json = r#"{"name":"元数据组","states":{"main":{"file":"main.png"}}}"#;
        let meta: PicGroupMeta = serde_json::from_str(json).unwrap();
        assert_eq!(meta.name, "元数据组");
        assert_eq!(meta.states.get("main").unwrap().file, "main.png");

        // 缺失 states 时按空表处理（历史组自愈的前提）。
        let minimal: PicGroupMeta = serde_json::from_str(r#"{"name":"历史组"}"#).unwrap();
        assert!(minimal.states.is_empty());
    }
}
