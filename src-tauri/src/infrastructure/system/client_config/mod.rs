//! 客户端配置文件读写（模型路由的落地点）
//!
//! 把「某供应商在某客户端上的路由配置」（[`ClientRenderInput`]）翻译成客户端真实配置文件的
//! **合并式**内容，并在需要时连备份一起落盘。
//!
//! 三个值对象（渲染输入 / 渲染结果 / 写入结果）的定义在
//! `domain::client::model::valobj`：应用层与命令层都要用它们，
//! 按依赖倒置归属于领域层；本模块只负责「怎么渲染、怎么写」。
//!
//! # 为什么是合并式
//! 目标文件（`~/.claude/settings.json`、`~/.codex/config.toml`）是用户自己的文件，
//! 里面除了我们接管的字段，还有 `mcpServers` / `permissions` / 其它 provider 等无关内容。
//! 因此这里只覆盖「本应用接管的键」，其余原样保留；写入前先备份 `.bak`，
//! 写盘走 `types::utils::fs` 的原子写（先写临时文件再整体替换），避免半写损坏。
//!
//! # 三层契约
//! - [`render`]：**只读**实盘并合并出将要写入的完整内容（界面预览与落盘用的是同一份字节）；
//! - [`write`]：合并 + 备份 + 原子写盘，返回写了哪些文件、备份在哪；
//! - [`read_live`]：读实盘当前内容（不合并、不改写），供界面展示「当前生效的配置」。
//!
//! # 动态扩展
//! **新增客户端 = 在 `client_service::CLIENTS` 登记一条 + 在本目录新增一个实现文件 +
//! 在下方分派处加一行**。实现文件需导出同名三件套 `paths(home)` / `render(home, input)` /
//! `read_live(home)`；本模块不含任何客户端特有的字段知识。
//!
//! # 测试
//! 公开函数固定用 `dirs::home_dir()`；内部一律提供可注入根目录的 `*_at(home, ...)` 版本，
//! 因此测试能完整覆盖合并 / 备份 / 落盘，而**绝不触碰真实家目录**。

pub mod claude;
pub mod codex;

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::domain::client::model::valobj::{ClientRenderInput, ClientWriteOutcome, RenderedFile};
use crate::domain::client::service::client_service;
use crate::domain::supplier::model::SupplierRouting;
use crate::types::exception::{AppError, AppResult};
use crate::types::utils::fs as fs_utils;

/// 渲染某客户端的目标文件（只读实盘用于合并，**不落盘**）。
pub fn render(client_id: &str, input: &ClientRenderInput) -> AppResult<Vec<RenderedFile>> {
    render_at(&home_dir(), client_id, input)
}

/// 写入：合并 + `.bak` 备份 + 原子写盘。客户端标识非法或未登记时返回错误。
pub fn write(client_id: &str, input: &ClientRenderInput) -> AppResult<ClientWriteOutcome> {
    write_at(&home_dir(), client_id, input)
}

/// 读取实盘当前内容（不合并、不改写），供界面展示「当前生效的配置」。
pub fn read_live(client_id: &str) -> AppResult<Vec<RenderedFile>> {
    read_live_at(&home_dir(), client_id)
}

// ---------------------------------------------------------------------------
// 通用配置片段（只有登记了「应用通用配置」开关的客户端才有）
// ---------------------------------------------------------------------------

/// 该客户端不支持通用配置片段时的错误文案。
fn unsupported_common_config(client_id: &str) -> AppError {
    AppError::invalid(format!("{} 不支持通用配置片段", client_id.trim()))
}

/// 校验通用配置片段（保存前调用）：语法非法时把原因原文交给用户。
pub fn validate_common_config(client_id: &str, snippet: &str) -> AppResult<()> {
    if !client_service::supports_common_config(client_id) {
        return Err(unsupported_common_config(client_id));
    }
    codex::validate_common_config(snippet)
}

/// 从一份配置文件内容里提取「通用部分」（与供应商绑定的键会被排除）。
pub fn extract_common_config(client_id: &str, config_text: &str) -> AppResult<String> {
    if !client_service::supports_common_config(client_id) {
        return Err(unsupported_common_config(client_id));
    }
    codex::extract_common_config(config_text)
}

// ---------------------------------------------------------------------------
// 内部实现（可注入根目录，供测试使用）
// ---------------------------------------------------------------------------

/// 家目录：无法解析时回退当前目录（与既有外部集成一致的宽松策略）。
fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// 未登记（或尚未落地实现）的客户端：直接拒绝，绝不在用户家目录里乱写文件。
fn unknown_client(client_id: &str) -> AppError {
    AppError::invalid(format!("未登记的客户端：{}", client_id.trim()))
}

/// 分派渲染实现（新增客户端在此加一行）。
fn render_at(
    home: &Path,
    client_id: &str,
    input: &ClientRenderInput,
) -> AppResult<Vec<RenderedFile>> {
    match client_service::find_client(client_id).map(|client| client.id) {
        Some(claude::CLIENT_ID) => claude::render(home, input),
        Some(codex::CLIENT_ID) => codex::render(home, input),
        _ => Err(unknown_client(client_id)),
    }
}

/// 分派写盘实现（新增客户端在此加一行）。
fn write_at(
    home: &Path,
    client_id: &str,
    input: &ClientRenderInput,
) -> AppResult<ClientWriteOutcome> {
    // 先渲染（只读实盘）再统一落盘：合并阶段不写任何字节，失败时原文件分毫未动。
    let files = render_at(home, client_id, input)?;
    let mut backups = Vec::new();
    for file in &files {
        if let Some(parent) = file.path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                AppError::io(format!(
                    "创建客户端配置目录失败（{}）：{}",
                    parent.display(),
                    e
                ))
            })?;
        }
        // 先备份再写正式文件：备份失败视为整体写入失败，绝不继续覆盖原文件。
        if file.existed {
            let backup = backup_path(&file.path);
            fs::copy(&file.path, &backup).map_err(|e| {
                AppError::io(format!("备份客户端配置失败（{}）：{}", backup.display(), e))
            })?;
            backups.push(backup);
        }
        fs_utils::write_atomic(
            &file.path,
            file.content.as_bytes(),
            |e| {
                AppError::io(format!(
                    "写入客户端配置失败（{}）：{}",
                    file.path.display(),
                    e
                ))
            },
            |e| {
                AppError::io(format!(
                    "保存客户端配置失败（{}）：{}",
                    file.path.display(),
                    e
                ))
            },
        )?;
    }
    Ok(ClientWriteOutcome { files, backups })
}

/// 分派读取实现（新增客户端在此加一行）。
fn read_live_at(home: &Path, client_id: &str) -> AppResult<Vec<RenderedFile>> {
    match client_service::find_client(client_id).map(|client| client.id) {
        Some(claude::CLIENT_ID) => claude::read_live(home),
        Some(codex::CLIENT_ID) => codex::read_live(home),
        _ => Err(unknown_client(client_id)),
    }
}

/// 备份文件路径：同目录同名 + `.bak`（反复写入即反复覆盖同一份备份）。
fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    path.with_file_name(format!("{}.bak", name))
}

/// 读取实盘目标文件（不合并、不改写）：文件缺失视为「尚未创建」——内容为空串。
fn read_live_files(targets: &[(PathBuf, &'static str)]) -> AppResult<Vec<RenderedFile>> {
    targets
        .iter()
        .map(|(path, language)| match fs::read_to_string(path) {
            Ok(content) => Ok(RenderedFile {
                path: path.clone(),
                language: (*language).to_string(),
                content,
                existed: true,
            }),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(RenderedFile {
                path: path.clone(),
                language: (*language).to_string(),
                content: String::new(),
                existed: false,
            }),
            Err(err) => Err(AppError::io(format!(
                "读取客户端配置失败（{}）：{}",
                path.display(),
                err
            ))),
        })
        .collect()
}

/// 读取现有 JSON 对象：文件不存在视为 `{}`；解析失败或根不是对象也视为 `{}` 并留日志。
///
/// 「坏 JSON 不让应用整体失败」是有意为之：这是用户的文件，宁可只覆盖我们接管的键，
/// 也不能因为文件里有一处笔误就让「应用配置」彻底不可用。
fn read_json_object(path: &Path) -> Map<String, Value> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == ErrorKind::NotFound => return Map::new(),
        Err(err) => {
            log::warn!(
                "读取客户端配置失败，将按空对象处理（{}）：{}",
                path.display(),
                err
            );
            return Map::new();
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => map,
        Ok(_) => {
            log::warn!("客户端配置的根不是对象，将按空对象处理：{}", path.display());
            Map::new()
        }
        Err(err) => {
            log::warn!(
                "解析客户端配置失败，将按空对象处理（{}）：{}",
                path.display(),
                err
            );
            Map::new()
        }
    }
}

/// 递归按键名升序重排 JSON 对象。
///
/// `serde_json` 的对象在 `preserve_order` feature 下是插入序，因此不能依赖
/// 「BTreeMap 天然有序」：显式排序才能保证渲染结果稳定可比（预览与落盘逐字节一致，
/// 也让「键序」不随解析顺序漂移）。
fn sort_json(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = std::mem::take(map).into_iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            for (key, mut child) in entries {
                sort_json(&mut child);
                map.insert(key, child);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(sort_json),
        _ => {}
    }
}

/// 取值非空（去空白后非空）时才返回，供「空值 = 不配置」的字段复用。
fn non_empty(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).and_then(non_empty_str)
}

/// 字符串的非空借用形式。
fn non_empty_str(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// 布尔开关是否开启：未配置时取注册表登记的默认值。
///
/// 默认值取自注册表而非各处硬编码，避免「界面显示的默认」与「实际写入的结果」漂移。
fn switch_enabled(client_id: &str, routing: &SupplierRouting, key: &str) -> bool {
    if let Some(enabled) = routing.switches.get(key) {
        return *enabled;
    }
    client_service::find_client(client_id)
        .and_then(|client| client.switches().iter().find(|item| item.key == key))
        .is_some_and(|item| item.default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::supplier::model::ModelCatalogEntry;
    use std::collections::BTreeMap;

    /// 独立临时家目录：客户端配置的测试一律不碰真实 `~/.claude` 与 `~/.codex`。
    fn unique_home(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "dsw-client-config-test-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    /// 目标文件路径（测试用，与实现模块的 `paths` 保持同一约定）。
    fn claude_settings(home: &Path) -> PathBuf {
        home.join(".claude").join("settings.json")
    }

    fn codex_auth(home: &Path) -> PathBuf {
        home.join(".codex").join("auth.json")
    }

    fn codex_config(home: &Path) -> PathBuf {
        home.join(".codex").join("config.toml")
    }

    /// 完整打开全部开关的 Claude 路由（关闭状态的断言走 `without_switches`）。
    fn all_switches() -> BTreeMap<String, bool> {
        client_service::find_client("claude")
            .unwrap()
            .switches()
            .iter()
            .map(|switch| (switch.key.to_string(), true))
            .collect()
    }

    fn claude_input() -> ClientRenderInput {
        ClientRenderInput {
            base_url: "https://api.deepseek.com/anthropic".to_string(),
            api_key: "sk-dsw-test".to_string(),
            api_format: "anthropic".to_string(),
            auth_field: "ANTHROPIC_AUTH_TOKEN".to_string(),
            routing: SupplierRouting {
                client_id: "claude".to_string(),
                model_map: BTreeMap::from([
                    ("haiku".to_string(), "deepseek-chat".to_string()),
                    ("sonnet".to_string(), "deepseek-chat[1M]".to_string()),
                    ("opus".to_string(), "deepseek-reasoner".to_string()),
                    ("fable".to_string(), "deepseek-chat".to_string()),
                    ("subagent".to_string(), "deepseek-chat".to_string()),
                ]),
                display_map: BTreeMap::from([
                    ("haiku".to_string(), "快速档".to_string()),
                    ("sonnet".to_string(), "标准档".to_string()),
                    ("opus".to_string(), "高能档".to_string()),
                    ("fable".to_string(), "Fable 档".to_string()),
                ]),
                context_window: 200_000,
                ..SupplierRouting::default()
            },
            supplier_name: "DeepSeek".to_string(),
            common_config: String::new(),
        }
    }

    fn codex_input() -> ClientRenderInput {
        ClientRenderInput {
            base_url: "https://api.deepseek.com".to_string(),
            api_key: "sk-dsw-test".to_string(),
            api_format: "openai".to_string(),
            auth_field: "OPENAI_API_KEY".to_string(),
            routing: SupplierRouting {
                client_id: "codex".to_string(),
                model_map: BTreeMap::from([("primary".to_string(), "deepseek-chat".to_string())]),
                context_window: 200_000,
                switches: BTreeMap::from([
                    ("disable_response_storage".to_string(), true),
                    ("web_search".to_string(), true),
                ]),
                options: BTreeMap::from([("reasoning_effort".to_string(), "high".to_string())]),
                ..SupplierRouting::default()
            },
            supplier_name: "DeepSeek".to_string(),
            common_config: String::new(),
        }
    }

    /// 渲染唯一目标文件（claude 只有一个目标文件）。
    fn render_claude(home: &Path, input: &ClientRenderInput) -> RenderedFile {
        let mut files = render_at(home, "claude", input).expect("渲染 Claude 配置应成功");
        assert_eq!(files.len(), 1, "Claude 只有一个目标文件");
        files.remove(0)
    }

    fn parse_json(content: &str) -> Value {
        serde_json::from_str(content).expect("渲染结果必须是合法 JSON")
    }

    fn object_keys(value: &Value) -> Vec<String> {
        value
            .as_object()
            .expect("应为对象")
            .keys()
            .cloned()
            .collect()
    }

    fn write_file(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// 1. 合并式写入：用户自己的键（`mcpServers` / `env` 里的非接管键）必须原样保留。
    #[test]
    fn claude_merge_keeps_user_keys() {
        let home = unique_home("claude-merge");
        write_file(
            &claude_settings(&home),
            r#"{"mcpServers":{"demo":{"command":"node"}},"env":{"OTHER_KEY":"keep-me","ANTHROPIC_MODEL":"old-model"},"permissions":{"allow":["Bash"]}}"#,
        );

        let file = render_claude(&home, &claude_input());
        assert_eq!(file.path, claude_settings(&home));
        assert_eq!(file.language, "json");
        assert!(file.existed, "原文件已存在");
        let value = parse_json(&file.content);

        assert_eq!(
            value["mcpServers"]["demo"]["command"].as_str(),
            Some("node"),
            "非接管键必须保留"
        );
        assert_eq!(value["permissions"]["allow"][0].as_str(), Some("Bash"));
        assert_eq!(value["env"]["OTHER_KEY"].as_str(), Some("keep-me"));

        let env = &value["env"];
        assert_eq!(
            env["ANTHROPIC_BASE_URL"].as_str(),
            Some("https://api.deepseek.com/anthropic")
        );
        // 认证字段默认是 ANTHROPIC_AUTH_TOKEN：写它、并且不留下 API_KEY。
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"].as_str(), Some("sk-dsw-test"));
        assert!(
            env.get("ANTHROPIC_API_KEY").is_none(),
            "认证字段互斥：另一个来源必须删除"
        );
        assert_eq!(
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"].as_str(),
            Some("deepseek-chat")
        );
        assert_eq!(
            env["ANTHROPIC_DEFAULT_SONNET_MODEL"].as_str(),
            Some("deepseek-chat[1M]"),
            "1M 能力标记随模型名一起写入（Claude Code 靠后缀声明 100 万上下文）"
        );
        assert_eq!(
            env["ANTHROPIC_DEFAULT_OPUS_MODEL"].as_str(),
            Some("deepseek-reasoner")
        );
        assert_eq!(
            env["ANTHROPIC_DEFAULT_FABLE_MODEL"].as_str(),
            Some("deepseek-chat")
        );
        assert_eq!(
            env["CLAUDE_CODE_SUBAGENT_MODEL"].as_str(),
            Some("deepseek-chat")
        );
        // 显示名只写进 *_MODEL_NAME，不进 *_MODEL。
        assert_eq!(
            env["ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"].as_str(),
            Some("标准档")
        );
        assert_eq!(
            env["ANTHROPIC_DEFAULT_FABLE_MODEL_NAME"].as_str(),
            Some("Fable 档")
        );
        // 「上下文窗口」配置项已移除：相关历史键一律清理，不再写入。
        assert!(
            env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS").is_none()
                && env.get("ANTHROPIC_MODEL_CONTEXT_WINDOW").is_none(),
            "上下文窗口键必须被清理：{:?}",
            env
        );
        // 「主模型」槽位已移除：旧值必须被清理，否则会架空整套档位映射。
        assert!(
            env.get("ANTHROPIC_MODEL").is_none(),
            "旧版本写入的 ANTHROPIC_MODEL 必须删除"
        );
        assert!(env.get("ANTHROPIC_SMALL_FAST_MODEL").is_none());

        let _ = fs::remove_dir_all(&home);
    }

    /// 2. 认证字段互斥：写一个必删另一个，避免 Claude Code 同时读到两个来源。
    #[test]
    fn claude_auth_field_switches_exclusive_key() {
        let home = unique_home("claude-auth");
        write_file(
            &claude_settings(&home),
            r#"{"env":{"ANTHROPIC_API_KEY":"stale","ANTHROPIC_AUTH_TOKEN":"stale"}}"#,
        );

        // 默认（ANTHROPIC_AUTH_TOKEN）→ 写 ANTHROPIC_AUTH_TOKEN，删除 ANTHROPIC_API_KEY。
        let token = parse_json(&render_claude(&home, &claude_input()).content);
        assert_eq!(
            token["env"]["ANTHROPIC_AUTH_TOKEN"].as_str(),
            Some("sk-dsw-test")
        );
        assert!(token["env"].get("ANTHROPIC_API_KEY").is_none());

        // ANTHROPIC_API_KEY → 写 ANTHROPIC_API_KEY，删除 ANTHROPIC_AUTH_TOKEN。
        let mut api_key = claude_input();
        api_key.auth_field = "ANTHROPIC_API_KEY".to_string();
        let keyed = parse_json(&render_claude(&home, &api_key).content);
        assert_eq!(
            keyed["env"]["ANTHROPIC_API_KEY"].as_str(),
            Some("sk-dsw-test")
        );
        assert!(keyed["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());

        // 大小写 / 空白不影响判定（界面草稿可能未归一化）。
        let mut loose = claude_input();
        loose.auth_field = " anthropic_api_key ".to_string();
        let normalized = parse_json(&render_claude(&home, &loose).content);
        assert_eq!(
            normalized["env"]["ANTHROPIC_API_KEY"].as_str(),
            Some("sk-dsw-test")
        );

        let _ = fs::remove_dir_all(&home);
    }

    /// 3. 开关：打开写值（含顶层 `attribution`），关闭删键且不留空对象残留。
    #[test]
    fn claude_switches_write_and_remove_keys() {
        let home = unique_home("claude-switches");
        let mut input = claude_input();
        input.routing.switches = all_switches();

        let opened = render_claude(&home, &input);
        let value = parse_json(&opened.content);
        assert_eq!(
            value["attribution"],
            serde_json::json!({"commit": "", "pr": ""}),
            "隐藏 AI 署名走顶层 attribution"
        );
        let env = &value["env"];
        assert_eq!(
            env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"].as_str(),
            Some("1")
        );
        assert_eq!(env["ENABLE_TOOL_SEARCH"].as_str(), Some("true"));
        assert_eq!(env["CLAUDE_CODE_EFFORT_LEVEL"].as_str(), Some("max"));
        assert_eq!(env["DISABLE_AUTOUPDATER"].as_str(), Some("1"));
        assert_eq!(env["CLAUDE_CODE_DISABLE_ARTIFACT"].as_str(), Some("1"));

        // 关闭：一律删除对应键（不留 "attribution": {} 之类的空对象残留）。
        input.routing.switches = BTreeMap::new();
        let closed = render_claude(&home, &input);
        let value = parse_json(&closed.content);
        assert!(value.get("attribution").is_none());
        assert!(!closed.content.contains("\"attribution\""));
        let env = &value["env"];
        for key in [
            "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
            "ENABLE_TOOL_SEARCH",
            "CLAUDE_CODE_EFFORT_LEVEL",
            "DISABLE_AUTOUPDATER",
            "CLAUDE_CODE_DISABLE_ARTIFACT",
        ] {
            assert!(env.get(key).is_none(), "关闭后不得残留 {}", key);
        }

        let _ = fs::remove_dir_all(&home);
    }

    /// 4. 清理历史遗留键，但不误删非接管键。
    #[test]
    fn claude_cleanup_touches_only_managed_keys() {
        let home = unique_home("claude-cleanup");
        write_file(
            &claude_settings(&home),
            r#"{"env":{"ANTHROPIC_MODEL_CONTEXT_WINDOW":123456,"ANTHROPIC_MODEL":"legacy","ANTHROPIC_SMALL_FAST_MODEL":"legacy","ANTHROPIC_DEFAULT_FABLE_MODEL_NAME":"我改的名字","OTHER_KEY":"keep"}}"#,
        );

        let file = render_claude(&home, &claude_input());
        let env = &parse_json(&file.content)["env"];
        assert!(
            env.get("ANTHROPIC_MODEL_CONTEXT_WINDOW").is_none(),
            "旧版本写入的非法键必须被清理"
        );
        assert!(
            env.get("ANTHROPIC_MODEL").is_none() && env.get("ANTHROPIC_SMALL_FAST_MODEL").is_none(),
            "已移除的「主模型 / 快速模型」槽位不得留下旧值"
        );
        assert_eq!(
            env["OTHER_KEY"].as_str(),
            Some("keep"),
            "不在注册表内的历史键不属于接管范围，必须保留"
        );
        // 显示名是接管键：本次草稿给了 Fable 的名字，旧值必须被覆盖。
        assert_eq!(
            env["ANTHROPIC_DEFAULT_FABLE_MODEL_NAME"].as_str(),
            Some("Fable 档")
        );

        // 显示名留空 = 不配置：对应键一并删除（不写空串）。
        let mut no_name = claude_input();
        no_name.routing.display_map.remove("haiku");
        let env = &parse_json(&render_claude(&home, &no_name).content)["env"];
        assert!(env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME").is_none());
        assert_eq!(
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"].as_str(),
            Some("deepseek-chat"),
            "显示名与模型名互不影响"
        );

        // 上下文窗口为 0 表示沿用客户端默认：删除该键。
        let mut no_window = claude_input();
        no_window.routing.context_window = 0;
        let env = &parse_json(&render_claude(&home, &no_window).content)["env"];
        assert!(env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS").is_none());

        // 槽位留空 = 不配置该槽位：对应 env 键一并删除（不留下上一次应用的陈旧值）。
        let mut partial = claude_input();
        partial.routing.model_map.remove("haiku");
        let env = &parse_json(&render_claude(&home, &partial).content)["env"];
        assert!(env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").is_none());
        assert_eq!(
            env["ANTHROPIC_DEFAULT_SONNET_MODEL"].as_str(),
            Some("deepseek-chat[1M]")
        );

        // 草稿给 Haiku 带了 1M 标记：渲染时就剥掉（预览与落盘是同一段代码）。
        let mut marked = claude_input();
        marked
            .routing
            .model_map
            .insert("haiku".to_string(), "deepseek-chat[1M]".to_string());
        marked
            .routing
            .display_map
            .insert("haiku".to_string(), "快速档[1M]".to_string());
        let env = &parse_json(&render_claude(&home, &marked).content)["env"];
        assert_eq!(
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"].as_str(),
            Some("deepseek-chat"),
            "Haiku 不支持 1M：标记必须被剥掉"
        );
        assert_eq!(
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"].as_str(),
            Some("快速档"),
            "显示名里的标记同样不属于名字"
        );

        let _ = fs::remove_dir_all(&home);
    }

    /// 5. 键序稳定：顶层与 `env` 内（乃至更深层）的键都按升序输出。
    #[test]
    fn rendered_json_keys_are_sorted_recursively() {
        let home = unique_home("claude-order");
        // 故意乱序写入，确保断言的是「我们排过的序」而不是解析顺序。
        write_file(
            &claude_settings(&home),
            r#"{"zeta":1,"env":{"ZZZ":"1","AAA":"2"},"mcpServers":{"z":{},"a":{}},"alpha":2}"#,
        );

        let file = render_claude(&home, &claude_input());
        let value = parse_json(&file.content);

        let top = object_keys(&value);
        let mut sorted = top.clone();
        sorted.sort();
        assert_eq!(top, sorted, "顶层键必须升序：{:?}", top);
        assert_eq!(top, vec!["alpha", "env", "mcpServers", "zeta"]);

        let env = object_keys(&value["env"]);
        let mut sorted_env = env.clone();
        sorted_env.sort();
        assert_eq!(env, sorted_env, "env 键必须升序：{:?}", env);
        assert_eq!(
            env.first().map(String::as_str),
            Some("AAA"),
            "用户的环境变量与接管的键混排在同一套升序里"
        );
        assert!(env.contains(&"ANTHROPIC_AUTH_TOKEN".to_string()));
        assert_eq!(
            env.last().map(String::as_str),
            Some("ZZZ"),
            "用户键 ZZZ 仍保留（且排在最后）"
        );
        assert_eq!(object_keys(&value["mcpServers"]), vec!["a", "z"]);

        // 字符串里的位置也必须单调递增：证明序列化输出本身有序。
        for keys in [&top, &env] {
            let mut last = 0;
            for key in keys {
                let position = file
                    .content
                    .find(&format!("\"{}\"", key))
                    .unwrap_or_else(|| panic!("输出里找不到键 {}", key));
                assert!(position >= last, "键 {} 的位置回退了", key);
                last = position;
            }
        }

        let _ = fs::remove_dir_all(&home);
    }

    /// 6. Codex：合并 `config.toml`（保留其它 provider 与顶层键、删掉遗留段）并把 `auth.json` 里的密钥合并写入。
    #[test]
    fn codex_merge_keeps_user_keys_and_replaces_provider() {
        let home = unique_home("codex-merge");
        write_file(
            &codex_config(&home),
            "approval_policy = \"never\"\n\n[model_providers.other]\nname = \"Other\"\nbase_url = \"https://other.example.com/v1\"\n\n[model_providers.custom]\nname = \"旧版本\"\nbase_url = \"https://stale.example.com\"\n",
        );
        write_file(
            &codex_auth(&home),
            r#"{"OPENAI_API_KEY":"stale","tokens":{"id_token":"keep"}}"#,
        );

        let files = render_at(&home, "codex", &codex_input()).expect("渲染 Codex 配置应成功");
        assert_eq!(files.len(), 2, "Codex 有两个目标文件");
        let auth = &files[0];
        let config = &files[1];
        assert_eq!(auth.path, codex_auth(&home));
        assert_eq!(auth.language, "json");
        assert_eq!(config.path, codex_config(&home));
        assert_eq!(config.language, "toml");
        assert!(auth.existed && config.existed);

        // auth.json：只接管 OPENAI_API_KEY，其它键保留。
        let auth_json = parse_json(&auth.content);
        assert_eq!(auth_json["OPENAI_API_KEY"].as_str(), Some("sk-dsw-test"));
        assert_eq!(auth_json["tokens"]["id_token"].as_str(), Some("keep"));

        // config.toml：往返解析一遍，确保写出的是合法 TOML。
        let table: toml::Table = toml::from_str(&config.content).expect("渲染结果必须是合法 TOML");
        assert_eq!(table["approval_policy"].as_str(), Some("never"));
        assert_eq!(
            table["model_providers"]["other"]["name"].as_str(),
            Some("Other"),
            "别的 provider 段必须保留"
        );
        assert!(
            table["model_providers"].get("custom").is_none(),
            "旧版本写入的 provider 段应被删除"
        );

        let dsw = &table["model_providers"]["dsw"];
        assert_eq!(dsw["name"].as_str(), Some("DeepSeek"));
        assert_eq!(dsw["base_url"].as_str(), Some("https://api.deepseek.com"));
        assert_eq!(dsw["wire_api"].as_str(), Some("chat"));
        assert_eq!(dsw["requires_openai_auth"].as_bool(), Some(true));

        assert_eq!(table["model_provider"].as_str(), Some("dsw"));
        assert_eq!(table["model"].as_str(), Some("deepseek-chat"));
        assert_eq!(table["model_reasoning_effort"].as_str(), Some("high"));
        assert_eq!(table["model_context_window"].as_integer(), Some(200_000));
        assert_eq!(table["disable_response_storage"].as_bool(), Some(true));
        assert_eq!(
            table["web_search"].as_str(),
            Some("live"),
            "联网搜索写字符串模式（布尔 true 是已废弃的旧别名）"
        );

        // 上下文窗口 0 / 开关关闭：对应键被删除；非法思考强度回落注册表默认值。
        let mut tightened = codex_input();
        tightened.routing.context_window = 0;
        tightened.routing.switches = BTreeMap::new();
        tightened.routing.options =
            BTreeMap::from([("reasoning_effort".to_string(), "turbo".to_string())]);
        tightened.api_format = "openai-responses".to_string();
        tightened.supplier_name = String::new();
        let files = render_at(&home, "codex", &tightened).unwrap();
        let table: toml::Table = toml::from_str(&files[1].content).unwrap();
        assert!(table.get("model_context_window").is_none());
        assert!(table.get("disable_response_storage").is_none());
        assert!(table.get("web_search").is_none());
        assert_eq!(
            table["model_reasoning_effort"].as_str(),
            Some("high"),
            "非法取值回落注册表默认值"
        );
        assert_eq!(
            table["model_providers"]["dsw"]["wire_api"].as_str(),
            Some("responses")
        );
        assert_eq!(
            table["model_providers"]["dsw"]["name"].as_str(),
            Some("DSW"),
            "供应商名为空时写固定名"
        );

        let _ = fs::remove_dir_all(&home);
    }

    /// 6b. Codex 模型映射：生成目录文件、接管 `model_catalog_json` 指针、写 1M 上下文与压缩阈值。
    #[test]
    fn codex_model_catalog_is_generated_and_pointed() {
        let home = unique_home("codex-catalog");
        let mut input = codex_input();
        input.routing.model_catalog = vec![
            ModelCatalogEntry {
                display_name: "DeepSeek V4".to_string(),
                model: "deepseek-chat".to_string(),
                context_window: 1_048_576,
                reasoning_levels: vec!["medium".to_string(), "high".to_string()],
            },
            ModelCatalogEntry {
                display_name: String::new(),
                model: "deepseek-reasoner".to_string(),
                context_window: 0,
                reasoning_levels: Vec::new(),
            },
        ];
        // 勾选「支持1M」：窗口 1000000、压缩阈值 900000。
        input.routing.context_window = 1_000_000;
        input.routing.compact_token_limit = 900_000;

        let files = render_at(&home, "codex", &input).expect("渲染 Codex 配置应成功");
        assert_eq!(files.len(), 3, "密钥 + 配置 + 目录");
        let config = &files[1];
        let catalog = &files[2];
        assert_eq!(
            catalog.path,
            home.join(".codex").join("dsw-model-catalog.json")
        );
        assert_eq!(catalog.language, "json");
        assert!(!catalog.existed, "首次渲染只给出内容，不创建文件");

        let table: toml::Table = toml::from_str(&config.content).unwrap();
        assert_eq!(
            table["model_catalog_json"].as_str(),
            Some("dsw-model-catalog.json"),
            "目录指针写在 config.toml 顶层"
        );
        assert_eq!(table["model_context_window"].as_integer(), Some(1_000_000));
        assert_eq!(
            table["model_auto_compact_token_limit"].as_integer(),
            Some(900_000)
        );

        let document: Value = parse_json(&catalog.content);
        let models = document["models"].as_array().expect("顶层是 models 数组");
        assert_eq!(models.len(), 2);
        let first = &models[0];
        assert_eq!(first["slug"].as_str(), Some("deepseek-chat"));
        assert_eq!(first["display_name"].as_str(), Some("DeepSeek V4"));
        assert_eq!(first["context_window"].as_u64(), Some(1_048_576));
        assert_eq!(first["max_context_window"].as_u64(), Some(1_048_576));
        assert_eq!(
            first["supported_reasoning_levels"][0]["effort"].as_str(),
            Some("medium")
        );
        assert_eq!(first["default_reasoning_level"].as_str(), Some("high"));
        assert_eq!(
            first["supported_reasoning_levels"][0]["description"].as_str(),
            Some("兼顾速度与思考深度"),
            "档位说明是中文文案"
        );
        // 第二条：没填显示名 → 用模型名；上下文窗口 0 → 沿用顶层窗口；未声明档位 → 保守兜底。
        let second = &models[1];
        assert_eq!(second["display_name"].as_str(), Some("deepseek-reasoner"));
        assert_eq!(second["context_window"].as_u64(), Some(1_000_000));
        assert_eq!(second["priority"].as_i64(), Some(1));
        assert_eq!(
            second["supported_reasoning_levels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["effort"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["none", "high"]
        );

        // 映射清空：删除指针（只删我们自己写的那一个），且不再产出目录文件。
        let mut cleared = input.clone();
        cleared.routing.model_catalog = Vec::new();
        let files = render_at(&home, "codex", &cleared).unwrap();
        assert_eq!(files.len(), 2);
        let table: toml::Table = toml::from_str(&files[1].content).unwrap();
        assert!(table.get("model_catalog_json").is_none());

        // 用户自己的目录文件：指针不指向我们，则既不覆盖也不删除。
        write_file(
            &codex_config(&home),
            "model_catalog_json = \"/custom/my-catalog.json\"\n",
        );
        let table: toml::Table =
            toml::from_str(&render_at(&home, "codex", &input).unwrap()[1].content).unwrap();
        assert_eq!(
            table["model_catalog_json"].as_str(),
            Some("/custom/my-catalog.json"),
            "用户自管的目录文件不得被接管"
        );
        let table: toml::Table =
            toml::from_str(&render_at(&home, "codex", &cleared).unwrap()[1].content).unwrap();
        assert_eq!(
            table["model_catalog_json"].as_str(),
            Some("/custom/my-catalog.json"),
            "清空映射同样不得删除用户的指针"
        );

        let _ = fs::remove_dir_all(&home);
    }

    /// 6c. Codex 模型目录文件真的落盘：新建 → 备份 → 清空映射后删除指针。
    #[test]
    fn codex_catalog_file_is_written_and_backed_up() {
        let home = unique_home("codex-catalog-write");
        let mut input = codex_input();
        input.routing.model_catalog = vec![ModelCatalogEntry {
            display_name: "DeepSeek V4".to_string(),
            model: "deepseek-chat".to_string(),
            context_window: 0,
            reasoning_levels: vec!["high".to_string()],
        }];

        let outcome = write_at(&home, "codex", &input).expect("写入应成功");
        assert_eq!(outcome.files.len(), 3, "密钥 + 配置 + 模型目录");
        let catalog_path = home.join(".codex").join("dsw-model-catalog.json");
        assert!(catalog_path.is_file(), "模型目录文件必须真的落盘");
        let written = fs::read_to_string(&catalog_path).unwrap();
        assert_eq!(
            written, outcome.files[2].content,
            "落盘内容与预览逐字节一致"
        );
        let document: Value = serde_json::from_str(&written).expect("目录文件必须是合法 JSON");
        assert_eq!(document["models"][0]["slug"], "deepseek-chat");
        assert_eq!(
            document["models"][0]["context_window"], 200_000,
            "条目没填窗口时沿用供应商的上下文窗口"
        );

        // 再次写入：目录文件与另两个文件各自产生一份备份。
        let mut changed = input.clone();
        changed.routing.model_catalog[0].display_name = "改名后的模型".to_string();
        let second = write_at(&home, "codex", &changed).unwrap();
        let catalog_backup = catalog_path.with_extension("json.bak");
        assert!(
            second.backups.contains(&catalog_backup),
            "目录文件同样要先备份：{:?}",
            second.backups
        );
        assert!(fs::read_to_string(&catalog_backup)
            .unwrap()
            .contains("DeepSeek V4"));

        // 清空映射：删除指针，且不再产出目录文件（旧文件保留，下次写入会被覆写）。
        let mut cleared = input.clone();
        cleared.routing.model_catalog = Vec::new();
        let third = write_at(&home, "codex", &cleared).unwrap();
        assert_eq!(third.files.len(), 2, "没有映射就不再产出目录文件");
        let table: toml::Table =
            toml::from_str(&fs::read_to_string(home.join(".codex").join("config.toml")).unwrap())
                .unwrap();
        assert!(table.get("model_catalog_json").is_none());
        assert!(catalog_path.is_file(), "旧目录文件保留，不留半截状态");

        let _ = fs::remove_dir_all(&home);
    }

    /// 6d. Codex「启用远程压缩」：勾选时把 provider 段的 `name` 写成 `OpenAI`
    ///（Codex 见到该名字才会尝试远程压缩，与 cc-switch 一致），取消后回到供应商展示名。
    #[test]
    fn codex_remote_compaction_rewrites_provider_name() {
        let home = unique_home("codex-compaction");
        let mut input = codex_input();

        input
            .routing
            .switches
            .insert("remote_compaction".into(), true);
        let table: toml::Table =
            toml::from_str(&render_at(&home, "codex", &input).unwrap()[1].content).unwrap();
        assert_eq!(
            table["model_providers"]["dsw"]["name"].as_str(),
            Some("OpenAI")
        );

        input
            .routing
            .switches
            .insert("remote_compaction".into(), false);
        let table: toml::Table =
            toml::from_str(&render_at(&home, "codex", &input).unwrap()[1].content).unwrap();
        assert_eq!(
            table["model_providers"]["dsw"]["name"].as_str(),
            Some("DeepSeek"),
            "取消勾选后回到供应商展示名"
        );

        let _ = fs::remove_dir_all(&home);
    }

    /// 6e. Codex 通用配置片段：勾选「应用通用配置」合并进 `config.toml`（同名覆盖、子表递归），
    /// 取消勾选按「值一致」反向剥离；用户改过的值必须保留。
    #[test]
    fn codex_common_config_merges_and_strips() {
        let home = unique_home("codex-common");
        let snippet = "\
notify = [\"turn-ended\"]\n\
\n\
[tui]\n\
alternate_screen = \"always\"\n\
\n\
[mcp_servers.shared]\n\
command = \"npx\"\n";
        write_file(
            &codex_config(&home),
            "approval_policy = \"never\"\n\n[tui]\nnotifications = true\n",
        );

        let mut input = codex_input();
        input.common_config = snippet.to_string();
        input
            .routing
            .switches
            .insert("apply_common_config".into(), true);
        let applied = render_at(&home, "codex", &input).unwrap();
        let table: toml::Table = toml::from_str(&applied[1].content).unwrap();
        assert_eq!(table["notify"][0].as_str(), Some("turn-ended"));
        assert_eq!(table["tui"]["alternate_screen"].as_str(), Some("always"));
        assert_eq!(
            table["tui"]["notifications"].as_bool(),
            Some(true),
            "子表递归合并：片段没提到的键必须保留"
        );
        assert_eq!(
            table["mcp_servers"]["shared"]["command"].as_str(),
            Some("npx")
        );
        assert_eq!(table["approval_policy"].as_str(), Some("never"));

        // 落盘后再取消勾选：片段里的键被剥离，用户的 `approval_policy` 与其自加键保留。
        write_at(&home, "codex", &input).unwrap();
        let mut off = input.clone();
        off.routing
            .switches
            .insert("apply_common_config".into(), false);
        let stripped = render_at(&home, "codex", &off).unwrap();
        let table: toml::Table = toml::from_str(&stripped[1].content).unwrap();
        assert!(table.get("notify").is_none(), "片段带入的键应被剥离");
        assert!(table.get("mcp_servers").is_none());
        assert!(
            table["tui"].get("alternate_screen").is_none(),
            "片段带入的子键应被剥离"
        );
        assert_eq!(table["tui"]["notifications"].as_bool(), Some(true));
        assert_eq!(table["approval_policy"].as_str(), Some("never"));

        // 用户把片段带入的值改掉了：取消勾选时不能连他的修改一起删。
        write_at(&home, "codex", &input).unwrap();
        let edited = fs::read_to_string(codex_config(&home))
            .unwrap()
            .replace("\"turn-ended\"", "\"user-edited\"");
        write_file(&codex_config(&home), &edited);
        let stripped = render_at(&home, "codex", &off).unwrap();
        let table: toml::Table = toml::from_str(&stripped[1].content).unwrap();
        assert_eq!(
            table["notify"][0].as_str(),
            Some("user-edited"),
            "值被用户改过就不再属于片段，必须保留"
        );

        // 片段语法非法：报错而不是静默跳过（用户正在编辑的就是这段文本）。
        let mut broken = input.clone();
        broken.common_config = "this is not = = toml".to_string();
        let err = render_at(&home, "codex", &broken).unwrap_err();
        assert!(
            err.message().contains("无效的 TOML 格式"),
            "{}",
            err.message()
        );

        let _ = fs::remove_dir_all(&home);
    }

    /// 6f. Codex 通用配置提取：与供应商强绑定的键（模型 / provider 段 / MCP / 密钥 /
    /// 目录指针 / cc-switch 写下的 `web_search = "disabled"` 哨兵）一律剔除。
    #[test]
    fn codex_extract_common_config_drops_private_keys() {
        let config = "\
model = \"deepseek-chat\"\n\
model_provider = \"dsw\"\n\
model_catalog_json = \"dsw-model-catalog.json\"\n\
web_search = \"disabled\"\n\
approval_policy = \"never\"\n\
notify = [\"turn-ended\"]\n\
\n\
[model_providers.dsw]\n\
name = \"DeepSeek\"\n\
base_url = \"https://api.deepseek.com\"\n\
\n\
[mcp_servers.shared]\n\
command = \"npx\"\n";
        let snippet = extract_common_config("codex", config).expect("提取应成功");
        assert!(snippet.contains("approval_policy"));
        assert!(snippet.contains("turn-ended"));
        assert!(!snippet.contains("deepseek-chat"));
        assert!(!snippet.contains("model_providers"));
        assert!(!snippet.contains("mcp"));
        assert!(!snippet.contains("disabled"));
        assert!(
            !snippet.contains("model_catalog_json"),
            "目录指针属于供应商私有：{}",
            snippet
        );

        // 不是 `disabled` 哨兵的取值（用户自设、或本应用勾选写下的 `"live"`）属于通用部分。
        let custom = extract_common_config("codex", "web_search = \"live\"\n").unwrap();
        assert!(custom.contains("web_search"), "{}", custom);

        // 余额配置列表没有客户端语义，提取一律拒绝。
        assert!(extract_common_config("balance", config).is_err());
    }

    /// 7. 备份策略：已存在 → 备份原文；再写 → 覆盖旧备份；不存在 → 不产生备份。
    #[test]
    fn write_creates_and_refreshes_backup() {
        let home = unique_home("backup");
        let settings = claude_settings(&home);
        let backup = home.join(".claude").join("settings.json.bak");

        // 首次写入：原文件不存在 → 不产生备份，文件被创建。
        let first = write_at(&home, "claude", &claude_input()).expect("首次写入应成功");
        assert!(first.backups.is_empty(), "原文件不存在时不应产生备份");
        assert!(!backup.exists());
        assert!(settings.is_file());
        let first_content = fs::read_to_string(&settings).unwrap();
        assert_eq!(first_content, first.files[0].content);

        // 第二次写入：备份内容 = 写入前的原文。
        let mut second_input = claude_input();
        second_input.api_key = "sk-second".to_string();
        let second = write_at(&home, "claude", &second_input).expect("再次写入应成功");
        assert_eq!(second.backups, vec![backup.clone()]);
        assert_eq!(fs::read_to_string(&backup).unwrap(), first_content);
        assert!(fs::read_to_string(&settings).unwrap().contains("sk-second"));

        // 第三次写入：备份被新内容覆盖（只保留最近一份备份）。
        let third = write_at(&home, "claude", &claude_input()).unwrap();
        assert_eq!(third.backups.len(), 1);
        let backed_up = fs::read_to_string(&backup).unwrap();
        assert!(
            backed_up.contains("sk-second"),
            "备份应被新写入前的原文覆盖"
        );
        assert!(!backed_up.contains("sk-dsw-test"));
        assert!(
            !settings.with_extension("json.tmp").exists(),
            "原子写盘不得残留临时文件"
        );

        // Codex 两个文件各自独立备份。
        let mut codex = codex_input();
        codex.api_key = "sk-codex".to_string();
        write_at(&home, "codex", &codex).unwrap();
        let outcome = write_at(&home, "codex", &codex).unwrap();
        assert_eq!(
            outcome.backups,
            vec![
                codex_auth(&home).with_extension("json.bak"),
                codex_config(&home).with_extension("toml.bak")
            ],
        );

        let _ = fs::remove_dir_all(&home);
    }

    /// 7b. 「原始配置不丢」的落盘级证明：合并写入后，用户的键仍在文件里、
    /// 备份里留着写入前的完整原文、且不残留半截临时文件。
    #[test]
    fn apply_never_loses_user_config_on_disk() {
        let home = unique_home("no-loss");
        // 一份「用户自己维护」的配置：既有我们接管的键（旧值），也有完全不归我们管的键。
        let original = r#"{"env":{"ANTHROPIC_BASE_URL":"https://old.example.com","ANTHROPIC_AUTH_TOKEN":"sk-old","MY_OWN_KEY":"keep-me"},"permissions":{"allow":["Bash"]},"mcpServers":{"a":{"command":"node"}},"myOwnTopLevel":{"x":1}}"#;
        write_file(&claude_settings(&home), original);

        let outcome = write_at(&home, "claude", &claude_input()).expect("写入应成功");

        // 备份 = 写入前的完整原文（用户可随时人工还原）。
        let backup = claude_settings(&home).with_extension("json.bak");
        assert_eq!(fs::read_to_string(&backup).unwrap(), original);
        assert_eq!(outcome.backups, vec![backup]);

        // 落盘内容：接管的键被更新，用户的键一个不少。
        let written = parse_json(&fs::read_to_string(claude_settings(&home)).unwrap());
        assert_eq!(
            written["env"]["ANTHROPIC_BASE_URL"].as_str(),
            Some("https://api.deepseek.com/anthropic")
        );
        assert_eq!(
            written["env"]["ANTHROPIC_AUTH_TOKEN"].as_str(),
            Some("sk-dsw-test")
        );
        assert_eq!(written["env"]["MY_OWN_KEY"].as_str(), Some("keep-me"));
        assert_eq!(written["permissions"]["allow"][0].as_str(), Some("Bash"));
        assert_eq!(written["mcpServers"]["a"]["command"].as_str(), Some("node"));
        assert_eq!(written["myOwnTopLevel"]["x"].as_i64(), Some(1));
        assert!(
            !claude_settings(&home).with_extension("json.tmp").exists(),
            "原子写盘不得残留临时文件"
        );

        let _ = fs::remove_dir_all(&home);
    }

    /// 8. 未登记客户端：渲染 / 写入 / 读取一律报错，且不产生任何文件。
    #[test]
    fn unknown_client_is_rejected() {
        let home = unique_home("unknown");
        let err = render_at(&home, "unknown", &claude_input()).unwrap_err();
        assert_eq!(err.message(), "未登记的客户端：unknown");
        assert_eq!(
            write_at(&home, " gemini ", &claude_input())
                .unwrap_err()
                .message(),
            "未登记的客户端：gemini"
        );
        assert!(read_live_at(&home, "codex-cli").is_err());
        assert!(
            fs::read_dir(&home).unwrap().next().is_none(),
            "非法客户端不得创建任何文件"
        );

        let _ = fs::remove_dir_all(&home);
    }

    /// 10. 渲染（预览）不落盘：目标文件的内容与存在性都不被改变。
    #[test]
    fn render_never_writes_to_disk() {
        let home = unique_home("preview");
        let settings = claude_settings(&home);
        let original = r#"{"env":{"OTHER_KEY":"keep-me"}}"#;
        write_file(&settings, original);

        let preview = render_at(&home, "claude", &claude_input()).unwrap();
        assert_eq!(fs::read_to_string(&settings).unwrap(), original);
        assert!(preview[0].content.contains("ANTHROPIC_BASE_URL"));

        // 尚不存在的文件：预览只给出「将会写入的内容」，不创建文件。
        assert!(!codex_auth(&home).exists());
        let preview = render_at(&home, "codex", &codex_input()).unwrap();
        assert!(!codex_auth(&home).exists());
        assert!(!codex_config(&home).exists());
        assert!(!preview[0].existed && !preview[1].existed);

        let _ = fs::remove_dir_all(&home);
    }

    /// `read_live` 读实盘原文：存在即原样返回（不做任何合并与排序），缺失即空内容。
    #[test]
    fn read_live_returns_raw_content() {
        let home = unique_home("read-live");
        let raw = r#"{"zeta":1,"alpha":2}"#;
        write_file(&claude_settings(&home), raw);

        let files = read_live_at(&home, "claude").unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].content, raw, "不得改写实盘内容");
        assert!(files[0].existed);

        let codex = read_live_at(&home, "codex").unwrap();
        assert_eq!(codex.len(), 2);
        assert!(codex
            .iter()
            .all(|file| !file.existed && file.content.is_empty()));

        let _ = fs::remove_dir_all(&home);
    }

    /// 公开入口的注入版本与固定家目录版本必须是同一套实现（这里只校验参数校验不分叉）。
    #[test]
    fn public_entry_points_share_the_same_validation() {
        assert_eq!(
            render("unknown", &ClientRenderInput::default())
                .unwrap_err()
                .message(),
            "未登记的客户端：unknown"
        );
        assert!(read_live("balance").is_err());
    }
}
