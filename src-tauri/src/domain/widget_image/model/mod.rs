//! 挂件图片组数据传输对象
//!
//! 与音频组元数据同一规范：camelCase 字段、以组名标识自身、逐个资源记录
//! `file`，使图片组自包含、可整体迁移。

//! 目录约定（见 `1.md`）：`aggregate/` 聚合根、`entity/` 实体、`valobj/` 值对象与常量。
pub mod entity;
pub mod valobj;

pub use entity::{pic_group_meta};
pub use valobj::{pic_asset};

pub use pic_asset::PicAsset;
pub use pic_group_meta::PicGroupMeta;
