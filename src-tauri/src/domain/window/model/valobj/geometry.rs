//! 窗口几何 DTO

use serde::Serialize;

/// 挂件窗口当前的物理几何信息（返回给前端用于状态同步）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetGeometry {
    /// 窗口左上角 X 坐标（物理像素）。
    pub x: i32,
    /// 窗口左上角 Y 坐标（物理像素）。
    pub y: i32,
    /// 窗口宽度（物理像素）。
    pub width: u32,
    /// 窗口高度（物理像素）。
    pub height: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端契约：字段名为 x / y / width / height。
    #[test]
    fn geometry_is_wire_compatible() {
        let geometry = WidgetGeometry {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
        };
        let json = serde_json::to_string(&geometry).unwrap();
        assert!(json.contains("\"x\":1"), "{}", json);
        assert!(json.contains("\"y\":2"), "{}", json);
        assert!(json.contains("\"width\":3"), "{}", json);
        assert!(json.contains("\"height\":4"), "{}", json);
    }
}
