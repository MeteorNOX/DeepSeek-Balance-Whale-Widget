//! 供应商相关命令
//!
//! 供应商列表的增删改查、应用（把配置写进客户端真实文件）、连通性测试与用量报表。
//!
//! 数据落盘在 `<数据目录>/supplier/<scope>/`（见 `infrastructure::repository::supplier::supplier_store`），
//! 业务判断全部在 `application::supplier::service`，本层只做三件事：
//! 线缆 DTO ↔ 领域 DTO 的转换、事件广播、统一返回。
//!
//! # 两套契约
//! 磁盘结构（`domain::supplier::model`）是 snake_case，前端契约（本模块的线缆 DTO）
//! 是 camelCase：转换只发生在这一层，改前端字段名不会动摇磁盘格式，反之亦然。

use chrono::NaiveDate;
use tauri::{AppHandle, Emitter};

use crate::api::dto::supplier::{
    ApplyResultDto, ClientTabDto, RenderedFileDto, SupplierCardDto, SupplierDetailDto,
    SupplierSaveDto,
};
use crate::application::supplier::result::SupplierSaveOutcome;
use crate::application::supplier::service;
use crate::application::routing;
use crate::application::usage;
use crate::domain::supplier::model::{ConnectionTestResult, UsageReport};
use crate::domain::supplier::service::supplier_service::BALANCE_SCOPE;
use crate::types::common::constants::EVENT_BALANCE_REFRESH_REQUESTED;
use crate::types::exception::{guard, AppError, IntoWire};

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 列出已登记客户端（含表单元数据）。
///
/// 前端在标签栏自行在最前面加「余额配置」（scope = `balance`）。
#[tauri::command]
pub fn list_supplier_clients() -> Vec<ClientTabDto> {
    service::list_clients()
        .into_iter()
        .map(ClientTabDto::from)
        .collect()
}

/// 列出某 scope 下的供应商卡片。
///
/// 语义是「列表展示」：失败时返回空数组并留日志，与既有 `list_*` 命令一致。
#[tauri::command]
pub fn list_suppliers(scope: String) -> Vec<SupplierCardDto> {
    match service::list_cards(&scope) {
        Ok(cards) => cards.into_iter().map(SupplierCardDto::from).collect(),
        Err(err) => {
            log::warn!("列出供应商失败（{}）：{}", scope, err);
            Vec::new()
        }
    }
}

/// 读取供应商详情（编辑弹窗预填）。
#[tauri::command]
pub fn get_supplier(scope: String, slug: String) -> Result<SupplierDetailDto, String> {
    guard::catch(|| service::get_detail(&scope, &slug))
        .map(SupplierDetailDto::from)
        .into_wire()
}

/// 新建或编辑供应商。
#[tauri::command]
pub fn save_supplier(
    app: AppHandle,
    payload: SupplierSaveDto,
) -> Result<SupplierDetailDto, String> {
    guard::catch(|| service::save_supplier(payload.into()))
        .inspect(|outcome| {
            // 改动的是余额配置列表的**当前启用项**、且密钥或请求地址发生变化：
            // 这两项一变，界面上显示的余额就不再代表当前数据源，必须让前端作废重取
            // （载荷 `true`）。编辑非启用项时该标记为 false，不打扰显示。
            if outcome.balance_source_changed {
                let _ = app.emit(EVENT_BALANCE_REFRESH_REQUESTED, true);
            }
        })
        .map(|outcome: SupplierSaveOutcome| SupplierDetailDto::from(outcome.detail))
        .into_wire()
}

/// 删除供应商（启用中被拦截，返回错误文案）。
#[tauri::command]
pub fn delete_supplier(app: AppHandle, scope: String, slug: String) -> Result<(), String> {
    let outcome = delete_supplier_inner(&scope, &slug);
    // 删除的是余额配置列表的供应商：余额数据源可能已消失，通知前端重新拉取。
    //
    // 载荷 `false`：启用项本身不允许被删除（见领域层校验），因此当前余额来源没变，
    // 已显示的数值仍然有效。
    if outcome.is_ok() && scope.trim() == BALANCE_SCOPE {
        let _ = app.emit(EVENT_BALANCE_REFRESH_REQUESTED, false);
    }
    outcome
}

/// 删除主体（命令层只做转交与广播，便于在无窗口环境下单测）。
fn delete_supplier_inner(scope: &str, slug: &str) -> Result<(), String> {
    guard::catch(|| service::delete_supplier(scope, slug)).into_wire()
}

/// 应用：设为该列表当前启用项；客户端 scope 同时写入客户端配置文件。
#[tauri::command]
pub fn apply_supplier(
    app: AppHandle,
    scope: String,
    slug: String,
) -> Result<ApplyResultDto, String> {
    // scope 归一化（首尾空白由用例层裁剪）之前先判定是否余额配置列表，供事件广播使用。
    let balance_scope = scope.trim() == BALANCE_SCOPE;
    // 切换前的启用项：只有它真的换了，已显示的余额才失效。
    let previous_active = if balance_scope {
        service::read_active(BALANCE_SCOPE).ok().flatten()
    } else {
        None
    };
    guard::catch(|| service::apply_supplier(&scope, &slug))
        .inspect(|_| {
            if balance_scope {
                // 载荷 `true` = 换源（前端必须作废旧数值并显示「--」）；
                // 重复应用同一个供应商时启用项没变，载荷 false，不打扰显示。
                let current = service::read_active(BALANCE_SCOPE).ok().flatten();
                let _ = app.emit(EVENT_BALANCE_REFRESH_REQUESTED, previous_active != current);
            }
        })
        .map(|outcome| ApplyResultDto::new(scope, slug, &outcome))
        .into_wire()
}

/// 连通性测试（含毫秒耗时）。
#[tauri::command]
pub async fn test_supplier(scope: String, slug: String) -> ConnectionTestResult {
    usage::service::test_connection(&scope, &slug).await
}

/// 用量报表（在线优先、本地兜底）。
#[tauri::command]
pub async fn get_supplier_usage(scope: String, slug: String) -> Result<UsageReport, String> {
    usage::service::get_usage_report(&scope, &slug)
        .await
        .into_wire()
}

/// 用量报表（只读本地历史，不触网）。
///
/// 详细账单窗口先用它把图与账单画出来（一次文件读取），随后再调
/// [`get_supplier_usage`] 用在线结果覆盖，用户不必盯着空白面板等接口往返。
#[tauri::command]
pub fn get_supplier_usage_cached(scope: String, slug: String) -> Result<UsageReport, String> {
    guard::catch(|| usage::service::cached_usage_report(&scope, &slug)).into_wire()
}

/// 按界面所选**时间段**重新取数并落盘（日期筛选器联动）。
///
/// `start` / `end` 是本地日期 `YYYY-MM-DD`（含端点）。日期解析放在这一层：
/// 前端传的是界面上的日期串，解析失败直接给出可展示的错误，不进用例层。
#[tauri::command]
pub async fn refresh_supplier_usage(
    scope: String,
    slug: String,
    start: String,
    end: String,
) -> Result<UsageReport, String> {
    let parsed = || -> Result<(NaiveDate, NaiveDate), AppError> {
        let start = parse_date(&start).ok_or_else(|| AppError::invalid("起始日期格式应为 YYYY-MM-DD"))?;
        let end = parse_date(&end).ok_or_else(|| AppError::invalid("结束日期格式应为 YYYY-MM-DD"))?;
        Ok((start, end))
    };
    let (start, end) = match parsed() {
        Ok(range) => range,
        Err(err) => return Err(err.message().to_string()),
    };
    usage::service::refresh_usage_window(&scope, &slug, start, end)
        .await
        .into_wire()
}

/// 解析 `YYYY-MM-DD` 日期串（不做时区换算，纯本地日历日）。
fn parse_date(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d").ok()
}

/// 实时渲染预览（用界面草稿，不落盘）。
#[tauri::command]
pub fn preview_supplier_config(payload: SupplierSaveDto) -> Result<Vec<RenderedFileDto>, String> {
    guard::catch(|| service::preview_supplier(&payload.into()))
        .map(|files| files.iter().map(RenderedFileDto::from).collect())
        .into_wire()
}

/// 读取客户端当前实盘配置内容。
#[tauri::command]
pub fn read_client_config(client_id: String) -> Result<Vec<RenderedFileDto>, String> {
    guard::catch(|| routing::service::read_live(&client_id))
        .map(|files| files.iter().map(RenderedFileDto::from).collect())
        .into_wire()
}

/// 读取某客户端的「通用配置片段」（尚未配置时返回空串）。
#[tauri::command]
pub fn get_common_config(scope: String) -> Result<String, String> {
    guard::catch(|| routing::service::read_common_config(&scope)).into_wire()
}

/// 保存某客户端的「通用配置片段」（保存前校验 TOML 语法）。
#[tauri::command]
pub fn save_common_config(scope: String, snippet: String) -> Result<(), String> {
    guard::catch(|| routing::service::save_common_config(&scope, &snippet)).into_wire()
}

/// 从「当前编辑中的配置文件内容」提取通用配置片段。
#[tauri::command]
pub fn extract_common_config(scope: String, config_text: String) -> Result<String, String> {
    guard::catch(|| routing::service::extract_common_config(&scope, &config_text)).into_wire()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::api::dto::supplier::{
        ChoiceDto, ModelCatalogEntryDto, ModelSlotDto, OptionDto, RoutingDto, SwitchDto,
    };
    use crate::application::supplier::command::SupplierSaveInput;
    use crate::application::supplier::service::{allocate_slug, resolve_routing};
    use crate::domain::supplier::model::SupplierRouting;
    use crate::types::enums::ErrorCode;
    use crate::types::exception::AppError;

    fn sample_card() -> SupplierCardDto {
        SupplierCardDto {
            scope: "balance".to_string(),
            slug: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            note: String::new(),
            category: "官方".to_string(),
            logo: "deepseek".to_string(),
            homepage: "https://www.deepseek.com".to_string(),
            api_key_url: "https://platform.deepseek.com/api_keys".to_string(),
            base_url: "https://api.deepseek.com".to_string(),
            active: true,
            created_at: "2026-01-01 00:00:00".to_string(),
        }
    }

    /// 只读命令可直接调用：登记的两个客户端都带齐表单元数据（前端不硬编码客户端字段）。
    #[test]
    fn client_tabs_carry_form_metadata() {
        let clients = list_supplier_clients();
        assert_eq!(clients.len(), 2, "当前登记 claude / codex 两个客户端");
        assert_eq!(
            clients
                .iter()
                .map(|client| client.id.as_str())
                .collect::<Vec<_>>(),
            vec!["claude", "codex"]
        );
        for client in &clients {
            assert!(!client.name.is_empty(), "{} 缺少展示名", client.id);
            assert!(!client.logo.is_empty(), "{} 缺少 logo", client.id);
            assert!(!client.model_slots.is_empty(), "{} 缺少模型槽位", client.id);
            assert!(!client.switches.is_empty(), "{} 缺少开关", client.id);
            for slot in &client.model_slots {
                assert!(!slot.key.is_empty() && !slot.label.is_empty() && !slot.hint.is_empty());
            }
        }

        // 两侧都不再渲染枚举型选项：「思考强度」已按需求从 Codex 界面移除
        // （注册表里仍以默认值参与落盘，但不进线缆契约）。
        assert!(clients[0].options.is_empty());
        assert!(clients[1].options.is_empty());

        // 认证字段：Claude 两项（默认 AUTH_TOKEN），Codex 没有该项。
        let claude = &clients[0];
        assert_eq!(claude.default_auth_field, "ANTHROPIC_AUTH_TOKEN");
        assert_eq!(
            claude
                .auth_fields
                .iter()
                .map(|field| field.value.as_str())
                .collect::<Vec<_>>(),
            vec!["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
        );
        assert!(clients[1].auth_fields.is_empty());
        assert!(clients[1].default_auth_field.is_empty());
    }

    /// 线缆契约：字段名一律 camelCase（前端直接消费），且不得出现 snake_case 键。
    #[test]
    fn wire_dtos_serialize_camel_case() {
        let tab = ClientTabDto {
            id: "codex".to_string(),
            name: "Codex".to_string(),
            logo: "openai".to_string(),
            model_slots: vec![ModelSlotDto {
                key: "primary".to_string(),
                label: "默认模型".to_string(),
                hint: "写入 config.toml 的 model".to_string(),
                placeholder: "deepseek-chat".to_string(),
                display_name: false,
                supports_one_m: false,
            }],
            routing_layout: "catalog".to_string(),
            default_api_format: "openai-responses".to_string(),
            catalog_reasoning_levels: vec![ChoiceDto {
                value: "high".to_string(),
                label: "高".to_string(),
            }],
            auth_fields: vec![ChoiceDto {
                value: "ANTHROPIC_AUTH_TOKEN".to_string(),
                label: "ANTHROPIC_AUTH_TOKEN（默认）".to_string(),
            }],
            default_auth_field: "ANTHROPIC_AUTH_TOKEN".to_string(),
            switches: vec![SwitchDto {
                key: "web_search".to_string(),
                label: "启用联网搜索".to_string(),
                hint: "config.toml: web_search = \"live\"".to_string(),
                default: false,
            }],
            options: vec![OptionDto {
                key: "reasoning_effort".to_string(),
                label: "思考强度".to_string(),
                hint: "config.toml: model_reasoning_effort".to_string(),
                choices: vec![ChoiceDto {
                    value: "high".to_string(),
                    label: "高".to_string(),
                }],
                default: "high".to_string(),
            }],
        };
        let json = serde_json::to_string(&tab).expect("线缆 DTO 必须可序列化");
        assert!(json.contains("\"modelSlots\""), "{}", json);
        assert!(
            json.contains("\"routingLayout\"")
                && json.contains("\"defaultApiFormat\"")
                && json.contains("\"catalogReasoningLevels\""),
            "新增的字段也必须走 camelCase：{}",
            json
        );
        assert!(
            !json.contains("model_slots") && !json.contains("routing_layout"),
            "{}",
            json
        );
        assert!(
            json.contains("\"supportsOneM\""),
            "「支持1M」列开关必须能被前端读到：{}",
            json
        );

        let card = serde_json::to_string(&sample_card()).unwrap();
        assert!(card.contains("\"apiKeyUrl\""), "{}", card);
        assert!(card.contains("\"createdAt\""), "{}", card);
        assert!(
            !card.contains("api_key_url") && !card.contains("created_at"),
            "{}",
            card
        );

        let routing = serde_json::to_string(&RoutingDto {
            client_id: "claude".to_string(),
            model_map: BTreeMap::from([("sonnet".to_string(), "deepseek-chat[1M]".to_string())]),
            display_map: BTreeMap::from([("sonnet".to_string(), "标准档".to_string())]),
            context_window: 200_000,
            compact_token_limit: 900_000,
            model_catalog: vec![ModelCatalogEntryDto {
                display_name: "DeepSeek V4".to_string(),
                model: "deepseek-chat".to_string(),
                context_window: 1_048_576,
                reasoning_levels: vec!["high".to_string()],
            }],
            switches: BTreeMap::from([("hide_attribution".to_string(), true)]),
            options: BTreeMap::new(),
        })
        .unwrap();
        for key in [
            "\"clientId\"",
            "\"modelMap\"",
            "\"displayMap\"",
            "\"contextWindow\"",
            "\"compactTokenLimit\"",
            "\"modelCatalog\"",
        ] {
            assert!(routing.contains(key), "{} 缺少 {}", routing, key);
        }
        for key in [
            "client_id",
            "model_map",
            "display_map",
            "context_window",
            "compact_token_limit",
            "model_catalog",
        ] {
            assert!(!routing.contains(key), "{} 不得出现 {}", routing, key);
        }
    }

    /// 线缆 DTO ↔ 领域 DTO 往返：字段不丢失，磁盘结构（snake_case）不被前端契约牵动。
    #[test]
    fn wire_and_domain_dtos_roundtrip() {
        let save = SupplierSaveDto {
            scope: " claude ".to_string(),
            slug: "suggested".to_string(),
            name: "DeepSeek".to_string(),
            note: "备注".to_string(),
            category: "官方".to_string(),
            logo: "deepseek".to_string(),
            homepage: "https://www.deepseek.com".to_string(),
            api_key_url: "https://platform.deepseek.com/api_keys".to_string(),
            api_key: " sk-x ".to_string(),
            usage_token: " tok-y ".to_string(),
            base_url: "https://api.deepseek.com/anthropic/".to_string(),
            full_url: false,
            api_format: "anthropic".to_string(),
            auth_field: "x-api-key".to_string(),
            endpoint_candidates: vec!["https://api.deepseek.com".to_string()],
            routing: Some(RoutingDto {
                client_id: "codex".to_string(),
                model_map: BTreeMap::from([("primary".to_string(), "deepseek-chat".to_string())]),
                display_map: BTreeMap::from([("primary".to_string(), "DeepSeek V4".to_string())]),
                context_window: 1_000_000,
                compact_token_limit: 900_000,
                model_catalog: vec![ModelCatalogEntryDto {
                    display_name: "DeepSeek V4".to_string(),
                    model: "deepseek-chat".to_string(),
                    context_window: 1_048_576,
                    reasoning_levels: vec!["low".to_string(), "high".to_string()],
                }],
                switches: BTreeMap::from([("web_search".to_string(), true)]),
                options: BTreeMap::from([("reasoning_effort".to_string(), "high".to_string())]),
            }),
        };

        let input = SupplierSaveInput::from(save);
        assert_eq!(input.scope, " claude ");
        assert_eq!(input.slug, "suggested");
        assert_eq!(input.profile.name, "DeepSeek");
        assert_eq!(input.profile.note, "备注");
        assert_eq!(
            input.profile.slug, "",
            "slug 由用例层按分配规则决定，不得沿用前端建议值"
        );
        assert_eq!(input.credential.api_key, " sk-x ");
        assert_eq!(input.credential.usage_token, " tok-y ");
        assert_eq!(
            input.endpoint.base_url,
            "https://api.deepseek.com/anthropic/"
        );
        assert_eq!(input.endpoint.endpoint_candidates.len(), 1);
        let routing = input.routing.expect("客户端列表应带上 routing");
        assert_eq!(routing.client_id, "codex");
        assert_eq!(routing.context_window, 1_000_000);
        assert_eq!(routing.compact_token_limit, 900_000);
        assert_eq!(
            routing.model_map.get("primary").map(String::as_str),
            Some("deepseek-chat")
        );
        assert_eq!(
            routing.display_map.get("primary").map(String::as_str),
            Some("DeepSeek V4")
        );
        assert_eq!(routing.model_catalog.len(), 1, "模型映射不得在转换中丢失");
        assert_eq!(routing.model_catalog[0].model, "deepseek-chat");
        assert_eq!(
            routing.model_catalog[0].reasoning_levels,
            vec!["low".to_string(), "high".to_string()]
        );
        assert_eq!(routing.switches.get("web_search"), Some(&true));
        assert_eq!(
            routing.options.get("reasoning_effort").map(String::as_str),
            Some("high")
        );
    }

    /// slug 分配规则（纯函数：占用现状由测试注入，不触碰任何目录）。
    #[test]
    fn slug_allocation_rules() {
        let taken = |names: &[&str]| {
            names
                .iter()
                .map(|name| name.to_string())
                .collect::<Vec<_>>()
        };

        // 编辑：目录已存在 → 沿用该 slug。
        assert_eq!(
            allocate_slug("deepseek", "任意名称", &taken(&["deepseek", "kimi"])).unwrap(),
            "deepseek"
        );
        // 新建：无建议 slug 时由名称派生；有建议值时优先用建议值。
        assert_eq!(
            allocate_slug("", "DeepSeek API", &taken(&[])).unwrap(),
            "deepseek-api"
        );
        assert_eq!(
            allocate_slug("suggested", "另一个名称", &taken(&[])).unwrap(),
            "suggested"
        );
        // 基名冲突 → 依次尝试 `-2` / `-3`。
        assert_eq!(
            allocate_slug("", "DeepSeek", &taken(&["deepseek"])).unwrap(),
            "deepseek-2"
        );
        assert_eq!(
            allocate_slug("", "DeepSeek", &taken(&["deepseek", "deepseek-2"])).unwrap(),
            "deepseek-3"
        );
        // 纯中文名派生出空基名 → `custom-N`（该列表内第一个未占用的序号）。
        assert_eq!(
            allocate_slug("", "自定义供应商", &taken(&[])).unwrap(),
            "custom-1"
        );
        assert_eq!(
            allocate_slug("", "自定义供应商", &taken(&["custom-1", "custom-2"])).unwrap(),
            "custom-3"
        );
        // 非法建议 slug 按标识校验拒绝，而不是悄悄换一个标识。
        assert!(allocate_slug("My Supplier", "x", &taken(&[])).is_err());

        // 冲突次数用尽：报冲突错误，而不是无限试探。
        let mut exhausted = vec!["deepseek".to_string()];
        for index in 2..=101 {
            exhausted.push(format!("deepseek-{}", index));
        }
        let err = allocate_slug("", "DeepSeek", &exhausted).unwrap_err();
        assert_eq!(err.code(), ErrorCode::Conflict);
        assert!(err.message().contains("deepseek"), "{}", err.message());
    }

    /// 余额配置列表不参与模型路由：前端多传 routing 被忽略且不报错。
    #[test]
    fn balance_scope_ignores_routing() {
        let routing = SupplierRouting {
            client_id: "claude".to_string(),
            ..SupplierRouting::default()
        };
        assert!(
            resolve_routing(BALANCE_SCOPE, Some(routing.clone())).is_none(),
            "余额配置列表必须忽略 routing"
        );
        assert!(resolve_routing(BALANCE_SCOPE, None).is_none());

        // 客户端列表：没有 routing 时补一个「属于该客户端」的默认值。
        let filled = resolve_routing("claude", None).expect("客户端列表应有路由配置");
        assert_eq!(filled.client_id, "claude");
        assert!(filled.model_map.is_empty());
        // 已给 routing 时原样转交（client_id 由存储层以 scope 目录名为准覆盖）。
        assert_eq!(
            resolve_routing("codex", Some(routing))
                .expect("客户端列表应有路由配置")
                .client_id,
            "claude"
        );
    }

    /// 删除：用例层的错误被转成 `Err(String)`，启用中拦截的文案不得被包装或改写。
    #[test]
    fn delete_error_is_wired_as_string() {
        assert!(delete_supplier_inner("balance", "../escape").is_err());
        assert_eq!(
            Err::<(), _>(AppError::invalid("该供应商正在使用中，请先切换后再删除")).into_wire(),
            Err("该供应商正在使用中，请先切换后再删除".to_string())
        );
    }
}
