//! 供应商密钥 DTO（`credential.json`）
//!
//! 密钥单独成文件，使「展示信息」可以脱离密钥被读取与传递（如索引、列表）。
//!
//! 这里存**两套凭证**，接口层面互不通用：
//! - [`SupplierCredential::api_key`]：官方 API 的密钥（`sk-…`），官方接口只认它；
//! - [`SupplierCredential::usage_token`]：网页控制台登录后下发的会话令牌，控制台内部
//!   用量接口（如 DeepSeek `api/v0/usage/*`）只认它——用 API Key 调会被拒
//!   （实测 `{"code":40003,"msg":"Authorization Failed (invalid token)"}`）。
//!
//! 用量查询配置用 `token_source` 声明该请求该用哪一套，见
//! [`crate::domain::supplier::model::usage_query::SupplierUsageQuery::token_source`]。

use serde::{Deserialize, Serialize};

use super::super::usage_query::TOKEN_SOURCE_USAGE_TOKEN;

/// 供应商凭证（明文，与 `config.json` 同级安全策略）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SupplierCredential {
    /// API Key。
    pub api_key: String,
    /// 平台登录令牌（网页控制台会话令牌）。
    ///
    /// 只用于控制台内部用量接口；缺失时相关查询会给出「未配置平台登录令牌」，
    /// 而不是拿 API Key 去试（那只会得到 40003 而让用户以为是密钥写错了）。
    pub usage_token: String,
}

impl SupplierCredential {
    /// 按配置里的 `token_source` 取对应凭证的明文值。
    ///
    /// 取值后都会 trim：用户从浏览器复制令牌时极易带上首尾空白或换行。
    pub fn token_for(&self, token_source: &str) -> &str {
        if token_source.trim() == TOKEN_SOURCE_USAGE_TOKEN {
            self.usage_token.trim()
        } else {
            self.api_key.trim()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// token_source 决定用哪套凭证；未知取值一律按 API Key（向后兼容默认值）。
    #[test]
    fn token_source_selects_credential() {
        let credential = SupplierCredential {
            api_key: "  sk-1  ".to_string(),
            usage_token: " tok-1\n".to_string(),
        };
        assert_eq!(credential.token_for("usage_token"), "tok-1");
        assert_eq!(credential.token_for("api_key"), "sk-1");
        assert_eq!(credential.token_for(""), "sk-1");
        assert_eq!(credential.token_for("unknown"), "sk-1");
    }
}
