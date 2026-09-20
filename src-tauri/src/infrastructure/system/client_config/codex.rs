//! Codex 客户端配置（`~/.codex/auth.json` + `~/.codex/config.toml`）
//!
//! # 写入策略
//! 两个文件都是合并式：只接管下表中的键，用户文件里的其它内容（其它 `[model_providers.*]`、
//! `approval_policy`、`auth.json` 里的 tokens…）原样保留。**关闭 = 删除**：开关关闭、
//! 上下文窗口为 0 时对应键会被删除，不留下「上次应用」的陈旧值。
//!
//! # 接管的键
//!
//! | 来源 | 目标 |
//! | --- | --- |
//! | — | `auth.json` 的 `OPENAI_API_KEY` |
//! | — | `config.toml` 顶层 `model_provider`（固定 [`CODEX_PROVIDER_ID`]） |
//! | `model_map["primary"]` | `config.toml` 顶层 `model` |
//! | `options["reasoning_effort"]` | `config.toml` 顶层 `model_reasoning_effort` |
//! | `context_window > 0` | `config.toml` 顶层 `model_context_window`（勾选「支持1M」时为 1000000） |
//! | `compact_token_limit > 0` | `config.toml` 顶层 `model_auto_compact_token_limit` |
//! | `model_catalog` 非空 | 生成 [`CATALOG_FILE`] 并写入顶层 `model_catalog_json` 指针 |
//! | `disable_response_storage` | 同名顶层布尔键（关闭则删键） |
//! | `web_search` | 顶层 `web_search = "live"`（字符串模式；关闭则删键） |
//! | `remote_compaction` | `[model_providers.dsw]` 的 `name = "OpenAI"`（关闭则写回展示名） |
//! | `apply_common_config` | 把「通用配置片段」结构化合并进 `config.toml`（取消则按值剥离） |
//! | `base_url` / `supplier_name` / `api_format` | `[model_providers.dsw]` 段 |
//!
//! 「思考强度」不再出现在界面上（与 cc-switch 的模板一致：它固定写 `high`），
//! 但注册表仍登记该项，渲染层按注册表默认值继续写 `model_reasoning_effort`。
//!
//! provider 段用固定标识 [`CODEX_PROVIDER_ID`]，并注明「本应用接管该段」：路由配置里拿不到
//! 供应商 slug（渲染输入只有展示名），固定标识才能保证「写什么」与「读什么」始终对得上。
//! 旧版本写入的 `[model_providers.custom]` 属于本应用的遗留，一律删除。
//!
//! # 模型目录（`model_catalog_json`）
//! Codex 的 `/model` 菜单只认它自己的模型目录，第三方模型必须写进目录文件才显示得出来。
//! 因此「模型映射」非空时，本模块额外生成 [`CATALOG_FILE`]（与 `config.toml` 同目录）
//! 并把 `model_catalog_json` 指向它；映射清空则删除指针，文件留着无害（下次又被覆写）。
//!
//! 指针遵循「只接管自己写的那一个」：文件里的 `model_catalog_json` 若指向别的文件，
//! 说明用户自己维护着目录，此时我们既不覆盖也不删除。
//!
//! # 输出格式
//! `auth.json` 与目录文件都递归按键名升序 + 2 空格缩进；`config.toml` 由 `toml` crate
//! 序列化（顶层标量在前、子表在后），三者都保证输出稳定。

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::{json, Map as JsonMap, Value as JsonValue};
use toml::{Table, Value};

use super::{
    non_empty, non_empty_str, read_json_object, read_live_files, sort_json, switch_enabled,
    ClientRenderInput, RenderedFile,
};
use crate::domain::client::service::client_service;
use crate::domain::supplier::model::{ModelCatalogEntry, SupplierRouting};
use crate::types::exception::{AppError, AppResult};

/// 客户端标识（与注册表 `CLIENTS` 中的 id 一致）。
pub const CLIENT_ID: &str = "codex";

/// 配置目录（相对家目录）。
const CONFIG_DIR: &str = ".codex";
/// 密钥文件名。
const AUTH_FILE: &str = "auth.json";
/// 配置文件名。
const CONFIG_FILE: &str = "config.toml";
/// 模型目录文件名（与 `config.toml` 同目录，`model_catalog_json` 写的就是这个名字）。
pub const CATALOG_FILE: &str = "dsw-model-catalog.json";

/// 本应用接管的 provider 标识（`[model_providers.dsw]` 段由本应用维护）。
pub const CODEX_PROVIDER_ID: &str = "dsw";
/// 旧版本写入的 provider 标识，属于本应用的遗留，必须清理。
const LEGACY_PROVIDER_ID: &str = "custom";
/// provider 展示名为空时的兜底取值。
const FALLBACK_PROVIDER_NAME: &str = "DSW";

/// `auth.json` 里的密钥键。
const AUTH_API_KEY: &str = "OPENAI_API_KEY";
/// provider 段所在顶层键。
const KEY_MODEL_PROVIDERS: &str = "model_providers";
/// 当前 provider。
const KEY_MODEL_PROVIDER: &str = "model_provider";
/// 模型槽位：主模型（注册表 `ClientModelSlot.key`）。
const SLOT_PRIMARY: &str = "primary";
/// 主模型落点。
const KEY_MODEL: &str = "model";
/// 思考强度选项（注册表 `ClientOption.key`）与其落点。
const OPTION_REASONING_EFFORT: &str = "reasoning_effort";
const KEY_REASONING_EFFORT: &str = "model_reasoning_effort";
/// 上下文窗口落点。
const KEY_CONTEXT_WINDOW: &str = "model_context_window";
/// 自动压缩阈值落点（勾选「支持1M」时随 1M 窗口一起写）。
const KEY_AUTO_COMPACT_LIMIT: &str = "model_auto_compact_token_limit";
/// 指向模型目录文件的顶层键。
const KEY_MODEL_CATALOG_JSON: &str = "model_catalog_json";
/// 目录文件的顶层键与条目字段。
const JSON_KEY_MODELS: &str = "models";
const JSON_KEY_SLUG: &str = "slug";
const JSON_KEY_DISPLAY_NAME: &str = "display_name";
const JSON_KEY_DESCRIPTION: &str = "description";
const JSON_KEY_CONTEXT_WINDOW: &str = "context_window";
const JSON_KEY_MAX_CONTEXT_WINDOW: &str = "max_context_window";
const JSON_KEY_EFFECTIVE_PERCENT: &str = "effective_context_window_percent";
const JSON_KEY_DEFAULT_REASONING: &str = "default_reasoning_level";
const JSON_KEY_SUPPORTED_REASONING: &str = "supported_reasoning_levels";
const JSON_KEY_REASONING_EFFORT: &str = "effort";
const JSON_KEY_REASONING_DESC: &str = "description";
const JSON_KEY_BASE_INSTRUCTIONS: &str = "base_instructions";
const JSON_KEY_VISIBILITY: &str = "visibility";
const JSON_KEY_PRIORITY: &str = "priority";
const JSON_KEY_TRUNCATION: &str = "truncation_policy";
const JSON_KEY_INPUT_MODALITIES: &str = "input_modalities";
const JSON_KEY_SUPPORTS_SEARCH: &str = "supports_search_tool";
const JSON_KEY_SHELL_TYPE: &str = "shell_type";
const JSON_KEY_SUPPORTED_IN_API: &str = "supported_in_api";
const JSON_KEY_SUPPORTS_PARALLEL: &str = "supports_parallel_tool_calls";
const JSON_KEY_SUPPORTS_IMAGE_DETAIL: &str = "supports_image_detail_original";
const JSON_KEY_SUPPORTS_SUMMARIES: &str = "supports_reasoning_summaries";
const JSON_KEY_DEFAULT_SUMMARY: &str = "default_reasoning_summary";
const JSON_KEY_SUPPORT_VERBOSITY: &str = "support_verbosity";

/// 目录条目的固定取值（与 Codex 官方「native responses」条目的字段集对齐）。
const CATALOG_SHELL_TYPE: &str = "shell_command";
const CATALOG_VISIBILITY: &str = "list";
/// 条目未声明思考档位时写入的保守兜底（与官方模板一致）。
const CATALOG_FALLBACK_LEVELS: [&str; 2] = ["none", "high"];
/// 条目未声明上下文窗口、且供应商也没配上下文窗口时使用的默认值。
const CATALOG_DEFAULT_CONTEXT_WINDOW: u32 = 128_000;
/// 目录条目使用的固定指令（第三方网关不认厂商专属的 harness 指令）。
const CATALOG_BASE_INSTRUCTIONS: &str = "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.";

/// 「思考档位 → 写进目录文件的说明文案」（展示给用户的 `/model` 菜单说明）。
///
/// 档位清单本身由注册表登记（`client_service::CODEX_CATALOG_REASONING_LEVELS`），
/// 这里只负责把它翻译成 Codex 能读的说明；未登记的档位不会走到这里（领域层已过滤）。
const REASONING_DESCRIPTIONS: [(&str, &str); 8] = [
    ("none", "关闭思考"),
    ("minimal", "最小思考深度"),
    ("low", "较轻的思考，响应更快"),
    ("medium", "兼顾速度与思考深度"),
    ("high", "复杂问题使用更深的思考"),
    ("xhigh", "复杂问题使用极高的思考深度"),
    ("max", "最难的问题使用最深的思考"),
    ("ultra", "极致思考深度"),
];

/// 布尔开关落点（键名与注册表 `ClientSwitch.key` 同名）。
const SWITCH_DISABLE_RESPONSE_STORAGE: &str = "disable_response_storage";
const SWITCH_WEB_SEARCH: &str = "web_search";
/// 勾选「启用联网搜索」时写下的取值（Codex 的字符串模式：`disabled` / `cached` / `live`）。
const WEB_SEARCH_LIVE: &str = "live";
/// 「启用远程压缩」：把 provider 段的 `name` 写成 `OpenAI`，Codex 才会尝试远程压缩。
const SWITCH_REMOTE_COMPACTION: &str = "remote_compaction";
/// 「应用通用配置」：把通用配置片段合并进 `config.toml`。
const SWITCH_APPLY_COMMON_CONFIG: &str = "apply_common_config";
/// 远程压缩要求的 provider 名（与 cc-switch 一致）。
const REMOTE_COMPACTION_PROVIDER_NAME: &str = "OpenAI";
/// 提取通用配置时排除的键：这些键与「当前供应商」强绑定，属于私有部分。
const PRIVATE_CONFIG_KEYS: [&str; 8] = [
    "model",
    "model_provider",
    "base_url",
    "wire_api",
    "model_providers",
    "mcp_servers",
    "experimental_bearer_token",
    "model_catalog_json",
];
/// provider 段内的键。
const KEY_NAME: &str = "name";
const KEY_BASE_URL: &str = "base_url";
const KEY_WIRE_API: &str = "wire_api";
const KEY_REQUIRES_OPENAI_AUTH: &str = "requires_openai_auth";
/// `api_format == "openai-responses"` 时使用 Responses 协议，其余一律 Chat Completions。
const API_FORMAT_RESPONSES: &str = "openai-responses";

/// 目标文件列表（路径 + 内容语言）。
pub fn paths(home: &Path) -> Vec<(PathBuf, &'static str)> {
    let dir = home.join(CONFIG_DIR);
    vec![
        (dir.join(AUTH_FILE), "json"),
        (dir.join(CONFIG_FILE), "toml"),
    ]
}

/// 读取实盘 `auth.json` 与 `config.toml`（不合并、不改写）。
///
/// 生成的模型目录文件不在此列：它由本应用维护、内容就是路由配置的投影，
/// 「读实盘」只关心用户自己那两个文件。
pub fn read_live(home: &Path) -> AppResult<Vec<RenderedFile>> {
    read_live_files(&paths(home))
}

/// 渲染合并后的 `auth.json` / `config.toml`（以及需要时的模型目录文件），只读实盘、不落盘。
///
/// 文件顺序即界面上的预览顺序：密钥 → 配置 → 目录。
pub fn render(home: &Path, input: &ClientRenderInput) -> AppResult<Vec<RenderedFile>> {
    let catalog = render_catalog(home, input)?;
    let mut files = vec![
        render_auth(home, input)?,
        render_config(home, input, catalog.is_some())?,
    ];
    if let Some(catalog) = catalog {
        files.push(catalog);
    }
    Ok(files)
}

/// 合并式渲染 `auth.json`：只接管密钥键，其它键保留。
fn render_auth(home: &Path, input: &ClientRenderInput) -> AppResult<RenderedFile> {
    let path = home.join(CONFIG_DIR).join(AUTH_FILE);
    let existed = path.is_file();
    let mut root = read_json_object(&path);
    root.insert(
        AUTH_API_KEY.to_string(),
        JsonValue::String(input.api_key.clone()),
    );

    let mut merged = JsonValue::Object(root);
    sort_json(&mut merged);
    let content =
        serde_json::to_string_pretty(&merged).map_err(|e| AppError::serde(e.to_string()))?;
    Ok(RenderedFile {
        path,
        language: "json".to_string(),
        content,
        existed,
    })
}

/// 合并式渲染 `config.toml`。
///
/// `has_catalog` 决定是否接管 `model_catalog_json` 指针：有目录就指向
/// [`CATALOG_FILE`]，没有就删除（且只删我们自己写的那一个）。
fn render_config(
    home: &Path,
    input: &ClientRenderInput,
    has_catalog: bool,
) -> AppResult<RenderedFile> {
    let path = home.join(CONFIG_DIR).join(CONFIG_FILE);
    let existed = path.is_file();
    let mut table = read_toml_table(&path);

    table.insert(
        KEY_MODEL_PROVIDER.to_string(),
        Value::String(CODEX_PROVIDER_ID.to_string()),
    );
    set_string(
        &mut table,
        KEY_MODEL,
        non_empty(input.routing.model_map.get(SLOT_PRIMARY)),
    );
    // 思考强度：取值白名单即注册表 `ClientOption.choices`，非法 / 缺失时用注册表默认值。
    set_string(
        &mut table,
        KEY_REASONING_EFFORT,
        non_empty_str(&reasoning_effort(&input.routing)),
    );
    if input.routing.context_window > 0 {
        table.insert(
            KEY_CONTEXT_WINDOW.to_string(),
            Value::Integer(i64::from(input.routing.context_window)),
        );
    } else {
        table.remove(KEY_CONTEXT_WINDOW);
    }
    // 压缩阈值：只有勾选「支持1M」时上游才会给出取值，为 0 即删除该键。
    if input.routing.compact_token_limit > 0 {
        table.insert(
            KEY_AUTO_COMPACT_LIMIT.to_string(),
            Value::Integer(i64::from(input.routing.compact_token_limit)),
        );
    } else {
        table.remove(KEY_AUTO_COMPACT_LIMIT);
    }
    set_catalog_pointer(&mut table, has_catalog);
    set_flag(
        &mut table,
        SWITCH_DISABLE_RESPONSE_STORAGE,
        switch_enabled(CLIENT_ID, &input.routing, SWITCH_DISABLE_RESPONSE_STORAGE),
    );
    // 联网搜索的取值是**字符串模式**（`disabled` / `cached` / `live`），不是布尔：
    // 勾选写 `"live"`（实时检索），未勾选删键（回到 Codex 默认的 `cached`）。
    // 写 `true` 属于已废弃的旧别名，会被新版 Codex 的严格校验拒绝。
    if switch_enabled(CLIENT_ID, &input.routing, SWITCH_WEB_SEARCH) {
        table.insert(
            SWITCH_WEB_SEARCH.to_string(),
            Value::String(WEB_SEARCH_LIVE.to_string()),
        );
    } else {
        table.remove(SWITCH_WEB_SEARCH);
    }

    // provider 段：本应用接管 [model_providers.dsw]，并清掉旧版本写入的 custom 段；
    // 其余 provider 段原样保留。
    let mut providers = match table.remove(KEY_MODEL_PROVIDERS) {
        Some(Value::Table(map)) => map,
        Some(_) => {
            log::warn!(
                "Codex config.toml 的 model_providers 不是表，将整体重建：{}",
                path.display()
            );
            Table::new()
        }
        None => Table::new(),
    };
    providers.remove(LEGACY_PROVIDER_ID);
    let mut provider = Table::new();
    provider.insert(
        KEY_NAME.to_string(),
        Value::String(provider_name_for(input)),
    );
    provider.insert(
        KEY_BASE_URL.to_string(),
        Value::String(input.base_url.clone()),
    );
    provider.insert(
        KEY_WIRE_API.to_string(),
        Value::String(wire_api(&input.api_format).to_string()),
    );
    provider.insert(KEY_REQUIRES_OPENAI_AUTH.to_string(), Value::Boolean(true));
    providers.insert(CODEX_PROVIDER_ID.to_string(), Value::Table(provider));
    table.insert(KEY_MODEL_PROVIDERS.to_string(), Value::Table(providers));

    // 通用配置片段最后处理：勾选则合并（同名键以片段为准），取消勾选则按「值一致」反向剥离。
    //
    // 剥离这一步不能省：本渲染是「读实盘 → 改我们接管的键 → 写回」，上一次合并写入的键
    // 就躺在用户的文件里，不剥离的话取消勾选等于没取消。
    if let Some(snippet) = parse_common_config(&input.common_config)? {
        if switch_enabled(CLIENT_ID, &input.routing, SWITCH_APPLY_COMMON_CONFIG) {
            merge_common_config(&mut table, &snippet);
        } else {
            remove_common_config(&mut table, &snippet);
        }
    }

    sort_table(&mut table);
    let content = toml::to_string_pretty(&table).map_err(|e| AppError::serde(e.to_string()))?;
    Ok(RenderedFile {
        path,
        language: "toml".to_string(),
        content,
        existed,
    })
}

/// provider 段的展示名。
///
/// 勾选「启用远程压缩」时固定写 `OpenAI`（Codex 见到该名字才会尝试远程压缩，与 cc-switch 一致）；
/// 否则写供应商展示名，为空时兜底 `DSW`。
fn provider_name_for(input: &ClientRenderInput) -> String {
    if switch_enabled(CLIENT_ID, &input.routing, SWITCH_REMOTE_COMPACTION) {
        return REMOTE_COMPACTION_PROVIDER_NAME.to_string();
    }
    provider_name(&input.supplier_name)
}

/// 解析通用配置片段：空 / 纯注释片段视为「没有内容」（返回 `None`，不报错）。
///
/// 语法错误必须报出来——用户正在编辑的就是这段文本，静默吞掉会让他以为已保存。
pub fn parse_common_config(snippet: &str) -> AppResult<Option<Table>> {
    let trimmed = snippet.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let table: Table = toml::from_str(trimmed).map_err(|e| {
        AppError::invalid(format!(
            "无效的 TOML 格式：{}",
            e.message().lines().next().unwrap_or("解析失败")
        ))
    })?;
    Ok((!table.is_empty()).then_some(table))
}

/// 校验通用配置片段（保存前调用，错误文案直接给用户看）。
pub fn validate_common_config(snippet: &str) -> AppResult<()> {
    parse_common_config(snippet).map(|_| ())
}

/// 合并通用配置片段：同名键被片段覆盖、子表递归合并、缺失键插入。
fn merge_common_config(table: &mut Table, snippet: &Table) {
    for (key, source) in snippet {
        match table.get_mut(key) {
            Some(target) => merge_toml_value(target, source),
            None => {
                table.insert(key.clone(), source.clone());
            }
        }
    }
}

fn merge_toml_value(target: &mut Value, source: &Value) {
    if let (Value::Table(target), Value::Table(source)) = (&mut *target, source) {
        merge_common_config(target, source);
        return;
    }
    *target = source.clone();
}

/// 剥离通用配置片段：只有「值一致」才删（数组按子集逐项删），表删空后整键移除。
///
/// 这是「取消勾选」的路径：不能凭我们自己的记忆删键——用户可能已经手工改过其中的值，
/// 那种情况下保留他的修改才是正确行为。
pub fn remove_common_config(table: &mut Table, snippet: &Table) {
    let keys: Vec<String> = snippet.keys().cloned().collect();
    for key in keys {
        let Some(source) = snippet.get(&key) else {
            continue;
        };
        let should_remove = match table.get_mut(&key) {
            Some(target) => remove_toml_value(target, source),
            None => false,
        };
        if should_remove {
            table.remove(&key);
        }
    }
}

/// 返回 `true` 表示目标项与片段「一致」，可以整键删除。
fn remove_toml_value(target: &mut Value, source: &Value) -> bool {
    match (target, source) {
        (Value::Table(target), Value::Table(source)) => {
            remove_common_config(target, source);
            target.is_empty()
        }
        (Value::Array(target), Value::Array(source)) => {
            target.retain(|item| !source.iter().any(|candidate| candidate == item));
            target.is_empty()
        }
        (target, source) => target == source,
    }
}

/// 从一份 `config.toml` 里提取「通用部分」：去掉与当前供应商强绑定的键。
///
/// 与 cc-switch 的 `extract_codex_common_config` 同一套排除规则：模型 / provider 段 /
/// MCP 服务器 / 目录指针 / 密钥 / 值为 `disabled` 的联网搜索开关都被剔除，
/// 剩下的（插件、环境变量、通知等）才是可以跨供应商共享的部分。
///
/// 注：本项目的 `config.toml` 由 `toml` crate 解析后重新序列化，**注释不会保留**
/// （渲染层一直以来就是这个行为），因此提取结果同样不含注释。
pub fn extract_common_config(config_toml: &str) -> AppResult<String> {
    let trimmed = config_toml.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let mut table: Table = toml::from_str(trimmed).map_err(|e| {
        AppError::invalid(format!(
            "无效的 TOML 格式：{}",
            e.message().lines().next().unwrap_or("解析失败")
        ))
    })?;

    for key in PRIVATE_CONFIG_KEYS {
        table.remove(key);
    }
    if let Some(Value::Table(mcp)) = table.get_mut("mcp") {
        mcp.remove("servers");
        if mcp.is_empty() {
            table.remove("mcp");
        }
    }
    // cc-switch 给「不支持联网搜索」的网关写下的是 `web_search = "disabled"` 哨兵值，
    // 它同样属于供应商私有；用户自己设的取值（本应用勾选写的是 `"live"`）保留。
    if table
        .get(SWITCH_WEB_SEARCH)
        .and_then(|value| value.as_str())
        == Some("disabled")
    {
        table.remove(SWITCH_WEB_SEARCH);
    }
    if table.is_empty() {
        return Ok(String::new());
    }
    sort_table(&mut table);
    toml::to_string_pretty(&table).map_err(|e| AppError::serde(e.to_string()))
}

/// 接管 `model_catalog_json` 指针：只在「没有该键」或「键指向我们自己的目录文件」时动手。
///
/// 用户若自己维护着别的目录文件，我们既不覆盖也不删除——那属于他的配置。
fn set_catalog_pointer(table: &mut Table, has_catalog: bool) {
    let owned = match table
        .get(KEY_MODEL_CATALOG_JSON)
        .and_then(|value| value.as_str())
    {
        // 没有指针 = 空位，可以接管；指向别人的文件 = 用户自己维护，不碰。
        None => true,
        Some(value) => is_own_catalog_path(value),
    };
    if has_catalog {
        if owned {
            table.insert(
                KEY_MODEL_CATALOG_JSON.to_string(),
                Value::String(CATALOG_FILE.to_string()),
            );
        }
    } else if owned {
        table.remove(KEY_MODEL_CATALOG_JSON);
    }
}

/// 指针是否指向我们自己生成的目录文件（只比文件名，用户写在哪个目录都算）。
fn is_own_catalog_path(value: &str) -> bool {
    Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == CATALOG_FILE)
}

/// 渲染模型目录文件；「模型映射」为空时返回 `None`（不写文件、也不接管指针）。
fn render_catalog(home: &Path, input: &ClientRenderInput) -> AppResult<Option<RenderedFile>> {
    if input.routing.model_catalog.is_empty() {
        return Ok(None);
    }
    let path = home.join(CONFIG_DIR).join(CATALOG_FILE);
    let existed = path.is_file();
    let default_window = if input.routing.context_window > 0 {
        input.routing.context_window
    } else {
        CATALOG_DEFAULT_CONTEXT_WINDOW
    };
    let entries: Vec<JsonValue> = input
        .routing
        .model_catalog
        .iter()
        .enumerate()
        .map(|(index, entry)| catalog_entry(entry, index, default_window))
        .collect();
    let mut document = JsonValue::Object(JsonMap::new());
    document[JSON_KEY_MODELS] = JsonValue::Array(entries);
    sort_json(&mut document);
    let content =
        serde_json::to_string_pretty(&document).map_err(|e| AppError::serde(e.to_string()))?;
    Ok(Some(RenderedFile {
        path,
        language: "json".to_string(),
        content,
        existed,
    }))
}

/// 把一条映射记录翻译成 Codex 目录条目。
///
/// 字段集与 Codex 官方「native responses」条目对齐（第三方网关只走 Responses / Chat 协议，
/// 不含厂商专属的 harness 字段），逐项覆写成用户填的值。
fn catalog_entry(entry: &ModelCatalogEntry, index: usize, default_window: u32) -> JsonValue {
    let window = if entry.context_window > 0 {
        entry.context_window
    } else {
        default_window
    };
    let levels: Vec<&str> = if entry.reasoning_levels.is_empty() {
        CATALOG_FALLBACK_LEVELS.to_vec()
    } else {
        entry.reasoning_levels.iter().map(String::as_str).collect()
    };
    // 默认档位取最深的一档：用户的档位是按思考深度升序存的，最后一档最强。
    let default_level = levels.last().copied().unwrap_or("high");
    let supported: Vec<JsonValue> = levels
        .iter()
        .map(|effort| {
            json!({
                JSON_KEY_REASONING_EFFORT: effort,
                JSON_KEY_REASONING_DESC: reasoning_description(effort),
            })
        })
        .collect();
    let display_name = if entry.display_name.trim().is_empty() {
        entry.model.as_str()
    } else {
        entry.display_name.trim()
    };

    let mut model = JsonMap::new();
    model.insert(JSON_KEY_SLUG.to_string(), json!(entry.model));
    model.insert(JSON_KEY_DISPLAY_NAME.to_string(), json!(display_name));
    model.insert(JSON_KEY_DESCRIPTION.to_string(), json!(display_name));
    model.insert(
        JSON_KEY_BASE_INSTRUCTIONS.to_string(),
        json!(CATALOG_BASE_INSTRUCTIONS),
    );
    model.insert(
        JSON_KEY_SUPPORTED_REASONING.to_string(),
        JsonValue::Array(supported),
    );
    model.insert(JSON_KEY_DEFAULT_REASONING.to_string(), json!(default_level));
    model.insert(JSON_KEY_SHELL_TYPE.to_string(), json!(CATALOG_SHELL_TYPE));
    model.insert(JSON_KEY_VISIBILITY.to_string(), json!(CATALOG_VISIBILITY));
    model.insert(JSON_KEY_SUPPORTED_IN_API.to_string(), json!(true));
    model.insert(JSON_KEY_PRIORITY.to_string(), json!(index as i64));
    model.insert(JSON_KEY_SUPPORTS_SUMMARIES.to_string(), json!(true));
    model.insert(JSON_KEY_DEFAULT_SUMMARY.to_string(), json!("none"));
    model.insert(JSON_KEY_SUPPORT_VERBOSITY.to_string(), json!(false));
    model.insert(
        JSON_KEY_TRUNCATION.to_string(),
        json!({ "mode": "bytes", "limit": 10000 }),
    );
    model.insert(JSON_KEY_SUPPORTS_PARALLEL.to_string(), json!(false));
    model.insert(JSON_KEY_SUPPORTS_IMAGE_DETAIL.to_string(), json!(false));
    model.insert(JSON_KEY_CONTEXT_WINDOW.to_string(), json!(window));
    model.insert(JSON_KEY_MAX_CONTEXT_WINDOW.to_string(), json!(window));
    model.insert(JSON_KEY_EFFECTIVE_PERCENT.to_string(), json!(95));
    model.insert(JSON_KEY_INPUT_MODALITIES.to_string(), json!(["text"]));
    model.insert(JSON_KEY_SUPPORTS_SEARCH.to_string(), json!(false));
    JsonValue::Object(model)
}

/// 思考档位的展示说明：注册表登记过的取表内文案，未登记的退回档位名本身。
fn reasoning_description(effort: &str) -> String {
    REASONING_DESCRIPTIONS
        .iter()
        .find(|(value, _)| *value == effort)
        .map(|(_, description)| (*description).to_string())
        .unwrap_or_else(|| effort.to_string())
}

/// 读取现有 TOML 表：不存在 / 解析失败都以空表开始（解析失败留日志）。
fn read_toml_table(path: &Path) -> Table {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == ErrorKind::NotFound => return Table::new(),
        Err(err) => {
            log::warn!(
                "读取 Codex config.toml 失败，将按空表处理（{}）：{}",
                path.display(),
                err
            );
            return Table::new();
        }
    };
    match toml::from_str::<Table>(&text) {
        Ok(table) => table,
        Err(err) => {
            log::warn!(
                "解析 Codex config.toml 失败，将按空表处理（{}）：{}",
                path.display(),
                err
            );
            Table::new()
        }
    }
}

/// 递归按键名升序重排 TOML 表（保证输出稳定，不受 `preserve_order` feature 影响）。
fn sort_table(table: &mut Table) {
    let mut entries: Vec<(String, Value)> = std::mem::take(table).into_iter().collect();
    entries.sort_by(|(left, _), (right, _)| left.cmp(right));
    for (key, mut value) in entries {
        if let Value::Table(child) = &mut value {
            sort_table(child);
        }
        table.insert(key, value);
    }
}

/// 写入 / 删除可选字符串键：值为空即删除该键（不留下陈旧值）。
fn set_string(table: &mut Table, key: &str, value: Option<&str>) {
    match value {
        Some(value) => {
            table.insert(key.to_string(), Value::String(value.to_string()));
        }
        None => {
            table.remove(key);
        }
    }
}

/// 写入 / 删除布尔开关：打开写 `true`，关闭删除该键。
fn set_flag(table: &mut Table, key: &str, enabled: bool) {
    if enabled {
        table.insert(key.to_string(), Value::Boolean(true));
    } else {
        table.remove(key);
    }
}

/// `api_format` → Codex 的 `wire_api` 取值。
fn wire_api(api_format: &str) -> &'static str {
    if api_format.trim().eq_ignore_ascii_case(API_FORMAT_RESPONSES) {
        "responses"
    } else {
        "chat"
    }
}

/// provider 展示名：供应商名为空时用固定名，避免写出空 string。
fn provider_name(supplier_name: &str) -> String {
    let name = supplier_name.trim();
    if name.is_empty() {
        FALLBACK_PROVIDER_NAME.to_string()
    } else {
        name.to_string()
    }
}

/// 思考强度：非法 / 缺失时回落注册表登记的默认值；注册表缺登记时不写该键。
fn reasoning_effort(routing: &SupplierRouting) -> String {
    let option = client_service::find_client(CLIENT_ID).and_then(|client| {
        client
            .options()
            .iter()
            .find(|item| item.key == OPTION_REASONING_EFFORT)
    });
    let Some(option) = option else {
        return String::new();
    };
    let value = non_empty(routing.options.get(OPTION_REASONING_EFFORT)).unwrap_or_default();
    if option.choices.iter().any(|(choice, _)| *choice == value) {
        value.to_string()
    } else {
        option.default.to_string()
    }
}
