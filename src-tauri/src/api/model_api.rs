//! 模型列表相关命令
//!
//! 只服务于「获取模型列表」按钮：按界面上的草稿（请求地址 / API Key / API 格式 /
//! 预设声明的模型列表地址）去供应商的模型接口取可用模型，供用户在下拉里挑选。
//!
//! 入参与错误文案都是前端契约：密钥不可用时返回 `API Key无效或无权限`，
//! 所有候选地址都 404 时返回 `未找到模型列表接口，请检查请求地址`
//! （见 `domain::supplier::service::model_service`）。

use crate::api::dto::model::FetchModelsDto;
use crate::application::model::service;
use crate::types::exception::IntoWire;

/// 获取某供应商的可用模型名（去重、按字典序排序）。
///
/// 入参全部来自界面草稿：用户还没点保存也能取列表，因此本命令不读写任何本地文件。
#[tauri::command]
pub async fn fetch_models(payload: FetchModelsDto) -> Result<Vec<String>, String> {
    service::fetch_models(&payload.into())
        .await
        .into_wire()
}
