//! 供应商历史用量 DTO（`usage_history.json`）
//!
//! 这是**账单与用量图表的唯一数据源**：日 / 周 / 月 / 年各维度都由这里的逐日数字
//! 聚合而来。这里同时保存两类口径（`remote` 令牌用量统计拉取、`local` 余额差值记账），
//! 以及差值记账所需的基准（[`SupplierUsageHistory::last_balance`]）。
//!
//! # 按模型明细也放在这里
//! 官方用量接口的应答本身就是「按模型分组的桶」，[`ModelUsage`] 把这份**接口原始粒度**
//! 原样留下来（金额 + 三类 Token），供金额柱状图的逐模型 tooltip、以及新增的模型 Token
//! 柱状图消费。它没有再落一份独立 JSON：同一份应答、同一个刷新节奏派生出来的数据，
//! 拆成两个文件只会出现「一个刷新了、另一个还是旧的」这种不一致，也与既有的
//! `hourly`（合计）和 `hourly_models`（按模型）之间的关系重复。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// 按日聚合的历史用量。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SupplierUsageHistory {
    /// 最近一次更新（`YYYY-MM-DD HH:MM:SS`，本地时区）。
    pub updated_at: String,
    /// 最近一次观测到的余额（差值记账基准）。
    ///
    /// 在线失败时**必须保留**：下次成功观测的差值会一并覆盖离线期间的用量，
    /// 使本地兜底数据不出现缺口。
    pub last_balance: Option<f64>,
    /// 最近一次在线余额的币种（如 `CNY`），空串表示未知。
    pub currency: String,
    /// 按日聚合：日期（`YYYY-MM-DD`）→ 当日用量。
    ///
    /// 使用 `BTreeMap` 使磁盘键天然有序，便于人工阅读与增量追加。
    pub daily: BTreeMap<String, DailyUsage>,
    /// 在线用量统计接口**已经给过数据**的日期（升序）。
    ///
    /// 用来区分两种「在线用量为 0」：官方口径确实是 0（必须展示 0），
    /// 与官方没有这天的数据（才允许回落本地记账估算）。缺了它，官网显示的 0
    /// 会被本地估算值顶替，正是「与官网对不上」的来源之一。
    pub remote_days: BTreeSet<String>,
    /// 已经**整年回填**过官方用量的年份（0 表示从未回填）。
    ///
    /// 官网用量接口对窗口长度有上限（≥60 天直接拒绝），因此「当年 1 月 1 日至今」
    /// 只能拆成若干次月窗口请求。该字段保证这套回填只在每个自然年做一次，
    /// 之后的刷新只取当月，不会每次都打十几次请求。
    pub backfilled_year: i32,
    /// 已经整年回填过 **Token** 用量的年份（0 表示从未回填）。
    ///
    /// 与 [`Self::backfilled_year`] 分开保存：Token 统计是**另一条接口**，
    /// 它可能因为令牌权限、限流等原因长期取不到，共用一个标记会让这段缺口
    /// 被金额的成功永久掩盖（界面表现为「近一年只有金额、没有 Token」）。
    pub token_backfilled_year: i32,
    /// 按小时聚合的官方用量：`YYYY-MM-DD HH` → 该小时金额（仅 `remote` 口径）。
    ///
    /// 只有官网按小时粒度应答（单日窗口）时才写；界面上的「今天 / 昨天」按小时
    /// 画柱状图，逐日合计无法还原分布在一天内的高峰。为避免文件无限增长，
    /// 每次写入后只保留最近两天。
    pub hourly: BTreeMap<String, f64>,
    /// 按模型拆分的逐小时明细：`YYYY-MM-DD HH` → 模型名 → 明细。
    ///
    /// 与 [`Self::hourly`] 同一份官方应答的两种切法：`hourly` 是「该小时各模型合计」，
    /// 这里是「该小时每个模型各自用了多少」。两者一起落盘而不是另建文件，
    /// 是因为它们来自同一次请求、同一次落盘，分开存只会带来刷新时机不一致的风险。
    pub hourly_models: BTreeMap<String, BTreeMap<String, ModelUsage>>,
    /// 最近一次**逐小时明细**的刷新时间（`YYYY-MM-DD HH:MM:SS`，本地时区）。
    ///
    /// 单日窗口要多花两次请求，不能每次余额刷新都跟着打；界面按它判断缓存是否过期。
    pub hourly_updated_at: String,
}

/// 单个模型在一个时间桶里的明细。
///
/// 金额与三类 Token 分别由**两条**官方接口提供（`by_api_key/cost` 给金额、
/// `by_api_key/amount` 给 Token 计数），因此这里同时承载两个口径：同一份历史里
/// 合并保存，缺失的那个口径保持 0，界面按「有数据的维度」动态出图。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelUsage {
    /// 该模型在该桶内的金额。
    pub cost: f64,
    /// 输入（命中缓存）Token 数。
    pub hit: f64,
    /// 输入（未命中缓存）Token 数。
    pub miss: f64,
    /// 输出 Token 数。
    pub out: f64,
}

impl ModelUsage {
    /// 该模型在这三个维度上的 Token 合计。
    pub fn tokens(&self) -> f64 {
        self.hit + self.miss + self.out
    }

    /// 是否全为 0（三个维度都没用量）。界面据此决定要不要画这根柱 / 这一行。
    pub fn is_empty(&self) -> bool {
        self.cost == 0.0 && self.tokens() == 0.0
    }
}

/// 单日用量：本地记账与在线拉取分别留痕，两者口径不同，不做合并。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DailyUsage {
    /// 本地记账累计用量。
    pub local: f64,
    /// 在线接口拉取到的用量。
    pub remote: f64,
    /// 该日**按模型拆分**的明细（模型名 → 金额 / Token）。
    ///
    /// 只有「令牌用量统计」开启且接口按模型应答时才有内容；本地记账兜底没有模型维度，
    /// 因此它是空 map。合并语义见 `usage::service::record_stats`。
    pub models: BTreeMap<String, ModelUsage>,
}
