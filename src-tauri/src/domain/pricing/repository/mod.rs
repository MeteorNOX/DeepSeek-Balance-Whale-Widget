//! pricing 领域的端口抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这些 trait，代码里不出现任何文件 / 网络细节。
//!
//! 两个端口刚好覆盖节假日数据的两个方向：
//! - [`HolidayCacheRepository`]：**本地**缓存读写（落盘 JSON）；
//! - [`HolidaySource`]：**远端**数据源（第三方权威接口）。

use std::future::Future;
use std::pin::Pin;

use crate::domain::pricing::model::valobj::holiday_calendar::HolidayCalendar;
use crate::types::exception::AppResult;

/// 节假日缓存端口：按年份读写本地 JSON 缓存。
pub trait HolidayCacheRepository: Send + Sync {
    /// 读取某年的缓存；文件缺失或解析失败返回 `None`（调用方据此回退到远端）。
    fn read_year(&self, year: i32) -> Option<HolidayCalendar>;

    /// 写入某年的缓存（原子写盘：先写临时文件再整体替换）。
    fn write_year(&self, calendar: &HolidayCalendar) -> AppResult<()>;
}

/// 节假日数据源端口：按年份拉取权威节假日数据。
///
/// 数据源**不允许用户配置**：内置多个免注册、免 AppKey 的免费接口，按顺序尝试，
/// 用户无需（也无法）指定接口地址与密钥。
pub trait HolidaySource: Send + Sync {
    /// 拉取某年的完整日历（放假区间 + 调休上班日）。
    ///
    /// 实现内部依次尝试各内置免费源，只有拿到**通过完整性校验**的数据才返回成功。
    fn fetch_year(
        &self,
        year: i32,
    ) -> Pin<Box<dyn Future<Output = AppResult<HolidayCalendar>> + Send + 'static>>;
}
