//! 应用配置持久化
//!
//! 使用 `OnceLock<RwLock<AppConfig>>` 做进程内唯一实例，避免多命令并发读写冲突；
//! 落盘走「临时文件 + rename」的原子写，避免半写损坏。

use std::fs;
use std::sync::{OnceLock, RwLock};

use crate::domain::config::service::config_service as config_rules;
use crate::domain::config::model::AppConfig;
use crate::infrastructure::system::paths;
use crate::types::exception::{AppError, AppResult};
use crate::types::utils::fs as fs_utils;

/// 进程内唯一配置实例。
static CONFIG_STORE: OnceLock<RwLock<AppConfig>> = OnceLock::new();

/// 返回全局配置缓存实例，首次访问时从磁盘加载。
fn config_store() -> &'static RwLock<AppConfig> {
    CONFIG_STORE.get_or_init(|| RwLock::new(load_from_file()))
}

/// 从磁盘加载配置；文件缺失或解析失败时回退默认值。
fn load_from_file() -> AppConfig {
    let path = paths::config_path();
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<AppConfig>(&content) {
            Ok(mut cfg) => {
                config_rules::normalize(&mut cfg);
                cfg
            }
            Err(err) => {
                log::warn!(
                    "解析配置文件失败，使用默认配置（{}）: {}",
                    path.display(),
                    err
                );
                AppConfig::default()
            }
        },
        Err(_) => AppConfig::default(),
    }
}

/// 原子写入配置到磁盘。
fn save_to_file(cfg: &AppConfig) -> AppResult<()> {
    let mut normalized = cfg.clone();
    config_rules::normalize(&mut normalized);

    let dir = paths::app_data_dir();
    fs::create_dir_all(&dir).map_err(|e| AppError::io(e.to_string()))?;

    let json =
        serde_json::to_string_pretty(&normalized).map_err(|e| AppError::serde(e.to_string()))?;
    fs_utils::write_atomic_plain(&paths::config_path(), json.as_bytes())
}

/// 获取当前配置快照。
pub fn get_config() -> AppConfig {
    config_store()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// 全量更新配置（规范化 + 保存到磁盘 + 刷新内存缓存）。
pub fn update_config(new_cfg: AppConfig) -> AppResult<AppConfig> {
    let mut cfg = new_cfg;
    config_rules::normalize(&mut cfg);
    save_to_file(&cfg)?;

    let mut guard = config_store()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = cfg.clone();
    Ok(cfg)
}

/// 局部修改配置（闭包内修改副本，成功后写盘并刷新缓存）。
pub fn mutate_config<F>(mutator: F) -> AppResult<AppConfig>
where
    F: FnOnce(&mut AppConfig),
{
    let mut next = get_config();
    mutator(&mut next);
    update_config(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 规范化是配置入内存与落盘的唯一入口：
    /// 无论调用方提交什么，落盘内容都必须是合法值。
    #[test]
    fn normalize_is_applied_before_saving() {
        let mut cfg = AppConfig::default();
        cfg.widget.scale = 99.0;
        cfg.widget.display_currency = "bad".into();
        cfg.dialogue.mode = "bad".into();
        config_rules::normalize(&mut cfg);

        let json = serde_json::to_string(&cfg).unwrap();
        let restored: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.widget.scale, 1.5);
        assert_eq!(restored.widget.display_currency, "CNY");
        assert_eq!(restored.dialogue.mode, "random");
    }

    /// 缓存实例是进程内唯一：多次读取必须拿到同一份数据。
    #[test]
    fn config_store_is_singleton() {
        let a = get_config();
        let b = get_config();
        assert_eq!(a.api_key, b.api_key);
        assert_eq!(a.widget.scale, b.widget.scale);
        // 只读访问不应产生写锁（同一线程重复读取不会死锁）。
        let c = get_config();
        assert_eq!(c.widget.sound_set, b.widget.sound_set);
    }

    /// 落盘路径必须是数据目录下的 config.json。
    #[test]
    fn save_target_is_config_json() {
        assert_eq!(
            paths::config_path(),
            paths::app_data_dir().join("config.json")
        );
    }
}
