//! client 领域的端口抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这个 trait，代码里不出现任何文件路径与 JSON / TOML 细节。

use crate::domain::client::model::valobj::{ClientRenderInput, ClientWriteOutcome, RenderedFile};
use crate::types::exception::AppResult;

/// 客户端配置文件网关：渲染 / 写入 / 读取客户端真实配置文件。
pub trait ClientConfigRepository: Send + Sync {
    /// 见 `client_config::render`：只读实盘用于合并，**不落盘**。
    fn render(&self, client_id: &str, input: &ClientRenderInput) -> AppResult<Vec<RenderedFile>>;

    /// 见 `client_config::write`：合并 + 备份 + 原子写盘。
    fn write(&self, client_id: &str, input: &ClientRenderInput) -> AppResult<ClientWriteOutcome>;

    /// 见 `client_config::read_live`：读实盘当前内容（不合并、不改写）。
    fn read_live(&self, client_id: &str) -> AppResult<Vec<RenderedFile>>;

    /// 见 `client_config::validate_common_config`：保存通用配置片段前的语法校验。
    fn validate_common_config(&self, client_id: &str, snippet: &str) -> AppResult<()>;

    /// 见 `client_config::extract_common_config`：从配置文件内容里提取通用部分。
    fn extract_common_config(&self, client_id: &str, config_text: &str) -> AppResult<String>;
}
