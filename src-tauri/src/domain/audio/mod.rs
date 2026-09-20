//! 音效领域
//!
//! - `dto`：音效组数据模型（同时是 `<数据目录>/audio/<组名>/meta.json` 与前端契约）；
//! - `audio_service`：组名合法性、片段参数值域、模式归一化等纯规则。

pub mod service;
pub mod model;
pub mod repository;
