//! 峰谷时段与日期类型枚举

/// 峰谷时段（DeepSeek 错峰定价）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeakPeriod {
    /// 高峰时段（价格较高）。
    Peak,
    /// 空闲时段（谷价：周末、法定节假日以及所有非高峰钟点）。
    Off,
}

impl PeakPeriod {
    /// 是否处于高峰时段。
    pub fn is_peak(self) -> bool {
        matches!(self, PeakPeriod::Peak)
    }
}

/// 北京时间的日期类型（决定当天是否适用工作日峰谷）。
///
/// 类型划分只用于「这一天是什么日子」的表述与展示；**是否适用高峰**由
/// [`DateKind::has_peak_hours`] 统一回答，规则见该方法的文档。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateKind {
    /// 普通工作日（周一至周五，且不在法定节假日放假区间内）。
    Workday,
    /// 普通周末（未被调休为工作日）。
    Weekend,
    /// 法定节假日（放假区间内，全天不适用峰谷）。
    Holiday,
    /// 法定节假日调休上班日（原本是周六日的补班日）。
    AdjustedWorkday,
}

impl DateKind {
    /// 当天是否适用工作日高峰时段（09:00–12:00 / 14:00–18:00）。
    ///
    /// 口径：**只有周一至周五、且当天不在法定节假日放假区间内**才算高峰日。
    ///
    /// - 法定节假日（即便落在周一至周五）全天谷价；
    /// - 周六日的调休上班日（补班日）同样全天谷价 —— 计价规则按自然周日历
    ///   判定「周一至周五」，补班不改变周末这一事实，因此统一纳入谷价时段。
    pub fn has_peak_hours(self) -> bool {
        matches!(self, DateKind::Workday)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_peak_reflects_variant() {
        assert!(PeakPeriod::Peak.is_peak());
        assert!(!PeakPeriod::Off.is_peak());
    }

    /// 只有普通工作日适用高峰：法定节假日与周六日（含调休补班）一律谷价。
    #[test]
    fn only_plain_workday_has_peak_hours() {
        assert!(DateKind::Workday.has_peak_hours());
        assert!(!DateKind::Weekend.has_peak_hours());
        assert!(!DateKind::Holiday.has_peak_hours());
        assert!(
            !DateKind::AdjustedWorkday.has_peak_hours(),
            "周六日的调休上班日属于谷价时段，不得开出高峰段"
        );
    }
}
