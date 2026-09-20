//! PicRepository / MattingRepository 的实现
//!
//! 只做一件事：把领域层的仓储 trait 委派给本层的落盘实现（`<store>`）与抠图推理。

use crate::types::exception::AppResult;
use crate::domain::widget_image::model::PicGroupMeta;
use crate::types::enums::WidgetState;
use crate::domain::widget_image::repository::{MattingRepository, PicRepository};

/// 生产实现：直接落盘到便携数据目录。
pub struct PicRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static PIC_REPOSITORY: PicRepositoryImpl = PicRepositoryImpl;

impl PicRepository for PicRepositoryImpl {
    fn group_meta(&self, group: &str) -> AppResult<PicGroupMeta> {
        crate::infrastructure::repository::widget_image::pic_store::group_meta(group)
    }

    fn list_groups(&self) -> Vec<String> {
        crate::infrastructure::repository::widget_image::pic_store::list_groups()
    }

    fn group_states(&self, group: &str) -> AppResult<Vec<String>> {
        crate::infrastructure::repository::widget_image::pic_store::group_states(group)
    }

    fn save_image(&self, group: &str, state: WidgetState, bytes: &[u8]) -> AppResult<()> {
        crate::infrastructure::repository::widget_image::pic_store::save_image(group, state, bytes)
    }

    fn delete_group(&self, group: &str) -> AppResult<()> {
        crate::infrastructure::repository::widget_image::pic_store::delete_group(group)
    }

    fn read_image_bytes(&self, group: &str, state: WidgetState) -> AppResult<Vec<u8>> {
        crate::infrastructure::repository::widget_image::pic_store::read_image_bytes(group, state)
    }
}

/// 生产实现：本地 onnxruntime 抠图。
pub struct MattingRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static MATTING_REPOSITORY: MattingRepositoryImpl = MattingRepositoryImpl;

impl MattingRepository for MattingRepositoryImpl {
    fn model_ready(&self) -> bool {
        crate::infrastructure::matting::model_ready()
    }

    fn download_model(&self, progress: &mut dyn FnMut(u32)) -> AppResult<()> {
        crate::infrastructure::matting::download_model(progress)
    }

    fn remove_background(&self, bytes: &[u8]) -> AppResult<Vec<u8>> {
        crate::infrastructure::matting::remove_background(bytes)
    }
}
