//! balance 领域的端口抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这个 trait，代码里不出现任何 HTTP / 缓存细节。

use std::future::Future;
use std::pin::Pin;

use crate::types::exception::AppResult;

/// 汇率端口：取「一种货币兑另一种」的最新汇率（按北京日缓存，见实现处）。
///
/// 异步方法用装箱 `Future` 声明：仓储需要作为 `dyn` trait 对象注入，
/// 原生 `async fn` 在 trait 里不可 dyn 化。
pub trait ExchangeRateRepository: Send + Sync {
    /// 见 `currency_client::get_or_fetch_rate`。
    fn rate<'a>(
        &'a self,
        from: &'a str,
        to: &'a str,
    ) -> Pin<Box<dyn Future<Output = AppResult<f64>> + Send + 'a>>;
}
