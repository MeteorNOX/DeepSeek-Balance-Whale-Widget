//! 显示币种枚举

/// 显示币种。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Currency {
    /// 人民币。
    Cny,
    /// 美元。
    Usd,
    /// 欧元。
    Eur,
    /// 日元。
    Jpy,
    /// 英镑。
    Gbp,
    /// 港元。
    Hkd,
}

impl Currency {
    /// 全部受支持的币种（顺序即前端选择器顺序）。
    pub const ALL: [Currency; 6] = [
        Currency::Cny,
        Currency::Usd,
        Currency::Eur,
        Currency::Jpy,
        Currency::Gbp,
        Currency::Hkd,
    ];

    /// 默认币种。
    pub const DEFAULT: Currency = Currency::Cny;

    /// 币种代码（三字母大写）。
    pub fn as_str(self) -> &'static str {
        match self {
            Currency::Cny => "CNY",
            Currency::Usd => "USD",
            Currency::Eur => "EUR",
            Currency::Jpy => "JPY",
            Currency::Gbp => "GBP",
            Currency::Hkd => "HKD",
        }
    }

    /// 严格解析（不做大小写 / 空白容错），用于配置规范化。
    pub fn parse(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == code)
    }

    /// 宽松解析（去空白 + 大写），用于「币种切换」入口。
    pub fn parse_loose(code: &str) -> Option<Self> {
        let normalized = code.trim().to_ascii_uppercase();
        Self::parse(&normalized)
    }

    /// 严格解析，非法值回落默认币种。
    pub fn parse_or_default(code: &str) -> Self {
        Self::parse(code).unwrap_or(Self::DEFAULT)
    }

    /// 宽松解析，非法值回落默认币种。
    pub fn parse_loose_or_default(code: &str) -> Self {
        Self::parse_loose(code).unwrap_or(Self::DEFAULT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 币种契约：字符串与顺序必须与前端选择器一致。
    #[test]
    fn currency_codes_and_order_are_stable() {
        let codes: Vec<&str> = Currency::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(codes, vec!["CNY", "USD", "EUR", "JPY", "GBP", "HKD"]);
        assert_eq!(Currency::parse("CNY"), Some(Currency::Cny));
        assert_eq!(Currency::parse("cny"), None, "严格解析不做大小写容错");
        assert_eq!(Currency::parse_loose(" usd "), Some(Currency::Usd));
        assert_eq!(Currency::parse_or_default("XXX"), Currency::Cny);
        assert_eq!(Currency::parse_loose_or_default("gbp"), Currency::Gbp);
    }
}
