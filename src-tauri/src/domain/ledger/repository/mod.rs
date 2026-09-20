//! ledger 领域的仓储抽象（依赖倒置）
//!
//! 领域层只声明「需要什么能力」，具体实现由 `infrastructure` 提供：
//! 应用层拿到的是这些 trait，代码里不出现任何文件 / 网络 / 框架细节。

use crate::domain::ledger::model::UsageLedger;

/// 账本仓储：本地记账账本的读取（旧版文件只在迁移时被读一次）。
pub trait LedgerRepository: Send + Sync {
    /// 见 `ledger_store::read_ledger`。
    fn read_ledger(&self) -> UsageLedger;
}
