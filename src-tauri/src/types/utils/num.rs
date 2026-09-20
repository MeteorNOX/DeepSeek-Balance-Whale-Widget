//! 数值工具

/// 保留两位小数（避免逻辑坐标反复序列化后产生噪声）。
pub fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round2_trims_float_noise() {
        assert_eq!(round2(1.0 / 3.0), 0.33);
        assert_eq!(round2(0.1 + 0.2), 0.3);
        assert_eq!(round2(-1.239), -1.24);
        assert_eq!(round2(2.0), 2.0);
    }
}
