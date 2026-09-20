//! 模型列表用例
//!
//! 「获取模型列表」按界面草稿取数（地址 / 密钥 / API 格式都由用户当场填），因此用例
//! 只做一次转交，不需要读写任何本地文件：真正的规则在 `domain::supplier::service::model_service`，
//! 请求由基础设施实现（`infrastructure::http::model_client`），
//! 本层经由装配注册表拿到端口 `domain::supplier::repository::ModelCatalogRepository`。

use crate::application::model::command::ModelFetchInput;
use crate::application::registry;
use crate::types::exception::AppResult;

/// 读取可用模型名（去重、按字典序排序）。
///
/// 未填写请求地址时返回「请先填写请求地址」；密钥未填或无效时返回
/// `model_service::MSG_INVALID_API_KEY`（界面直接展示这两句文案）。
pub async fn fetch_models(input: &ModelFetchInput) -> AppResult<Vec<String>> {
    let models_url = input.models_url.trim();
    registry::model_catalog()
        .fetch_models(
            &input.base_url,
            &input.api_key,
            &input.api_format,
            input.full_url,
            (!models_url.is_empty()).then_some(models_url),
        )
        .await
}
