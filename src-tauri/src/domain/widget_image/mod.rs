//! 挂件图片领域
//!
//! - `dto`：图片组元数据模型（`pic/<组名>/meta.json` 与前端契约）；
//! - `widget_image_service`：组名合法性、图片格式 / 尺寸 / 体积校验规则。

pub mod model;
pub mod service;
pub mod repository;
