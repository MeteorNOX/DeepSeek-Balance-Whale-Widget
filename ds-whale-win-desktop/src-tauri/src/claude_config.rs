//! Claude 配置落盘模块：把本应用的 base_url / api_key / 模型写入
//! `~/.claude/settings.json` 的 `env` 字段，使 Claude Code 命令行使用所配置的模型。

use std::fs;
use std::path::PathBuf;
use serde_json::{json, Value};

/// Claude Code 设置文件路径：`~/.claude/settings.json`。
fn claude_settings_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("settings.json")
}

/// 把配置写入 Claude Code settings.json（合并 env，保留其它字段如 mcpServers）。
pub fn write_claude_settings(cfg: &crate::config::AppConfig) -> Result<(), String> {
    let path = claude_settings_path();

    // 读取现有 settings.json（不存在则视为空对象）。
    let mut settings: Value = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };

    let root = settings
        .as_object_mut()
        .ok_or_else(|| "Claude settings.json 根不是对象".to_string())?;
    let env = root
        .entry("env")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "Claude settings.json env 不是对象".to_string())?;

    let primary = cfg.models.primary.name.clone();
    let haiku = cfg.models.haiku.name.clone();
    let sonnet = cfg.models.sonnet.name.clone();
    let opus = cfg.models.opus.name.clone();

    env.insert("ANTHROPIC_BASE_URL".to_string(), json!(cfg.base_url));
    env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), json!(cfg.api_key));
    env.insert("ANTHROPIC_MODEL".to_string(), json!(primary));
    env.insert("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), json!(haiku));
    env.insert("ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(), json!(sonnet));
    env.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), json!(opus));
    // Claude Code 无独立的上下文窗口字段（由模型名决定），此处按最佳努力注入自定义字段。
    env.insert("ANTHROPIC_MODEL_CONTEXT_WINDOW".to_string(), json!(cfg.models.primary.context_window));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let out = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, out).map_err(|e| e.to_string())?;
    Ok(())
}
