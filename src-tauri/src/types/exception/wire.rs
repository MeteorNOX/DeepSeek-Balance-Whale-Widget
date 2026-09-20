//! 统一返回机制
//!
//! 命令层（`api`）不直接手工拆解错误，而是统一调用 [`IntoWire::into_wire`]：
//! - 成功：原样返回领域载荷；
//! - 失败：落一条 warn 日志（带错误码）并只把文案交给前端。
//!
//! 这样「所有接口的失败路径」只有一处实现，避免各命令各写一套。

use super::error::AppResult;

/// 应用层结果 → 命令出参。
pub trait IntoWire<T> {
    /// 转换为 Tauri 命令的返回值（`Result<T, String>`）。
    fn into_wire(self) -> Result<T, String>;
}

impl<T> IntoWire<T> for AppResult<T> {
    fn into_wire(self) -> Result<T, String> {
        self.map_err(|err| {
            log::warn!("接口调用失败[{}]：{}", err.code().as_str(), err.message());
            err.into_message()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::exception::AppError;

    #[test]
    fn success_is_passed_through() {
        let value: AppResult<u32> = Ok(3);
        assert_eq!(value.into_wire(), Ok(3));
    }

    /// 失败时只暴露文案（错误码不外泄），保持与前端既有契约一致。
    #[test]
    fn error_is_flattened_to_message() {
        let failed: AppResult<u32> = Err(AppError::not_found("挂件组不存在：甲组"));
        assert_eq!(failed.into_wire(), Err("挂件组不存在：甲组".to_string()));
    }
}
