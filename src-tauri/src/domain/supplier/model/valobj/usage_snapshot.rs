//! 一次在线用量查询的结果（值对象）
//!
//! 由基础设施按 [`SupplierUsageQuery`] 的声明解析响应得到，应用层据此记账与组装报表。
//! 它是「接口应答的形状」，不属于某个客户端的私有格式，因此放在领域层。

use std::collections::BTreeMap;

use crate::domain::supplier::model::ModelUsage;

/// 一次在线查询的结果。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsageSnapshot {
    /// 余额。
    pub balance: Option<f64>,
    /// 已用额度。
    pub used: Option<f64>,
    /// 总额度。
    pub total: Option<f64>,
    /// 余额币种（大写；空串表示接口未提供）。
    pub currency: String,
    /// 逐日明细（日期 → 金额），按日期升序。
    pub daily: Vec<(String, f64)>,
    /// 逐小时明细（`YYYY-MM-DD HH` → 金额），按时间升序。
    ///
    /// 只有接口按小时粒度应答（桶长 = 3600）时才有内容：界面上的「今天 / 昨天」
    /// 要按小时画柱状图，逐日合计不够用。
    pub hourly: Vec<(String, f64)>,
    /// **按模型拆分**的逐日明细：日期 → 模型名 → 明细（金额 / 三类 Token）。
    ///
    /// 只有配置了模型路径的接口才有内容。
    pub daily_models: BTreeMap<String, BTreeMap<String, ModelUsage>>,
    /// **按模型拆分**的逐小时明细：`YYYY-MM-DD HH` → 模型名 → 明细。
    pub hourly_models: BTreeMap<String, BTreeMap<String, ModelUsage>>,
    /// 本次应答是否携带**金额**口径。
    ///
    /// 落账时必须区分口径：Token 统计来源的合计是「Token 个数」，
    /// 若当成金额写进历史，账单会被放大成天文数字。
    pub money: bool,
    /// 本次应答是否携带 **Token** 口径（命中缓存 / 未命中缓存 / 输出）。
    pub tokens: bool,
}
