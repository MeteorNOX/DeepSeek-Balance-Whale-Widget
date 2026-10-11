//! 挂件窗口吸附锚点枚举

/// 水平吸附锚点（决定挂件是否镜像翻转）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HorizontalAnchor {
    /// 吸附屏幕左侧。
    Left,
    /// 吸附屏幕右侧。
    Right,
    /// 未吸附。
    None,
}

impl HorizontalAnchor {
    /// 默认锚点（悬于中间 / 无有效记录时向右）。
    pub const DEFAULT: HorizontalAnchor = HorizontalAnchor::Right;

    /// 锚点标识（前端取值，同时是持久化取值）。
    pub fn as_str(self) -> &'static str {
        match self {
            HorizontalAnchor::Left => "left",
            HorizontalAnchor::Right => "right",
            HorizontalAnchor::None => "none",
        }
    }

    /// 解析锚点。
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "left" => Some(HorizontalAnchor::Left),
            "right" => Some(HorizontalAnchor::Right),
            "none" => Some(HorizontalAnchor::None),
            _ => None,
        }
    }
}

/// 垂直吸附锚点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerticalAnchor {
    /// 吸附屏幕顶部。
    Top,
    /// 吸附屏幕底部。
    Bottom,
    /// 未吸附。
    None,
}

impl VerticalAnchor {
    /// 默认锚点（内容贴窗口下沿，即历史行为）。
    pub const DEFAULT: VerticalAnchor = VerticalAnchor::None;

    /// 锚点标识（前端取值，同时是持久化取值）。
    ///
    /// 只有 `top` 会改变内容在窗口内的锚定方向（贴窗口上沿，为上方的气泡预留空间）；
    /// `bottom` / `none` 都沿用「贴窗口下沿」的默认锚定。
    pub fn as_str(self) -> &'static str {
        match self {
            VerticalAnchor::Top => "top",
            VerticalAnchor::Bottom => "bottom",
            VerticalAnchor::None => "none",
        }
    }

    /// 解析锚点。
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "top" => Some(VerticalAnchor::Top),
            "bottom" => Some(VerticalAnchor::Bottom),
            "none" => Some(VerticalAnchor::None),
            _ => None,
        }
    }
}

/// 桌宠朝向。
///
/// 判定基准是**桌宠所在显示器工作区的物理水平中心**，与拖拽方向无关：
/// 桌宠落在左半区 → 朝右；落在右半区 → 朝左 —— 两种情形都「面向屏幕中心」。
///
/// 刻意与 [`HorizontalAnchor`] 分开：锚点决定内容块贴在窗口的哪一侧（左右吸附要
/// 靠它做零间隙贴合），朝向只决定贴图是否镜像。二者可以取值相同而含义完全无关
/// （例如「左下角贴合并朝右」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Facing {
    /// 面朝屏幕左侧。
    Left,
    /// 面朝屏幕右侧。
    Right,
}

impl Facing {
    /// 默认朝向（坐标不可用时）。
    pub const DEFAULT: Facing = Facing::Right;

    /// 朝向标识（前端取值，同时是持久化取值）。
    pub fn as_str(self) -> &'static str {
        match self {
            Facing::Left => "left",
            Facing::Right => "right",
        }
    }

    /// 解析朝向。
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "left" => Some(Facing::Left),
            "right" => Some(Facing::Right),
            _ => None,
        }
    }

    /// 反向朝向。
    pub fn flipped(self) -> Self {
        match self {
            Facing::Left => Facing::Right,
            Facing::Right => Facing::Left,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 吸附锚点：取值必须与前端判断逻辑一致。
    #[test]
    fn anchors_round_trip() {
        for anchor in [
            HorizontalAnchor::Left,
            HorizontalAnchor::Right,
            HorizontalAnchor::None,
        ] {
            assert_eq!(HorizontalAnchor::parse(anchor.as_str()), Some(anchor));
        }
        assert_eq!(HorizontalAnchor::parse("middle"), None);
        assert_eq!(HorizontalAnchor::DEFAULT.as_str(), "right");

        for anchor in [
            VerticalAnchor::Top,
            VerticalAnchor::Bottom,
            VerticalAnchor::None,
        ] {
            assert_eq!(VerticalAnchor::parse(anchor.as_str()), Some(anchor));
        }
        assert_eq!(VerticalAnchor::parse("middle"), None);
        assert_eq!(
            VerticalAnchor::DEFAULT.as_str(),
            "none",
            "默认锚定是「贴窗口下沿」，即历史行为"
        );
    }

    /// 朝向与锚点是两套语义：取值可以相同，但解析互不影响。
    #[test]
    fn facing_round_trip_and_flip() {
        for facing in [Facing::Left, Facing::Right] {
            assert_eq!(Facing::parse(facing.as_str()), Some(facing));
        }
        assert_eq!(Facing::parse("none"), None, "朝向没有 none");
        assert_eq!(Facing::Left.flipped(), Facing::Right);
        assert_eq!(Facing::Right.flipped(), Facing::Left);
        assert_eq!(Facing::DEFAULT.as_str(), "right");
    }
}
