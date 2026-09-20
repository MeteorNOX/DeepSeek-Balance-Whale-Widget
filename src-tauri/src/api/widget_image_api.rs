//! 挂件图片组命令
//!
//! 提供自定义挂件图片组的枚举、保存、读取、元数据与智能抠图。

use tauri::{AppHandle, Emitter};

use crate::application::widget_image;
use crate::domain::widget_image::model::PicGroupMeta;
use crate::types::common::constants::{
    EVENT_MATTING_DOWNLOAD_PROGRESS, EVENT_WIDGET_IMAGE_CHANGED,
};
use crate::types::exception::{guard, IntoWire};

/// 列出所有挂件组（含默认「小鲸鱼」，置于首位）。
#[tauri::command]
pub fn list_widget_groups() -> Vec<String> {
    widget_image::service::list_groups_with_default()
}

/// 保存挂件图片：base64 data 解码后写入 `pic/{group}/{state}.png`，并广播挂件刷新。
#[tauri::command]
pub fn save_widget_image(
    app: AppHandle,
    group: String,
    state: String,
    data: String,
) -> Result<(), String> {
    guard::catch(|| widget_image::service::save_image_from_data_url(&group, &state, &data))
        .map(|_| {
            let _ = app.emit(EVENT_WIDGET_IMAGE_CHANGED, ());
        })
        .into_wire()
}

/// 删除自定义挂件图片组：移除该组的全部图片资源，并广播挂件刷新。
#[tauri::command]
pub fn delete_widget_group(app: AppHandle, group: String) -> Result<(), String> {
    guard::catch(|| widget_image::service::delete_group(&group))
        .map(|_| {
            let _ = app.emit(EVENT_WIDGET_IMAGE_CHANGED, ());
        })
        .into_wire()
}

/// 读取挂件图片并返回 base64 Data URL（供挂件加载自定义组）。
#[tauri::command]
pub fn read_widget_image(group: String, state: String) -> Result<String, String> {
    guard::catch(|| widget_image::service::read_image_data_url(&group, &state)).into_wire()
}

/// 列出指定挂件组已存在的状态资源（供挂件状态机做加载与兜底决策）。
#[tauri::command]
pub fn widget_group_states(group: String) -> Result<Vec<String>, String> {
    guard::catch(|| widget_image::service::group_states(&group)).into_wire()
}

/// 读取挂件组元数据（磁盘为唯一事实来源，缺失或过期时自动补写 meta.json）。
#[tauri::command]
pub fn read_widget_group_meta(group: String) -> Result<PicGroupMeta, String> {
    guard::catch(|| widget_image::service::group_meta(&group)).into_wire()
}

/// 系统对话框选择图片，返回 base64 Data URL（未选择返回错误）。
///
/// 选择后立即校验格式与尺寸，非法文件给出明确错误而不是等到渲染阶段。
#[tauri::command]
pub fn pick_image_file() -> Result<String, String> {
    guard::catch(widget_image::service::pick_image_data_url).into_wire()
}

/// 移除背景（Rust 原生推理），返回处理后的图片 Data URL。
#[tauri::command]
pub async fn remove_background(data: String) -> Result<String, String> {
    widget_image::service::remove_background_data_url(&data)
        .await
        .into_wire()
}

/// 抠图模型是否已下载就绪。
#[tauri::command]
pub fn matting_model_ready() -> bool {
    widget_image::service::matting_model_ready()
}

/// 下载抠图模型（按需下载，边下边通过事件上报进度）。
#[tauri::command]
pub async fn download_matting_model(app: AppHandle) -> Result<(), String> {
    widget_image::service::download_matting_model(move |percent| {
        // AppHandle 实现了 Send + Sync，可安全地在阻塞线程池回调中广播进度。
        let _ = app.emit(EVENT_MATTING_DOWNLOAD_PROGRESS, percent);
    })
    .await
    .into_wire()
}
