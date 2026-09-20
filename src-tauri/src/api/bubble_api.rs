//! 模块化气泡命令
//!
//! 气泡配置的保存、气泡组的增删与切换，以及客户端字体 / 图片动图的上传与读取。
//!
//! 广播口径：只有**用户明确应用**的命令（应用另存 / 切换气泡组 / 删除当前组）
//! 才向挂件窗口广播 `bubble-changed`；编辑期的草稿保存（`save_bubble`）不广播——
//! 编辑区里的半成品只在配置页的预览气泡里实时预览，不会闪到桌面上。

use tauri::{AppHandle, Emitter};

use crate::application::bubble;
use crate::domain::bubble::model::entity::bubble_config::{BubbleConfig, PickedBubbleAsset};
use crate::types::common::constants::EVENT_BUBBLE_CHANGED;
use crate::types::exception::{guard, IntoWire};

/// 保存模块化气泡草稿（写盘，不广播）。
#[tauri::command]
pub fn save_bubble(bubble: BubbleConfig) -> Result<BubbleConfig, String> {
    guard::catch(|| bubble::service::save_bubble(bubble)).into_wire()
}

/// 列出全部气泡组（配置页的「气泡组」下拉）。
///
/// 只读且无失败分支：目录不存在时返回空列表，「默认」组缺失时按当前配置补写。
#[tauri::command]
pub fn list_bubble_groups() -> Vec<String> {
    bubble::service::list_groups()
}

/// 切换气泡组：把该组内容设为草稿与已应用气泡并广播（挂件立即换成这一组的气泡）。
#[tauri::command]
pub fn switch_bubble_group(app: AppHandle, name: String) -> Result<BubbleConfig, String> {
    guard::catch(|| bubble::service::switch_group(&name))
        .inspect(|saved| {
            let _ = app.emit(EVENT_BUBBLE_CHANGED, saved);
        })
        .into_wire()
}

/// 把当前编辑内容另存为一个新气泡组（「应用」按钮）：该组同时成为草稿与已应用气泡，
/// 并广播给挂件窗口。
#[tauri::command]
pub fn save_bubble_group(
    app: AppHandle,
    name: String,
    bubble: BubbleConfig,
) -> Result<BubbleConfig, String> {
    guard::catch(|| bubble::service::save_group(&name, &bubble))
        .inspect(|saved| {
            let _ = app.emit(EVENT_BUBBLE_CHANGED, saved);
        })
        .into_wire()
}

/// 静默回写某个气泡组的内容（只写组文件，不改配置、不广播）。
///
/// 「应用」把编辑区内容另存为新组时，源组在编辑期间被自动保存改写过；
/// 前端先用本命令把源组还原成编辑前的样子，再另存新组，见 bubble::service::write_group。
#[tauri::command]
pub fn write_bubble_group(name: String, bubble: BubbleConfig) -> Result<(), String> {
    guard::catch(|| bubble::service::write_group(&name, &bubble)).into_wire()
}

/// 删除气泡组（内置「默认」组不可删除）；删的是当前组时回落到「默认」并广播。
#[tauri::command]
pub fn delete_bubble_group(app: AppHandle, name: String) -> Result<BubbleConfig, String> {
    guard::catch(|| bubble::service::delete_group(&name))
        .inspect(|saved| {
            let _ = app.emit(EVENT_BUBBLE_CHANGED, saved);
        })
        .into_wire()
}

/// 选择并上传图片 / 动图（落盘到数据目录的 `bubble/`，返回文件名与预览用 Data URL）。
#[tauri::command]
pub fn pick_bubble_media() -> Result<PickedBubbleAsset, String> {
    guard::catch(bubble::service::pick_media).into_wire()
}

/// 读取气泡媒体为 Data URL（挂件 / 配置页还原图片时使用）。
#[tauri::command]
pub fn read_bubble_media(name: String) -> Result<String, String> {
    guard::catch(|| bubble::service::read_media(&name)).into_wire()
}

/// 选择并上传字体（落盘到数据目录的 `fonts/`）。
#[tauri::command]
pub fn pick_bubble_font() -> Result<PickedBubbleAsset, String> {
    guard::catch(bubble::service::pick_font).into_wire()
}

/// 读取字体为 Data URL（前端注入 `@font-face` 用）。
#[tauri::command]
pub fn read_bubble_font(name: String) -> Result<String, String> {
    guard::catch(|| bubble::service::read_font(&name)).into_wire()
}

/// 列出已上传的字体文件名（配置页字体下拉）。
///
/// 只读且无失败分支：目录不存在时返回空列表，因此不需要错误包装。
#[tauri::command]
pub fn list_bubble_fonts() -> Vec<String> {
    bubble::service::list_fonts()
}
