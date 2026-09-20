//! 客户端配置渲染的值对象
//!
//! 这三个对象描述「把某供应商的路由配置渲染成客户端真实配置文件」这件事的输入与产物：
//! - [`ClientRenderInput`]：要写什么；
//! - [`RenderedFile`]：一个目标文件渲染后的完整内容；
//! - [`ClientWriteOutcome`]：写盘结果（写了哪些文件、备份在哪）。
//!
//! 它们原先落在 `infrastructure::system::client_config`，但应用层与命令层都要用，
//! 因此按依赖倒置上移到领域层：解析与落盘实现仍在基础设施。

use std::path::PathBuf;

use crate::domain::supplier::model::SupplierRouting;

/// 渲染输入：一份供应商在某个客户端上的完整「要写入什么」。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ClientRenderInput {
    /// 请求地址（供应商 API 的根地址）。
    pub base_url: String,
    /// API 密钥。
    pub api_key: String,
    /// API 协议格式（`anthropic` / `openai` / `openai-responses` / `gemini`）。
    pub api_format: String,
    /// 认证字段（客户端语义：Claude 是「写哪个 env 键」，Codex 不使用）。
    pub auth_field: String,
    /// 模型路由（模型角色 / 上下文窗口 / 开关 / 选项）。
    pub routing: SupplierRouting,
    /// 供应商展示名（用于 provider 的 `name` 字段）。
    pub supplier_name: String,
    /// 该客户端的「通用配置片段」（TOML 文本；空 = 未配置）。
    ///
    /// 只有勾选「应用通用配置」的供应商才会把它合并进 `config.toml`，
    /// 因此「切换供应商不丢插件 / 环境变量」这类共享配置由它承载。
    pub common_config: String,
}

/// 一个目标文件的渲染结果。
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedFile {
    /// 目标文件绝对路径。
    pub path: PathBuf,
    /// 内容语言（`json` / `toml`），供前端高亮与展示。
    pub language: String,
    /// **合并式写入后的完整文件内容**（即真正会落盘的字节）。
    pub content: String,
    /// 原文件是否已存在（不存在时为新建）。
    pub existed: bool,
}

/// 写入结果。
#[derive(Debug, Clone, PartialEq)]
pub struct ClientWriteOutcome {
    /// 已写入的文件（含最终内容）。
    pub files: Vec<RenderedFile>,
    /// 本次产生的备份文件路径（原文件不存在时为空）。
    pub backups: Vec<PathBuf>,
}
