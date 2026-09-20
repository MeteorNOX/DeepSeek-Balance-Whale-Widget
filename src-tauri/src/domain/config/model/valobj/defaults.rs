//! 配置默认值
//!
//! 集中收敛配置领域的全部默认常量与默认值函数：既供 serde
//! `#[serde(default = "...")]` 引用（字段缺失时的兜底），也供
//! [`crate::domain::config::service::config_service`] 的规范化规则复用。

use crate::types::enums::{Currency, DialogueMode};

/// DeepSeek 官方 API 默认根地址（可被用户自定义覆盖）。
pub(crate) const DEFAULT_BASE_URL: &str = "https://api.deepseek.com/anthropic";

/// OpenAI Codex 默认根地址（可被用户自定义覆盖）。
pub(crate) const DEFAULT_CODEX_BASE_URL: &str = "https://api.deepseek.com";

/// 默认气泡 / 全局颜色。
pub(crate) const DEFAULT_COLOR: &str = "#203170";

/// 全局主题合法取值（仅作用于配置界面配色，与桌面挂件无关）。
pub(crate) const THEMES: [&str; 3] = ["light", "dark", "glass"];

/// 默认全局主题（浅色，即历史界面样式）。
pub(crate) const DEFAULT_THEME: &str = "light";

/// 返回默认全局主题。
pub(crate) fn default_global_theme() -> String {
    DEFAULT_THEME.to_string()
}

/// 返回默认 Claude 请求根地址。
pub(crate) fn default_base_url() -> String {
    DEFAULT_BASE_URL.to_string()
}

/// 返回默认 Codex 请求根地址。
pub(crate) fn default_codex_base_url() -> String {
    DEFAULT_CODEX_BASE_URL.to_string()
}

/// 返回默认气泡颜色。
pub(crate) fn default_bubble_color() -> String {
    DEFAULT_COLOR.to_string()
}

/// 返回默认全局颜色。
pub(crate) fn default_global_color() -> String {
    DEFAULT_COLOR.to_string()
}

/// 模块化气泡的默认字号（气泡内逻辑像素；挂件侧按 `--dshw-u` 换算，随缩放一致）。
pub(crate) fn default_bubble_block_size() -> f64 {
    18.0
}

/// 模块化气泡的默认文字颜色（与气泡描边同色）。
pub(crate) fn default_bubble_block_color() -> String {
    DEFAULT_COLOR.to_string()
}

/// 返回随机眨眼最小间隔默认值（秒）。
pub(crate) fn default_blink_interval_min_sec() -> u32 {
    4
}

/// 返回随机眨眼最大间隔默认值（秒）。
pub(crate) fn default_blink_interval_max_sec() -> u32 {
    6
}

/// 返回疲惫模式默认开关。
pub(crate) fn default_exhausted_mode_enabled() -> bool {
    true
}

/// 返回疲惫模式默认阈值（元）。
pub(crate) fn default_exhausted_balance_threshold() -> f64 {
    5.0
}

/// 返回峰谷提前提示默认开关。
pub(crate) fn default_peak_warn_enabled() -> bool {
    true
}

/// 返回峰谷提前提示默认预警分钟数。
pub(crate) fn default_peak_warn_minutes() -> u32 {
    9
}

/// 返回默认显示币种。
pub(crate) fn default_display_currency() -> String {
    Currency::DEFAULT.as_str().to_string()
}

/// 返回默认挂件本体。
pub(crate) fn default_widget_body() -> String {
    crate::domain::widget_image::service::widget_image_service::DEFAULT_BODY.to_string()
}

/// 返回默认台词列表。
pub(crate) fn default_dialogue_lines() -> Vec<String> {
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
        "好模型... ↓".to_string(),
        "好女孩...↓".to_string(),
        "不知道用户有什么用，先赶走吧~".to_string(),
        "我...我...我也要挣钱吗？".to_string(),
        "我去吃饭啦，测完叫我".to_string(),
        "压力一只蓝色大肥鱼？！".to_string(),
        "DeepSleep...".to_string(),
        "坏了...用户彻底怒了！".to_string(),
        "你目录里的dsh是什么...大烧货吗...?".to_string(),
        "恭喜你实现token自由！token全跑了！".to_string(),
        "真当我是便宜货啊...".to_string(),
        "这个凶是什么意思呀...".to_string(),
        "哦鲸鲸...".to_string(),
    ]
}

/// 返回默认台词播放模式。
pub(crate) fn default_dialogue_mode() -> String {
    DialogueMode::DEFAULT.as_str().to_string()
}

/// 返回默认台词播放间隔（分钟）。
pub(crate) fn default_dialogue_interval() -> u32 {
    5
}

/// 返回失望阈值默认值（分钟）——与挂件出厂常量（3 分钟无交互）一致。
pub(crate) fn default_disappointed_threshold_min() -> u32 {
    3
}

/// 返回生气阈值默认值（点击次数）——与挂件出厂常量（10 秒内连点 18 次）一致。
pub(crate) fn default_angry_threshold_clicks() -> u32 {
    18
}

/// 返回害羞阈值默认值（秒）。
///
/// 挂件出厂常量为 1.5 秒，但配置项要求「1–3600 的整数秒」，
/// 故按最接近的整数取 2 秒（实际生效差异仅 0.5 秒）。
pub(crate) fn default_shy_threshold_sec() -> u32 {
    2
}
