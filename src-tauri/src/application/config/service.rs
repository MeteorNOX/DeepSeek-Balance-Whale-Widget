//! 配置用例
//!
//! 覆盖配置的读取、全量保存、分片保存（挂件显示 / 台词 / 币种）与位置记录。

use crate::domain::bubble::model::entity::bubble_config::DEFAULT_BUBBLE_GROUP;
use crate::domain::config::model::{AppConfig, DialogueConfig, WidgetConfig, WidgetPosition};
use crate::types::enums::Currency;
use crate::types::exception::AppResult;
use crate::application::config::result::ConfigSaveOutcome;
use crate::application::registry;

/// 读取完整应用配置。
///
/// 顺带把系统真实的开机自启状态同步回配置，避免界面开关与系统状态漂移。
pub fn get_config() -> AppConfig {
    let mut cfg = registry::config().get();
    if let Ok(actual) = registry::autostart().is_enabled() {
        if cfg.autostart != actual {
            cfg.autostart = actual;
            let _ = registry::config().mutate(Box::new(move |c| c.autostart = actual));
        }
    }
    cfg
}

/// 保存完整应用配置（写盘）。
///
/// 不再同步第三方 CLI 配置：客户端配置文件改由「模型路由」用例按供应商写入
/// （`routing_app_service`，合并式 + 备份），应用配置的保存与客户端配置互不干涉。
pub fn save_config(cfg: AppConfig) -> AppResult<ConfigSaveOutcome> {
    let previous = registry::config().get();
    let mut incoming = cfg;
    // 「已应用气泡」只由气泡用例维护（应用 / 切换气泡组 / 恢复默认设置）：
    // 配置页拿的是打开页面时的旧快照，全量保存时照单落盘会把桌宠拽回旧气泡。
    incoming.bubble_applied = previous.bubble_applied.clone();
    let saved = registry::config().update(incoming)?;

    Ok(ConfigSaveOutcome {
        balance_source_changed: balance_source_changed(&previous, &saved),
        config: saved,
    })
}

/// 快速保存挂件显示配置（汉堡菜单实时调整时使用）。
pub fn save_widget_config(widget: WidgetConfig) -> AppResult<WidgetConfig> {
    let cfg = registry::config().mutate(Box::new(move |c| c.widget = widget))?;
    Ok(cfg.widget)
}

/// 恢复默认设置：把界面上可配置的取值全部恢复为出厂默认，但**保留用户数据**。
///
/// 保留项（有意为之）：
/// - 台词内容（`dialogue.lines`）——它有自己的「恢复默认台词」按钮，两者不应互相干扰；
/// - 挂件位置（`widget_position`）——这是运行期状态而非设置项，重置不该让挂件跳回原位；
/// - 供应商列表——完全存放在 `supplier/` 目录下，本函数不触碰；
/// - 气泡组——图片 / 音频 / 字体 / 气泡组等持久化资源一律不删，
///   模块化气泡只回到「默认」组的内容（组文件与其它组全部保留）。
///
/// 开机自启会**同步关闭系统项**：配置回落到默认（关闭）后，若不同步系统，
/// 下一次 [`get_config`] 会把系统里的真实状态再写回配置，界面开关就会「自己弹回去」。
pub fn reset_config() -> AppResult<ConfigSaveOutcome> {
    let previous = registry::config().get();
    let mut next = defaulted_config(&previous);
    // 气泡组是用户资源：重置只把当前组切回内置的「默认」组，并取其内容。
    // 组文件缺失（从未保存过）时保持空内容，与出厂状态一致。
    if let Ok(group) = registry::bubble().read_group(DEFAULT_BUBBLE_GROUP) {
        next.bubble.rows = group.rows;
    }
    // 重置后草稿与已应用气泡都是「默认」组的内容：配置页与桌宠显示同一份，不必再点一次应用。
    next.bubble_applied = Some(next.bubble.clone());
    let saved = registry::config().update(next)?;

    if previous.autostart && !saved.autostart {
        if let Err(err) = registry::autostart().set_enabled(false) {
            // 系统项关不掉不该阻断重置：配置已经回落到默认，界面如实反映结果即可。
            log::warn!("恢复默认设置时关闭开机自启失败：{}", err);
        }
    }

    Ok(ConfigSaveOutcome {
        balance_source_changed: balance_source_changed(&previous, &saved),
        config: saved,
    })
}

/// 「恢复默认」的目标配置（纯函数，便于回归测试与阅读保留项）。
fn defaulted_config(previous: &AppConfig) -> AppConfig {
    AppConfig {
        dialogue: DialogueConfig {
            // 台词内容由「恢复默认台词」独立负责，这里原样保留。
            lines: previous.dialogue.lines.clone(),
            ..DialogueConfig::default()
        },
        // 挂件位置是运行期状态，不是设置项。
        widget_position: previous.widget_position.clone(),
        ..AppConfig::default()
    }
}

/// 保存台词管理配置。
pub fn save_dialogue(dialogue: DialogueConfig) -> AppResult<DialogueConfig> {
    let cfg = registry::config().mutate(Box::new(move |c| c.dialogue = dialogue))?;
    Ok(cfg.dialogue)
}

/// 切换余额显示币种。
pub fn set_currency(currency: &str) -> AppResult<WidgetConfig> {
    let code = Currency::parse_loose_or_default(currency)
        .as_str()
        .to_string();
    let cfg = registry::config().mutate(Box::new(move |c| c.widget.display_currency = code))?;
    Ok(cfg.widget)
}

/// 切换「令牌用量统计（实验性功能）」开关，返回落盘后的实际值。
///
/// 开关只决定用量与账单的**取数口径**（关闭 = 本地余额差值记账，开启 = 按平台令牌
/// 向官网取逐日用量），余额本身照常联网，因此这里不触碰任何供应商配置。
pub fn set_token_usage(enabled: bool) -> AppResult<bool> {
    let cfg = registry::config().mutate(Box::new(move |c| c.token_usage = enabled))?;
    Ok(cfg.token_usage)
}

/// 读取令牌用量统计开关（用量用例据此决定取数口径；只读，不触发自启状态同步）。
pub fn token_usage_enabled() -> bool {
    registry::config().get().token_usage
}

/// 记录桌宠显示 / 隐藏状态（`hidden = true` 表示隐藏）。
///
/// 只影响可视化窗口，后台服务不受影响；状态落盘后重启可记忆。
pub fn set_widget_hidden(hidden: bool) -> AppResult<WidgetConfig> {
    let cfg = registry::config().mutate(Box::new(move |c| c.widget.hidden = hidden))?;
    Ok(cfg.widget)
}

/// 记录挂件窗口位置（拖拽吸附后调用）。
pub fn save_widget_position(position: WidgetPosition) -> AppResult<()> {
    registry::config().mutate(Box::new(move |cfg| cfg.widget_position = Some(position)))?;
    Ok(())
}

/// 余额 / 用量数据源是否变化（API Key、请求地址，或令牌用量统计开关）。
///
/// 开关注解：切换它会把账表的取数口径整体换掉（本地差值 ↔ 官网逐日），
/// 界面必须重新拉取，否则图里还留着另一种口径的旧数字。
fn balance_source_changed(previous: &AppConfig, next: &AppConfig) -> bool {
    previous.api_key.trim() != next.api_key.trim()
        || previous.base_url.trim().trim_end_matches('/')
            != next.base_url.trim().trim_end_matches('/')
        || previous.token_usage != next.token_usage
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_source(api_key: &str, base_url: &str) -> AppConfig {
        AppConfig {
            api_key: api_key.to_string(),
            base_url: base_url.to_string(),
            ..AppConfig::default()
        }
    }

    /// 只有「数据源」变化才需要通知前端刷新余额。
    #[test]
    fn balance_source_change_detection() {
        let base = with_source("sk-a", "https://api.deepseek.com/anthropic");

        // 完全一致：无需刷新。
        assert!(!balance_source_changed(
            &base,
            &with_source("sk-a", "https://api.deepseek.com/anthropic")
        ));

        // 仅尾部斜杠 / 空白差异：视为未变化（与历史逻辑一致）。
        assert!(!balance_source_changed(
            &base,
            &with_source("  sk-a  ", "https://api.deepseek.com/anthropic/")
        ));

        // Key 变化：需要刷新。
        assert!(balance_source_changed(
            &base,
            &with_source("sk-b", "https://api.deepseek.com/anthropic")
        ));

        // 地址变化：需要刷新。
        assert!(balance_source_changed(
            &base,
            &with_source("sk-a", "https://proxy.example.com")
        ));

        // 令牌用量统计开关变化：取数口径整体改变，同样需要刷新。
        let mut toggled = with_source("sk-a", "https://api.deepseek.com/anthropic");
        toggled.token_usage = true;
        assert!(balance_source_changed(&base, &toggled));
    }

    /// 币种切换：大小写与空白容错，非法值回落 CNY。
    #[test]
    fn currency_normalization_rules() {
        assert_eq!(Currency::parse_loose_or_default(" usd ").as_str(), "USD");
        assert_eq!(Currency::parse_loose_or_default("xxx").as_str(), "CNY");
    }

    /// 恢复默认设置：界面上的数值 / 开关全部回到出厂默认，唯独「台词内容」与
    /// 「挂件位置」保留——前者有独立按钮、后者是运行期状态。
    #[test]
    fn reset_restores_defaults_but_keeps_user_lines_and_position() {
        let mut previous = AppConfig::default();
        previous.widget.bubble_color = "#ff0000".to_string();
        previous.widget.blink_interval_min_sec = 99;
        previous.widget.blink_interval_max_sec = 120;
        previous.widget.exhausted_mode_enabled = false;
        previous.widget.exhausted_balance_threshold = 42.0;
        previous.widget.disappointed_threshold_min = 77;
        previous.widget.angry_threshold_clicks = 3;
        previous.widget.shy_threshold_sec = 9;
        previous.widget.scale = 3.0;
        previous.widget.vol = 0.1;
        previous.global_color = "#00ff00".to_string();
        previous.global_theme = "glass".to_string();
        previous.token_usage = true;
        previous.autostart = true;
        previous.widget_position = Some(WidgetPosition {
            x: 123.0,
            y: 456.0,
            h: "left".to_string(),
            v: "top".to_string(),
        });
        previous.dialogue.lines = vec!["我自己的台词".to_string()];
        previous.dialogue.interval_min = 99;

        let next = defaulted_config(&previous);

        // 数值 / 开关：回到默认。
        assert_eq!(
            next.widget.bubble_color,
            AppConfig::default().widget.bubble_color
        );
        assert_eq!(next.widget.blink_interval_min_sec, 4);
        assert_eq!(next.widget.blink_interval_max_sec, 6);
        assert!(next.widget.exhausted_mode_enabled, "疲惫模式默认开启");
        assert_eq!(next.widget.exhausted_balance_threshold, 5.0);
        assert_eq!(next.widget.disappointed_threshold_min, 3);
        assert_eq!(next.widget.angry_threshold_clicks, 18);
        assert_eq!(next.widget.shy_threshold_sec, 2);
        assert_eq!(next.widget.scale, 1.0);
        assert_eq!(next.widget.vol, 0.8);
        assert_eq!(next.global_color, "#203170");
        assert_eq!(next.global_theme, "light");
        assert!(!next.token_usage, "实验性开关同样回到默认关闭");
        assert!(!next.autostart);
        assert_eq!(next.dialogue.interval_min, 5, "台词间隔属于数值，一并复位");
        assert_eq!(
            next.bubble.current_group, DEFAULT_BUBBLE_GROUP,
            "气泡组回到内置的「默认」组"
        );
        assert!(next.bubble.rows.is_empty(), "默认组未落盘时内容为空");

        // 保留项。
        assert_eq!(next.dialogue.lines, vec!["我自己的台词".to_string()]);
        assert_eq!(
            next.widget_position.as_ref().map(|p| (p.x, p.h.as_str())),
            Some((123.0, "left"))
        );
    }
}
