//! 统一异常码枚举
//!
//! 由 `exception` 模块迁移至此统一维护：错误码用于**日志与问题定位**，
//! 不参与前端展示（前端只消费 `AppError` 的文案），因此新增错误码不会
//! 影响任何既有交互。

/// 统一错误分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// 未分类错误。
    Unknown,
    /// 入参非法（校验不通过）。
    InvalidInput,
    /// 资源不存在。
    NotFound,
    /// 资源冲突（重名、重复创建等）。
    Conflict,
    /// 未配置 API Key。
    NoApiKey,
    /// 本地读写失败。
    Io,
    /// 序列化 / 反序列化失败。
    Serde,
    /// 网络请求失败。
    Network,
    /// 外部依赖返回异常（HTTP 非 2xx、响应结构异常等）。
    External,
    /// 依赖资源尚未就绪（如抠图模型未下载）。
    Unavailable,
    /// 内部异常（panic）。
    Internal,
}

impl ErrorCode {
    /// 稳定的字符串表示（仅用于日志，不作为接口契约）。
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Unknown => "UNKNOWN",
            ErrorCode::InvalidInput => "INVALID_INPUT",
            ErrorCode::NotFound => "NOT_FOUND",
            ErrorCode::Conflict => "CONFLICT",
            ErrorCode::NoApiKey => "NO_API_KEY",
            ErrorCode::Io => "IO",
            ErrorCode::Serde => "SERDE",
            ErrorCode::Network => "NETWORK",
            ErrorCode::External => "EXTERNAL",
            ErrorCode::Unavailable => "UNAVAILABLE",
            ErrorCode::Internal => "INTERNAL",
        }
    }
}

/// 错误分类的短名称（日志用）。
impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 错误码字符串必须稳定（日志与排查脚本依赖它）。
    #[test]
    fn error_code_strings_are_stable() {
        assert_eq!(ErrorCode::InvalidInput.as_str(), "INVALID_INPUT");
        assert_eq!(ErrorCode::NotFound.as_str(), "NOT_FOUND");
        assert_eq!(ErrorCode::NoApiKey.as_str(), "NO_API_KEY");
        assert_eq!(ErrorCode::Unavailable.as_str(), "UNAVAILABLE");
        assert_eq!(ErrorCode::Internal.to_string(), "INTERNAL");
    }

    /// 分类覆盖全部业务失败面（新增分类时此表必须同步扩展）。
    #[test]
    fn error_code_table_is_complete() {
        let table = [
            ErrorCode::Unknown,
            ErrorCode::InvalidInput,
            ErrorCode::NotFound,
            ErrorCode::Conflict,
            ErrorCode::NoApiKey,
            ErrorCode::Io,
            ErrorCode::Serde,
            ErrorCode::Network,
            ErrorCode::External,
            ErrorCode::Unavailable,
            ErrorCode::Internal,
        ];
        assert_eq!(table.len(), 11);
        for code in table {
            assert!(!code.as_str().is_empty());
        }
    }
}
