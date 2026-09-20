//! ClientConfigRepository 的实现
//!
//! 只做一件事：把领域层的客户端配置网关 trait 委派给本层的
//! `system::client_config`（合并式渲染 + 备份 + 原子写盘）。

use crate::domain::client::model::valobj::{ClientRenderInput, ClientWriteOutcome, RenderedFile};
use crate::domain::client::repository::ClientConfigRepository;
use crate::infrastructure::system::client_config;
use crate::types::exception::AppResult;

/// 生产实现：直接读写客户端的真实配置文件。
pub struct ClientConfigRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static CLIENT_CONFIG_REPOSITORY: ClientConfigRepositoryImpl = ClientConfigRepositoryImpl;

impl ClientConfigRepository for ClientConfigRepositoryImpl {
    fn render(&self, client_id: &str, input: &ClientRenderInput) -> AppResult<Vec<RenderedFile>> {
        client_config::render(client_id, input)
    }

    fn write(&self, client_id: &str, input: &ClientRenderInput) -> AppResult<ClientWriteOutcome> {
        client_config::write(client_id, input)
    }

    fn read_live(&self, client_id: &str) -> AppResult<Vec<RenderedFile>> {
        client_config::read_live(client_id)
    }

    fn validate_common_config(&self, client_id: &str, snippet: &str) -> AppResult<()> {
        client_config::validate_common_config(client_id, snippet)
    }

    fn extract_common_config(&self, client_id: &str, config_text: &str) -> AppResult<String> {
        client_config::extract_common_config(client_id, config_text)
    }
}
