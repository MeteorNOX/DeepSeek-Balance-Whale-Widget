//! OpenAI Codex 配置落盘模块：把请求地址 / API Key / 主模型写入
//! `~/.codex/config.toml` 与 `~/.codex/auth.json`，参考 cc-switch 的 to_codex_provider。

use std::fs;
use std::path::PathBuf;
use serde_json::json;

fn codex_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".codex")
}

fn codex_config_path() -> PathBuf {
    codex_dir().join("config.toml")
}

fn codex_auth_path() -> PathBuf {
    codex_dir().join("auth.json")
}

/// 把 Codex 配置写入磁盘。
pub fn write_codex_settings(cfg: &crate::config::AppConfig) -> Result<(), String> {
    let dir = codex_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let model = cfg.codex_models.primary.name.clone();
    let context_window = cfg.codex_models.primary.context_window;
    let base_url = cfg.codex_base_url.trim_end_matches('/').to_string();

    let config_toml = format!(
        "model_provider = \"custom\"\nmodel = \"{model}\"\nmodel_reasoning_effort = \"high\"\ndisable_response_storage = true\nmodel_context_window = {context_window}\n\n[model_providers.custom]\nname = \"DeepSeek\"\nbase_url = \"{base_url}\"\nwire_api = \"chat\"\nrequires_openai_auth = true\n"
    );
    fs::write(codex_config_path(), config_toml).map_err(|e| e.to_string())?;

    let auth = json!({ "OPENAI_API_KEY": cfg.api_key });
    let auth_str = serde_json::to_string_pretty(&auth).map_err(|e| e.to_string())?;
    fs::write(codex_auth_path(), auth_str).map_err(|e| e.to_string())?;

    Ok(())
}
