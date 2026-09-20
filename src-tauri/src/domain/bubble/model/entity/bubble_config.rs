//! 模块化气泡配置 DTO
//!
//! 气泡内容不再写死：整块气泡由若干「行」组成，每行可以并排放置多个模块，
//! 每个模块自带尺寸 / 样式 / 色彩等属性（文本、余额、今日已用、峰谷倒计时、
//! 超链接、图片动图六种）。
//!
//! 字段名（camelCase）是前端契约：配置页与挂件窗口共用同一份 JSON。

use serde::{Deserialize, Serialize};

use crate::domain::config::model::defaults::{default_bubble_block_color, default_bubble_block_size};

/// 模块类型（前端契约字符串）。
pub const BLOCK_KIND_TEXT: &str = "text";
/// 余额模块。
pub const BLOCK_KIND_BALANCE: &str = "balance";
/// 今日已用模块。
pub const BLOCK_KIND_TODAY: &str = "today";
/// DS 峰谷倒计时模块。
pub const BLOCK_KIND_COUNTDOWN: &str = "countdown";
/// 超链接模块。
pub const BLOCK_KIND_LINK: &str = "link";
/// 图片 / 动图模块。
pub const BLOCK_KIND_MEDIA: &str = "media";

/// 支持的全部模块类型（规范化时据此丢弃未知模块）。
pub const BLOCK_KINDS: [&str; 6] = [
    BLOCK_KIND_TEXT,
    BLOCK_KIND_BALANCE,
    BLOCK_KIND_TODAY,
    BLOCK_KIND_COUNTDOWN,
    BLOCK_KIND_LINK,
    BLOCK_KIND_MEDIA,
];

/// 单个气泡模块。
///
/// 所有字段都带默认值：前端只提交与默认值不同的部分（也便于旧配置缺失字段时平滑升级）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BubbleBlock {
    /// 前端生成的稳定标识（拖拽 / 删除时定位用）。
    #[serde(default)]
    pub id: String,
    /// 模块类型，取值见本文件 `BLOCK_KIND_*`。
    #[serde(default = "default_block_kind")]
    pub kind: String,
    /// 文本内容（文本模块）。
    #[serde(default)]
    pub text: String,
    /// 超链接显示名称。
    #[serde(default)]
    pub link_name: String,
    /// 超链接跳转地址。
    #[serde(default)]
    pub link_url: String,
    /// 图片 / 动图文件名（位于 `<数据目录>/bubble/`）。
    #[serde(default)]
    pub media: String,
    /// 图片显示宽度（气泡内逻辑像素，50–300）。
    #[serde(default = "default_media_width")]
    pub media_width: f64,
    /// 余额 / 今日已用的数据来源供应商标识（空 = 跟随当前启用供应商）。
    #[serde(default)]
    pub supplier: String,
    /// 上传字体的文件名（空 = 使用项目默认字体）。
    #[serde(default)]
    pub font_family: String,
    /// 字号（气泡内逻辑像素，10–40）。
    #[serde(default = "default_bubble_block_size")]
    pub font_size: f64,
    /// 文字颜色。
    #[serde(default = "default_bubble_block_color")]
    pub color: String,
    /// 加粗。
    #[serde(default)]
    pub bold: bool,
    /// 斜体。
    #[serde(default)]
    pub italic: bool,
    /// 下划线。
    #[serde(default)]
    pub underline: bool,
    /// 是否使用底色。
    #[serde(default)]
    pub background: bool,
    /// 底色（仅 `background` 为真时生效）。
    #[serde(default = "default_background_color")]
    pub background_color: String,
    /// 流光效果。
    #[serde(default)]
    pub glow: bool,
}

/// 一行：并排的若干模块（至少一个）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BubbleRow {
    /// 该行的模块，从左到右排列。
    #[serde(default)]
    pub blocks: Vec<BubbleBlock>,
}

/// 模块化气泡配置。
///
/// `rows` 为空表示「未使用模块化气泡」：挂件沿用内置的余额三行气泡，
/// 保证老用户与新装用户在未配置时看到的界面完全一致。
///
/// `current_group` 是「当前气泡组」的组名，同时也是下拉里的选中项：
/// 组内容存在 `<数据目录>/bubble/<组名>/group.json`，`rows` 始终是它的镜像，
/// 挂件因此只认 `rows`，不需要知道「组」这一层的存在。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BubbleConfig {
    /// 自上而下的行。
    #[serde(default)]
    pub rows: Vec<BubbleRow>,
    /// 当前气泡组名（默认「默认」组）。
    #[serde(default = "default_group")]
    pub current_group: String,
}

impl Default for BubbleConfig {
    fn default() -> Self {
        Self {
            rows: Vec::new(),
            current_group: default_group(),
        }
    }
}

/// 默认气泡组（内置，不可删除）：旧配置升级的落点，也是下拉里的兜底项。
pub const DEFAULT_BUBBLE_GROUP: &str = "默认";

/// 气泡组名最大长度（与前端输入框限制一致）。
pub const MAX_BUBBLE_GROUP_NAME_LEN: usize = 16;

/// 默认组名。
fn default_group() -> String {
    DEFAULT_BUBBLE_GROUP.to_string()
}

/// 上传成功后的气泡资源（字体 / 图片动图）。
///
/// `name` 是落盘后的文件名（配置里保存的就是它），`data_url` 供前端**立即**预览，
/// 不必等下一次读取往返。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedBubbleAsset {
    /// 落盘后的文件名。
    pub name: String,
    /// 资源内容（Data URL）。
    pub data_url: String,
}

impl Default for BubbleBlock {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: default_block_kind(),
            text: String::new(),
            link_name: String::new(),
            link_url: String::new(),
            media: String::new(),
            media_width: default_media_width(),
            supplier: String::new(),
            font_family: String::new(),
            font_size: default_bubble_block_size(),
            color: default_bubble_block_color(),
            bold: false,
            italic: false,
            underline: false,
            background: false,
            background_color: default_background_color(),
            glow: false,
        }
    }
}

fn default_block_kind() -> String {
    BLOCK_KIND_TEXT.to_string()
}

/// 图片默认宽度：气泡文字区宽度约 560u，120 起步既能看清也不会一上来就撑满。
fn default_media_width() -> f64 {
    120.0
}

fn default_background_color() -> String {
    "#ffffff".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试辅助：按类型造一个模块（其余字段取默认值）。
    fn block(kind: &str) -> BubbleBlock {
        BubbleBlock {
            kind: kind.to_string(),
            ..BubbleBlock::default()
        }
    }

    /// 默认配置必须是「空行列表 + 默认组」：未配置时挂件仍走内置三行气泡，界面不变。
    #[test]
    fn default_config_has_no_rows() {
        let cfg = BubbleConfig::default();
        assert!(cfg.rows.is_empty());
        assert_eq!(cfg.current_group, DEFAULT_BUBBLE_GROUP);
        let json = serde_json::to_string(&cfg).unwrap();
        assert_eq!(json, r#"{"rows":[],"currentGroup":"默认"}"#);
    }

    /// 旧配置（还没有「气泡组」这个概念）必须平滑升级到默认组。
    #[test]
    fn legacy_config_without_group_upgrades_to_default() {
        let cfg: BubbleConfig = serde_json::from_str(r#"{"rows":[]}"#).unwrap();
        assert_eq!(cfg.current_group, DEFAULT_BUBBLE_GROUP);
        // 反过来也必须成立：组名是前端契约，必须 camelCase。
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"currentGroup\""), "{}", json);
    }

    /// 字段名是前端契约：必须与前端 camelCase 一致。
    #[test]
    fn block_serializes_camel_case() {
        let json = serde_json::to_string(&block(BLOCK_KIND_BALANCE)).unwrap();
        for key in [
            "\"kind\"",
            "\"linkName\"",
            "\"linkUrl\"",
            "\"mediaWidth\"",
            "\"fontFamily\"",
            "\"fontSize\"",
            "\"backgroundColor\"",
        ] {
            assert!(json.contains(key), "缺少字段 {}：{}", key, json);
        }
        assert!(json.contains("\"kind\":\"balance\""), "{}", json);
    }

    /// 六种模块类型都必须被规范化放行（前端「可选模块区」一一对应）。
    #[test]
    fn all_kinds_are_known() {
        assert_eq!(BLOCK_KINDS.len(), 6);
        for kind in BLOCK_KINDS {
            assert!(BLOCK_KINDS.contains(&kind));
        }
    }

    /// 旧配置 / 精简载荷缺字段时必须能读出来并回落默认值。
    #[test]
    fn partial_block_deserializes_with_defaults() {
        let json = r#"{"rows":[{"blocks":[{"kind":"text","text":"你好"}]}]}"#;
        let cfg: BubbleConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.rows.len(), 1);
        let block = &cfg.rows[0].blocks[0];
        assert_eq!(block.kind, "text");
        assert_eq!(block.text, "你好");
        assert_eq!(block.font_size, default_bubble_block_size());
        assert_eq!(block.media_width, 120.0);
        assert!(!block.bold);
    }

    /// 行与模块的嵌套结构可完整往返（前端拖拽后提交的就是这个形状）。
    #[test]
    fn rows_roundtrip() {
        let cfg = BubbleConfig {
            rows: vec![
                BubbleRow {
                    blocks: vec![block(BLOCK_KIND_TEXT)],
                },
                BubbleRow {
                    blocks: vec![block(BLOCK_KIND_BALANCE), block(BLOCK_KIND_MEDIA)],
                },
            ],
            current_group: "我的组".to_string(),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: BubbleConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.rows.len(), 2);
        assert_eq!(back.rows[1].blocks.len(), 2);
        assert_eq!(back.rows[1].blocks[0].kind, "balance");
        assert_eq!(back.rows[1].blocks[1].kind, "media");
        assert_eq!(back.current_group, "我的组");
    }
}
