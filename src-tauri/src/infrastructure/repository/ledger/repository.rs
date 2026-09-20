//! LedgerRepository 的实现
//!
//! 只做一件事：把领域层的仓储 trait 委派给本层的落盘实现（`<store>`）。

use crate::domain::ledger::model::UsageLedger;
use crate::domain::ledger::repository::LedgerRepository;

/// 生产实现：直接落盘到便携数据目录。
pub struct LedgerRepositoryImpl;

/// 进程内唯一实例（组合根 `lib.rs` 用它完成装配）。
pub static LEDGER_REPOSITORY: LedgerRepositoryImpl = LedgerRepositoryImpl;

impl LedgerRepository for LedgerRepositoryImpl {
    fn read_ledger(&self) -> UsageLedger {
        crate::infrastructure::repository::ledger::ledger_store::read_ledger()
    }
}
