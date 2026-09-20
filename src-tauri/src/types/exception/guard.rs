//! 全局异常捕获与守卫
//!
//! Rust 没有宿主语言的 try/catch，等价能力由两处构成：
//! 1. [`install_panic_hook`]：进程级 panic 钩子，保证任何未捕获异常都会落到
//!    统一日志（而不是只在控制台一闪而过），随后仍交回默认钩子（崩溃语义不变）；
//! 2. [`catch`]：命令级守卫，把 panic 收敛为 [`AppError`]，使单个命令的异常
//!    只会返回一条错误，而不会影响其它命令与整个 WebView。

use std::panic::{catch_unwind, AssertUnwindSafe};

use super::error::{AppError, AppResult};

/// 安装全局 panic 钩子（在应用启动最早期调用一次）。
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "非字符串 panic 载荷".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "未知位置".to_string());
        log::error!("未捕获异常：{}（{}）", payload, location);
        previous(info);
    }));
}

/// 执行任务并捕获其中的 panic，统一转换为 [`AppError`]。
///
/// 用于命令入口等「不允许把异常抛给宿主」的位置。
pub fn catch<T, F>(task: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T>,
{
    match catch_unwind(AssertUnwindSafe(task)) {
        Ok(result) => result,
        Err(payload) => {
            let message = describe_panic(payload);
            log::error!("命令执行异常已被捕获：{}", message);
            Err(AppError::internal(format!("内部异常：{}", message)))
        }
    }
}

/// 把 panic 载荷转换为可读文案。
fn describe_panic(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "非字符串 panic 载荷".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 正常返回不做任何包装。
    #[test]
    fn catch_passes_through_success_and_error() {
        let ok: AppResult<u32> = catch(|| Ok(7));
        assert_eq!(ok.unwrap(), 7);

        let err: AppResult<u32> = catch(|| Err(AppError::invalid("校验失败")));
        assert_eq!(err.unwrap_err().message(), "校验失败");
    }

    /// panic 被收敛为内部错误，而不是向上冒泡。
    #[test]
    fn catch_converts_panic_into_error() {
        let result: AppResult<()> = catch(|| panic!("模拟内部异常"));
        let err = result.expect_err("panic 应被转换为错误");
        assert_eq!(err.code(), crate::types::enums::ErrorCode::Internal);
        assert!(
            err.message().contains("模拟内部异常"),
            "错误文案应包含 panic 信息：{}",
            err.message()
        );
    }
}
