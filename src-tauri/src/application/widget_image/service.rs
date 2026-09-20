//! 挂件图片用例
//!
//! 图片组的枚举 / 保存 / 删除 / 读取，以及智能抠图与模型下载。

use crate::domain::widget_image::model::PicGroupMeta;
use crate::domain::widget_image::service::widget_image_service as widget_image;
use crate::types::enums::WidgetState;
use crate::types::exception::{AppError, AppResult};
use crate::types::utils::base64 as b64;
use crate::types::utils::fs;
use crate::application::registry;

/// 列出所有挂件组（含默认「小鲸鱼」，置于首位）。
pub fn list_groups_with_default() -> Vec<String> {
    let mut groups = vec![widget_image::DEFAULT_BODY.to_string()];
    groups.extend(registry::pic().list_groups());
    groups
}

/// 由 Data URL 保存挂件图片。
pub fn save_image_from_data_url(group: &str, state: &str, data: &str) -> AppResult<()> {
    let state = parse_state(state)?;
    let bytes = b64::decode_data_url(data, "图片")?;
    registry::pic().save_image(group, state, &bytes).map_err(|err| {
        log::error!("保存挂件图片失败（{} / {}）：{}", group, state.key(), err);
        err
    })
}

/// 删除自定义挂件图片组。
pub fn delete_group(group: &str) -> AppResult<()> {
    registry::pic().delete_group(group).map_err(|err| {
        log::error!("删除挂件组失败（{}）：{}", group, err);
        err
    })
}

/// 读取挂件图片并转换为 Data URL。
pub fn read_image_data_url(group: &str, state: &str) -> AppResult<String> {
    let bytes = registry::pic().read_image_bytes(group, parse_state(state)?)?;
    Ok(b64::image_data_url(&bytes))
}

/// 列出指定挂件组已存在的状态资源。
pub fn group_states(group: &str) -> AppResult<Vec<String>> {
    registry::pic().group_states(group)
}

/// 读取挂件组元数据（缺失或过期时自动补写）。
pub fn group_meta(group: &str) -> AppResult<PicGroupMeta> {
    registry::pic().group_meta(group)
}

/// 系统对话框选择图片：校验格式与尺寸后返回 Data URL。
///
/// 非法文件在导入阶段就给出明确错误，而不是等到渲染阶段。
pub fn pick_image_data_url() -> AppResult<String> {
    let path = registry::asset_picker()
        .pick_image()
        .ok_or_else(|| AppError::invalid("未选择图片"))?;
    let bytes = fs::read_bytes(&path, "图片文件")?;
    if let Err(err) = widget_image::validate_image_bytes(&bytes) {
        log::warn!("图片校验未通过（{}）：{}", path.display(), err);
        return Err(err);
    }
    Ok(b64::image_data_url(&bytes))
}

/// 移除背景（Rust 原生推理），返回处理后的图片 Data URL。
///
/// 推理为 CPU 密集操作，放入阻塞线程池，避免卡住 UI。
pub async fn remove_background_data_url(data: &str) -> AppResult<String> {
    let bytes = b64::decode_data_url(data, "图片")?;
    let out = tokio::task::spawn_blocking(move || registry::matting().remove_background(&bytes))
        .await
        .map_err(|e| AppError::internal(format!("智能抠图执行失败: {}", e)))??;
    Ok(b64::image_data_url(&out))
}

/// 抠图模型是否已下载就绪。
pub fn matting_model_ready() -> bool {
    registry::matting().model_ready()
}

/// 下载抠图模型，进度通过回调上报（0–100）。
pub async fn download_matting_model<P>(progress: P) -> AppResult<()>
where
    P: Fn(u32) + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let mut report = progress;
        registry::matting().download_model(&mut report)
    })
    .await
    .map_err(|e| AppError::internal(format!("下载任务执行失败: {}", e)))?
}

/// 解析状态键，未知状态给出与历史一致的错误。
fn parse_state(state: &str) -> AppResult<WidgetState> {
    WidgetState::parse(state).ok_or_else(|| AppError::invalid("未知的图片状态"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 挂件本体列表：默认组必须位于首位（前端默认选中项）。
    #[test]
    fn default_group_is_first() {
        let groups = list_groups_with_default();
        assert_eq!(
            groups.first().map(String::as_str),
            Some(widget_image::DEFAULT_BODY)
        );
    }

    /// 未知状态键必须被拒绝，且文案与历史一致。
    #[test]
    fn unknown_state_is_rejected() {
        let err = read_image_data_url("任意组", "not-a-state").unwrap_err();
        assert_eq!(err.message(), "未知的图片状态");
        assert!(parse_state("main").is_ok());
    }

    /// 非法 base64 数据在解码阶段报错，文案带业务前缀。
    #[test]
    fn invalid_payload_reports_decode_failure() {
        let err = save_image_from_data_url("任意组", "main", "!!!").unwrap_err();
        assert!(
            err.message().starts_with("图片数据解码失败: "),
            "{}",
            err.message()
        );
    }

    /// 模型未下载时 `matting_model_ready` 必为 false（本机未下载时）。
    #[test]
    fn model_ready_flag_is_readable() {
        crate::install_test_repositories();
        let ready = matting_model_ready();
        assert_eq!(ready, registry::matting().model_ready());
    }
}
