//! 应用顶层配置 DTO

use serde::{Deserialize, Serialize};

use super::super::defaults::*;
use super::super::dialogue_config::DialogueConfig;
use super::super::model_config::ModelConfig;
use super::super::widget_config::WidgetConfig;
use super::super::widget_position::WidgetPosition;
use crate::domain::bubble::model::entity::bubble_config::BubbleConfig;

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
    /// 令牌用量统计（实验性功能）：开启后按平台令牌向官网取逐日用量，并以其作为
    /// 用量统计与账单展示的数据来源；关闭时只按本地余额差值记账（离线口径）。
    #[serde(default)]
    pub token_usage: bool,
    /// 全局颜色（配置界面文字/按钮边框等，十六进制）。
    #[serde(default = "default_global_color")]
    pub global_color: String,
    /// 全局主题（配置界面配色：light / dark / glass，不影响桌面挂件）。
    #[serde(default = "default_global_theme")]
    pub global_theme: String,
    /// 台词管理配置。
    #[serde(default)]
    pub dialogue: DialogueConfig,
    /// 模块化气泡配置（气泡内容由用户自定义的模块组成；为空时挂件沿用内置三行）。
    ///
    /// 这是**编辑区的草稿**：随改随存，只服务于配置页的实时预览。
    #[serde(default)]
    pub bubble: BubbleConfig,
    /// 已经应用到桌面挂件的那一份气泡（点「应用」或切换气泡组时更新）。
    ///
    /// 桌面挂件只认这一份，因此编辑区里的半成品不会实时推到桌面上。
    /// 老配置没有这个字段时由规范化按 [`bubble`] 补齐，升级后桌宠显示不变。
    #[serde(default)]
    pub bubble_applied: Option<BubbleConfig>,
    /// 挂件上次保存的位置与朝向。
    #[serde(default)]
    pub widget_position: Option<WidgetPosition>,
}

impl Default for AppConfig {
    /// 返回应用完整默认配置。
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: DEFAULT_BASE_URL.to_string(),
            codex_base_url: DEFAULT_CODEX_BASE_URL.to_string(),
            models: ModelConfig::default(),
            codex_models: ModelConfig::default(),
            widget: WidgetConfig::default(),
            autostart: false,
            token_usage: false,
            global_color: DEFAULT_COLOR.to_string(),
            global_theme: DEFAULT_THEME.to_string(),
            dialogue: DialogueConfig::default(),
            bubble: BubbleConfig::default(),
            // 从未应用过任何气泡：由规范化按草稿补齐（桌宠因此沿用配置里的气泡）。
            bubble_applied: None,
            widget_position: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 顶层配置的字段名同样是前端契约，不得改名。
    #[test]
    fn app_config_serializes_camel_case() {
        let json = serde_json::to_string(&AppConfig::default()).unwrap();
        for key in [
            "\"apiKey\"",
            "\"baseUrl\"",
            "\"codexBaseUrl\"",
            "\"codexModels\"",
            "\"globalColor\"",
            "\"globalTheme\"",
            "\"tokenUsage\"",
            "\"bubbleApplied\"",
            "\"widgetPosition\"",
        ] {
            assert!(json.contains(key), "缺少字段 {}：{}", key, json);
        }
    }

    /// 缺字段的旧配置必须能读出来（全部字段带 serde 默认值）。
    #[test]
    fn partial_config_deserializes_with_defaults() {
        let cfg: AppConfig = serde_json::from_str(r#"{"apiKey":"sk-x"}"#).unwrap();
        assert_eq!(cfg.api_key, "sk-x");
        assert_eq!(cfg.base_url, DEFAULT_BASE_URL);
        assert_eq!(cfg.codex_base_url, DEFAULT_CODEX_BASE_URL);
        assert_eq!(cfg.widget.display_currency, "CNY");
        assert_eq!(cfg.dialogue.mode, "random");
        assert!(cfg.widget_position.is_none());
        assert_eq!(cfg.global_theme, DEFAULT_THEME, "旧配置缺字段时回落浅色");
        assert!(
            cfg.bubble_applied.is_none(),
            "已应用气泡缺失时保持 None，交由规范化按草稿补齐"
        );
    }

    /// 默认值即产品默认值（改动必须在评审中被看见）。
    #[test]
    fn defaults_are_stable() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.widget.scale, 1.0);
        assert_eq!(cfg.widget.vol, 0.8);
        assert_eq!(cfg.widget.sound_set, "duck");
        assert_eq!(cfg.widget.bubble_color, "#203170");
        assert_eq!(cfg.global_theme, "light", "默认主题为浅色");
        assert_eq!(cfg.widget.blink_interval_min_sec, 4);
        assert_eq!(cfg.widget.blink_interval_max_sec, 6);
        assert_eq!(cfg.widget.peak_warn_minutes, 9);
        assert_eq!(cfg.widget.widget_body, "小鲸鱼");
        assert!(cfg.widget_position.is_none());
        assert_eq!(cfg.dialogue.interval_min, 5);
        assert_eq!(cfg.dialogue.jitter, 0);
        assert!(!cfg.dialogue.lines.is_empty());
        assert!(!cfg.token_usage, "令牌用量统计是实验性功能，默认关闭");
        assert_eq!(WidgetPosition::default().h, "right");
    }
}
