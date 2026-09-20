//! Claude Code 客户端配置（`~/.claude/settings.json`）
//!
//! # 写入策略
//! 合并式：只接管下表中的键，用户文件里的其它内容（`mcpServers` / `permissions` / 其它
//! 环境变量…）原样保留。**关闭 = 删除**：开关关闭、槽位留空、上下文窗口为 0 时，
//! 对应键会被删除，不留下「上次应用」的陈旧值，也不产生空对象残留。
//!
//! # 接管的键
//!
//! | 来源 | 目标键 |
//! | --- | --- |
//! | `base_url` | `env.ANTHROPIC_BASE_URL` |
//! | `api_key`（`auth_field == "ANTHROPIC_API_KEY"`） | `env.ANTHROPIC_API_KEY`（并删除 `ANTHROPIC_AUTH_TOKEN`） |
//! | `api_key`（其它认证字段，含默认的 `ANTHROPIC_AUTH_TOKEN`） | `env.ANTHROPIC_AUTH_TOKEN`（并删除 `ANTHROPIC_API_KEY`） |
//! | [`MODEL_ENV`] | `env.<模型角色对应的 *_MODEL>`（Sonnet / Opus / Fable / Haiku / 子代理） |
//! | [`MODEL_NAME_ENV`] | `env.<*_MODEL_NAME>`（`/model` 菜单里的显示名） |
//! | [`SWITCH_ENV`] | `env.<开关对应变量>` = 表中取值 |
//! | `hide_attribution` | 顶层 `attribution = { commit: "", pr: "" }` |
//!
//! 认证字段的两个取值与 cc-switch 的 `apiKeyField` 完全一致（只有这两项，默认 AUTH_TOKEN）。
//!
//! 模型名上的 `[1M]` 能力标记原样写入 `*_MODEL`（Claude Code 靠这个后缀声明 100 万
//! 上下文）；不支持 1M 的档位（Haiku）已在领域层归一化时剥掉标记。
//!
//! 历史遗留的 `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` 与 `env.ANTHROPIC_MODEL_CONTEXT_WINDOW`
//! （上下文窗口配置项已移除）、`env.ANTHROPIC_MODEL` 与 `env.ANTHROPIC_SMALL_FAST_MODEL`
//! （已移除的「主模型 / 快速模型」槽位）无论开关如何都一律清理；不在上表内的环境变量
//! （如 `MCP_*` 或用户自加的键）不属于接管范围，**不动它**。
//!
//! # 输出格式
//! JSON 递归按键名升序 + 2 空格缩进：预览与落盘是同一份字节，且键序不随解析顺序漂移。

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::{
    non_empty, read_json_object, read_live_files, sort_json, switch_enabled, ClientRenderInput,
    RenderedFile,
};
use crate::domain::supplier::service::supplier_service::strip_one_m;
use crate::types::exception::{AppError, AppResult};

/// 客户端标识（与注册表 `CLIENTS` 中的 id 一致）。
pub const CLIENT_ID: &str = "claude";

/// 目标文件所在目录（相对家目录）。
const SETTINGS_DIR: &str = ".claude";
/// 目标文件名。
const SETTINGS_FILE: &str = "settings.json";
/// 内容语言（供前端高亮）。
const LANGUAGE: &str = "json";

/// 环境变量容器键。
const ENV_KEY: &str = "env";
/// 请求地址。
const ENV_BASE_URL: &str = "ANTHROPIC_BASE_URL";
/// 认证：API Key 形式。
const ENV_API_KEY: &str = "ANTHROPIC_API_KEY";
/// 认证：Bearer Token 形式（界面默认项）。
const ENV_AUTH_TOKEN: &str = "ANTHROPIC_AUTH_TOKEN";
/// 命中该认证字段时写 `ANTHROPIC_API_KEY`，否则写 `ANTHROPIC_AUTH_TOKEN`。
///
/// 取值即注册表登记的认证字段（`client_service::CLAUDE_AUTH_FIELDS`），与 cc-switch 的
/// `apiKeyField` 同词表：`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`。
const AUTH_FIELD_API_KEY: &str = "ANTHROPIC_API_KEY";
/// 旧版本接管的上下文窗口键：配置项已按需求移除，旧值一律清理。
const LEGACY_ENV_CONTEXT_WINDOW: [&str; 2] = [
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    "ANTHROPIC_MODEL_CONTEXT_WINDOW",
];
/// 旧版本接管的「主模型」与更早的「快速模型」键。
///
/// 两个槽位都已从注册表移除（见 `client_service::CLAUDE_MODEL_SLOTS`）：`ANTHROPIC_MODEL`
/// 会架空整个档位映射，留下旧值等于让用户以为切了供应商、请求却还打在上一个模型上。
/// 因此它们与其它已接管键一样按「移除 = 删除」处理。
const LEGACY_ENV_MODEL: [&str; 2] = ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"];
/// AI 署名开关的落点（顶层键）。
const ATTRIBUTION_KEY: &str = "attribution";

/// 模型槽位（注册表 `ClientModelSlot.key`）→ (目标环境变量, 是否允许 1M 能力标记)。
///
/// 「是否允许 1M」与注册表登记的一致：Haiku 档位不参与 1M 声明，即使草稿里带着
/// `[1M]` 也会在渲染时剥掉——预览与落盘用的是同一段渲染代码，因此界面看到的就是
/// 最终写进文件的（领域层归一化只负责把已保存的数据也收拾干净）。
const MODEL_ENV: [(&str, &str, bool); 5] = [
    ("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL", true),
    ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL", true),
    ("fable", "ANTHROPIC_DEFAULT_FABLE_MODEL", true),
    ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL", false),
    ("subagent", "CLAUDE_CODE_SUBAGENT_MODEL", true),
];

/// 模型槽位 → 「菜单显示名」环境变量（只影响 `/model` 菜单里的名字）。
///
/// 子代理模型不在菜单里，因此没有对应键。
const MODEL_NAME_ENV: [(&str, &str); 4] = [
    ("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"),
    ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"),
    ("fable", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME"),
    ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"),
];

/// 布尔开关（注册表 `ClientSwitch.key`）→ (目标环境变量, 打开时的取值)。
const SWITCH_ENV: [(&str, &str, &str); 5] = [
    ("agent_teams", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1"),
    ("tool_search", "ENABLE_TOOL_SEARCH", "true"),
    ("max_effort", "CLAUDE_CODE_EFFORT_LEVEL", "max"),
    ("disable_autoupdater", "DISABLE_AUTOUPDATER", "1"),
    ("disable_artifact", "CLAUDE_CODE_DISABLE_ARTIFACT", "1"),
];

/// 通过顶层 `attribution` 生效的开关。
const SWITCH_ATTRIBUTION: &str = "hide_attribution";

/// 目标文件列表（路径 + 内容语言）：本客户端只有 `settings.json`。
pub fn paths(home: &Path) -> Vec<(PathBuf, &'static str)> {
    vec![(home.join(SETTINGS_DIR).join(SETTINGS_FILE), LANGUAGE)]
}

/// 读取实盘 `settings.json`（不合并、不改写）。
pub fn read_live(home: &Path) -> AppResult<Vec<RenderedFile>> {
    read_live_files(&paths(home))
}

/// 渲染合并后的 `settings.json` 内容（只读实盘，不落盘）。
pub fn render(home: &Path, input: &ClientRenderInput) -> AppResult<Vec<RenderedFile>> {
    let (path, language) = paths(home)
        .into_iter()
        .next()
        .expect("Claude 必然有且仅有一个目标文件");
    let existed = path.is_file();
    let mut root = read_json_object(&path);

    // `env` 不是对象时整体重建：宁可只覆盖我们接管的键，也不能让「应用」直接失败。
    let mut env = match root.remove(ENV_KEY) {
        Some(Value::Object(map)) => map,
        Some(_) => {
            log::warn!(
                "Claude settings.json 的 env 不是对象，将整体重建：{}",
                path.display()
            );
            Map::new()
        }
        None => Map::new(),
    };

    env.insert(
        ENV_BASE_URL.to_string(),
        Value::String(input.base_url.clone()),
    );
    // 两种认证方式互斥：写一种就删掉另一种，避免 Claude Code 读到两个来源而行为不确定。
    if is_api_key_auth(&input.auth_field) {
        env.insert(
            ENV_API_KEY.to_string(),
            Value::String(input.api_key.clone()),
        );
        env.remove(ENV_AUTH_TOKEN);
    } else {
        env.insert(
            ENV_AUTH_TOKEN.to_string(),
            Value::String(input.api_key.clone()),
        );
        env.remove(ENV_API_KEY);
    }
    // 模型槽位：路由里给了取值就写，没给就删（这些键由本应用接管）。
    for (slot, env_key, allow_one_m) in MODEL_ENV {
        match non_empty(input.routing.model_map.get(slot)) {
            Some(model) => {
                let model = if allow_one_m {
                    model
                } else {
                    strip_one_m(model)
                };
                env.insert(env_key.to_string(), Value::String(model.to_string()));
            }
            None => {
                env.remove(env_key);
            }
        }
    }
    // 菜单显示名：只影响 `/model` 菜单，留空即删除（不写空串，避免菜单出现空白项）。
    for (slot, env_key) in MODEL_NAME_ENV {
        match non_empty(input.routing.display_map.get(slot)) {
            Some(name) => {
                env.insert(
                    env_key.to_string(),
                    Value::String(strip_one_m(name).to_string()),
                );
            }
            None => {
                env.remove(env_key);
            }
        }
    }
    // 上下文窗口配置项已移除：旧版本写入的两个键一律清理，不留「界面看不到却仍在生效」的值。
    for key in LEGACY_ENV_CONTEXT_WINDOW {
        env.remove(key);
    }
    for key in LEGACY_ENV_MODEL {
        env.remove(key);
    }
    // 布尔开关：打开写值，关闭删除。
    for (switch, env_key, enabled_value) in SWITCH_ENV {
        if switch_enabled(CLIENT_ID, &input.routing, switch) {
            env.insert(
                env_key.to_string(),
                Value::String(enabled_value.to_string()),
            );
        } else {
            env.remove(env_key);
        }
    }

    root.insert(ENV_KEY.to_string(), Value::Object(env));
    // 「隐藏 AI 署名」走顶层键：关闭即删除，不留空对象。
    if switch_enabled(CLIENT_ID, &input.routing, SWITCH_ATTRIBUTION) {
        root.insert(
            ATTRIBUTION_KEY.to_string(),
            json!({ "commit": "", "pr": "" }),
        );
    } else {
        root.remove(ATTRIBUTION_KEY);
    }

    let mut merged = Value::Object(root);
    sort_json(&mut merged);
    let content =
        serde_json::to_string_pretty(&merged).map_err(|e| AppError::serde(e.to_string()))?;
    Ok(vec![RenderedFile {
        path,
        language: language.to_string(),
        content,
        existed,
    }])
}

/// 认证字段是否走 API Key（大小写与空白容错，界面草稿可能未归一化）。
fn is_api_key_auth(auth_field: &str) -> bool {
    auth_field.trim().eq_ignore_ascii_case(AUTH_FIELD_API_KEY)
}
