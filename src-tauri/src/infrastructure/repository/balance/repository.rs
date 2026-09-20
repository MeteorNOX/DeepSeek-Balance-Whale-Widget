//! ExchangeRateRepository 的实现
//!
//! 只做一件事：把领域层的汇率端口委派给本层的汇率客户端。

use std::future::Future;
use std::pin::Pin;

use crate::domain::balance::repository::ExchangeRateRepository;
use crate::infrastructure::http::currency_client;
use crate::types::exception::AppResult;

/// 生产实现：远端汇率接口 + 按北京日缓存。
pub struct ExchangeRateRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static EXCHANGE_RATE_REPOSITORY: ExchangeRateRepositoryImpl = ExchangeRateRepositoryImpl;

impl ExchangeRateRepository for ExchangeRateRepositoryImpl {
    fn rate<'a>(
        &'a self,
        from: &'a str,
        to: &'a str,
    ) -> Pin<Box<dyn Future<Output = AppResult<f64>> + Send + 'a>> {
        Box::pin(currency_client::get_or_fetch_rate(from, to))
    }
}
