//! 模型路由用例
//!
//! 把某个客户端列表（scope = 客户端 id）下**被应用**的供应商配置，合并式写入该客户端的
//! 真实配置文件，并支持在界面上实时预览将要写入的 JSON / TOML。
//!
//! # 三个入口的取舍
//! - [`preview_saved`] / [`preview_draft`]：只渲染（读实盘 + 合并），**不落盘**。
//!   预览与真正写入用的是同一段渲染代码，因此「预览看到什么，落盘就是什么」；
//!   `preview_draft` 直接吃界面草稿，用户还没点保存就能看到最终文件长什么样。
//! - [`read_live`]：读实盘当前生效的配置（不合并、不改写），供界面做「当前 vs 将要」对比。
//! - [`apply`]：**先写文件、后标记启用**。写文件失败就不能标记为已启用，否则界面会显示
//!   「已应用」而实际没生效；反过来，文件写成功了标记失败，界面重新读取时也会自愈。
//!
//! 余额配置列表（`balance`）只查余额 / 用量，不参与模型路由，因此所有入口一律拒绝它。
//!
//! 命令层接入见 `api::supplier_api`（应用 / 预览 / 读取实盘）。

use crate::domain::client::model::valobj::{ClientRenderInput, ClientWriteOutcome, RenderedFile};
use crate::domain::supplier::model::SupplierRouting;
use crate::domain::supplier::service::supplier_service::{self, BALANCE_SCOPE};
use crate::types::exception::{AppError, AppResult};
use crate::application::registry;

/// 从已保存的供应商配置渲染预览（不落盘）。
///
/// 命令层的预览命令走 [`preview_draft`]（界面草稿），因此本入口当前只由回归测试消费：
/// 它保证「预览与落盘同一段渲染代码」这条约定在「已保存配置」这条路径上同样成立
/// （命令层按需接入时直接可用），故保留豁免。
#[allow(dead_code)]
pub fn preview_saved(scope: &str, slug: &str) -> AppResult<Vec<RenderedFile>> {
    let scope = routable_scope(scope)?;
    let input = load_input(&scope, slug)?;
    registry::client_config().render(&scope, &input)
}

/// 用界面草稿（未保存）渲染预览（不落盘）。
pub fn preview_draft(client_id: &str, input: &ClientRenderInput) -> AppResult<Vec<RenderedFile>> {
    let client_id = routable_scope(client_id)?;
    registry::client_config().render(&client_id, input)
}

/// 读取实盘当前内容。
pub fn read_live(client_id: &str) -> AppResult<Vec<RenderedFile>> {
    let client_id = routable_scope(client_id)?;
    registry::client_config().read_live(&client_id)
}

// ---------------------------------------------------------------------------
// 通用配置片段（只有登记了「应用通用配置」开关的客户端才有，目前是 Codex）
// ---------------------------------------------------------------------------

/// 读取某客户端的通用配置片段（尚未配置时返回空串）。
pub fn read_common_config(scope: &str) -> AppResult<String> {
    let scope = routable_scope(scope)?;
    registry::supplier().read_common_config(&scope)
}

/// 保存某客户端的通用配置片段（先校验语法：写进去的必须是能解析的 TOML）。
pub fn save_common_config(scope: &str, snippet: &str) -> AppResult<()> {
    let scope = routable_scope(scope)?;
    registry::client_config().validate_common_config(&scope, snippet)?;
    registry::supplier().save_common_config(&scope, snippet)
}

/// 从「当前编辑中的配置文件内容」提取通用部分（用户点「从编辑内容提取」时调用）。
pub fn extract_common_config(scope: &str, config_text: &str) -> AppResult<String> {
    let scope = routable_scope(scope)?;
    registry::client_config().extract_common_config(&scope, config_text)
}

/// 应用：把该供应商设为所属客户端列表的当前启用项，并把配置写入客户端真实文件。
pub fn apply(scope: &str, slug: &str) -> AppResult<ClientWriteOutcome> {
    let scope = routable_scope(scope)?;
    let input = load_input(&scope, slug)?;
    let outcome = registry::client_config().write(&scope, &input)?;
    // 写盘成功后才标记启用：顺序反了会让界面显示「已应用」而实际未生效。
    registry::supplier().set_active(&scope, slug)?;
    Ok(outcome)
}

/// 校验参与模型路由的 scope：非法标识与余额配置列表都在这里被拒绝。
fn routable_scope(scope: &str) -> AppResult<String> {
    let scope = supplier_service::validate_scope(scope)?;
    if scope == BALANCE_SCOPE {
        return Err(AppError::invalid("余额配置列表不支持模型路由"));
    }
    Ok(scope)
}

/// 读取该供应商的完整配置并组装渲染输入。
///
/// 请求地址在这里就校验：把它写进用户的客户端配置是「有去无回」的操作，
/// 与其写出一个空地址，不如让用户先补全供应商配置。
fn load_input(scope: &str, slug: &str) -> AppResult<ClientRenderInput> {
    let profile = registry::supplier().read_profile(scope, slug)?;
    let credential = registry::supplier().read_credential(scope, slug)?;
    let endpoint = registry::supplier().read_endpoint(scope, slug)?;
    let routing = load_routing(scope, slug)?;
    supplier_service::validate_endpoint(&endpoint)?;

    Ok(ClientRenderInput {
        base_url: endpoint.base_url,
        api_key: credential.api_key,
        api_format: endpoint.api_format,
        auth_field: endpoint.auth_field,
        routing,
        supplier_name: profile.name,
        common_config: registry::supplier().read_common_config(scope)?,
    })
}

/// 读取模型路由；文件缺失（尚未配置）时给出「属于该客户端」的默认值。
fn load_routing(scope: &str, slug: &str) -> AppResult<SupplierRouting> {
    let mut routing = registry::supplier().read_routing(scope, slug)?;
    // 目录名是唯一事实来源：把 scope 作为客户端标识兜底，避免空 client_id 流出。
    if routing.client_id.is_empty() {
        routing.client_id = scope.to_string();
    }
    Ok(routing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn draft() -> ClientRenderInput {
        ClientRenderInput {
            base_url: "https://api.deepseek.com/anthropic".to_string(),
            api_key: "sk-x".to_string(),
            api_format: "anthropic".to_string(),
            auth_field: "ANTHROPIC_AUTH_TOKEN".to_string(),
            routing: SupplierRouting {
                client_id: "claude".to_string(),
                model_map: BTreeMap::from([("sonnet".to_string(), "deepseek-chat".to_string())]),
                ..SupplierRouting::default()
            },
            supplier_name: "DeepSeek".to_string(),
            common_config: String::new(),
        }
    }

    /// 9. 余额配置列表不参与模型路由：写文件、预览、读实盘一律拒绝。
    #[test]
    fn balance_scope_is_rejected_everywhere() {
        for err in [
            apply(BALANCE_SCOPE, "deepseek").unwrap_err(),
            preview_saved(BALANCE_SCOPE, "deepseek").unwrap_err(),
            preview_draft(BALANCE_SCOPE, &draft()).unwrap_err(),
            read_live(BALANCE_SCOPE).unwrap_err(),
        ] {
            assert_eq!(err.message(), "余额配置列表不支持模型路由");
        }

        // 前后空白会被裁掉，仍是余额配置列表。
        assert_eq!(
            read_live(" balance ").unwrap_err().message(),
            "余额配置列表不支持模型路由"
        );
        // 非法 scope 走「列表标识」那套校验（与存储层同一套规则），不触碰磁盘。
        for bad in ["../escape", "Balance", ""] {
            let err = read_live(bad).unwrap_err();
            assert!(
                err.message().starts_with("列表标识"),
                "「{}」应被列表标识校验拦下：{}",
                bad,
                err.message()
            );
        }
    }

    /// 未登记客户端不会写出任何文件。
    #[test]
    fn unknown_client_drafts_are_rejected() {
        crate::install_test_repositories();
        assert_eq!(
            preview_draft("gemini", &draft()).unwrap_err().message(),
            "未登记的客户端：gemini"
        );
        assert_eq!(
            read_live("unknown").unwrap_err().message(),
            "未登记的客户端：unknown"
        );
    }
}
