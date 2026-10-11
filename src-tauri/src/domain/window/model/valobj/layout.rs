//! 显示器布局值对象（多屏 / 混合 DPI 放置计算）
//!
//! 多显示器 + 混合缩放场景下，坐标必须先明确「属于哪个坐标系」再参与运算：
//!
//! - **物理像素**：Win32 的屏幕绝对坐标（`GetMonitorInfo`、窗口 `outer_position`），
//!   全局唯一，不随任何显示器的缩放变化；
//! - **逻辑像素**：物理 ÷ 该显示器缩放因子，**只对该显示器有意义**。
//!
//! 本 issue 的根因正是把「主屏逻辑坐标」当成「全局逻辑坐标」使用：在 100% 主屏上
//! 算出 `(1295, 407)`，却被 150% 的副屏按 1.5 倍换算成 `(1943, 611)`，于是窗口
//! （以及固定在窗口右下角的宠物本体）落到了副屏工作区之外。
//!
//! 因此本模块统一承担两件事：把两种坐标系互转的函数显式化，并给出
//! 「选屏 / 夹取到工作区」的纯算法（不依赖 Tauri，可对任意显示器组合做单测）。

/// 一台显示器的物理工作区与缩放因子。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayLayout {
    /// 工作区（物理像素）：`(x, y, width, height)`，已排除任务栏。
    pub work_area: (i32, i32, u32, u32),
    /// 缩放因子（100% = 1.0，125% = 1.25，150% = 1.5，200% = 2.0）。
    pub scale_factor: f64,
}

impl DisplayLayout {
    /// 构造显示器布局（缩放因子非法时按 100% 处理，避免除零）。
    pub fn new(work_area: (i32, i32, u32, u32), scale_factor: f64) -> Self {
        let sf = if scale_factor.is_finite() && scale_factor > 0.0 {
            scale_factor
        } else {
            1.0
        };
        Self {
            work_area,
            scale_factor: sf,
        }
    }

    /// 该显示器的有效 DPI（96 = 100%），与 Win32 `GetDpiForMonitor` 同口径。
    pub fn dpi(&self) -> u32 {
        (self.scale_factor * 96.0).round() as u32
    }

    /// 工作区左边界（物理）。
    pub fn left(&self) -> i32 {
        self.work_area.0
    }

    /// 工作区上边界（物理）。
    pub fn top(&self) -> i32 {
        self.work_area.1
    }

    /// 工作区右边界（物理，开区间）。
    pub fn right(&self) -> i32 {
        self.work_area.0 + self.work_area.2 as i32
    }

    /// 工作区下边界（物理，开区间）。
    pub fn bottom(&self) -> i32 {
        self.work_area.1 + self.work_area.3 as i32
    }

    /// 点是否落在本显示器工作区内。
    pub fn contains(&self, point: (i32, i32)) -> bool {
        point.0 >= self.left()
            && point.0 < self.right()
            && point.1 >= self.top()
            && point.1 < self.bottom()
    }

    /// 点到本显示器工作区矩形的平方距离（用于「都不包含时取最近一块屏」）。
    pub fn distance_squared(&self, point: (i32, i32)) -> i64 {
        let dx = axis_distance(point.0, self.left(), self.right());
        let dy = axis_distance(point.1, self.top(), self.bottom());
        (dx as i64) * (dx as i64) + (dy as i64) * (dy as i64)
    }

    /// 逻辑像素（该显示器坐标系）→ 物理像素。
    pub fn to_physical(&self, logical_x: f64, logical_y: f64) -> (i32, i32) {
        (
            (logical_x * self.scale_factor).round() as i32,
            (logical_y * self.scale_factor).round() as i32,
        )
    }

    /// 物理像素 → 逻辑像素（该显示器坐标系）。
    pub fn to_logical(&self, physical: (i32, i32)) -> (f64, f64) {
        (
            physical.0 as f64 / self.scale_factor,
            physical.1 as f64 / self.scale_factor,
        )
    }
}

/// 单轴距离：点在区间内为 0，否则到最近端点的距离。
fn axis_distance(value: i32, min: i32, max: i32) -> i32 {
    if value < min {
        min - value
    } else if value >= max {
        value - max + 1
    } else {
        0
    }
}
