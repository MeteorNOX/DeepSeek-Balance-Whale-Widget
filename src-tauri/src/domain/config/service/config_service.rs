//! 配置规范化（领域规则）
//!
//! 规范化是配置的唯一可信入口：所有落盘与读盘路径都会先经过它，
//! 因此它同时承担「旧数据迁移」与「非法值兜底」两件事。
//!
//! 这里只做**纯计算**，不涉及任何文件读写（读写见
//! `infrastructure::repository::config::config_store`）。

use crate::domain::bubble::model::entity::bubble_config::{
    BubbleConfig, BLOCK_KINDS, DEFAULT_BUBBLE_GROUP, MAX_BUBBLE_GROUP_NAME_LEN,
};
use crate::domain::config::model::{
    default_blink_interval_max_sec, default_blink_interval_min_sec, default_bubble_block_size,
    default_exhausted_balance_threshold, AppConfig, WidgetConfig, DEFAULT_BASE_URL,
    DEFAULT_CODEX_BASE_URL, DEFAULT_COLOR, DEFAULT_THEME, THEMES,
};
use crate::domain::widget_image::service::widget_image_service as widget_rules;
use crate::types::enums::{Currency, DialogueMode, HorizontalAnchor, VerticalAnchor};
use crate::types::exception::{AppError, AppResult};

/// 失望阈值上限（分钟）：24 小时。
pub const MAX_DISAPPOINTED_THRESHOLD_MIN: u32 = 1440;
/// 生气阈值上限（鼠标点击次数）。
pub const MAX_ANGRY_THRESHOLD_CLICKS: u32 = 100;
/// 害羞阈值上限（秒）：1 小时。
pub const MAX_SHY_THRESHOLD_SEC: u32 = 3600;

/// 规范化整份配置：去除首尾空白、空地址回落默认值、非法值钳制到合法区间。
pub fn normalize(config: &mut AppConfig) {
    config.api_key = config.api_key.trim().to_string();

    let base = config.base_url.trim().trim_end_matches('/').to_string();
    config.base_url = if base.is_empty() {
        DEFAULT_BASE_URL.to_string()
    } else {
        base
    };

    let codex_base = config
        .codex_base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    config.codex_base_url = if codex_base.is_empty() {
        DEFAULT_CODEX_BASE_URL.to_string()
    } else {
        codex_base
    };

    for entry in [
        &mut config.models.primary,
        &mut config.models.haiku,
        &mut config.models.sonnet,
        &mut config.models.opus,
        &mut config.codex_models.primary,
        &mut config.codex_models.haiku,
        &mut config.codex_models.sonnet,
        &mut config.codex_models.opus,
    ] {
        entry.name = entry.name.trim().to_string();
    }

    config.global_color = normalize_color(&config.global_color);
    config.global_theme = normalize_theme(&config.global_theme);
    normalize_widget(&mut config.widget);

    // 台词：过滤空行，校验播放模式，钳制间隔与波动幅度。
    config.dialogue.lines.retain(|s| !s.trim().is_empty());
    config.dialogue.mode = DialogueMode::parse_or_default(&config.dialogue.mode)
        .as_str()
        .to_string();
    if config.dialogue.interval_min < 1 {
        config.dialogue.interval_min = 1;
    }
    if config.dialogue.jitter > 100 {
        config.dialogue.jitter = 100;
    }

    normalize_bubble(&mut config.bubble);

    // 已应用的气泡：老配置（或从未应用过）里没有这一份，按草稿补齐
    // ——升级后桌面挂件显示的内容与升级前完全一致。
    if config.bubble_applied.is_none() {
        config.bubble_applied = Some(config.bubble.clone());
    }
    if let Some(applied) = config.bubble_applied.as_mut() {
        normalize_bubble(applied);
    }

    normalize_widget_position(config);
}

/// 模块化气泡的取值区间（与前端滑块一致，越界值一律钳制）。
pub const MIN_BUBBLE_FONT_SIZE: f64 = 10.0;
/// 字号上限。
pub const MAX_BUBBLE_FONT_SIZE: f64 = 40.0;
/// 图片宽度下限（逻辑像素）。
pub const MIN_BUBBLE_MEDIA_WIDTH: f64 = 50.0;
/// 图片宽度上限（逻辑像素）。
pub const MAX_BUBBLE_MEDIA_WIDTH: f64 = 300.0;

/// 规范化模块化气泡：丢掉空行 / 未知模块，钳制尺寸，清理颜色与文件名。
///
/// 空行与未知模块没有可渲染的内容，留着只会在气泡里留下一片空白，
/// 因此直接删除；文件名只保留纯文件名，杜绝 `../` 之类的越权读取。
pub(crate) fn normalize_bubble(bubble: &mut BubbleConfig) {
    // 组名是目录名：非法值一律回落到默认组，绝不让脏值渗到文件系统。
    bubble.current_group = match sanitize_group_name(&bubble.current_group) {
        Ok(name) => name,
        Err(_) => DEFAULT_BUBBLE_GROUP.to_string(),
    };
    bubble.rows.retain_mut(|row| {
        row.blocks.retain_mut(|block| {
            block.kind = block.kind.trim().to_ascii_lowercase();
            if !BLOCK_KINDS.contains(&block.kind.as_str()) {
                return false;
            }
            block.id = block.id.trim().to_string();
            block.text = block.text.trim_end().to_string();
            block.link_name = block.link_name.trim().to_string();
            block.link_url = block.link_url.trim().to_string();
            block.supplier = block.supplier.trim().to_string();
            block.media = sanitize_file_name(&block.media);
            block.font_family = sanitize_file_name(&block.font_family);
            block.color = normalize_color(&block.color);
            block.background_color = normalize_color(&block.background_color);
            if !(MIN_BUBBLE_FONT_SIZE..=MAX_BUBBLE_FONT_SIZE).contains(&block.font_size) {
                block.font_size = default_bubble_block_size();
            }
            if !(MIN_BUBBLE_MEDIA_WIDTH..=MAX_BUBBLE_MEDIA_WIDTH).contains(&block.media_width) {
                block.media_width = 120.0;
            }
            true
        });
        !row.blocks.is_empty()
    });
}

/// 规范化气泡组名（同时用于目录名）：去空白、限长、挡住目录分隔符。
///
/// 与音效组名同一套规则（`domain::audio::service::audio_service::sanitize_group`）：
/// 组名既是下拉里的展示文本，也是 `bubble/<组名>/` 的目录名。
pub fn sanitize_group_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid("气泡组名称不能为空"));
    }
    if trimmed.chars().count() > MAX_BUBBLE_GROUP_NAME_LEN {
        return Err(AppError::invalid(format!(
            "气泡组名称过长（上限 {} 个字符）",
            MAX_BUBBLE_GROUP_NAME_LEN
        )));
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed == "."
        || trimmed == ".."
    {
        return Err(AppError::invalid("气泡组名称包含非法字符"));
    }
    Ok(trimmed.to_string())
}

/// 只保留纯文件名（去掉任何目录成分），空值原样返回。
fn sanitize_file_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    std::path::Path::new(trimmed)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

/// 规范化挂件显示配置。
fn normalize_widget(widget: &mut WidgetConfig) {
    widget.bubble_color = normalize_color(&widget.bubble_color);

    if !(0.6..=2.5).contains(&widget.scale) {
        widget.scale = 1.5;
    }
    if !(0.0..=1.0).contains(&widget.vol) {
        widget.vol = 0.9;
    }
    widget.sound = widget.sound || widget.vol > 0.0;

    // 音效组：预设直接放行；自定义组按目录命名规则校验，非法则回落预设。
    // 旧版预设 id `fx1` 已更名为 `dingdong`（叮咚），这里统一迁移，
    // 避免升级后用户的音效选择被回落到小黄鸭。
    let mut sound_set = widget.sound_set.trim().to_string();
    if sound_set == "fx1" {
        sound_set = "dingdong".to_string();
    }
    widget.sound_set = if crate::domain::audio::service::audio_service::is_preset(&sound_set) {
        sound_set
    } else {
        crate::domain::audio::service::audio_service::sanitize_group(&sound_set)
            .unwrap_or_else(|_| "duck".to_string())
    };

    if widget.blink_interval_min_sec < 1 {
        widget.blink_interval_min_sec = default_blink_interval_min_sec();
    }
    if widget.blink_interval_max_sec < 1 {
        widget.blink_interval_max_sec = default_blink_interval_max_sec();
    }
    if widget.blink_interval_max_sec < widget.blink_interval_min_sec {
        widget.blink_interval_max_sec = widget.blink_interval_min_sec;
    }
    if !widget.exhausted_balance_threshold.is_finite() || widget.exhausted_balance_threshold < 0.0 {
        widget.exhausted_balance_threshold = default_exhausted_balance_threshold();
    }
    if widget.peak_warn_minutes < 1 {
        widget.peak_warn_minutes = 1;
    }
    // 表情阈值：限定在各自区间内（越界钳制到边界，0 视为最小值 1）。
    widget.disappointed_threshold_min = widget
        .disappointed_threshold_min
        .clamp(1, MAX_DISAPPOINTED_THRESHOLD_MIN);
    widget.angry_threshold_clicks = widget
        .angry_threshold_clicks
        .clamp(1, MAX_ANGRY_THRESHOLD_CLICKS);
    widget.shy_threshold_sec = widget.shy_threshold_sec.clamp(1, MAX_SHY_THRESHOLD_SEC);
    if !(0.0..1.0).contains(&widget.snap_distance) {
        widget.snap_distance = 0.0;
    }
    widget.display_currency = Currency::parse_or_default(&widget.display_currency)
        .as_str()
        .to_string();
    widget.widget_body = widget.widget_body.trim().to_string();
    if widget.widget_body.is_empty() {
        widget.widget_body = widget_rules::DEFAULT_BODY.to_string();
    }
}

/// 规范化挂件位置：坐标必须有限，朝向必须合法。
fn normalize_widget_position(config: &mut AppConfig) {
    let Some(position) = &mut config.widget_position else {
        return;
    };
    if !position.x.is_finite() || !position.y.is_finite() {
        config.widget_position = None;
        return;
    }
    position.h = position.h.trim().to_string();
    match HorizontalAnchor::parse(&position.h) {
        Some(anchor) => position.h = anchor.as_str().to_string(),
        None => position.h = HorizontalAnchor::DEFAULT.as_str().to_string(),
    }
    position.v = position.v.trim().to_string();
    match VerticalAnchor::parse(&position.v) {
        Some(anchor) => position.v = anchor.as_str().to_string(),
        None => position.v = VerticalAnchor::DEFAULT.as_str().to_string(),
    }
}

/// 颜色规范化：空值回落默认色，否则去空白。
fn normalize_color(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        DEFAULT_COLOR.to_string()
    } else {
        trimmed.to_string()
    }
}

/// 主题规范化：只放行 light / dark / glass，其余（含空值）回落浅色。
fn normalize_theme(value: &str) -> String {
    let trimmed = value.trim();
    if THEMES.contains(&trimmed) {
        trimmed.to_string()
    } else {
        DEFAULT_THEME.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::config::model::{WidgetPosition, DEFAULT_CODEX_BASE_URL};

    /// 旧版预设 id `fx1` 已更名为 `dingdong`（叮咚）：
    /// 老配置文件必须被迁移，而不是回落为小黄鸭。
    #[test]
    fn sound_set_migrates_legacy_fx1_preset_to_dingdong() {
        let mut legacy = AppConfig::default();
        legacy.widget.sound_set = "fx1".to_string();
        normalize(&mut legacy);
        assert_eq!(legacy.widget.sound_set, "dingdong");

        // 新预设 id 与小黄鸭均直接放行。
        for preset in ["dingdong", "duck"] {
            let mut cfg = AppConfig::default();
            cfg.widget.sound_set = preset.to_string();
            normalize(&mut cfg);
            assert_eq!(cfg.widget.sound_set, preset);
        }
    }

    /// 非法音效组名回落预设，合法自定义组名保留。
    #[test]
    fn sound_set_falls_back_for_illegal_group_name() {
        let mut cfg = AppConfig::default();
        cfg.widget.sound_set = "a/b".to_string();
        normalize(&mut cfg);
        assert_eq!(cfg.widget.sound_set, "duck");

        let mut ok = AppConfig::default();
        ok.widget.sound_set = "  我的音效 ".to_string();
        normalize(&mut ok);
        assert_eq!(ok.widget.sound_set, "我的音效");
    }

    /// 币种：非法值回落 CNY，合法值保留。
    #[test]
    fn display_currency_is_validated() {
        let mut cfg = AppConfig::default();
        cfg.widget.display_currency = "USD".to_string();
        normalize(&mut cfg);
        assert_eq!(cfg.widget.display_currency, "USD");

        cfg.widget.display_currency = "xyz".to_string();
        normalize(&mut cfg);
        assert_eq!(cfg.widget.display_currency, "CNY");
    }

    /// 台词模式：仅 carousel / random 合法；空行被过滤；数值被钳制。
    #[test]
    fn dialogue_mode_is_validated_and_lines_are_filtered() {
        let mut cfg = AppConfig::default();
        cfg.dialogue.mode = "carousel".to_string();
        cfg.dialogue.lines = vec!["甲".into(), "   ".into(), "乙".into()];
        cfg.dialogue.interval_min = 0;
        cfg.dialogue.jitter = 250;
        normalize(&mut cfg);
        assert_eq!(cfg.dialogue.mode, "carousel");
        assert_eq!(cfg.dialogue.lines, vec!["甲".to_string(), "乙".to_string()]);
        assert_eq!(cfg.dialogue.interval_min, 1);
        assert_eq!(cfg.dialogue.jitter, 100);

        cfg.dialogue.mode = "乱写".to_string();
        normalize(&mut cfg);
        assert_eq!(cfg.dialogue.mode, "random");
    }

    /// 数值边界：倍率 / 音量 / 吸附比例 / 预警分钟。
    #[test]
    fn numeric_fields_are_clamped() {
        let mut cfg = AppConfig::default();
        cfg.widget.scale = 99.0;
        cfg.widget.vol = -1.0;
        cfg.widget.snap_distance = 1.0;
        cfg.widget.peak_warn_minutes = 0;
        cfg.widget.blink_interval_min_sec = 0;
        cfg.widget.blink_interval_max_sec = 0;
        normalize(&mut cfg);
        assert_eq!(cfg.widget.scale, 1.5);
        assert_eq!(cfg.widget.vol, 0.9);
        assert_eq!(cfg.widget.snap_distance, 0.0, "1.0 为开区间上界，应回落 0");
        assert_eq!(cfg.widget.peak_warn_minutes, 1);
        assert_eq!(cfg.widget.blink_interval_min_sec, 4);
        assert_eq!(cfg.widget.blink_interval_max_sec, 6);
    }

    /// 眨眼上下限倒挂时收敛到下限。
    #[test]
    fn blink_interval_range_is_ordered() {
        let mut cfg = AppConfig::default();
        cfg.widget.blink_interval_min_sec = 8;
        cfg.widget.blink_interval_max_sec = 3;
        normalize(&mut cfg);
        assert_eq!(cfg.widget.blink_interval_max_sec, 8);
    }

    /// 挂件位置：非法锚点兜底为默认值，非法坐标整条丢弃。
    #[test]
    fn widget_position_is_normalized() {
        let mut cfg = AppConfig {
            widget_position: Some(WidgetPosition {
                x: 12.5,
                y: 8.0,
                h: "  left ".to_string(),
                v: "  top ".to_string(),
            }),
            ..AppConfig::default()
        };
        normalize(&mut cfg);
        let position = cfg.widget_position.as_ref().unwrap();
        assert_eq!(position.h, "left");
        assert_eq!(position.v, "top", "顶部吸附必须被保留（重启后仍贴顶）");
        assert_eq!(position.x, 12.5);

        cfg.widget_position = Some(WidgetPosition {
            x: 1.0,
            y: 1.0,
            h: "middle".to_string(),
            v: "middle".to_string(),
        });
        normalize(&mut cfg);
        let position = cfg.widget_position.as_ref().unwrap();
        assert_eq!(position.h, "right");
        assert_eq!(position.v, "none", "非法垂直锚点回落默认（贴窗口下沿）");

        cfg.widget_position = Some(WidgetPosition {
            x: f64::NAN,
            y: 1.0,
            h: "left".to_string(),
            v: "top".to_string(),
        });
        normalize(&mut cfg);
        assert!(cfg.widget_position.is_none(), "非法坐标应整条丢弃");
    }

    /// 老配置（`widgetPosition` 里没有 `v`）必须能读出来，并按默认锚定处理。
    #[test]
    fn legacy_widget_position_without_vertical_anchor() {
        let mut cfg: AppConfig =
            serde_json::from_str(r#"{"widgetPosition":{"x":10,"y":20,"h":"left"}}"#).unwrap();
        assert_eq!(cfg.widget_position.as_ref().unwrap().v, "none");
        normalize(&mut cfg);
        assert_eq!(cfg.widget_position.as_ref().unwrap().v, "none");
    }

    /// 地址：空值回落默认，尾部斜杠被裁剪。
    #[test]
    fn base_urls_are_normalized() {
        let mut cfg = AppConfig {
            base_url: "  https://api.deepseek.com/anthropic/  ".to_string(),
            codex_base_url: "   ".to_string(),
            ..AppConfig::default()
        };
        normalize(&mut cfg);
        assert_eq!(cfg.base_url, "https://api.deepseek.com/anthropic");
        assert_eq!(cfg.codex_base_url, DEFAULT_CODEX_BASE_URL);
    }

    /// 主题：仅三种合法取值；空值与非法值均回落浅色。
    #[test]
    fn theme_falls_back_to_light() {
        for theme in ["light", "dark", "glass"] {
            let mut cfg = AppConfig {
                global_theme: format!(" {} ", theme),
                ..AppConfig::default()
            };
            normalize(&mut cfg);
            assert_eq!(cfg.global_theme, theme);
        }

        let mut blank = AppConfig {
            global_theme: "  ".to_string(),
            ..AppConfig::default()
        };
        normalize(&mut blank);
        assert_eq!(blank.global_theme, "light");

        let mut illegal = AppConfig {
            global_theme: "霓虹".to_string(),
            ..AppConfig::default()
        };
        normalize(&mut illegal);
        assert_eq!(illegal.global_theme, "light");
    }

    /// 颜色：空值回落默认色。
    #[test]
    fn colors_fall_back_when_blank() {
        let mut cfg = AppConfig {
            global_color: "   ".to_string(),
            ..AppConfig::default()
        };
        cfg.widget.bubble_color = "  #abcdef ".to_string();
        normalize(&mut cfg);
        assert_eq!(cfg.global_color, "#203170");
        assert_eq!(cfg.widget.bubble_color, "#abcdef");
    }

    /// 音量大于 0 时自动保持音效开启（历史行为）。
    #[test]
    fn sound_flag_follows_volume() {
        let mut cfg = AppConfig::default();
        cfg.widget.sound = false;
        cfg.widget.vol = 0.5;
        normalize(&mut cfg);
        assert!(cfg.widget.sound, "有音量时应自动开启音效");
    }

    /// 规范化必须幂等：重复执行不应产生新的变化。
    #[test]
    fn normalize_is_idempotent() {
        let mut cfg = AppConfig::default();
        cfg.widget.scale = 99.0;
        cfg.dialogue.mode = "乱写".to_string();
        normalize(&mut cfg);
        let once = serde_json::to_string(&cfg).unwrap();
        normalize(&mut cfg);
        assert_eq!(once, serde_json::to_string(&cfg).unwrap());
    }

    /// 表情阈值区间：越界钳制到边界，0 视为最小值 1，默认值即出厂行为。
    #[test]
    fn mood_thresholds_are_clamped_to_range() {
        // 默认值 = 原硬编码行为（3 分钟 / 18 次 / 2 秒）。
        let defaults = AppConfig::default();
        assert_eq!(defaults.widget.disappointed_threshold_min, 3);
        assert_eq!(defaults.widget.angry_threshold_clicks, 18);
        assert_eq!(defaults.widget.shy_threshold_sec, 2);
        assert!(!defaults.widget.hidden, "默认显示桌宠");

        // 越界：上界收敛到区间上界。
        let mut upper = AppConfig::default();
        upper.widget.disappointed_threshold_min = 99999;
        upper.widget.angry_threshold_clicks = 9999;
        upper.widget.shy_threshold_sec = 99999;
        normalize(&mut upper);
        assert_eq!(
            upper.widget.disappointed_threshold_min,
            MAX_DISAPPOINTED_THRESHOLD_MIN
        );
        assert_eq!(
            upper.widget.angry_threshold_clicks,
            MAX_ANGRY_THRESHOLD_CLICKS
        );
        assert_eq!(upper.widget.shy_threshold_sec, MAX_SHY_THRESHOLD_SEC);

        // 0 与其它越界下界：收敛到 1。
        let mut lower = AppConfig::default();
        lower.widget.disappointed_threshold_min = 0;
        lower.widget.angry_threshold_clicks = 0;
        lower.widget.shy_threshold_sec = 0;
        normalize(&mut lower);
        assert_eq!(lower.widget.disappointed_threshold_min, 1);
        assert_eq!(lower.widget.angry_threshold_clicks, 1);
        assert_eq!(lower.widget.shy_threshold_sec, 1);

        // 区间内保持原值。
        let mut keep = AppConfig::default();
        keep.widget.disappointed_threshold_min = 1440;
        keep.widget.angry_threshold_clicks = 100;
        keep.widget.shy_threshold_sec = 3600;
        normalize(&mut keep);
        assert_eq!(keep.widget.disappointed_threshold_min, 1440);
        assert_eq!(keep.widget.angry_threshold_clicks, 100);
        assert_eq!(keep.widget.shy_threshold_sec, 3600);
    }

    /// 隐藏状态属于纯布尔开关：规范化不得篡改。
    #[test]
    fn hidden_flag_survives_normalization() {
        let mut cfg = AppConfig::default();
        cfg.widget.hidden = true;
        normalize(&mut cfg);
        assert!(cfg.widget.hidden, "隐藏状态必须原样保留（重启后要能恢复）");
    }

    /// 已应用的气泡：老配置缺这一份时按草稿补齐（升级不改变桌宠显示），
    /// 已存在时独立规范化、不被草稿覆盖。
    #[test]
    fn applied_bubble_falls_back_to_draft_once() {
        use crate::domain::bubble::model::entity::bubble_config::{BubbleBlock, BubbleRow};
        let mut legacy = AppConfig {
            bubble: BubbleConfig {
                rows: vec![BubbleRow {
                    blocks: vec![BubbleBlock {
                        kind: "text".to_string(),
                        text: "草稿".to_string(),
                        ..Default::default()
                    }],
                }],
                ..Default::default()
            },
            ..AppConfig::default()
        };
        normalize(&mut legacy);
        let applied = legacy.bubble_applied.clone().expect("规范化后必须补齐");
        assert_eq!(applied.rows.len(), 1);
        assert_eq!(applied.rows[0].blocks[0].text, "草稿");

        // 已应用与草稿各自独立：改草稿不会顺带改掉已应用的那一份。
        let mut split = legacy.clone();
        split.bubble.rows[0].blocks[0].text = "改过的草稿".to_string();
        normalize(&mut split);
        assert_eq!(
            split.bubble_applied.unwrap().rows[0].blocks[0].text,
            "草稿",
            "草稿的改动不得渗进已应用的气泡"
        );
    }
}
