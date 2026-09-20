//! 供应商领域
//!
//! - `dto`：供应商数据模型（`<数据目录>/supplier/` 下 `index.json`、各 scope 的
//!   `active.json` 与 `<scope>/<slug>/` 内的各个 JSON 文件）；
//! - `supplier_service`：slug / scope 目录名校验、字段归一化、必填校验等纯规则；
//! - `model_service`：模型列表（`/v1/models`）的候选地址、响应解析与失败分类。

pub mod model;
pub mod service;
pub mod repository;
