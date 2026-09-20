//! 连通性测试结果 DTO（**线上面向前端的契约，不落盘**）
//!
//! 配置界面的「测试连接」按钮直接展示这里的字段，因此字段名采用前端契约（camelCase）。
//! 测试本身属于用例（`application::usage::service`），本文件只描述结果形状。

use serde::Serialize;

/// 连通性测试结果（前端契约，camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    /// 是否连通。
    pub ok: bool,
    /// 实时响应耗时（毫秒）。
    pub latency_ms: u64,
    /// 可展示的结果文案。
    pub message: String,
    /// 测试实际使用的地址（便于用户核对）。
    pub url: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_serializes_camel_case() {
        let result = ConnectionTestResult {
            ok: true,
            latency_ms: 123,
            message: "连接成功".to_string(),
            url: "https://api.deepseek.com/user/balance".to_string(),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"latencyMs\":123"), "{}", json);
        assert!(!json.contains("latency_ms"), "{}", json);
    }
}
