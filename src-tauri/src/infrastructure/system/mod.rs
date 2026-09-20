//! 系统集成
//!
//! 与操作系统交互的能力：开机自启（注册表）、客户端配置文件读写、
//! 系统文件对话框、外部浏览器。

pub mod paths;
pub mod autostart;
pub mod client_config;
pub mod external_config;
pub mod file_dialog;
