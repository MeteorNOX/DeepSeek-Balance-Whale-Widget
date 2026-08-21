//! 配置持久化模块
//!
//! 职责单一：负责应用配置（API Key、请求地址、模型、挂件显示、开机自启）的
//! 加载、内存缓存与原子写盘。借鉴 cc-switch 的 `settings.rs` 模式，使用
//! `OnceLock<RwLock<AppConfig>>` 做进程内唯一实例，避免多命令并发读写冲突。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

/// DeepSeek 官方 API 默认根地址（可被用户自定义覆盖）。
const DEFAULT_BASE_URL: &str = "https://api.deepseek.com/anthropic";

/// OpenAI Codex 默认根地址（可被用户自定义覆盖）。
const DEFAULT_CODEX_BASE_URL: &str = "https://api.deepseek.com";

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/// 单个模型系列的配置：模型名称 + 上下文窗口大小。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// 模型名称（用户可自定义，如 `deepseek-chat`）。
    pub name: String,
    /// 上下文窗口大小（token 数）。
    pub context_window: u32,
}

impl ModelEntry {
    fn new(name: &str, context_window: u32) -> Self {
        Self {
            name: name.to_string(),
            context_window,
        }
    }
}

/// Haiku / Sonnet / Opus 三个系列的默认调用模型配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    /// 主模型（默认调用模型，映射 ANTHROPIC_MODEL / Codex model）。
    pub primary: ModelEntry,
    /// 快速轻量档（Haiku）。
    pub haiku: ModelEntry,
    /// 均衡档（Sonnet）。
    pub sonnet: ModelEntry,
    /// 旗舰推理档（Opus）。
    pub opus: ModelEntry,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            primary: ModelEntry::new("deepseek-v4-flash", 1_000_000),
            haiku: ModelEntry::new("deepseek-v4-flash", 1_000_000),
            sonnet: ModelEntry::new("deepseek-v4-flash", 1_000_000),
            opus: ModelEntry::new("deepseek-v4-flash", 1_000_000),
        }
    }
}

/// 挂件显示配置（与旧 DSH 插件的 `.dshw-size.json` 一一对应）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetConfig {
    /// 尺寸倍率 0.6–2.5。
    pub scale: f64,
    /// 是否开启音效。
    pub sound: bool,
    /// 音量 0.0–1.0。
    pub vol: f64,
    /// 音效组：`duck`（小黄鸭）/ `fx1`（音效1）或自定义音频文件路径。
    pub sound_set: String,
    /// 自定义音效文件路径列表。
    #[serde(default)]
    pub custom_sounds: Vec<String>,
    /// 气泡颜色（十六进制，如 `#203170`）。
    #[serde(default = "default_bubble_color")]
    pub bubble_color: String,
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            scale: 1.0,
            sound: true,
            vol: 0.8,
            sound_set: "duck".to_string(),
            custom_sounds: Vec::new(),
            bubble_color: "#203170".to_string(),
        }
    }
}

/// 台词管理配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogueConfig {
    /// 台词列表。
    #[serde(default = "default_dialogue_lines")]
    pub lines: Vec<String>,
    /// 播放模式：`carousel`（轮播）/ `random`（随机）。
    #[serde(default = "default_dialogue_mode")]
    pub mode: String,
    /// 每句台词基础间隔（分钟）。
    #[serde(default = "default_dialogue_interval")]
    pub interval_min: u32,
    /// 波动幅度（0–100，步长 1%）。
    #[serde(default)]
    pub jitter: u32,
}

impl Default for DialogueConfig {
    fn default() -> Self {
        Self {
            lines: default_dialogue_lines(),
            mode: default_dialogue_mode(),
            interval_min: default_dialogue_interval(),
            jitter: 0,
        }
    }
}

fn default_dialogue_lines() -> Vec<String> {
    vec![
        "喵~主人又忘记喂我啦！".to_string(),
        "哼，摸头要收费的哦！".to_string(),
        "尾巴不是给你拽的啦！".to_string(),
        "罐头呢？我闻到了！".to_string(),
        "抱抱可以，但先给小鱼干~".to_string(),
        "喵喵喵？你居然不理我？".to_string(),
        "毛线球不是用来玩的吗？".to_string(),
        "太阳晒够了，该撸我了~".to_string(),
        "窗外的鸟好吵，还是主人好~".to_string(),
        "喵~不许看别的鲸！".to_string(),
    ]
}

fn default_dialogue_mode() -> String {
    "random".to_string()
}

fn default_dialogue_interval() -> u32 {
    5
}

/// 应用顶层配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// DeepSeek API Key（用于官方余额接口）。
    #[serde(default)]
    pub api_key: String,
    /// Claude（Anthropic）请求根地址。
    #[serde(default = "default_base_url")]
    pub base_url: String,
    /// OpenAI Codex 请求根地址。
    #[serde(default = "default_codex_base_url")]
    pub codex_base_url: String,
    /// Claude 模型配置。
    #[serde(default)]
    pub models: ModelConfig,
    /// OpenAI Codex 模型配置。
    #[serde(default)]
    pub codex_models: ModelConfig,
    /// 挂件显示配置。
    #[serde(default)]
    pub widget: WidgetConfig,
    /// 是否开机自启。
    #[serde(default)]
    pub autostart: bool,
    /// 全局颜色（配置界面文字/按钮边框等，十六进制）。
    #[serde(default = "default_global_color")]
    pub global_color: String,
    /// 台词管理配置。
    #[serde(default)]
    pub dialogue: DialogueConfig,
}

fn default_base_url() -> String {
    DEFAULT_BASE_URL.to_string()
}

fn default_codex_base_url() -> String {
    DEFAULT_CODEX_BASE_URL.to_string()
}

fn default_bubble_color() -> String {
    "#203170".to_string()
}

fn default_global_color() -> String {
    "#203170".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: DEFAULT_BASE_URL.to_string(),
            codex_base_url: DEFAULT_CODEX_BASE_URL.to_string(),
            models: ModelConfig::default(),
            codex_models: ModelConfig::default(),
            widget: WidgetConfig::default(),
            autostart: false,
            global_color: "#203170".to_string(),
            dialogue: DialogueConfig::default(),
        }
    }
}

impl AppConfig {
    /// 规范化字段：去除首尾空白；空地址回落默认值；非法倍率/音量钳制到合法区间。
    pub fn normalize(&mut self) {
        self.api_key = self.api_key.trim().to_string();

        let base = self.base_url.trim().trim_end_matches('/').to_string();
        self.base_url = if base.is_empty() {
            DEFAULT_BASE_URL.to_string()
        } else {
            base
        };

        let codex_base = self.codex_base_url.trim().trim_end_matches('/').to_string();
        self.codex_base_url = if codex_base.is_empty() {
            DEFAULT_CODEX_BASE_URL.to_string()
        } else {
            codex_base
        };

        for entry in [
            &mut self.models.primary,
            &mut self.models.haiku,
            &mut self.models.sonnet,
            &mut self.models.opus,
            &mut self.codex_models.primary,
            &mut self.codex_models.haiku,
            &mut self.codex_models.sonnet,
            &mut self.codex_models.opus,
        ] {
            entry.name = entry.name.trim().to_string();
        }

        if self.global_color.trim().is_empty() {
            self.global_color = "#203170".to_string();
        } else {
            self.global_color = self.global_color.trim().to_string();
        }
        if self.widget.bubble_color.trim().is_empty() {
            self.widget.bubble_color = "#203170".to_string();
        } else {
            self.widget.bubble_color = self.widget.bubble_color.trim().to_string();
        }
        self.widget.custom_sounds.retain(|s| !s.trim().is_empty());

        let w = &mut self.widget;
        if !(0.6..=2.5).contains(&w.scale) {
            w.scale = 1.5;
        }
        if !(0.0..=1.0).contains(&w.vol) {
            w.vol = 0.9;
        }
        w.sound = w.sound || w.vol > 0.0;
        let is_preset = w.sound_set == "duck" || w.sound_set == "fx1";
        let is_custom = !w.sound_set.is_empty()
            && w.custom_sounds.iter().any(|s| s == &w.sound_set);
        if !is_preset && !is_custom {
            w.sound_set = "duck".to_string();
        }

        // 台词：过滤空行，校验播放模式，钳制间隔与波动幅度。
        self.dialogue.lines.retain(|s| !s.trim().is_empty());
        if self.dialogue.mode != "carousel" && self.dialogue.mode != "random" {
            self.dialogue.mode = "random".to_string();
        }
        if self.dialogue.interval_min < 1 {
            self.dialogue.interval_min = 1;
        }
        if self.dialogue.jitter > 100 {
            self.dialogue.jitter = 100;
        }
    }
}

// ---------------------------------------------------------------------------
// 持久化存储
// ---------------------------------------------------------------------------

/// 应用数据目录：`<config_dir>/DS Desktop Whale`（Windows 为 `%APPDATA%/DS Desktop Whale`）。
pub fn app_data_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("DS Desktop Whale")
}

/// 配置文件路径。
fn config_path() -> PathBuf {
    app_data_dir().join("config.json")
}

/// 账本文件路径（小鲸鱼记账数据）。
pub fn ledger_path() -> PathBuf {
    app_data_dir().join("usage.json")
}

/// 进程内唯一配置实例。
static CONFIG_STORE: OnceLock<RwLock<AppConfig>> = OnceLock::new();

fn config_store() -> &'static RwLock<AppConfig> {
    CONFIG_STORE.get_or_init(|| RwLock::new(load_from_file()))
}

/// 从磁盘加载配置；文件缺失或解析失败时回退默认值。
fn load_from_file() -> AppConfig {
    let path = config_path();
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<AppConfig>(&content) {
            Ok(mut cfg) => {
                cfg.normalize();
                cfg
            }
            Err(err) => {
                log::warn!("解析配置文件失败，使用默认配置（{}）: {}", path.display(), err);
                AppConfig::default()
            }
        },
        Err(_) => AppConfig::default(),
    }
}

/// 原子写入配置到磁盘（先写临时文件再替换，避免半写损坏）。
fn save_to_file(cfg: &AppConfig) -> Result<(), String> {
    let mut normalized = cfg.clone();
    normalized.normalize();

    let dir = app_data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let path = config_path();
    let json = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;

    // 原子写：临时文件 + rename。
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取当前配置快照。
pub fn get_config() -> AppConfig {
    config_store()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// 全量更新配置（保存到磁盘并刷新内存缓存）。
pub fn update_config(new_cfg: AppConfig) -> Result<AppConfig, String> {
    let mut cfg = new_cfg;
    cfg.normalize();
    save_to_file(&cfg)?;

    let mut guard = config_store()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = cfg.clone();
    Ok(cfg)
}

/// 局部修改配置（闭包内修改副本，成功后写盘并刷新缓存）。
pub fn mutate_config<F>(mutator: F) -> Result<AppConfig, String>
where
    F: FnOnce(&mut AppConfig),
{
    let current = get_config();
    let mut next = current;
    mutator(&mut next);
    update_config(next)
}
