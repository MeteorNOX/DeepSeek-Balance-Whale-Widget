//! 本地智能抠图
//!
//! 使用 `ort`（onnxruntime-rs）加载 rembg 官方 BiRefNet（birefnet-general-lite）模型
//! 完成背景移除。onnxruntime CPU 动态库随二进制内嵌，运行时解压到数据目录
//! （`<数据目录>/ort`）；抠图模型按需下载到同一目录后离线加载。
//! 不依赖任何 Python 环境或外部 onnxruntime 安装。

pub mod session;

pub use session::{download_model, model_ready, remove_background};
