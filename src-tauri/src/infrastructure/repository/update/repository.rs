//! UpdateRepository 的实现
//!
//! 只做一件事：把领域层的版本清单端口委派给本层的版本客户端。

use std::future::Future;
use std::pin::Pin;

use crate::domain::update::repository::UpdateRepository;
use crate::infrastructure::http::update_client;
use crate::types::exception::AppResult;

/// 生产实现：远端版本清单。
pub struct UpdateRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static UPDATE_REPOSITORY: UpdateRepositoryImpl = UpdateRepositoryImpl;

impl UpdateRepository for UpdateRepositoryImpl {
    fn latest_version(&self) -> Pin<Box<dyn Future<Output = AppResult<String>> + Send + 'static>> {
        Box::pin(update_client::fetch_latest_version())
    }
}
