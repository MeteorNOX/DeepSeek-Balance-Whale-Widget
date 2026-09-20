//! 模型列表查询客户端（`/v1/models`）
//!
//! 只做「发请求 + 读响应」：候选地址、鉴权头、响应解析与失败分类都在
//! `domain::supplier::service::model_service`（纯规则，可离线单测），本模块不做任何业务判断。
//!
//! # 与 cc-switch 对齐的两点
//! - **鉴权头由 API 格式决定**（Anthropic → `x-api-key`，Gemini → `x-goog-api-key`，
//!   其余 → `Authorization: Bearer`），而不是读「认证字段」配置：网关认的是协议；
//! - **候选地址逐个尝试**，且只有路径 / 方法不对（404 / 405）才换下一个；
//!   密钥问题（401 / 403）与网络失败立刻返回——换个地址也不会变好。

use std::time::Duration;

use crate::domain::supplier::service::model_service::{self, AuthHeader, MSG_INVALID_API_KEY};
use crate::types::enums::ErrorCode;
use crate::types::exception::{AppError, AppResult};

/// 获取模型列表的超时：列表接口很快，等太久只会让界面卡住（与 cc-switch 同为 15s）。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 读取供应商可用的模型名（去重排序）。
///
/// 入参都取自界面草稿（用户还没保存也能取列表），因此不做任何落盘读写：
/// - `api_format` 决定鉴权头；
/// - `is_full_url` 表示 `base_url` 是完整请求地址（会先截到根地址）；
/// - `models_url` 是预设里显式声明的模型列表地址（非空则只用它）。
pub async fn fetch_models(
    base_url: &str,
    api_key: &str,
    api_format: &str,
    is_full_url: bool,
    models_url: Option<&str>,
) -> AppResult<Vec<String>> {
    let candidates = model_service::models_url_candidates(base_url, is_full_url, models_url)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        // 没填 Key 与 Key 不对，对用户是同一件事：这个 Key 用不了。
        return Err(AppError::new(ErrorCode::NoApiKey, MSG_INVALID_API_KEY));
    }

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| AppError::network(format!("HTTP 客户端初始化失败：{}", e)))?;
    let header = model_service::auth_header_for(api_format);

    let mut last: Option<AppError> = None;
    for url in &candidates {
        match send(&client, url, api_key, header).await {
            Ok(models) => return Ok(models),
            Err(err) if model_service::should_try_next_candidate(&err) => last = Some(err),
            Err(err) => return Err(err),
        }
    }
    // 候选全部 404 / 405：地址不对（没有其它候选可试了）。
    Err(last.unwrap_or_else(|| AppError::external(model_service::MSG_ENDPOINT_NOT_FOUND)))
}

/// 发一次请求并解析响应。
async fn send(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    header: AuthHeader,
) -> AppResult<Vec<String>> {
    let request = client.get(url).header("Accept", "application/json");
    let request = match header {
        AuthHeader::Named(name) => request.header(name, api_key),
        AuthHeader::Bearer => request.header("Authorization", format!("Bearer {}", api_key)),
    };

    let response = request
        .send()
        .await
        .map_err(|e| AppError::network(format!("获取模型列表失败：{}", e)).transient())?;
    let status = response.status();
    if !status.is_success() {
        return Err(model_service::http_failure(status.as_u16()));
    }
    let body = response
        .text()
        .await
        .map_err(|e| AppError::network(format!("读取模型列表响应失败：{}", e)).transient())?;
    model_service::parse_models_response(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 入参校验先于网络：地址或密钥不合格时直接给出结论，不发任何请求。
    #[tokio::test]
    async fn invalid_input_fails_before_requesting() {
        let empty_url = fetch_models("   ", "sk-x", "anthropic", false, None)
            .await
            .unwrap_err();
        assert_eq!(empty_url.message(), model_service::MSG_MISSING_BASE_URL);
        assert_eq!(empty_url.code(), ErrorCode::InvalidInput);

        let empty_key = fetch_models("https://api.example.com", "  ", "anthropic", false, None)
            .await
            .unwrap_err();
        assert_eq!(empty_key.message(), MSG_INVALID_API_KEY);
        assert_eq!(empty_key.code(), ErrorCode::NoApiKey);
    }

    /// 预设给了模型列表地址时只用它一条（不再尝试其它候选）。
    #[tokio::test]
    async fn models_url_override_wins_over_candidates() {
        // 用一个必然连接失败的本机端口：这里只验证「走到请求这一步」而不是被候选逻辑拦下。
        let err = fetch_models(
            "https://api.deepseek.com/anthropic",
            "sk-x",
            "anthropic",
            false,
            Some("http://127.0.0.1:9/models"),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), ErrorCode::Network);
    }
}
