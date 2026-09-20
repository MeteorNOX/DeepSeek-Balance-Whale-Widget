//! 供应商接口的线缆 DTO（camelCase）
//!
//! 前端契约与磁盘结构是两套东西：磁盘（`domain::supplier::model`）是 snake_case，
//! 前端读的是这里的 camelCase 字段。转换只发生在本模块的 `From` 实现里，
//! 因此改前端字段名不会动摇磁盘格式，反之亦然。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::application::supplier::command::SupplierSaveInput;
use crate::application::supplier::result::{SupplierCard, SupplierDetail};
use crate::domain::client::model::valobj::{ClientWriteOutcome, RenderedFile};
use crate::domain::client::service::client_service::ClientDescriptor;
use crate::domain::supplier::model::{
    ModelCatalogEntry, SupplierCredential, SupplierEndpoint, SupplierProfile, SupplierRouting,
};

/// 客户端标签：界面渲染表单所需的全部元数据（前端不硬编码任何客户端字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientTabDto {
    /// 客户端标识（同时也是 scope 目录名）。
    pub id: String,
    /// 界面展示名。
    pub name: String,
    /// logo 资源名（对应 `frontend/assets/logos/<logo>.*`）。
    pub logo: String,
    /// 可映射的模型槽位（按界面顺序）。
    pub model_slots: Vec<ModelSlotDto>,
    /// 模型路由的界面形态：`roles`（角色表）/ `catalog`（默认模型 + 模型映射）。
    pub routing_layout: String,
    /// 新建供应商时表单默认选中的 API 格式。
    pub default_api_format: String,
    /// 「模型映射」行内「思考等级」的可选档位（空 = 该客户端没有模型映射区）。
    pub catalog_reasoning_levels: Vec<ChoiceDto>,
    /// 认证字段的可选项（空 = 该客户端没有「认证字段」配置项，如 Codex）。
    pub auth_fields: Vec<ChoiceDto>,
    /// 未配置时使用的认证字段（`auth_fields` 为空时无意义）。
    pub default_auth_field: String,
    /// 可配置的布尔开关。
    pub switches: Vec<SwitchDto>,
    /// 可配置的枚举型选项（只含界面上要渲染的那些）。
    pub options: Vec<OptionDto>,
}

/// 模型槽位（落盘为 `routing.model_map` 的键）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSlotDto {
    /// 稳定标识（即 `model_map` 的键）。
    pub key: String,
    /// 界面标签。
    pub label: String,
    /// 字段说明。
    pub hint: String,
    /// 输入框占位示例。
    pub placeholder: String,
    /// 是否有「显示名称」列（落盘为 `routing.displayMap` 的同名键）。
    pub display_name: bool,
    /// 「支持1M」列是否可勾选。
    pub supports_one_m: bool,
}

/// 布尔开关（落盘为 `routing.switches[key]`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchDto {
    /// 稳定标识（即 `switches` 的键）。
    pub key: String,
    /// 界面标签。
    pub label: String,
    /// 字段说明。
    pub hint: String,
    /// 未配置时的默认值。
    pub default: bool,
}

/// 枚举型选项（落盘为 `routing.options[key]`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionDto {
    /// 稳定标识（即 `options` 的键）。
    pub key: String,
    /// 界面标签。
    pub label: String,
    /// 字段说明。
    pub hint: String,
    /// 可选取值。
    pub choices: Vec<ChoiceDto>,
    /// 未配置 / 非法取值时使用的默认值（必为 `choices` 中的一项）。
    pub default: String,
}

/// 选项的一个取值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceDto {
    /// 落盘值。
    pub value: String,
    /// 展示名。
    pub label: String,
}

/// 供应商卡片（列表项，不含密钥）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierCardDto {
    /// 所属列表（scope）。
    pub scope: String,
    /// 供应商标识（目录名）。
    pub slug: String,
    /// 展示名称。
    pub name: String,
    /// 备注。
    pub note: String,
    /// 分类。
    pub category: String,
    /// Logo 标识。
    pub logo: String,
    /// 官网地址。
    pub homepage: String,
    /// API Key 获取页地址。
    pub api_key_url: String,
    /// 请求根地址。
    pub base_url: String,
    /// 是否为该列表的当前启用项。
    pub active: bool,
    /// 创建时间（`YYYY-MM-DD HH:MM:SS`）。
    pub created_at: String,
}

/// 模型路由配置（余额配置列表无此项）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingDto {
    /// 客户端标识（与 scope 目录名一致）。
    pub client_id: String,
    /// 模型映射：模型角色 → 实际请求模型。
    pub model_map: BTreeMap<String, String>,
    /// 菜单显示名：模型角色 → `/model` 菜单里的名字。
    pub display_map: BTreeMap<String, String>,
    /// 上下文窗口（token 数；0 表示沿用客户端默认）。
    pub context_window: u32,
    /// 自动压缩阈值（token 数；0 表示不写该键）。
    pub compact_token_limit: u32,
    /// 模型目录（Codex 的 `model_catalog_json` 内容）。
    pub model_catalog: Vec<ModelCatalogEntryDto>,
    /// 额外开关。
    pub switches: BTreeMap<String, bool>,
    /// 枚举型选项。
    pub options: BTreeMap<String, String>,
}

/// 模型目录条目（Codex「模型映射」表格的一行）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogEntryDto {
    /// 菜单显示名。
    pub display_name: String,
    /// 实际请求模型。
    pub model: String,
    /// 该模型的上下文窗口（token 数；0 表示沿用目录默认）。
    pub context_window: u32,
    /// 该模型声明的思考档位。
    pub reasoning_levels: Vec<String>,
}

/// 供应商完整详情（编辑弹窗预填）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierDetailDto {
    /// 所属列表（scope）。
    pub scope: String,
    /// 供应商标识（目录名）。
    pub slug: String,
    /// 展示名称。
    pub name: String,
    /// 备注。
    pub note: String,
    /// 分类。
    pub category: String,
    /// Logo 标识。
    pub logo: String,
    /// 官网地址。
    pub homepage: String,
    /// API Key 获取页地址。
    pub api_key_url: String,
    /// API 密钥。
    pub api_key: String,
    /// 平台登录令牌（网页控制台会话令牌，供控制台内部用量接口使用）。
    pub usage_token: String,
    /// 请求根地址。
    pub base_url: String,
    /// `base_url` 是否为可直接请求的完整 URL。
    pub full_url: bool,
    /// API 协议格式。
    pub api_format: String,
    /// 认证字段。
    pub auth_field: String,
    /// 候选端点（按优先级排列）。
    pub endpoint_candidates: Vec<String>,
    /// 模型路由；余额配置列表恒为 `None`。
    pub routing: Option<RoutingDto>,
    /// 是否为该列表的当前启用项。
    pub active: bool,
}

/// 保存请求（新建或编辑）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierSaveDto {
    /// 目标列表（scope）。
    pub scope: String,
    /// 空串 = 新建；非空 = 编辑（也可以是新建时给后端建议的 slug 基名）。
    pub slug: String,
    /// 展示名称。
    pub name: String,
    /// 备注。
    pub note: String,
    /// 分类。
    pub category: String,
    /// Logo 标识。
    pub logo: String,
    /// 官网地址。
    pub homepage: String,
    /// API Key 获取页地址。
    pub api_key_url: String,
    /// API 密钥。
    pub api_key: String,
    /// 平台登录令牌（网页控制台会话令牌）；旧请求不带该字段时留空。
    #[serde(default)]
    pub usage_token: String,
    /// 请求根地址。
    pub base_url: String,
    /// `base_url` 是否为可直接请求的完整 URL。
    pub full_url: bool,
    /// API 协议格式。
    pub api_format: String,
    /// 认证字段。
    pub auth_field: String,
    /// 候选端点（按优先级排列）。
    pub endpoint_candidates: Vec<String>,
    /// 模型路由（仅客户端列表适用）。
    pub routing: Option<RoutingDto>,
}

/// 渲染出的目标文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedFileDto {
    /// 目标文件绝对路径。
    pub path: String,
    /// `json` / `toml`。
    pub language: String,
    /// 合并式写入后的完整内容。
    pub content: String,
    /// 原文件是否已存在。
    pub existed: bool,
}

/// 「应用」结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResultDto {
    /// 所属列表（scope）。
    pub scope: String,
    /// 供应商标识。
    pub slug: String,
    /// 本次写入 / 将要生效的文件。
    pub files: Vec<RenderedFileDto>,
    /// 本次产生的备份文件路径。
    pub backups: Vec<String>,
}

// ---------------------------------------------------------------------------
// 线缆 DTO ↔ 领域 DTO / 用例对象
// ---------------------------------------------------------------------------

impl From<ClientDescriptor> for ClientTabDto {
    fn from(client: ClientDescriptor) -> Self {
        Self {
            id: client.id.to_string(),
            name: client.name.to_string(),
            logo: client.logo.to_string(),
            model_slots: client
                .model_slots()
                .iter()
                .map(|slot| ModelSlotDto {
                    key: slot.key.to_string(),
                    label: slot.label.to_string(),
                    hint: slot.hint.to_string(),
                    placeholder: slot.placeholder.to_string(),
                    display_name: slot.display_name,
                    supports_one_m: slot.supports_one_m,
                })
                .collect(),
            routing_layout: client.routing_layout.as_str().to_string(),
            default_api_format: client.default_api_format.to_string(),
            catalog_reasoning_levels: client
                .catalog_reasoning_levels()
                .iter()
                .map(|(value, label)| ChoiceDto {
                    value: (*value).to_string(),
                    label: (*label).to_string(),
                })
                .collect(),
            auth_fields: client
                .auth_fields()
                .iter()
                .map(|field| ChoiceDto {
                    value: field.value.to_string(),
                    label: field.label.to_string(),
                })
                .collect(),
            default_auth_field: client.default_auth_field.to_string(),
            switches: client
                .switches()
                .iter()
                .map(|switch| SwitchDto {
                    key: switch.key.to_string(),
                    label: switch.label.to_string(),
                    hint: switch.hint.to_string(),
                    default: switch.default,
                })
                .collect(),
            options: client
                .options()
                .iter()
                .filter(|option| option.visible)
                .map(|option| OptionDto {
                    key: option.key.to_string(),
                    label: option.label.to_string(),
                    hint: option.hint.to_string(),
                    choices: option
                        .choices
                        .iter()
                        .map(|(value, label)| ChoiceDto {
                            value: (*value).to_string(),
                            label: (*label).to_string(),
                        })
                        .collect(),
                    default: option.default.to_string(),
                })
                .collect(),
        }
    }
}

impl From<SupplierCard> for SupplierCardDto {
    fn from(card: SupplierCard) -> Self {
        Self {
            scope: card.scope,
            slug: card.profile.slug,
            name: card.profile.name,
            note: card.profile.note,
            category: card.profile.category,
            logo: card.profile.logo,
            homepage: card.profile.homepage,
            api_key_url: card.profile.api_key_url,
            base_url: card.endpoint.base_url,
            active: card.active,
            created_at: card.profile.created_at,
        }
    }
}

impl From<SupplierDetail> for SupplierDetailDto {
    fn from(detail: SupplierDetail) -> Self {
        Self {
            scope: detail.scope,
            slug: detail.profile.slug,
            name: detail.profile.name,
            note: detail.profile.note,
            category: detail.profile.category,
            logo: detail.profile.logo,
            homepage: detail.profile.homepage,
            api_key_url: detail.profile.api_key_url,
            api_key: detail.credential.api_key,
            usage_token: detail.credential.usage_token,
            base_url: detail.endpoint.base_url,
            full_url: detail.endpoint.full_url,
            api_format: detail.endpoint.api_format,
            auth_field: detail.endpoint.auth_field,
            endpoint_candidates: detail.endpoint.endpoint_candidates,
            routing: detail.routing.map(RoutingDto::from),
            active: detail.active,
        }
    }
}

impl From<SupplierSaveDto> for SupplierSaveInput {
    fn from(dto: SupplierSaveDto) -> Self {
        Self {
            scope: dto.scope,
            slug: dto.slug,
            // slug / created_at / order 由用例与存储层决定，这里只转交展示字段。
            profile: SupplierProfile {
                name: dto.name,
                note: dto.note,
                category: dto.category,
                logo: dto.logo,
                homepage: dto.homepage,
                api_key_url: dto.api_key_url,
                ..SupplierProfile::default()
            },
            credential: SupplierCredential {
                api_key: dto.api_key,
                usage_token: dto.usage_token,
            },
            endpoint: SupplierEndpoint {
                base_url: dto.base_url,
                full_url: dto.full_url,
                api_format: dto.api_format,
                auth_field: dto.auth_field,
                endpoint_candidates: dto.endpoint_candidates,
            },
            routing: dto.routing.map(SupplierRouting::from),
        }
    }
}

impl From<RoutingDto> for SupplierRouting {
    fn from(dto: RoutingDto) -> Self {
        Self {
            client_id: dto.client_id,
            model_map: dto.model_map,
            display_map: dto.display_map,
            context_window: dto.context_window,
            compact_token_limit: dto.compact_token_limit,
            model_catalog: dto.model_catalog.into_iter().map(Into::into).collect(),
            switches: dto.switches,
            options: dto.options,
        }
    }
}

impl From<SupplierRouting> for RoutingDto {
    fn from(routing: SupplierRouting) -> Self {
        Self {
            client_id: routing.client_id,
            model_map: routing.model_map,
            display_map: routing.display_map,
            context_window: routing.context_window,
            compact_token_limit: routing.compact_token_limit,
            model_catalog: routing.model_catalog.into_iter().map(Into::into).collect(),
            switches: routing.switches,
            options: routing.options,
        }
    }
}

impl From<ModelCatalogEntryDto> for ModelCatalogEntry {
    fn from(dto: ModelCatalogEntryDto) -> Self {
        Self {
            display_name: dto.display_name,
            model: dto.model,
            context_window: dto.context_window,
            reasoning_levels: dto.reasoning_levels,
        }
    }
}

impl From<ModelCatalogEntry> for ModelCatalogEntryDto {
    fn from(entry: ModelCatalogEntry) -> Self {
        Self {
            display_name: entry.display_name,
            model: entry.model,
            context_window: entry.context_window,
            reasoning_levels: entry.reasoning_levels,
        }
    }
}

impl From<&RenderedFile> for RenderedFileDto {
    fn from(file: &RenderedFile) -> Self {
        Self {
            path: file.path.display().to_string(),
            language: file.language.clone(),
            content: file.content.clone(),
            existed: file.existed,
        }
    }
}

impl ApplyResultDto {
    /// 组装「应用」结果：文件与备份都是绝对路径字符串（前端直接展示）。
    pub(crate) fn new(scope: String, slug: String, outcome: &ClientWriteOutcome) -> Self {
        Self {
            scope,
            slug,
            files: outcome.files.iter().map(RenderedFileDto::from).collect(),
            backups: outcome
                .backups
                .iter()
                .map(|path| path.display().to_string())
                .collect(),
        }
    }
}
