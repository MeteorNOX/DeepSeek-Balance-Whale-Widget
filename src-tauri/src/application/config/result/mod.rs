//! 配置用例的出参对象
//!
//! 只承载「发生了什么」的事实，不含业务逻辑；事件广播由 `api` 层完成。

use crate::domain::config::model::AppConfig;

/// 全量保存配置的结果描述。
pub struct ConfigSaveOutcome {
    /// 保存并规范化后的配置。
    pub config: AppConfig,
    /// 余额数据源（API Key 或请求地址）是否发生变化。
    /// `true` 表示命令层需要通知前端重新拉取余额。
    pub balance_source_changed: bool,
}
