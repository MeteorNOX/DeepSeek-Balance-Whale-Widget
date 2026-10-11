//! 显示器 / DPI 诊断 DTO
//!
//! 多显示器 + 混合缩放场景下排查「窗口位置偏移、宠物落到屏外」时的现场数据：
//! 一次返回每块显示器的物理工作区、缩放因子与有效 DPI，以及挂件窗口当前几何、
//! 所在显示器、是否完整落在该屏工作区内的结论。
//!
//! 字段全部为**物理像素**（与 Win32 `GetMonitorInfo` / 窗口 `outer_position` 同口径），
//! 只有 `scaleFactor` / `dpi` 是缩放信息。

use serde::Serialize;

use crate::domain::window::model::{DisplayLayout, WidgetGeometry};

/// 单块显示器的物理工作区与 DPI。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorDto {
    /// 工作区左上角 X（物理）。
    pub x: i32,
    /// 工作区左上角 Y（物理）。
    pub y: i32,
    /// 工作区宽度（物理）。
    pub width: u32,
    /// 工作区高度（物理）。
    pub height: u32,
    /// 缩放因子（100% = 1.0）。
    pub scale_factor: f64,
    /// 有效 DPI（96 = 100%，与 `GetDpiForMonitor` 同口径）。
    pub dpi: u32,
}

impl From<&DisplayLayout> for MonitorDto {
    fn from(display: &DisplayLayout) -> Self {
        Self {
            x: display.work_area.0,
            y: display.work_area.1,
            width: display.work_area.2,
            height: display.work_area.3,
            scale_factor: display.scale_factor,
            dpi: display.dpi(),
        }
    }
}

/// 窗口几何 DTO（物理像素 + 所在显示器缩放）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetGeometryDto {
    /// 窗口左上角 X（物理）。
    pub x: i32,
    /// 窗口左上角 Y（物理）。
    pub y: i32,
    /// 窗口宽度（物理）。
    pub width: u32,
    /// 窗口高度（物理）。
    pub height: u32,
    /// 窗口所在显示器的缩放因子。
    pub scale_factor: f64,
    /// 窗口所在显示器的有效 DPI。
    pub dpi: u32,
}

impl WidgetGeometryDto {
    /// 由窗口几何与所在显示器布局构建。
    pub fn new(geometry: &WidgetGeometry, display: Option<&DisplayLayout>) -> Self {
        Self {
            x: geometry.x,
            y: geometry.y,
            width: geometry.width,
            height: geometry.height,
            scale_factor: display.map(|d| d.scale_factor).unwrap_or(1.0),
            dpi: display.map(|d| d.dpi()).unwrap_or(96),
        }
    }
}

/// 持久化落点（配置里的原始值，便于对照「存了什么」与「落在哪」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedPositionDto {
    /// 持久化 X。
    pub x: f64,
    /// 持久化 Y。
    pub y: f64,
    /// 坐标口径：`physical` / 空串（历史主屏逻辑坐标）。
    pub unit: String,
    /// 水平锚点。
    pub h: String,
    /// 垂直锚点。
    pub v: String,
    /// 桌宠朝向：`left` / `right`。
    pub facing: String,
}

/// 显示器与挂件放置的完整诊断报告。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorReportDto {
    /// 所有显示器（顺序与系统枚举一致）。
    pub monitors: Vec<MonitorDto>,
    /// 主显示器下标（找不到时为 0）。
    pub primary_index: usize,
    /// 挂件窗口当前物理几何。
    pub widget: WidgetGeometryDto,
    /// 挂件窗口当前所在显示器下标。
    pub widget_display_index: Option<usize>,
    /// 挂件窗口是否**完整**落在所在显示器的工作区内（false 即本 issue 的病态）。
    pub inside_work_area: bool,
    /// 桌宠当前朝向（由所在显示器工作区的物理中心决定）：`left` / `right`。
    pub facing: String,
    /// 配置里持久化的落点（无记录时为 null）。
    pub persisted: Option<PersistedPositionDto>,
}
