//! 统一错误类型
//!
//! 设计要点：
//! 1. **文案即契约**——`Display` 只输出 `message`，与重构前的 `Result<_, String>`
//!    错误文案逐字一致，前端无需任何改动；
//! 2. **分类可诊断**——`code` / `transient` 供日志与回退策略使用；
//! 3. **转换低成本**——`From<String>` / `From<&str>` / `From<std::io::Error>` 等
//!    让各层的 `?` 直接可用，避免到处手写 `map_err`。

use crate::types::enums::ErrorCode;

/// 全系统统一错误。
#[derive(Debug, Clone)]
pub struct AppError {
    /// 错误分类（日志与诊断用）。
    code: ErrorCode,
    /// 面向用户的错误文案（前端直接展示）。
    message: String,
    /// 是否为瞬时失败（可重试 / 可回退到上次成功值）。
    transient: bool,
}

/// 统一结果别名。
pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    /// 构造错误（默认为非瞬时）。
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            transient: false,
        }
    }

    /// 业务校验失败（入参非法、规则不满足）。
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    /// 资源不存在。
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    /// 资源冲突（重名等）。
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }

    /// 本地读写失败。
    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, message)
    }

    /// 序列化失败。
    pub fn serde(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Serde, message)
    }

    /// 网络传输失败（连接、超时、读体失败等）。
    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Network, message)
    }

    /// 网络或外部服务失败。
    pub fn external(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::External, message)
    }

    /// 依赖资源未就绪。
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unavailable, message)
    }

    /// 内部异常（panic 捕获等）。
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    /// 标记为瞬时失败（网络抖动 / 5xx，可重试、可回退）。
    pub fn transient(mut self) -> Self {
        self.transient = true;
        self
    }

    /// 错误分类。
    pub fn code(&self) -> ErrorCode {
        self.code
    }

    /// 面向用户的错误文案。
    pub fn message(&self) -> &str {
        &self.message
    }

    /// 是否为瞬时失败。
    pub fn is_transient(&self) -> bool {
        self.transient
    }

    /// 取出错误文案（消费自身）。
    pub fn into_message(self) -> String {
        self.message
    }
}

/// **只输出文案**：保证前端拿到的错误字符串与重构前完全一致。
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::new(ErrorCode::Unknown, message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        Self::new(ErrorCode::Unknown, message)
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::io(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self::serde(err.to_string())
    }
}

impl From<std::num::ParseIntError> for AppError {
    fn from(err: std::num::ParseIntError) -> Self {
        Self::invalid(err.to_string())
    }
}

impl From<std::num::ParseFloatError> for AppError {
    fn from(err: std::num::ParseFloatError) -> Self {
        Self::invalid(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端契约：错误的展示文案就是 message，不含错误码等额外信息。
    #[test]
    fn display_is_exactly_the_message() {
        let err = AppError::invalid("音效名称不能为空");
        assert_eq!(err.to_string(), "音效名称不能为空");
        assert_eq!(err.message(), "音效名称不能为空");
        assert_eq!(err.into_message(), "音效名称不能为空");
    }

    /// `?` 与 `From` 转换必须保留原始文案（大量历史错误文本依赖它）。
    #[test]
    fn conversions_keep_original_message() {
        let from_string: AppError = "读取音效配置失败（a）：b".to_string().into();
        assert_eq!(from_string.message(), "读取音效配置失败（a）：b");
        assert_eq!(from_string.code(), ErrorCode::Unknown);

        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "文件不存在");
        let from_io: AppError = io_err.into();
        assert_eq!(from_io.code(), ErrorCode::Io);
        assert!(from_io.message().contains("文件不存在"));

        let from_serde: AppError = serde_json::from_str::<serde_json::Value>("not json")
            .unwrap_err()
            .into();
        assert_eq!(from_serde.code(), ErrorCode::Serde);
    }

    /// 瞬时标记用于余额接口的「可回退」判定。
    #[test]
    fn transient_flag_defaults_false_and_can_be_set() {
        assert!(!AppError::external("HTTP 500").is_transient());
        assert!(AppError::external("HTTP 500").transient().is_transient());
    }
}
