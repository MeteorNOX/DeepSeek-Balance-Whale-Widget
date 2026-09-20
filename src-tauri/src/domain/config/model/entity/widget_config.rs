//! 挂件显示配置 DTO

use serde::{Deserialize, Serialize};

use super::super::defaults::*;

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
    /// 音效组：预设 `duck`（小黄鸭）/ `dingdong`（叮咚），
    /// 或自定义音效组名称（对应 `<数据目录>/audio/<名称>/`）。
    pub sound_set: String,
    /// 气泡颜色（十六进制，如 `#203170`）。
    #[serde(default = "default_bubble_color")]
    pub bubble_color: String,
    /// 随机眨眼最小间隔（秒）。
    #[serde(default = "default_blink_interval_min_sec")]
    pub blink_interval_min_sec: u32,
    /// 随机眨眼最大间隔（秒）。
    #[serde(default = "default_blink_interval_max_sec")]
    pub blink_interval_max_sec: u32,
    /// 是否启用余额不足疲惫模式。
    #[serde(default = "default_exhausted_mode_enabled")]
    pub exhausted_mode_enabled: bool,
    /// 余额不足疲惫模式阈值（元）。
    #[serde(default = "default_exhausted_balance_threshold")]
    pub exhausted_balance_threshold: f64,
    /// 是否启用峰谷提前提示。
    #[serde(default = "default_peak_warn_enabled")]
    pub peak_warn_enabled: bool,
    /// 峰谷提前提示的预警分钟数。
    #[serde(default = "default_peak_warn_minutes")]
    pub peak_warn_minutes: u32,
    /// 边缘吸附阈值（占屏幕物理宽度比例 0–1；0 表示未设置，回退四分之一区域）。
    #[serde(default)]
    pub snap_distance: f64,
    /// 余额显示币种（六种之一，默认人民币）。
    #[serde(default = "default_display_currency")]
    pub display_currency: String,
    /// 当前挂件本体（图片组名）；「小鲸鱼」表示内置默认资源。
    #[serde(default = "default_widget_body")]
    pub widget_body: String,
    /// 是否隐藏桌宠。
    ///
    /// 只隐藏可视化窗口，后台（余额查询、记账、托盘）照常运行；
    /// 状态持久化，重启后保持；打开配置界面会强制恢复显示并写回 `false`。
    #[serde(default)]
    pub hidden: bool,
    /// 失望阈值（分钟，1–1440）：无交互超过该时长转入失望状态。
    #[serde(default = "default_disappointed_threshold_min")]
    pub disappointed_threshold_min: u32,
    /// 生气阈值（点击次数，1–100）：连点达到该次数转入生气状态。
    #[serde(default = "default_angry_threshold_clicks")]
    pub angry_threshold_clicks: u32,
    /// 害羞阈值（秒，1–3600）：鼠标持续悬浮达到该时长转入害羞状态。
    #[serde(default = "default_shy_threshold_sec")]
    pub shy_threshold_sec: u32,
}

impl Default for WidgetConfig {
    /// 返回挂件显示配置默认值。
    fn default() -> Self {
        Self {
            scale: 1.0,
            sound: true,
            vol: 0.8,
            sound_set: "duck".to_string(),
            bubble_color: DEFAULT_COLOR.to_string(),
            blink_interval_min_sec: default_blink_interval_min_sec(),
            blink_interval_max_sec: default_blink_interval_max_sec(),
            exhausted_mode_enabled: default_exhausted_mode_enabled(),
            exhausted_balance_threshold: default_exhausted_balance_threshold(),
            peak_warn_enabled: default_peak_warn_enabled(),
            peak_warn_minutes: default_peak_warn_minutes(),
            snap_distance: 0.0,
            display_currency: default_display_currency(),
            widget_body: default_widget_body(),
            hidden: false,
            disappointed_threshold_min: default_disappointed_threshold_min(),
            angry_threshold_clicks: default_angry_threshold_clicks(),
            shy_threshold_sec: default_shy_threshold_sec(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widget_config_reads_camel_case_widget_body() {
        // 前端以 camelCase 提交，必须落到 widget_body，否则自定义挂件本体无法生效。
        let json =
            r#"{"scale":1.0,"sound":true,"vol":0.8,"soundSet":"duck","widgetBody":"自定义组"}"#;
        let w: WidgetConfig = serde_json::from_str(json).unwrap();
        assert_eq!(w.widget_body, "自定义组");
    }

    #[test]
    fn widget_config_falls_back_to_default_body() {
        let json = r#"{"scale":1.0,"sound":true,"vol":0.8,"soundSet":"duck"}"#;
        let w: WidgetConfig = serde_json::from_str(json).unwrap();
        assert_eq!(w.widget_body, "小鲸鱼");
    }

    #[test]
    fn widget_config_serializes_camel_case() {
        let w = WidgetConfig::default();
        let json = serde_json::to_string(&w).unwrap();
        assert!(
            json.contains("\"widgetBody\""),
            "序列化应使用 camelCase: {}",
            json
        );
    }
}
