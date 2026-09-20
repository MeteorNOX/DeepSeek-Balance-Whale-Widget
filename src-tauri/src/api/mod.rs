//! 接口层（API）
//!
//! Tauri 命令入口，职责固定为四步：
//! 1. 接收并转交参数（不做业务判断）；
//! 2. 调用应用层用例；
//! 3. 广播跨窗口事件（挂件窗口实时响应配置变化）；
//! 4. 通过 [`crate::types::exception::IntoWire`] 统一返回。
//!
//! **命令名、事件名与错误文案都是前端契约，不可随意修改。**
//! 涉及文件 / 网络 / 注册表 / 原生对话框 / 推理的命令统一加 `guard::catch` 守卫，
//! 使单点 panic 只会返回一条错误，而不会影响其它命令与整个 WebView。

pub mod app_api;
pub mod audio_api;
pub mod balance_api;
pub mod bubble_api;
pub mod config_api;
pub mod dto;
pub mod model_api;
pub mod pricing_api;
pub mod supplier_api;
pub mod update_api;
pub mod widget_image_api;
pub mod window_api;
