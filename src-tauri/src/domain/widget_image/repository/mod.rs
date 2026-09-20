//! widget_image 领域的仓储抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这些 trait，代码里不出现任何文件 / 网络 / 框架细节。

use crate::types::exception::AppResult;
use crate::domain::widget_image::model::PicGroupMeta;
use crate::types::enums::WidgetState;

/// 挂件图片仓储：图片组元数据与各状态图片文件。
pub trait PicRepository: Send + Sync {
    /// 见 `pic_store::group_meta`。
    fn group_meta(&self, group: &str) -> AppResult<PicGroupMeta>;

    /// 见 `pic_store::list_groups`。
    fn list_groups(&self) -> Vec<String>;

    /// 见 `pic_store::group_states`。
    fn group_states(&self, group: &str) -> AppResult<Vec<String>>;

    /// 见 `pic_store::save_image`。
    fn save_image(&self, group: &str, state: WidgetState, bytes: &[u8]) -> AppResult<()>;

    /// 见 `pic_store::delete_group`。
    fn delete_group(&self, group: &str) -> AppResult<()>;

    /// 见 `pic_store::read_image_bytes`。
    fn read_image_bytes(&self, group: &str, state: WidgetState) -> AppResult<Vec<u8>>;
}

/// 智能抠图端口：本地模型的就绪判定、下载与背景移除。
///
/// 推理细节（onnxruntime / 模型文件）全在实现处，领域与应用层只看到这三个能力。
pub trait MattingRepository: Send + Sync {
    /// 见 `matting::model_ready`。
    fn model_ready(&self) -> bool;

    /// 见 `matting::download_model`：通过回调上报下载进度（0-100）。
    fn download_model(&self, progress: &mut dyn FnMut(u32)) -> AppResult<()>;

    /// 见 `matting::remove_background`：返回处理后的图片字节（原格式）。
    fn remove_background(&self, bytes: &[u8]) -> AppResult<Vec<u8>>;
}
