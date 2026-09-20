//! 余额查询命令
//!
//! 供前端调用查询余额 + 今日已用。

use crate::application::balance;
use crate::domain::balance::model::BalancePayload;

/// 查询余额 + 今日已用（异步，内部完成小鲸鱼记账）。
#[tauri::command]
pub async fn get_balance() -> BalancePayload {
    balance::service::get_balance_payload().await
}

/// 查询**指定供应商**的余额 + 今日已用。
///
/// 模块化气泡的「余额 / 今日已用」模块允许用户自选供应商，这里按 slug 取数；
/// `slug` 为空时回落到当前启用供应商（与 [`get_balance`] 一致）。
#[tauri::command]
pub async fn get_supplier_balance(scope: String, slug: String) -> BalancePayload {
    balance::service::get_supplier_balance_payload(&scope, &slug).await
}
