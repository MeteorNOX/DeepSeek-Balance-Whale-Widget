//! 版本清单客户端
//!
//! 只负责「取回远端最新版本号」；是否已是最新的判定属于领域规则，
//! 见 `domain::update::service::update_service`。

use serde_json::Value;
use std::time::Duration;

use crate::types::exception::{AppError, AppResult};

/// 远端版本清单地址。
const VERSION_URL: &str = "https://www.xiaolin.help/update/dswDesktopVersion.json";

/// 请求超时。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// 请求远端版本清单，返回最新版本号。
pub async fn fetch_latest_version() -> AppResult<String> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| AppError::network(format!("HTTP 客户端初始化失败: {}", e)))?;

    let resp = client
        .get(VERSION_URL)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::network(format!("版本检查请求失败: {}", e)))?;

    if !resp.status().is_success() {
        return Err(AppError::external(format!(
            "版本检查请求失败: HTTP {}",
            resp.status().as_u16()
        )));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| AppError::network(format!("读取版本响应失败: {}", e)))?;

    parse_latest_version(&body)
}

/// 解析版本清单响应，提取 `latestVersion`。
fn parse_latest_version(body: &Value) -> AppResult<String> {
    body.get("latestVersion")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::external("版本接口返回结构异常"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_latest_version() {
        let body = json!({ "latestVersion": "1.2.3" });
        assert_eq!(parse_latest_version(&body).unwrap(), "1.2.3");
    }

    /// 结构异常必须给出确定性错误，而不是 panic 或空版本号。
    #[test]
    fn rejects_broken_shapes() {
        for body in [
            json!({}),
            json!({ "latestVersion": 123 }),
            json!({ "latestVersion": null }),
            json!([]),
        ] {
            let err = parse_latest_version(&body).expect_err("结构异常应报错");
            assert_eq!(err.message(), "版本接口返回结构异常");
        }
    }
}
