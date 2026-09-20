//! 模型目录条目（`routing.json` 的 `model_catalog`）
//!
//! Codex 的 `/model` 菜单只认它自己的模型目录，因此要让菜单里出现第三方模型名，
//! 必须把条目写进 `model_catalog_json` 指向的目录文件
//! （渲染见 `infrastructure::system::client_config::codex`）。
//!
//! 一条记录就是菜单里的一行：菜单显示名 + 实际请求模型 + 上下文窗口 + 思考档位。
//! 字段名即磁盘键名（snake_case），前端契约（camelCase）在 `api` 层转换。

use serde::{Deserialize, Serialize};

/// 模型目录中的一条记录。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelCatalogEntry {
    /// 菜单显示名（`/model` 里展示的名字）。
    pub display_name: String,
    /// 实际请求模型（真正发给供应商的模型名）。
    pub model: String,
    /// 该模型的上下文窗口（token 数；0 表示沿用目录默认窗口）。
    pub context_window: u32,
    /// 该模型声明的思考档位（空 = 不声明，沿用目录默认档位）。
    pub reasoning_levels: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 磁盘键名必须是 snake_case，且缺字段时取默认值（旧文件可读）。
    #[test]
    fn disk_format_is_snake_case_and_lenient() {
        let text = r#"{"display_name":"DeepSeek V4","model":"deepseek-chat","context_window":1048576,"reasoning_levels":["low","high"]}"#;
        let entry: ModelCatalogEntry = serde_json::from_str(text).expect("应能解析");
        assert_eq!(entry.display_name, "DeepSeek V4");
        assert_eq!(entry.model, "deepseek-chat");
        assert_eq!(entry.context_window, 1_048_576);
        assert_eq!(entry.reasoning_levels, vec!["low", "high"]);

        let minimal: ModelCatalogEntry =
            serde_json::from_str(r#"{"model":"m"}"#).expect("缺字段应取默认值");
        assert_eq!(minimal.display_name, "");
        assert_eq!(minimal.context_window, 0);
        assert!(minimal.reasoning_levels.is_empty());
    }

    /// 序列化回的键名同样必须是 snake_case（磁盘格式不跟前端字段名漂移）。
    #[test]
    fn serialization_keeps_snake_case() {
        let entry = ModelCatalogEntry {
            display_name: "显示名".to_string(),
            model: "m".to_string(),
            context_window: 128_000,
            reasoning_levels: vec!["high".to_string()],
        };
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(value["display_name"], "显示名");
        assert_eq!(value["model"], "m");
        assert_eq!(value["context_window"], 128_000);
        assert_eq!(value["reasoning_levels"][0], "high");
        assert!(value.get("displayName").is_none());
    }
}
