//! 客户端注册表
//!
//! 客户端指「需要按供应商写自己的配置文件做模型路由」的那些客户端
//! （claude / codex / 未来可扩展）：每个客户端对应一个供应商列表，
//! 即 `<数据目录>/supplier/<id>/` 这个 scope 目录。
//!
//! **新增客户端只需**：
//! 1. 在 [`CLIENTS`] 登记一条 [`ClientDescriptor`]（含模型槽位 / 开关 / 选项）；
//! 2. 在 `infrastructure::system::client_config` 下新增一个实现文件并在分派处加一行。
//!
//! 存储层按 scope 目录自动扩展（列表、启用项、索引都无客户端硬编码），
//! 无需改动；界面标签页、logo、模型槽位、开关与选项也都取自本注册表，
//! 避免同一份清单散落多处——**界面与落盘都由注册表驱动，业务逻辑里没有客户端硬编码**。

/// 模型槽位：客户端上一个可映射的模型位（落盘为 `SupplierRouting.model_map` 的键）。
///
/// 界面上的「模型角色」表就是按本表的顺序逐行渲染的，列由 [`display_name`] 与
/// [`supports_one_m`] 决定：没有显示名的行（如子代理模型）不出现在 `/model` 菜单里，
/// 不支持 1M 的行（如 Haiku）勾选框一律禁用。
///
/// [`display_name`]: ClientModelSlot::display_name
/// [`supports_one_m`]: ClientModelSlot::supports_one_m
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientModelSlot {
    /// 稳定标识（即 `model_map` 的键），如 `sonnet` / `haiku`。
    pub key: &'static str,
    /// 界面标签（中文），如「Sonnet」。
    pub label: &'static str,
    /// 字段说明（中文，一句话讲清这个槽位对应客户端的哪个行为）。
    pub hint: &'static str,
    /// 输入框占位示例（真实模型名，便于用户照抄）。
    pub placeholder: &'static str,
    /// 是否有「显示名称」列（落盘为 `display_map` 的同名键）。
    pub display_name: bool,
    /// 「支持1M」列是否可勾选（不可勾选的行，写入前会强制剥掉 `[1M]` 标记）。
    pub supports_one_m: bool,
}

/// 模型路由的界面形态。
///
/// 两个客户端的模型配置结构差异很大，前端据此渲染不同布局；`roles` 无模型映射区，
/// `catalog` 的「模型映射」行可增删（Codex 专属），因此两者互不影响。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutingLayout {
    /// 角色表：固定若干「模型角色」行（Claude Code）。
    Roles,
    /// 目录式：单个「默认模型」+ 可增删的「模型映射」行（Codex）。
    Catalog,
}

impl RoutingLayout {
    /// 线缆取值（前端 `routingLayout` 字段）。
    pub fn as_str(self) -> &'static str {
        match self {
            RoutingLayout::Roles => "roles",
            RoutingLayout::Catalog => "catalog",
        }
    }
}

/// 布尔开关（落盘为 `SupplierRouting.switches[key]`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientSwitch {
    /// 稳定标识（即 `switches` 的键）。
    pub key: &'static str,
    /// 界面标签（中文）。
    pub label: &'static str,
    /// 字段说明（中文，一句话讲清它写到哪里、产生什么效果）。
    pub hint: &'static str,
    /// 未配置时的默认值。
    pub default: bool,
}

/// 枚举型选项（落盘为 `SupplierRouting.options[key]`，值, 展示名）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientOption {
    /// 稳定标识（即 `options` 的键）。
    pub key: &'static str,
    /// 界面标签（中文）。
    pub label: &'static str,
    /// 字段说明（中文）。
    pub hint: &'static str,
    /// 可选取值：(落盘值, 展示名)。落盘值同时是渲染时的白名单。
    pub choices: &'static [(&'static str, &'static str)],
    /// 未配置 / 非法取值时使用的默认值（必须是 `choices` 中的一项）。
    pub default: &'static str,
    /// 是否在表单里渲染。
    ///
    /// `false` = 界面不再暴露该项，但**渲染层仍按默认值写入**（与 cc-switch 的模板一致：
    /// 它固定写 `model_reasoning_effort = "high"`，同样没有给用户一个选择项）。
    pub visible: bool,
}

/// 认证字段的可选项（落盘值, 展示名）。
///
/// 语义按客户端而定：Claude 侧是「密钥写进 `settings.json` 的哪个 env 键」，
/// 因此取值是大写的环境变量名（与 cc-switch 的 `apiKeyField` 完全一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientAuthField {
    /// 落盘值（即 `endpoint.auth_field`）。
    pub value: &'static str,
    /// 界面展示名。
    pub label: &'static str,
}

/// 客户端描述：UI 标签页、logo、模型槽位与开关的唯一登记处。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientDescriptor {
    /// 客户端标识（同时也是 data/supplier 下的 scope 目录名）。
    pub id: &'static str,
    /// 界面展示名。
    pub name: &'static str,
    /// logo 资源名（对应 frontend/assets/logos/<logo>.*）。
    pub logo: &'static str,
    /// 可映射的模型槽位（按界面展示顺序排列）。
    model_slots: &'static [ClientModelSlot],
    /// 模型路由的界面形态。
    pub routing_layout: RoutingLayout,
    /// 新建供应商时表单默认选中的 API 格式（取值见 `supplier_service::API_FORMATS`）。
    pub default_api_format: &'static str,
    /// 「模型映射」行内「思考等级」的可选档位：(落盘值, 展示名)。
    ///
    /// 空 = 该客户端没有模型映射区（与 [`RoutingLayout::Roles`] 配套）。
    catalog_reasoning_levels: &'static [(&'static str, &'static str)],
    /// 认证字段的可选项（空 = 该客户端没有「认证字段」配置项）。
    auth_fields: &'static [ClientAuthField],
    /// 新建供应商时默认选中的认证字段（`auth_fields` 为空时无意义）。
    pub default_auth_field: &'static str,
    /// 可配置的布尔开关。
    switches: &'static [ClientSwitch],
    /// 可配置的枚举型选项。
    options: &'static [ClientOption],
}

impl ClientDescriptor {
    /// 该客户端可映射的模型槽位（键即 `routing.json` 的 `model_map` 键）。
    pub fn model_slots(&self) -> &'static [ClientModelSlot] {
        self.model_slots
    }

    /// 「模型映射」行内「思考等级」的可选档位：(落盘值, 展示名)。
    ///
    /// 空即表示该客户端没有模型映射区（见 [`ClientDescriptor::routing_layout`]）。
    pub fn catalog_reasoning_levels(&self) -> &'static [(&'static str, &'static str)] {
        self.catalog_reasoning_levels
    }

    /// 认证字段的可选项（空 = 表单里不渲染「认证字段」）。
    pub fn auth_fields(&self) -> &'static [ClientAuthField] {
        self.auth_fields
    }

    /// 该客户端可配置的布尔开关（键即 `routing.json` 的 `switches` 键）。
    pub fn switches(&self) -> &'static [ClientSwitch] {
        self.switches
    }

    /// 该客户端可配置的枚举型选项（键即 `routing.json` 的 `options` 键）。
    pub fn options(&self) -> &'static [ClientOption] {
        self.options
    }
}

/// Claude Code 的模型槽位（落盘键 → 目标环境变量见 `client_config::claude`）。
///
/// 顺序即界面顺序：Sonnet → Opus → Fable → Haiku → 子代理模型。
/// 「主模型」（`env.ANTHROPIC_MODEL`）已随本次改造移除——它会把档位映射整体架空的
/// 全局兜底值变成一个「看起来在生效」的槽位；旧版本写入的该键由渲染层清理。
const CLAUDE_MODEL_SLOTS: &[ClientModelSlot] = &[
    ClientModelSlot {
        key: "sonnet",
        label: "Sonnet",
        hint: "标准档位，写入 env.ANTHROPIC_DEFAULT_SONNET_MODEL",
        placeholder: "deepseek-chat",
        display_name: true,
        supports_one_m: true,
    },
    ClientModelSlot {
        key: "opus",
        label: "Opus",
        hint: "高能力档位，写入 env.ANTHROPIC_DEFAULT_OPUS_MODEL",
        placeholder: "deepseek-reasoner",
        display_name: true,
        supports_one_m: true,
    },
    ClientModelSlot {
        key: "fable",
        label: "Fable",
        hint: "Fable 档位，写入 env.ANTHROPIC_DEFAULT_FABLE_MODEL",
        placeholder: "deepseek-chat",
        display_name: true,
        supports_one_m: true,
    },
    ClientModelSlot {
        key: "haiku",
        label: "Haiku",
        hint: "快速档位，写入 env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
        placeholder: "deepseek-chat",
        display_name: true,
        // Haiku 档位不参与 1M 上下文声明：勾选框禁用，写入前也会剥掉 [1M]。
        supports_one_m: false,
    },
    ClientModelSlot {
        key: "subagent",
        label: "子代理模型",
        hint: "子代理（Task 工具）使用的模型，写入 env.CLAUDE_CODE_SUBAGENT_MODEL",
        placeholder: "deepseek-chat",
        // 不进 /model 菜单，因此没有「显示名称」列。
        display_name: false,
        supports_one_m: true,
    },
];

/// Claude Code 的开关。
///
/// 关闭一律意味着**删除**对应键（保持用户原文件干净，不留空对象残留）；
/// 具体键值见 `client_config::claude` 的映射表。
const CLAUDE_SWITCHES: &[ClientSwitch] = &[
    ClientSwitch {
        key: "hide_attribution",
        label: "隐藏 AI 署名",
        hint: "settings.json 顶层 attribution = { commit: \"\", pr: \"\" }，去掉提交与 PR 里的 AI 署名",
        default: false,
    },
    ClientSwitch {
        key: "agent_teams",
        label: "Teammates 模式",
        hint: "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = \"1\"，启用多代理协作",
        default: false,
    },
    ClientSwitch {
        key: "tool_search",
        label: "启用 Tool Search",
        hint: "env.ENABLE_TOOL_SEARCH = \"true\"，启用工具检索",
        default: false,
    },
    ClientSwitch {
        key: "max_effort",
        label: "最大强度思考",
        hint: "env.CLAUDE_CODE_EFFORT_LEVEL = \"max\"，把思考强度拉到最高",
        default: false,
    },
    ClientSwitch {
        key: "disable_autoupdater",
        label: "禁用自动升级",
        hint: "env.DISABLE_AUTOUPDATER = \"1\"，禁止 Claude Code 自动升级",
        default: false,
    },
    ClientSwitch {
        key: "disable_artifact",
        label: "禁用 Artifact",
        hint: "env.CLAUDE_CODE_DISABLE_ARTIFACT = \"1\"，关闭 Artifact 面板",
        default: false,
    },
];

/// Claude Code 暂无枚举型选项（返回空切片，界面据此不渲染选项区）。
const CLAUDE_OPTIONS: &[ClientOption] = &[];

/// Claude Code 的认证字段：密钥写进 `settings.json` 的哪个 env 键。
///
/// 与 cc-switch 的 `apiKeyField` 一致，只有两项；默认 `ANTHROPIC_AUTH_TOKEN`
/// （Claude Code 读它做 Bearer，官方订阅/中转场景都是这条路径）。
const CLAUDE_AUTH_FIELDS: &[ClientAuthField] = &[
    ClientAuthField {
        value: "ANTHROPIC_AUTH_TOKEN",
        label: "ANTHROPIC_AUTH_TOKEN（默认）",
    },
    ClientAuthField {
        value: "ANTHROPIC_API_KEY",
        label: "ANTHROPIC_API_KEY",
    },
];

/// Claude Code 的默认认证字段。
const CLAUDE_DEFAULT_AUTH_FIELD: &str = "ANTHROPIC_AUTH_TOKEN";

/// Codex 的模型槽位：只有「默认模型」一项（多档位路由由「模型映射」承担）。
const CODEX_MODEL_SLOTS: &[ClientModelSlot] = &[ClientModelSlot {
    key: "primary",
    label: "默认模型",
    hint: "Codex 请求使用的模型，写入 config.toml 的 model",
    placeholder: "deepseek-chat",
    // 不进 /model 菜单（菜单由模型映射生成），也不参与 1M 声明。
    display_name: false,
    supports_one_m: false,
}];

/// Codex「模型映射」行内「思考等级」的可选档位（按思考深度升序）。
///
/// 取值就是 Codex 认得的 effort 名（写进目录文件的 `supported_reasoning_levels`），
/// 展示名是中文，避免界面出现英文原名。
const CODEX_CATALOG_REASONING_LEVELS: &[(&str, &str)] = &[
    ("none", "无"),
    ("minimal", "极低"),
    ("low", "低"),
    ("medium", "中"),
    ("high", "高"),
    ("xhigh", "极高"),
    ("max", "最高"),
    ("ultra", "极致"),
];

/// Codex 的开关：只登记确实有目标字段的项（如「禁用自动升级」在 Codex 侧无对应字段）。
const CODEX_SWITCHES: &[ClientSwitch] = &[
    ClientSwitch {
        key: "disable_response_storage",
        label: "禁用响应存储",
        hint: "config.toml: disable_response_storage = true",
        default: false,
    },
    ClientSwitch {
        key: "web_search",
        label: "启用联网搜索",
        hint: "config.toml: web_search = \"live\"，开启实时检索（关闭则删键，回到 Codex 默认的 cached）",
        default: false,
    },
    ClientSwitch {
        key: "remote_compaction",
        label: "启用远程压缩",
        hint: "config.toml: 把 [model_providers.dsw] 的 name 写成 OpenAI，Codex 才会尝试远程压缩",
        default: false,
    },
    ClientSwitch {
        key: SWITCH_APPLY_COMMON_CONFIG,
        label: "应用通用配置",
        hint: "config.toml: 把「通用配置片段」合并进本供应商的配置（切换供应商不会丢）",
        default: false,
    },
];

/// Codex 的枚举型选项。
///
/// 「思考强度」不再出现在界面上（与 cc-switch 一致：它的模板固定写 `high`），
/// 但保留登记：渲染层按这里的默认值继续写 `model_reasoning_effort`。
const CODEX_OPTIONS: &[ClientOption] = &[ClientOption {
    key: "reasoning_effort",
    label: "思考强度",
    hint: "config.toml: model_reasoning_effort，取值即 Codex 的思考档位",
    choices: &[
        ("minimal", "低"),
        ("low", "较低"),
        ("medium", "中"),
        ("high", "高"),
    ],
    default: "high",
    visible: false,
}];

/// 已接入的客户端清单（新增客户端只需在此登记）。
pub const CLIENTS: &[ClientDescriptor] = &[
    ClientDescriptor {
        id: "claude",
        name: "Claude Code",
        logo: "claude",
        model_slots: CLAUDE_MODEL_SLOTS,
        routing_layout: RoutingLayout::Roles,
        default_api_format: "anthropic",
        catalog_reasoning_levels: &[],
        auth_fields: CLAUDE_AUTH_FIELDS,
        default_auth_field: CLAUDE_DEFAULT_AUTH_FIELD,
        switches: CLAUDE_SWITCHES,
        options: CLAUDE_OPTIONS,
    },
    ClientDescriptor {
        id: "codex",
        name: "Codex",
        logo: "openai",
        model_slots: CODEX_MODEL_SLOTS,
        routing_layout: RoutingLayout::Catalog,
        // Codex 默认走 Responses 协议：Chat Completions 无法承载它的工具与推理流。
        default_api_format: "openai-responses",
        catalog_reasoning_levels: CODEX_CATALOG_REASONING_LEVELS,
        // Codex 没有「认证字段」：密钥固定写 auth.json 的 OPENAI_API_KEY（与 cc-switch 一致）。
        auth_fields: &[],
        default_auth_field: "",
        switches: CODEX_SWITCHES,
        options: CODEX_OPTIONS,
    },
];

/// 「应用通用配置」开关的键（Codex 专属功能，注册表与渲染层共用这一个字符串）。
pub const SWITCH_APPLY_COMMON_CONFIG: &str = "apply_common_config";

/// 客户端是否支持「通用配置片段」。
///
/// 判据就是注册表里是否登记了 [`SWITCH_APPLY_COMMON_CONFIG`] 开关——登记了才在界面上
/// 出现这个勾选项，才谈得上保存 / 提取片段，避免两处清单各自维护。
pub fn supports_common_config(client_id: &str) -> bool {
    find_client(client_id).is_some_and(|client| {
        client
            .switches()
            .iter()
            .any(|switch| switch.key == SWITCH_APPLY_COMMON_CONFIG)
    })
}

/// 列出全部已接入客户端。
pub fn list_clients() -> Vec<ClientDescriptor> {
    CLIENTS.to_vec()
}

/// 按标识查找客户端（忽略首尾空白与大小写）。
pub fn find_client(id: &str) -> Option<ClientDescriptor> {
    let id = id.trim().to_lowercase();
    CLIENTS.iter().copied().find(|client| client.id == id)
}

/// 是否为已接入的客户端（校验规则与 `find_client` 一致）。
///
/// 与下面三个 `is_known_*` 一样，当前只由回归测试消费：生产路径只校验标识形状
/// （`validate_scope` / `validate_routing`），未登记的键由渲染层按注册表白名单忽略。
/// 保留它们是因为「某个键是否登记」是注册表对外的查询契约，删除会丢掉这层自洽性检查。
#[allow(dead_code)]
pub fn is_known_client(id: &str) -> bool {
    find_client(id).is_some()
}

/// 是否为该客户端登记的模型槽位（键即 `routing.json` 的 `model_map` 键）。
///
/// 未登记的客户端一律为 `false`：校验方无需再单独判客户端是否存在。
#[allow(dead_code)]
pub fn is_known_model_slot(client_id: &str, key: &str) -> bool {
    find_client(client_id)
        .is_some_and(|client| client.model_slots().iter().any(|slot| slot.key == key))
}

/// 是否为该客户端登记的布尔开关（键即 `routing.json` 的 `switches` 键）。
#[allow(dead_code)]
pub fn is_known_switch(client_id: &str, key: &str) -> bool {
    find_client(client_id)
        .is_some_and(|client| client.switches().iter().any(|switch| switch.key == key))
}

/// 是否为该客户端登记的枚举型选项（键即 `routing.json` 的 `options` 键）。
#[allow(dead_code)]
pub fn is_known_option(client_id: &str, key: &str) -> bool {
    find_client(client_id)
        .is_some_and(|client| client.options().iter().any(|option| option.key == key))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 登记表本身必须自洽：标识合法、不重复、字段非空。
    #[test]
    fn registry_entries_are_valid_and_unique() {
        assert!(
            CLIENTS.len() >= 2,
            "至少登记 claude / codex 两个客户端：{}",
            CLIENTS.len()
        );
        let mut ids = Vec::new();
        for client in CLIENTS {
            assert_eq!(
                crate::domain::supplier::service::supplier_service::validate_scope(client.id).unwrap(),
                client.id,
                "客户端 id 必须能直接用作 scope 目录名"
            );
            assert!(!client.name.is_empty());
            assert!(!client.logo.is_empty());
            ids.push(client.id);
        }
        let mut unique = ids.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), ids.len(), "客户端标识不得重复");
    }

    #[test]
    fn lookup_normalizes_input() {
        let claude = find_client(" Claude ").expect("应能按标识找到客户端");
        assert_eq!(claude.id, "claude");
        assert_eq!(claude.name, "Claude Code");
        assert_eq!(claude.logo, "claude");

        let codex = find_client("codex").unwrap();
        assert_eq!(codex.name, "Codex");
        assert_eq!(codex.logo, "openai");

        assert!(is_known_client("CODEX"));
        assert!(!is_known_client("gemini"));
        assert!(find_client("").is_none());
        assert_eq!(list_clients().len(), CLIENTS.len());
    }

    /// 模型槽位 / 开关 / 选项也必须自洽：键不重复、文案非空、
    /// 选项默认值必须落在自己的取值里（否则渲染会写出界面无法回显的值）。
    ///
    /// 另外校验两条布局契约：`roles` 不能带模型映射档位、`catalog` 必须带；
    /// 默认 API 格式必须落在白名单里（否则表单会默认选中一个后端会回落的取值）。
    #[test]
    fn capability_tables_are_self_consistent() {
        for client in CLIENTS {
            let mut slot_keys = Vec::new();
            for slot in client.model_slots() {
                assert!(!slot.key.is_empty() && !slot.label.is_empty());
                assert!(!slot.hint.is_empty());
                assert!(
                    !slot.placeholder.is_empty(),
                    "槽位 {} 缺少占位示例",
                    slot.key
                );
                slot_keys.push(slot.key);
            }
            let mut switch_keys = Vec::new();
            for switch in client.switches() {
                assert!(!switch.key.is_empty() && !switch.label.is_empty());
                assert!(!switch.hint.is_empty());
                assert!(!switch.default, "开关默认值当前统一为关闭");
                switch_keys.push(switch.key);
            }
            let mut option_keys = Vec::new();
            for option in client.options() {
                assert!(!option.key.is_empty() && !option.label.is_empty());
                assert!(!option.hint.is_empty());
                assert!(
                    !option.choices.is_empty(),
                    "选项 {} 至少要有两个取值",
                    option.key
                );
                assert!(
                    option
                        .choices
                        .iter()
                        .any(|(value, _)| *value == option.default),
                    "选项 {} 的默认值必须在 choices 中",
                    option.key
                );
                for (value, name) in option.choices {
                    assert!(!value.is_empty() && !name.is_empty());
                    assert_eq!(*value, value.trim().to_ascii_lowercase(), "取值应小写");
                }
                option_keys.push(option.key);
            }
            for keys in [slot_keys, switch_keys, option_keys] {
                let mut unique = keys.clone();
                unique.sort();
                unique.dedup();
                assert_eq!(unique.len(), keys.len(), "{} 的键不得重复", client.id);
            }

            assert!(
                crate::domain::supplier::service::supplier_service::API_FORMATS
                    .contains(&client.default_api_format),
                "{} 的默认 API 格式必须落在白名单里：{}",
                client.id,
                client.default_api_format
            );
            match client.routing_layout {
                RoutingLayout::Roles => assert!(
                    client.catalog_reasoning_levels().is_empty(),
                    "{} 是角色表布局，不应登记模型映射档位",
                    client.id
                ),
                RoutingLayout::Catalog => {
                    assert!(
                        !client.catalog_reasoning_levels().is_empty(),
                        "{} 是目录式布局，必须登记模型映射的思考档位",
                        client.id
                    );
                    for (value, label) in client.catalog_reasoning_levels() {
                        assert!(!value.is_empty() && !label.is_empty());
                        assert_eq!(*value, value.trim().to_ascii_lowercase());
                    }
                }
            }
        }

        // Claude：五个模型角色（已移除「主模型」）、六个开关、无枚举选项。
        let claude = find_client("claude").unwrap();
        assert_eq!(claude.model_slots().len(), 5);
        assert_eq!(claude.switches().len(), 6);
        assert!(claude.options().is_empty());
        assert_eq!(claude.routing_layout.as_str(), "roles");
        assert_eq!(claude.default_api_format, "anthropic");
        assert_eq!(
            claude
                .model_slots()
                .iter()
                .map(|slot| slot.key)
                .collect::<Vec<_>>(),
            vec!["sonnet", "opus", "fable", "haiku", "subagent"],
            "界面顺序：Sonnet → Opus → Fable → Haiku → 子代理模型"
        );
        let haiku = claude
            .model_slots()
            .iter()
            .find(|slot| slot.key == "haiku")
            .unwrap();
        assert!(
            !haiku.supports_one_m,
            "Haiku 不参与 1M 声明，勾选框必须禁用"
        );
        assert!(haiku.display_name, "Haiku 有独立的菜单显示名");
        let subagent = claude
            .model_slots()
            .iter()
            .find(|slot| slot.key == "subagent")
            .unwrap();
        assert!(!subagent.display_name, "子代理不进 /model 菜单，没有显示名");
        assert!(subagent.supports_one_m);
        for key in ["sonnet", "opus", "fable"] {
            let slot = claude
                .model_slots()
                .iter()
                .find(|slot| slot.key == key)
                .unwrap();
            assert!(
                slot.display_name && slot.supports_one_m,
                "{} 应可填显示名并勾 1M",
                key
            );
        }

        // Codex：一个「默认模型」槽位、两个开关、一个选项、目录式布局。
        let codex = find_client("codex").unwrap();
        assert_eq!(codex.model_slots().len(), 1);
        assert_eq!(codex.model_slots()[0].key, "primary");
        assert_eq!(codex.model_slots()[0].label, "默认模型");
        assert_eq!(codex.routing_layout.as_str(), "catalog");
        assert_eq!(
            codex.default_api_format, "openai-responses",
            "Codex 默认走 Responses 协议"
        );
        assert_eq!(codex.options().len(), 1);
        assert_eq!(codex.options()[0].key, "reasoning_effort");
        assert_eq!(codex.options()[0].default, "high");
        assert_eq!(
            codex
                .switches()
                .iter()
                .map(|switch| switch.key)
                .collect::<Vec<_>>(),
            vec![
                "disable_response_storage",
                "web_search",
                "remote_compaction",
                "apply_common_config"
            ],
            "Codex 只登记确实有目标字段的开关"
        );
        assert!(
            codex.options().iter().all(|option| !option.visible),
            "「思考强度」不再出现在界面上（渲染层仍按默认值写入）"
        );
        assert!(
            !codex.options().is_empty(),
            "隐藏的选项仍要登记：它是 model_reasoning_effort 的默认值来源"
        );
        assert!(codex.auth_fields().is_empty(), "Codex 没有认证字段配置项");

        // 认证字段：Claude 只有两项（与 cc-switch 的 apiKeyField 一致），默认 AUTH_TOKEN。
        assert_eq!(
            claude
                .auth_fields()
                .iter()
                .map(|field| field.value)
                .collect::<Vec<_>>(),
            vec!["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
        );
        assert_eq!(claude.default_auth_field, "ANTHROPIC_AUTH_TOKEN");
        assert!(
            claude
                .auth_fields()
                .iter()
                .any(|field| field.value == claude.default_auth_field),
            "默认值必须在可选值里"
        );
        assert_eq!(
            codex
                .catalog_reasoning_levels()
                .iter()
                .map(|(value, _)| *value)
                .collect::<Vec<_>>(),
            vec!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
            "思考档位按思考深度升序，且覆盖界面下拉的全部选项"
        );
    }

    /// 查询辅助按客户端区分：同名键在别的客户端上不算数，未登记客户端一律 false。
    #[test]
    fn known_key_queries_are_client_scoped() {
        assert!(is_known_model_slot("claude", "haiku"));
        assert!(is_known_model_slot(" Claude ", "sonnet"));
        assert!(
            !is_known_model_slot("claude", "primary"),
            "「主模型」槽位已移除，不再是 claude 的合法键"
        );
        assert!(!is_known_model_slot("codex", "haiku"));
        assert!(!is_known_model_slot("claude", "unknown"));

        assert!(is_known_switch("claude", "hide_attribution"));
        assert!(is_known_switch("codex", "web_search"));
        assert!(
            !is_known_switch("codex", "disable_autoupdater"),
            "Codex 无对应字段，不得登记该开关"
        );

        assert!(is_known_option("codex", "reasoning_effort"));
        assert!(!is_known_option("claude", "reasoning_effort"));

        for query in [is_known_model_slot, is_known_switch, is_known_option] {
            assert!(!query("gemini", "primary"));
            assert!(!query("", "primary"));
        }
    }
}
