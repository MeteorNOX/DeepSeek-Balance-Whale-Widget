//! 模型列表（`/v1/models`）的纯规则
//!
//! 只有「与网络无关」的部分：候选地址怎么拼、鉴权头放哪里、响应怎么读、失败怎么说。
//! 放在领域层是因为它们都是可判定的规则而不是副作用——因此能在无网络的环境下完整单测，
//! 也让界面（校验提示）与请求层（错误文案）引用同一份常量。
//!
//! # 完全对齐 cc-switch
//! 候选地址与鉴权头是按 cc-switch 的 `services/model_fetch.rs` 逐条移植的：
//! 第三方网关把 Anthropic 协议挂在各种兼容子路径下（`/anthropic`、`/api/coding`…），
//! 这些供应商的模型列表并不在 `{base}/v1/models`，必须**先剥离兼容后缀再拼**，
//! 否则会出现「密钥没问题、却提示找不到模型列表接口」。
//!
//! 网络请求见 `infrastructure::http::model_client`，用例见 `application::model::service`。

use serde_json::Value;

use crate::types::enums::ErrorCode;
use crate::types::exception::{AppError, AppResult};

/// 密钥不可用时的统一文案（用户没填、填错、无权限都归到这一句）。
///
/// 这是**前端契约**：界面直接展示它，改动必须同步前端文案。
pub const MSG_INVALID_API_KEY: &str = "API Key无效或无权限";
/// 所有候选地址都返回 404 / 405 时的提示（多为请求地址写错）。
pub const MSG_ENDPOINT_NOT_FOUND: &str = "未找到模型列表接口，请检查请求地址";
/// 请求地址为空时的提示。
pub const MSG_MISSING_BASE_URL: &str = "请先填写请求地址";

/// 单次请求最多返回的模型数（防止异常网关返回上万条把界面拖垮）。
pub const MAX_MODELS: usize = 500;

/// 已知的「Anthropic 协议兼容子路径」后缀（按长度降序，最长优先匹配）。
///
/// baseURL 命中这些后缀时，候选列表会追加「剥离后缀再拼 `/v1/models`、`/models`」的版本。
/// 顺序不能乱：`/anthropic` 若排在 `/api/anthropic` 前面，就会把后者剥成残缺的根地址。
const KNOWN_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

/// 鉴权头的放法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthHeader {
    /// 固定头名（`x-api-key` / `x-goog-api-key`）。
    Named(&'static str),
    /// `Authorization: Bearer <key>`。
    Bearer,
}

/// 按 API 格式决定鉴权头（与 cc-switch 一致：协议决定头名，而不是「认证字段」配置）。
///
/// - Anthropic 协议（`anthropic` / cc-switch 的 `anthropic-messages`）→ `x-api-key`；
/// - Gemini 原生（`gemini` / `google-generative-ai`）→ `x-goog-api-key`；
/// - 其余（OpenAI Chat / Responses 及其它兼容网关）→ `Authorization: Bearer`。
pub fn auth_header_for(api_format: &str) -> AuthHeader {
    match api_format.trim().to_ascii_lowercase().as_str() {
        "anthropic" | "anthropic-messages" => AuthHeader::Named("x-api-key"),
        "gemini" | "google-generative-ai" => AuthHeader::Named("x-goog-api-key"),
        _ => AuthHeader::Bearer,
    }
}

/// 模型列表的候选地址（按优先级排列，逐个尝试）。
///
/// 顺序与 cc-switch 的 `build_models_url_candidates` 完全一致：
/// 1. `models_url_override` 非空 → 只返回它（预设里显式声明的模型列表地址优先）；
/// 2. 完整 URL（`is_full_url`）→ 从 `/v1/` 之前截断再拼 `/v1/models`；
/// 3. 地址已以版本段 `/v{N}` 结尾（`/v1`、智谱 `/api/coding/paas/v4`）→ 拼 `/models`，
///    非 `/v1` 时再补一条 `/v1/models` 兜底（正确路径必须排在 404 路径之前）；
/// 4. 否则 → `{base}/v1/models`；
/// 5. 命中 [`KNOWN_COMPAT_SUFFIXES`] → 再追加「剥离后缀 + `/v1/models`、`/models`」两条。
///
/// 结果去重并保持首次出现顺序。`base_url` 为空时返回错误。
pub fn models_url_candidates(
    base_url: &str,
    is_full_url: bool,
    models_url_override: Option<&str>,
) -> AppResult<Vec<String>> {
    if let Some(raw) = models_url_override {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(vec![trimmed.to_string()]);
        }
    }

    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::invalid(MSG_MISSING_BASE_URL));
    }

    let mut candidates: Vec<String> = Vec::new();

    if is_full_url {
        // 完整 URL（用户直接把 chat/completions 的地址粘了进来）：截到 `/v1/` 之前。
        if let Some(index) = trimmed.find("/v1/") {
            candidates.push(format!("{}/v1/models", &trimmed[..index]));
        } else if let Some(index) = trimmed.rfind('/') {
            let root = &trimmed[..index];
            let scheme_end = root.find("://").map(|at| at + 3).unwrap_or(0);
            if root.contains("://") && root.len() > scheme_end {
                candidates.push(format!("{}/v1/models", root));
            }
        }
        if candidates.is_empty() {
            return Err(AppError::invalid(
                "无法从完整请求地址推断模型列表地址，请改用供应商根地址",
            ));
        }
        return Ok(candidates);
    }

    if ends_with_version_segment(trimmed) {
        candidates.push(format!("{}/models", trimmed));
        if !trimmed.ends_with("/v1") {
            candidates.push(format!("{}/v1/models", trimmed));
        }
    } else {
        candidates.push(format!("{}/v1/models", trimmed));
    }

    if let Some(stripped) = strip_compat_suffix(trimmed) {
        let root = stripped.trim_end_matches('/');
        if !root.is_empty() && root.contains("://") {
            candidates.push(format!("{}/v1/models", root));
            candidates.push(format!("{}/models", root));
        }
    }

    let mut unique: Vec<String> = Vec::with_capacity(candidates.len());
    for url in candidates {
        if !unique.contains(&url) {
            unique.push(url);
        }
    }
    Ok(unique)
}

/// 若地址以任一已知兼容子路径结尾，返回剥离后的剩余部分；否则 `None`。
fn strip_compat_suffix(base_url: &str) -> Option<&str> {
    KNOWN_COMPAT_SUFFIXES
        .iter()
        .find(|suffix| base_url.ends_with(**suffix))
        .map(|suffix| &base_url[..base_url.len() - suffix.len()])
}

/// 地址最后一段是否是 OpenAI 风格的版本段 `/v{N}`（`/v1`、`.../paas/v4`）。
fn ends_with_version_segment(url: &str) -> bool {
    let last = url.rsplit('/').next().unwrap_or("");
    match last.strip_prefix('v') {
        Some(digits) => !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()),
        None => false,
    }
}

/// 解析模型列表响应，返回去重排序后的模型名。
///
/// 兼容三种常见形态（与 cc-switch 的 `ModelsResponse` 同构）：
/// - OpenAI 兼容：`{"data":[{"id":"..."}]}`；
/// - 智谱 Responses：`{"models":[{"slug":"..."}]}`；
/// - 直接给数组：`[{"id":"..."}]`。
pub fn parse_models_response(body: &str) -> AppResult<Vec<String>> {
    let value: Value = serde_json::from_str(body)
        .map_err(|e| AppError::external(format!("模型列表响应不是合法 JSON：{}", e)))?;

    let mut ids = Vec::new();
    match &value {
        Value::Array(items) => collect_ids(items, &mut ids),
        Value::Object(map) => {
            if let Some(items) = map.get("data").and_then(Value::as_array) {
                collect_ids(items, &mut ids);
            }
            if let Some(items) = map.get("models").and_then(Value::as_array) {
                collect_ids(items, &mut ids);
            }
        }
        _ => {}
    }

    let models = normalize_models(ids);
    if models.is_empty() {
        return Err(AppError::external("模型列表响应中没有可用的模型"));
    }
    Ok(models)
}

/// 从一组条目里取模型名：优先 `id`，其次 `slug` / `model` / `name`。
fn collect_ids(items: &[Value], out: &mut Vec<String>) {
    for item in items {
        if let Some(id) = item.as_str() {
            out.push(id.to_string());
            continue;
        }
        for key in ["id", "slug", "model", "name"] {
            if let Some(id) = item.get(key).and_then(Value::as_str) {
                out.push(id.to_string());
                break;
            }
        }
    }
}

/// 去空白、丢空值、去重并按字典序排列（界面下拉按此顺序展示）。
pub fn normalize_models(ids: Vec<String>) -> Vec<String> {
    let mut models: Vec<String> = ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    models.sort();
    models.dedup();
    models.truncate(MAX_MODELS);
    models
}

/// 把 HTTP 失败翻译成提示文案。
///
/// 401 / 403 统一说「密钥无效或无权限」：对用户来说这两者的处理方式完全一样
/// （换一个能用的 Key），细分状态码只会增加噪音。调用方据此判断「是否值得换下一个
/// 候选地址」——密钥问题换地址也没用，只有 404 / 405（路径不对）才继续试下一条。
pub fn http_failure(status: u16) -> AppError {
    match status {
        401 | 403 => AppError::new(ErrorCode::NoApiKey, MSG_INVALID_API_KEY),
        404 | 405 => AppError::external(MSG_ENDPOINT_NOT_FOUND),
        _ => AppError::external(format!("获取模型列表失败：HTTP {}", status)),
    }
}

/// 这个失败是否值得换下一个候选地址再试。
///
/// 只有「路径 / 方法不对」才有意义：密钥问题（401/403）、服务端错误与网络失败
/// 换个地址结果一样，直接返回更快也更不容易误导用户。
pub fn should_try_next_candidate(err: &AppError) -> bool {
    err.message() == MSG_ENDPOINT_NOT_FOUND
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 鉴权头由 API 格式决定（与 cc-switch 的 `model_fetch_headers_follow_pi_api_format` 同口径）。
    #[test]
    fn auth_header_follows_api_format() {
        assert_eq!(auth_header_for("anthropic"), AuthHeader::Named("x-api-key"));
        assert_eq!(
            auth_header_for(" ANTHROPIC-MESSAGES "),
            AuthHeader::Named("x-api-key"),
            "兼容 cc-switch 的协议名，且大小写与空白不影响判定"
        );
        assert_eq!(
            auth_header_for("gemini"),
            AuthHeader::Named("x-goog-api-key")
        );
        assert_eq!(
            auth_header_for("google-generative-ai"),
            AuthHeader::Named("x-goog-api-key")
        );
        for format in ["openai", "openai-responses", "", "unknown"] {
            assert_eq!(auth_header_for(format), AuthHeader::Bearer, "{}", format);
        }
    }

    /// 候选地址：普通根地址只拼 `/v1/models`。
    #[test]
    fn candidates_plain_root() {
        assert_eq!(
            models_url_candidates("https://api.siliconflow.cn", false, None).unwrap(),
            vec!["https://api.siliconflow.cn/v1/models"]
        );
        assert_eq!(
            models_url_candidates("https://api.example.com/", false, None).unwrap(),
            vec!["https://api.example.com/v1/models"],
            "末尾斜杠不影响拼接"
        );
    }

    /// 已带版本段：正确路径（`/models`）必须排在 404 路径之前。
    #[test]
    fn candidates_with_version_segment() {
        assert_eq!(
            models_url_candidates("https://api.example.com/v1", false, None).unwrap(),
            vec!["https://api.example.com/v1/models"],
            "以 /v1 结尾时不再叠加 /v1"
        );
        assert_eq!(
            models_url_candidates("https://open.bigmodel.cn/api/coding/paas/v4", false, None)
                .unwrap(),
            vec![
                "https://open.bigmodel.cn/api/coding/paas/v4/models",
                "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
            ]
        );
        assert_eq!(
            models_url_candidates("https://api.z.ai/api/coding/paas/v4", false, None).unwrap(),
            vec![
                "https://api.z.ai/api/coding/paas/v4/models",
                "https://api.z.ai/api/coding/paas/v4/v1/models",
            ]
        );
    }

    /// 兼容子路径：剥离后补两条候选——这是「密钥没问题却提示找不到接口」的正解。
    #[test]
    fn candidates_strip_compat_suffixes() {
        // DeepSeek / Kimi 这类把 Anthropic 协议挂在 /anthropic 下的官方供应商。
        assert_eq!(
            models_url_candidates("https://api.deepseek.com/anthropic", false, None).unwrap(),
            vec![
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/v1/models",
                "https://api.deepseek.com/models",
            ]
        );
        assert_eq!(
            models_url_candidates("https://open.bigmodel.cn/api/anthropic", false, None).unwrap(),
            vec![
                "https://open.bigmodel.cn/api/anthropic/v1/models",
                "https://open.bigmodel.cn/v1/models",
                "https://open.bigmodel.cn/models",
            ]
        );
        assert_eq!(
            models_url_candidates("https://dashscope.aliyuncs.com/apps/anthropic", false, None)
                .unwrap(),
            vec![
                "https://dashscope.aliyuncs.com/apps/anthropic/v1/models",
                "https://dashscope.aliyuncs.com/v1/models",
                "https://dashscope.aliyuncs.com/models",
            ]
        );
        assert_eq!(
            models_url_candidates("https://api.stepfun.com/step_plan", false, None).unwrap(),
            vec![
                "https://api.stepfun.com/step_plan/v1/models",
                "https://api.stepfun.com/v1/models",
                "https://api.stepfun.com/models",
            ]
        );
        assert_eq!(
            models_url_candidates("https://ark.cn-beijing.volces.com/api/coding", false, None)
                .unwrap(),
            vec![
                "https://ark.cn-beijing.volces.com/api/coding/v1/models",
                "https://ark.cn-beijing.volces.com/v1/models",
                "https://ark.cn-beijing.volces.com/models",
            ]
        );
        assert_eq!(
            models_url_candidates("https://www.right.codes/claude", false, None).unwrap(),
            vec![
                "https://www.right.codes/claude/v1/models",
                "https://www.right.codes/v1/models",
                "https://www.right.codes/models",
            ]
        );
        // 最长后缀优先：/api/anthropic 不能被 /anthropic 抢先剥成残缺的 /api 根。
        assert_eq!(
            models_url_candidates("https://api.z.ai/api/anthropic", false, None).unwrap(),
            vec![
                "https://api.z.ai/api/anthropic/v1/models",
                "https://api.z.ai/v1/models",
                "https://api.z.ai/models",
            ]
        );
        // 没有命中后缀就不多补候选。
        assert_eq!(
            models_url_candidates("https://openrouter.ai/api", false, None).unwrap(),
            vec!["https://openrouter.ai/api/v1/models"]
        );
    }

    /// 用户报障的三家（小米 MiMo / Kimi / DeepSeek）用的正是 `{host}/anthropic` 这类地址：
    /// 候选里必须包含「剥离兼容后缀后的根地址」，否则只会得到 404。
    #[test]
    fn candidates_cover_reported_providers() {
        assert_eq!(
            models_url_candidates("https://api.moonshot.cn/anthropic", false, None).unwrap(),
            vec![
                "https://api.moonshot.cn/anthropic/v1/models",
                "https://api.moonshot.cn/v1/models",
                "https://api.moonshot.cn/models",
            ]
        );
        assert_eq!(
            models_url_candidates("https://api.deepseek.com/anthropic", false, None).unwrap(),
            vec![
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/v1/models",
                "https://api.deepseek.com/models",
            ]
        );
        assert_eq!(
            models_url_candidates("https://api.xiaomimimo.com/anthropic", false, None).unwrap(),
            vec![
                "https://api.xiaomimimo.com/anthropic/v1/models",
                "https://api.xiaomimimo.com/v1/models",
                "https://api.xiaomimimo.com/models",
            ]
        );
        assert_eq!(
            models_url_candidates("https://api.xiaomimimo.com/api/claudecode", false, None)
                .unwrap(),
            vec![
                "https://api.xiaomimimo.com/api/claudecode/v1/models",
                "https://api.xiaomimimo.com/v1/models",
                "https://api.xiaomimimo.com/models",
            ]
        );
    }

    /// 预设显式给定的模型列表地址优先级最高（只试它一条）。
    #[test]
    fn candidates_override_wins() {
        assert_eq!(
            models_url_candidates(
                "https://api.deepseek.com/anthropic",
                false,
                Some("https://api.deepseek.com/models")
            )
            .unwrap(),
            vec!["https://api.deepseek.com/models"]
        );
        // 空白的 override 视为没给。
        assert_eq!(
            models_url_candidates("https://api.siliconflow.cn", false, Some("   ")).unwrap(),
            vec!["https://api.siliconflow.cn/v1/models"]
        );
    }

    /// 完整 URL：从 `/v1/` 之前截断。
    #[test]
    fn candidates_from_full_url() {
        assert_eq!(
            models_url_candidates("https://proxy.example.com/v1/chat/completions", true, None)
                .unwrap(),
            vec!["https://proxy.example.com/v1/models"]
        );
        // 无法推断根地址时明确报错，而不是拼出一个奇怪的地址。
        assert!(models_url_candidates("not-a-url", true, None).is_err());
    }

    /// 空地址：报「请先填写请求地址」。
    #[test]
    fn candidates_require_base_url() {
        let err = models_url_candidates("   ", false, None).unwrap_err();
        assert_eq!(err.message(), MSG_MISSING_BASE_URL);
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    /// 全量预置供应商的候选地址覆盖检查（预设目录里的每一家都过一遍）。
    ///
    /// 断言的是三条硬要求：
    /// 1. 每个非空 `baseUrl` 都能算出候选（不会有「地址填了却说地址不合法」）；
    /// 2. 预设声明了 `modelsUrl` 时必须只试它（cc-switch 同款覆盖，避免先撞 404 / 401）；
    /// 3. 命中「Anthropic 兼容子路径」的地址必须有剥离后缀的兜底候选
    ///    （xiaomi mimo / kimi / deepseek 等取不到模型列表的根因）。
    #[test]
    fn every_preset_base_url_yields_candidates() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("frontend")
            .join("assets")
            .join("presets");
        let entries = std::fs::read_dir(&dir).expect("预设目录必须存在");
        let (mut checked, mut overridden, mut stripped) = (0usize, 0usize, 0usize);

        for entry in entries {
            let path = entry.expect("目录项必须可读").path();
            let file = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if !file.ends_with(".json") || file == "manifest.json" {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("预设文件必须可读");
            let value: Value = serde_json::from_str(&text).expect("预设文件必须是 JSON");
            let list: Vec<Value> = match &value {
                Value::Array(items) => items.clone(),
                Value::Object(map) => ["providers", "presets"]
                    .iter()
                    .find_map(|key| map.get(*key).and_then(Value::as_array).cloned())
                    .unwrap_or_default(),
                _ => Vec::new(),
            };

            for preset in list {
                let base_url = preset
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if base_url.trim().is_empty() {
                    // 官方订阅类预置没有请求地址，谈不上取模型列表。
                    continue;
                }
                let models_url = preset
                    .get("modelsUrl")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let candidates = models_url_candidates(&base_url, false, Some(models_url))
                    .unwrap_or_else(|err| {
                        panic!("{} 无法生成候选地址：{}", base_url, err.message())
                    });
                assert!(!candidates.is_empty(), "{} 没有候选地址", base_url);
                if !models_url.trim().is_empty() {
                    assert_eq!(
                        candidates,
                        vec![models_url.trim()],
                        "预设声明 modelsUrl 时必须只试它：{}",
                        base_url
                    );
                    overridden += 1;
                }
                checked += 1;

                // 有 override 的地址不会走到兼容后缀那条路，跳过该项检查。
                if models_url.trim().is_empty()
                    && strip_compat_suffix(base_url.trim().trim_end_matches('/')).is_some()
                {
                    stripped += 1;
                    assert!(
                        candidates.len() >= 3,
                        "命中兼容子路径时必须给出剥离后的兜底候选：{} → {:?}",
                        base_url,
                        candidates
                    );
                }
            }
        }

        assert!(
            checked >= 150,
            "预置供应商数量异常（只检查到 {} 个）",
            checked
        );
        assert!(
            overridden >= 5,
            "声明 modelsUrl 的预置数量异常（{}）",
            overridden
        );
        assert!(
            stripped >= 20,
            "命中兼容子路径的预置数量异常（{}）",
            stripped
        );
    }

    /// 三种常见响应形态都能读出来，且结果去重排序。
    #[test]
    fn parse_models_response_accepts_common_shapes() {
        let openai = parse_models_response(
            r#"{"object":"list","data":[{"id":"b-model"},{"id":"a-model"},{"id":"a-model"}]}"#,
        )
        .unwrap();
        assert_eq!(openai, vec!["a-model", "b-model"], "去重 + 排序");

        let zhipu = parse_models_response(r#"{"models":[{"slug":"glm-4.6"}]}"#).unwrap();
        assert_eq!(zhipu, vec!["glm-4.6"]);

        let bare = parse_models_response(r#"[{"model":"m1"},{"name":"m2"},"m3"]"#).unwrap();
        assert_eq!(bare, vec!["m1", "m2", "m3"]);

        // 空列表 / 结构不对：都算失败（界面上就是「没拿到模型」）。
        assert!(parse_models_response(r#"{"data":[]}"#).is_err());
        assert!(parse_models_response("not json").is_err());
        assert!(parse_models_response("[{}]").is_err());
    }

    /// 失败文案：401/403 统一成密钥问题，404/405 提示检查地址。
    #[test]
    fn http_failures_are_classified() {
        for status in [401, 403] {
            let err = http_failure(status);
            assert_eq!(err.message(), MSG_INVALID_API_KEY);
            assert_eq!(err.code(), ErrorCode::NoApiKey);
            assert!(!should_try_next_candidate(&err), "密钥问题换地址也没用");
        }
        for status in [404, 405] {
            let err = http_failure(status);
            assert_eq!(err.message(), MSG_ENDPOINT_NOT_FOUND);
            assert!(should_try_next_candidate(&err), "路径不对，值得换下一条");
        }
        assert_eq!(http_failure(500).message(), "获取模型列表失败：HTTP 500");
        assert!(!should_try_next_candidate(&http_failure(500)));
    }

    /// 模型数量上限：异常网关返回超长列表时只截断、不报错。
    #[test]
    fn normalize_models_caps_the_list() {
        let many: Vec<String> = (0..MAX_MODELS + 10)
            .map(|index| format!("m{:04}", index))
            .collect();
        assert_eq!(normalize_models(many).len(), MAX_MODELS);
        assert_eq!(
            normalize_models(vec![" b ".to_string(), "a".to_string(), "  ".to_string()]),
            vec!["a", "b"]
        );
    }
}
