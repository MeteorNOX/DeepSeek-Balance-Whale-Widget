//! 配置相关命令
//!
//! 读取/保存应用配置、挂件显示配置与台词配置，并向挂件窗口广播变更。

use tauri::{AppHandle, Emitter};

use crate::application::config;
use crate::domain::config::model::{AppConfig, DialogueConfig, WidgetConfig};
use crate::types::common::constants::{
    EVENT_BALANCE_REFRESH_REQUESTED, EVENT_BUBBLE_CHANGED, EVENT_DIALOGUE_CHANGED,
    EVENT_WIDGET_CONFIG_CHANGED,
};
use crate::types::exception::{guard, IntoWire};

/// 读取完整应用配置。
#[tauri::command]
pub fn get_config() -> AppConfig {
    config::service::get_config()
}

/// 保存完整应用配置（写盘 + 刷新缓存 + 同步第三方 CLI 配置）。
#[tauri::command]
pub fn save_config(app: AppHandle, cfg: AppConfig) -> Result<AppConfig, String> {
    guard::catch(|| config::service::save_config(cfg))
        .inspect(|outcome| {
            // 数据源变化时才需要前端重新拉取余额。
            //
            // 事件载荷 `false`：这里的「数据源变化」指配置里遗留的 apiKey / baseUrl
            // （当前余额来源是余额配置列表的启用供应商，不由它们决定），因此已显示的
            // 余额仍然有效，前端只需重新拉取一次，不必作废数值。
            if outcome.balance_source_changed {
                let _ = app.emit(EVENT_BALANCE_REFRESH_REQUESTED, false);
            }
        })
        .map(|outcome| outcome.config)
        .into_wire()
}

/// 快速保存挂件显示配置（汉堡菜单实时调整时使用）。
#[tauri::command]
pub fn save_widget_config(app: AppHandle, widget: WidgetConfig) -> Result<WidgetConfig, String> {
    guard::catch(|| config::service::save_widget_config(widget))
        .inspect(|saved| {
            // 广播给挂件窗口，使其实时应用来自配置窗口的显示设置。
            let _ = app.emit(EVENT_WIDGET_CONFIG_CHANGED, saved);
        })
        .into_wire()
}

/// 保存台词管理配置（写盘 + 广播给挂件窗口）。
#[tauri::command]
pub fn save_dialogue(app: AppHandle, dialogue: DialogueConfig) -> Result<DialogueConfig, String> {
    guard::catch(|| config::service::save_dialogue(dialogue))
        .inspect(|saved| {
            let _ = app.emit(EVENT_DIALOGUE_CHANGED, saved);
        })
        .into_wire()
}

/// 切换余额显示币种（保存 + 广播余额刷新）。
///
/// 事件载荷 `false`：显示币种只改变换算口径，余额仍是同一个供应商的，
/// 因此前端保留已显示的数值、只重新拉取一次（拿到新的汇率）。
#[tauri::command]
pub fn set_currency(app: AppHandle, currency: String) -> Result<WidgetConfig, String> {
    guard::catch(|| config::service::set_currency(&currency))
        .inspect(|_| {
            let _ = app.emit(EVENT_BALANCE_REFRESH_REQUESTED, false);
        })
        .into_wire()
}

/// 切换「令牌用量统计（实验性功能）」开关（保存 + 广播余额刷新）。
///
/// 开关会整体改变用量与账单的取数口径，因此必须让挂件 / 配置界面重新拉取，
/// 否则界面里还留着上一种口径的旧数字。
///
/// 事件载荷 `false`：余额数据源没变（还是同一个供应商），已显示的余额仍然有效。
#[tauri::command]
pub fn set_token_usage(app: AppHandle, enabled: bool) -> Result<bool, String> {
    guard::catch(|| config::service::set_token_usage(enabled))
        .inspect(|_| {
            let _ = app.emit(EVENT_BALANCE_REFRESH_REQUESTED, false);
        })
        .into_wire()
}

/// 恢复默认设置（保存 + 必要变更广播）。
///
/// 只复位「设置项」，不动用户数据：台词内容有独立的「恢复默认台词」按钮，
/// 供应商列表存放在 `supplier/` 目录下，挂件位置属于运行期状态，
/// 图片 / 音频 / 字体 / 气泡组等资源文件一律保留。
///
/// 广播三份分片结果：桌宠的显示、台词与模块化气泡据此**立即**换成默认值，
/// 用户不必再点一次对应设置才生效。
#[tauri::command]
pub fn reset_config(app: AppHandle) -> Result<AppConfig, String> {
    guard::catch(config::service::reset_config)
        .inspect(|outcome| {
            let _ = app.emit(EVENT_WIDGET_CONFIG_CHANGED, outcome.config.widget.clone());
            let _ = app.emit(EVENT_DIALOGUE_CHANGED, outcome.config.dialogue.clone());
            // 广播的是「已应用气泡」：挂件只认这一份（配置页里的草稿不外发）。
            let _ = app.emit(
                EVENT_BUBBLE_CHANGED,
                outcome
                    .config
                    .bubble_applied
                    .clone()
                    .unwrap_or_else(|| outcome.config.bubble.clone()),
            );
            // 事件载荷 `false`：判定依据是配置里遗留的 apiKey / baseUrl，而当前余额
            // 来源是余额配置列表的启用供应商，不由它们决定 —— 已显示的余额仍然有效。
            if outcome.balance_source_changed {
                let _ = app.emit(EVENT_BALANCE_REFRESH_REQUESTED, false);
            }
        })
        .map(|outcome| outcome.config)
        .into_wire()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 无需窗口参数的只读命令必须可直接调用（命令层装配正确性的最小回归）。
    #[test]
    fn read_only_command_is_callable() {
        crate::install_test_repositories();
        let cfg = get_config();
        assert!(!cfg.base_url.is_empty());
        assert!(!cfg.widget.display_currency.is_empty());
        // camelCase 契约：前端读取的字段名不得变化。
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"apiKey\""), "{}", json);
        assert!(json.contains("\"widget\""), "{}", json);
        assert!(json.contains("\"dialogue\""), "{}", json);
    }
}
