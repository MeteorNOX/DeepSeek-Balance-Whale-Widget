//! 基础设施层（Infrastructure）
//!
//! 承载一切**对外部世界的依赖**：文件系统、HTTP、注册表、ONNX 运行时。
//! 领域层与应用层只通过本层暴露的函数访问外部世界。
//!
//! - `repository`：便携数据目录与各类持久化（配置 / 账本 / 音效 / 图片）；
//! - `http`：余额、汇率、版本清单等远端接口；
//! - `system`：开机自启注册表、Claude / Codex 配置落盘、外部浏览器；
//! - `matting`：本地 ONNX 智能抠图。

pub mod http;
pub mod matting;
pub mod repository;
pub mod system;
