//! 宿主系统领域
//!
//! 应用赖以运行的外部环境：便携数据目录、系统默认程序（浏览器 / 文件管理器）。
//! 本领域只声明能力（[`repository::SystemHost`]），真实调用由 `infrastructure` 提供。

pub mod repository;
