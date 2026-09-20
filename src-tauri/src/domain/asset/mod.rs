//! 素材导入领域
//!
//! 用户从本地磁盘挑一个素材文件（音效 / 挂件图片 / 字体 / 气泡媒体）导入到某个资源组。
//! 本领域只声明「能挑文件」这一能力（[`repository::AssetPicker`]），
//! 系统文件对话框由 `infrastructure` 提供。

pub mod repository;
