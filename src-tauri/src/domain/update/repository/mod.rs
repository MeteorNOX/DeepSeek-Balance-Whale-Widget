//! update 领域的端口抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这个 trait，代码里不出现任何 HTTP 细节。

use std::future::Future;
use std::pin::Pin;

use crate::types::exception::AppResult;

/// 版本清单端口：取远端最新版本号（原始字符串，比较规则见 `update_service`）。
pub trait UpdateRepository: Send + Sync {
    /// 见 `update_client::fetch_latest_version`。
    fn latest_version(&self) -> Pin<Box<dyn Future<Output = AppResult<String>> + Send + 'static>>;
}
