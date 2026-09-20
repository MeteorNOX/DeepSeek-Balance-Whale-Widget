//! 模型列表接口的线缆 DTO

use crate::application::model::command::ModelFetchInput;

/// 取模型列表入参（线缆 DTO，camelCase 与前端一一对应）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsDto {
    /// 请求地址。
    pub base_url: String,
    /// API 密钥。
    pub api_key: String,
    /// API 协议格式（决定鉴权头）。
    pub api_format: String,
    /// 请求地址是否为完整 URL；旧请求不带该字段时按根地址处理。
    #[serde(default)]
    pub full_url: bool,
    /// 预设里显式声明的模型列表地址（可选）。
    #[serde(default)]
    pub models_url: String,
}

impl From<FetchModelsDto> for ModelFetchInput {
    fn from(dto: FetchModelsDto) -> Self {
        Self {
            base_url: dto.base_url,
            api_key: dto.api_key,
            api_format: dto.api_format,
            full_url: dto.full_url,
            models_url: dto.models_url,
        }
    }
}
