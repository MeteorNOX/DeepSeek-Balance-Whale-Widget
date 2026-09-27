// 阿里云百炼 Token Plan（provider 路由名 tokenplan）用量估算 —— 纯逻辑模块。
//
// 为什么是「估算」：
//   Token Plan 专属网关只提供推理接口（实测 /compatible-mode/v1 下
//   /v1/usage、/v1/dashboard/subscribe/detail、/v1/models 之外的路径全部被
//   当成 chat 请求兜底，响应头也不含任何额度字段），官方 Credits 只在百炼
//   控制台「Token Plan > 我的订阅」可见。所以本模块用本地 token 账本换算：
//   Credits ≈ 按量价(元/百万 token) × 100，系数与
//   ~/token-plan-tools/token_plan_report.py 的 RATES 保持一致。
//   控制台还会计入系统提示词/工具 schema/reasoning 等隐藏消耗，实际 Credits
//   可能高于这里估算的值 —— UI 必须标注「估算」。
//
// 本文件不做任何 IO、不读密钥、不发网络请求，便于独立单测（见 test/）。

export const TOKENPLAN_PROVIDER = 'tokenplan'
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000

// 档位额度（Credits）。09-23 抄自控制台「Token Plan 订阅总览」：Lite ¥39=11,500/月、Essential ¥79=25,500/月、
// Standard ¥139=45,000/月、Pro ¥499=180,000/月 —— **单位是月，不是周**。
// 这张表一定会过期，所以三处都可被配置覆盖：qwenCap（绝对上限）、qwenPeriodDays（窗口天数）、qwenResetAt（重置时刻）。
export const TIER_CAPS = { lite: 11500, essential: 25500, standard: 45000, pro: 180000 }
// 旧口径留一份，万一官方又切回按周算（09-12 的 429 报文当时说的是 1-week quota）
export const TIER_CAPS_WEEKLY = { lite: 2500, standard: 10000, pro: 40000 }
export const DEFAULT_CAP_CREDITS = TIER_CAPS.standard
export const DEFAULT_PERIOD_DAYS = 30
export const PLAN_PRICE_CNY = 139 // Standard 档 ¥139 / 30 天
export const PLAN_DAYS = 30 // 一期的天数（周额度 × 30/7 就是整期 Credits 预算）

// model -> [输入, 输出(含 reasoning), 缓存读取] 元/百万 token（按量价）
// Credits/百万 token = 元价 × 100
export const PRICE_CNY_PER_M = {
  'qwen3.8-flash': [0.8, 2.7, 0.1],
  'qwen3.8-max': [12, 36, 1.5],
  'qwen3.7-max': [12, 36, 2.4],
  'qwen3.7-plus': [2, 8, 0.4],
  'qwen3.6-flash': [2, 8, 0.2],
  'qwen3.6-plus': [2, 8, 0.4],
  'glm-5.2': [8, 28, 2],
  'deepseek-v4-flash-0731': [2, 12, 0.2],
  'deepseek-v4-pro': [9, 27, 0.9],
  'deepseek-v4-pro-0813': [9, 27, 0.9],
}
// 未知模型（新上架/改名）按主力模型 flash 计价，并单列到 unknownModels 提示校准
const FALLBACK_PRICE = PRICE_CNY_PER_M['qwen3.8-flash']

const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

function toNumber(v) {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

function normalizeModel(model) {
  return String(model || '').trim().toLowerCase()
}

/**
 * 取模型价目。返回 {price, known}：price = [输入, 输出, 缓存] 元/百万 token。
 */
export function priceForModel(model) {
  const m = normalizeModel(model)
  if (Object.prototype.hasOwnProperty.call(PRICE_CNY_PER_M, m)) {
    return { price: PRICE_CNY_PER_M[m], known: true }
  }
  return { price: FALLBACK_PRICE, known: false }
}

/**
 * 一次 usage（harness TokenUsage / 账本条目）→ {credits, payg, tokens, ...}。
 * usage: {inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, calls}
 * calib: 校准系数（默认 1，可在配置里按控制台实际 Credits 调）。
 */
export function estimateUsage(model, usage, calib) {
  const u = usage && typeof usage === 'object' ? usage : {}
  const input = toNumber(u.inputTokens)
  const cache = toNumber(u.cacheReadTokens) + toNumber(u.cacheWriteTokens)
  const output = toNumber(u.outputTokens) + toNumber(u.reasoningTokens)
  const calls = toNumber(u.calls) || (input + cache + output > 0 ? 1 : 0)
  const { price, known } = priceForModel(model)
  const k = isFinite(calib) && calib > 0 ? calib : 1
  const payg = ((input * price[0] + output * price[1] + cache * price[2]) / 1e6) * k
  const credits = payg * 100
  return {
    credits,
    payg,
    tokens: input + cache + output,
    input,
    cache,
    output,
    calls,
    known,
  }
}

function safeKey(k) {
  return typeof k === 'string' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype'
}

function emptyDay() {
  return { credits: 0, payg: 0, tokens: 0, calls: 0, models: {}, unknown: {} }
}

function addEstimate(day, model, est) {
  day.credits += est.credits
  day.payg += est.payg
  day.tokens += est.tokens
  day.calls += est.calls
  const key = safeKey(model) && model ? model : 'unknown'
  const slot = day.models[key] || { credits: 0, tokens: 0, calls: 0 }
  slot.credits += est.credits
  slot.tokens += est.tokens
  slot.calls += est.calls
  day.models[key] = slot
  if (!est.known) day.unknown[key] = true
}

/**
 * 解析 dsh-usage 账本（$DSH_HOME/dsh-usage/usage-ledger.json）：
 *   {version, days: {'YYYY-MM-DD': {provider: {model: totals}}}}
 * 只取 provider === tokenplan，返回 {'YYYY-MM-DD': dayAgg}。
 */
export function parseLedger(doc, providerName) {
  const provider = providerName || TOKENPLAN_PROVIDER
  const out = {}
  const days = doc && typeof doc === 'object' ? doc.days : null
  if (!days || typeof days !== 'object') return out
  for (const dateKey of Object.keys(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue
    const byProvider = days[dateKey]
    if (!byProvider || typeof byProvider !== 'object') continue
    const byModel = byProvider[provider]
    if (!byModel || typeof byModel !== 'object') continue
    const day = emptyDay()
    for (const model of Object.keys(byModel)) {
      if (!safeKey(model)) continue
      const totals = byModel[model]
      if (!totals || typeof totals !== 'object') continue
      addEstimate(day, model, estimateUsage(model, totals))
    }
    if (day.credits > 0 || day.calls > 0) out[dateKey] = day
  }
  return out
}

/**
 * 解析挂件自己的实时账本（.dshw-qwen.json：{days:{date:{credits,payg,tokens,calls,models}}）。
 * 用于 dsh-usage 插件没启用、或账本尚未落盘的当下增量。
 */
export function parseSelfLedger(doc) {
  const out = {}
  const days = doc && typeof doc === 'object' ? doc.days : null
  if (!days || typeof days !== 'object') return out
  for (const dateKey of Object.keys(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue
    const raw = days[dateKey]
    if (!raw || typeof raw !== 'object') continue
    const day = emptyDay()
    day.credits = toNumber(raw.credits)
    day.payg = toNumber(raw.payg)
    day.tokens = toNumber(raw.tokens)
    day.calls = toNumber(raw.calls)
    const models = raw.models && typeof raw.models === 'object' ? raw.models : {}
    for (const model of Object.keys(models)) {
      if (!safeKey(model)) continue
      const slot = models[model] || {}
      day.models[model] = {
        credits: toNumber(slot.credits),
        tokens: toNumber(slot.tokens),
        calls: toNumber(slot.calls),
      }
    }
    const unknown = raw.unknown && typeof raw.unknown === 'object' ? raw.unknown : {}
    for (const model of Object.keys(unknown)) if (safeKey(model)) day.unknown[model] = true
    if (day.credits > 0 || day.calls > 0) out[dateKey] = day
  }
  return out
}

/**
 * 合并两个来源的逐日聚合：同日取较大值（两者统计的是同一批调用，
 * 相加会重复计费；较大者更接近真实）。返回 {days, source}。
 */
export function mergeDays(ledgerDays, selfDays) {
  const keys = new Set([...Object.keys(ledgerDays || {}), ...Object.keys(selfDays || {})])
  const days = {}
  let fromLedger = 0
  let fromSelf = 0
  let both = 0
  for (const dateKey of keys) {
    const a = (ledgerDays && ledgerDays[dateKey]) || null
    const b = (selfDays && selfDays[dateKey]) || null
    if (!a && !b) continue
    let winner
    if (!a) { winner = b; fromSelf++ }
    else if (!b) { winner = a; fromLedger++ }
    else {
      winner = a.credits >= b.credits ? a : b
      both++
    }
    days[dateKey] = {
      credits: winner.credits,
      payg: winner.payg,
      tokens: winner.tokens,
      calls: winner.calls,
      models: winner.models,
      unknown: winner.unknown,
    }
  }
  const source = both > 0 || (fromLedger > 0 && fromSelf > 0)
    ? 'ledger+live'
    : fromSelf > 0 ? 'live' : fromLedger > 0 ? 'ledger' : 'none'
  return { days, source }
}

export function localDayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export function dayKeyToMs(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''))
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime()
  return isFinite(t) ? t : null
}

export function round(v, digits) {
  const p = Math.pow(10, digits)
  const n = Number(v)
  if (!isFinite(n)) return 0
  return Math.round(n * p) / p
}

/**
 * 窗口锚点：官方口径自「首次调用」起每 7 天一个固定窗口。本地只能推断：
 * 优先配置 qwenWindowAnchor，其次账本里最早有 tokenplan 用量的一天。
 */
/** 精确 anchor：'YYYY-MM-DDTHH:MM(:SS)' / 'YYYY-MM-DD HH:MM' / 毫秒数；纯日期串返回 null 走老口径 */
export function parseAnchorMs(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return isFinite(v) && v > 1e12 ? v : null
  const s = String(v).trim()
  if (!s) return null
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return null
  if (/^[0-9]+$/.test(s)) return Number(s)
  const t = Date.parse(s.replace(' ', 'T'))
  return isFinite(t) ? t : null
}

export function resolveAnchor(cfgAnchorKey, dayKeys, nowMs) {
  const fromCfg = dayKeyToMs(cfgAnchorKey)
  if (fromCfg !== null && fromCfg <= nowMs + DAY_MS) {
    return { anchorMs: fromCfg, anchorSource: 'config' }
  }
  const valid = (dayKeys || [])
    .map((k) => dayKeyToMs(k))
    .filter((t) => t !== null && t <= nowMs)
    .sort((x, y) => x - y)
  if (valid.length) return { anchorMs: valid[0], anchorSource: 'first-usage-day' }
  return { anchorMs: nowMs, anchorSource: 'now' }
}

// periodDays 默认 7（老口径）；官方把套餐改成「月额度」后，窗口长度与重置时刻都该跟着套餐走，
// 而不是把 7 天当成天经地义 —— 2026-09-23 控制台订阅详情页：Standard = 45,000 Credits / 月，
// 周期 2026-09-05 15:05:52 → 2026-10-06 00:00:00（接口 v2/usage 只回 per1MonthPercentage 与 per1MonthResetTime）。
// 给了 resetAtMs 就以它为准，窗口 = [reset - periodDays, reset)，往前滚动找包含 nowMs 的那一段。
export function currentWindow(anchorMs, nowMs, periodDays, resetAtMs) {
  const days = clampNum(Math.round(Number(periodDays) || 7), 1, 62)
  const span = days * DAY_MS
  if (isFinite(resetAtMs) && resetAtMs > 0 && resetAtMs > anchorMs) {
    let endMs = resetAtMs
    let startMs = endMs - span
    let guard = 0
    while (startMs > nowMs && guard++ < 400) { endMs = startMs; startMs = endMs - span }
    return {
      index: Math.max(0, Math.floor((startMs - anchorMs) / span)),
      startMs,
      endMs,
      startKey: localDayKey(startMs),
      dayIndex: clampNum(Math.floor((nowMs - startMs) / DAY_MS) + 1, 1, days),
      resetInMs: Math.max(0, endMs - nowMs),
      periodDays: days,
    }
  }
  const index = Math.max(0, Math.floor((nowMs - anchorMs) / span))
  const startMs = anchorMs + index * span
  const endMs = startMs + span
  return {
    index,
    startMs,
    endMs,
    startKey: localDayKey(startMs),
    dayIndex: clampNum(Math.floor((nowMs - startMs) / DAY_MS) + 1, 1, days),
    resetInMs: Math.max(0, endMs - nowMs),
    periodDays: days,
  }
}

/**
 * 30 天套餐维度。**只有配了 qwenPlanStart 才算** —— 绝不拿账本最早一天瞎猜：
 * 那是"开始监控的那天"，不是"下单的那天"，重装或换 profile 就会偏，
 * 宁可不显示，也不要给出一个看起来精确的假到期日。
 * 套餐内 Credits 总预算按周上限折算整期（10000/7 天 × 30 天），用于"这期还剩多少"。
 */
// 整期预算 = 档位额度 × (套餐天数 / 窗口天数)：窗口本来就是 30 天的月额度时，整期就是那一档的数；
// 老口径（7 天窗口、10,000/周）折算成 30 天才是 ×30/7。别把两种单位混着乘。
export function planWindow(startKey, nowMs, cap, priceCny, planDays, periodDays) {
  const startMs = dayKeyToMs(startKey)
  if (startMs === null || startMs > nowMs) return null
  const days = planDays > 0 ? planDays : PLAN_DAYS
  const totalMs = days * DAY_MS
  const endMs = startMs + totalMs
  const leftMs = endMs - nowMs
  return {
    startMs,
    endMs,
    totalDays: days,
    dayIndex: clampNum(Math.floor((nowMs - startMs) / DAY_MS) + 1, 1, days),
    daysLeft: Math.max(0, Math.ceil(leftMs / DAY_MS)),
    expired: leftMs <= 0,
    capTotal: Math.round((cap || 0) * (days / (periodDays > 0 ? periodDays : 7))),
    priceCny: priceCny > 0 ? priceCny : PLAN_PRICE_CNY,
    dailyCny: round((priceCny > 0 ? priceCny : PLAN_PRICE_CNY) / days, 2),
  }
}

export function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const cap = toNumber(cfg.qwenCap)
  const calib = toNumber(cfg.qwenCalib)
  const warn = toNumber(cfg.qwenWarnPct)
  const tier = String(cfg.qwenTier || '').toLowerCase()
  const fromTable = !(cap > 0)
  let capValue = cap > 0 ? Math.round(cap) : TIER_CAPS[tier] || DEFAULT_CAP_CREDITS
  if (capValue > 1000000) capValue = 1000000
  return {
    enabled: cfg.qwenEnabled !== false,
    cap: capValue,
    // 上限从哪来的：config = 人从控制台抄进来的实测值；tier-table:* = 内置档位表。
    // 官方一调整档位表就悄悄失真 —— 2026-09-23 就是这样把页面 4.8% 显示成 94.3%。
    capSource: fromTable ? "tier-table:" + (Object.prototype.hasOwnProperty.call(TIER_CAPS, tier) ? tier : "default") : "config",
    calib: calib > 0 && calib < 100 ? calib : 1,
    // 校准系数与它的出处：只有拿控制台两个读数对过表才该动 calib，note 记下什么时候对、剩多少没解释
    calibSource: calib > 0 && calib < 100 ? "config" : "unset",
    calibNote: String(cfg.qwenCalibNote || "").trim(),
    // 对表锚点：人从控制台抄回来的一次官方读数（它只给百分比与时刻），用来看我方估算偏了多少
    officialPct: (() => { const v = toNumber(cfg.qwenOfficialPct); return v > 0 && v <= 100 ? v : null })(),
    officialAtMs: parseAnchorMs(cfg.qwenOfficialAt),
    officialCap: (() => { const v = toNumber(cfg.qwenOfficialCap); return v > 0 ? Math.round(v) : 0 })(),
    warnPct: clampNum(warn > 0 ? warn : 70, 5, 100),
    windowAnchor:
      typeof cfg.qwenWindowAnchor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cfg.qwenWindowAnchor)
        ? cfg.qwenWindowAnchor
        : '',
    // 精确到时刻的窗口锚点（用了重置卡那天）：'YYYY-MM-DDTHH:MM' / 'YYYY-MM-DD HH:MM' / 毫秒数；
    // 纯日期串交给上面那条老口径，这条只补「今天 18:05 重置」这种窗口起点
    windowAnchorMs: parseAnchorMs(cfg.qwenWindowAnchorExact),
    // 窗口长度与重置时刻：跟着套餐走（月额度就填 30 与控制台那个重置时间）
    periodDays: (() => { const pd = Math.round(toNumber(cfg.qwenPeriodDays) || 0); return pd >= 1 && pd <= 62 ? pd : DEFAULT_PERIOD_DAYS })(),
    resetAtMs: parseAnchorMs(cfg.qwenResetAt),
    // 重置卡那一天的「重置前已计」Credits：只从窗口首日扣一次，跨窗口自动失效（本地账本只到「天」，拆不开）
    anchorSubtract: Math.max(0, Number(cfg.qwenAnchorSubtract) || 0),
    anchorSubtractNote: String(cfg.qwenAnchorSubtractNote || '').trim(),
    provider: typeof cfg.qwenProvider === 'string' && cfg.qwenProvider ? cfg.qwenProvider : TOKENPLAN_PROVIDER,
    models: Array.isArray(cfg.qwenModels) ? cfg.qwenModels.map((x) => String(x).toLowerCase()) : null,
    priceCny: isFinite(toNumber(cfg.qwenPlanPriceCny)) && toNumber(cfg.qwenPlanPriceCny) > 0 ? toNumber(cfg.qwenPlanPriceCny) : PLAN_PRICE_CNY,
    planStart:
      typeof cfg.qwenPlanStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cfg.qwenPlanStart)
        ? cfg.qwenPlanStart
        : '',
    planDays: isFinite(toNumber(cfg.qwenPlanDays)) && toNumber(cfg.qwenPlanDays) > 0 ? Math.round(toNumber(cfg.qwenPlanDays)) : PLAN_DAYS,
  }
}

/**
 * 判定某次调用是否算进 Token Plan：
 * 有路由信息（request/context 的 provider）时以路由为准 —— tokenplan 与
 * bailian 存在同名 qwen 模型，只看模型名会串账。
 */
export function isTokenPlanCall(cfg, provider, model) {
  const m = normalizeModel(model)
  if (!m) return false
  if (provider) return provider === cfg.provider
  if (Array.isArray(cfg.models) && cfg.models.length) return cfg.models.indexOf(m) !== -1
  return Object.prototype.hasOwnProperty.call(PRICE_CNY_PER_M, m)
}

// —— 触顶 / 限流 信号的存活时长与判定阈值 ——
// 官方 5 小时滚动限流窗口早已取消，触顶信号留 6h 足够；再长就会把
// 「用量还很多」显示成告警态。限流按分钟重置，15 分钟足够说明问题。
export const QUOTA_HIT_TTL_MS = 6 * 60 * 60 * 1000
export const RATE_LIMIT_TTL_MS = 15 * 60 * 1000
// 估算用量低于这个百分比时，一句「额度不足」的报错不足以断定周额度用尽，
// 降级成"存疑"而不是直接显示已触顶（理由见 classifyFailure 的实测教训）。
export const CAP_CONFIRM_PCT = 85

const THROTTLE_RE = /\b429\b|too many requests|rate.?limit|throttl|token-limit|token limit|\btpm\b|rpm limit|please (try|wait) later|稍后重试/
const FREE_QUOTA_RE = /free quota|use free tier only|free.?tier.?only|免费额度/
// 「套餐周额度真的用尽」的硬证据：百炼网关这条也带 429，但它不是限流（退避重试到重置时刻
// 之前都不会成功，必须换路由才有解）。09-15 复核才发现旧判定把它算成 throttle，
// 于是真耗尽反而永远不标触顶 —— 这条判定必须排在 429 兜底之前。
const CAP_HARD_RE = /quota has been exhausted|\d+[- ]week quota|weekly quota|周额度(已)?(用尽|耗尽|超限)|exceeded your weekly/i
const CAP_RE = /insufficient balance|balance is insufficient|额度(已)?(用尽|耗尽|超限|不足)|quota (exhausted|used up|reached)|exceeded your (weekly|monthly|plan|current)|reach(ed)? your (weekly|monthly) (usage )?limit|余额不足/

/**
 * 把 harness 写进 turn/end 的 LlmFailure 分成四类：
 *   'throttle'  速率/并发被打回 —— 与本周 Credits 无关，按分钟重置
 *   'freeQuota' 百炼免费额度耗尽 —— 另一条路由，不是套餐
 *   'cap'       可能真是套餐额度用尽
 *   'other'     与额度无关
 * 判定顺序很重要：先排免费额度与限流，剩下的才可能是真触顶。
 *
 * 实测教训（2026-09-07，本机 session fbb7dfbc 21:10:20 的 turn/end）：
 *   429 {"message":"Allocated quota exceeded, ... error-code#token-limit",
 *        "type":"insufficient_quota","code":"insufficient_quota"}
 * 这是每分钟 token 配额(TPM)被打满，文案里却带 quota/exhausted，旧判定
 * 把它算成周额度触顶 —— 实际用量 6651/10000 = 66.5%，气泡却长期显示
 * 「已触顶 · 暂停」，数字染红、小红点常驻。429 家族一律不算触顶。
 */
export function classifyFailure(err) {
  if (!err || typeof err !== 'object') return 'other'
  const status = Number(err.status)
  const text = (String(err.message || '') + ' ' + String(err.code || '') + ' ' + String(err.type || ''))
    .toLowerCase()
    .trim()
  if (!text) return 'other'
  if (FREE_QUOTA_RE.test(text)) return 'freeQuota'
  if (CAP_HARD_RE.test(text)) return 'cap'
  // 百炼的 429 / Throttling.* / #token-limit：无论文案里有没有 quota 字样
  if (status === 429 || /\bthrottling\b/.test(text) || THROTTLE_RE.test(text)) return 'throttle'
  if (CAP_RE.test(text)) return 'cap'
  if (status === 402 && /quota|balance|insufficient/.test(text)) return 'cap'
  // 兜底：带额度字样、又不属于以上任何一类的，按可疑触顶处理，交给
  // summarize 的 CAP_CONFIRM_PCT 把关，别在这里一刀切漏掉真触顶。
  if (/quota|额度|exhausted|limit exceeded/.test(text)) return 'cap'
  return 'other'
}

const ALERT_LABELS = {
  ok: '',
  // 09-23 起官方口径是「月额度」，标签里别再写死「周」—— 单位是配置项（qwenPeriodDays），不是天经地义
  warn: '套餐额度告警',
  high: '套餐额度即将用尽',
  exhausted: '套餐额度已触顶',
}

export function alertLevel(pct, warnPct) {
  if (pct >= 100) return 'exhausted'
  if (pct >= Math.max(90, warnPct + 20)) return 'high'
  if (pct >= warnPct) return 'warn'
  return 'ok'
}

export function fmtCreditsShort(v) {
  const n = Number(v)
  if (!isFinite(n)) return '--'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e4) return Math.round(n / 1e3) + 'k'
  if (Math.abs(n) >= 100) return String(Math.round(n))
  return (Math.round(n * 10) / 10).toString()
}

/**
 * 汇总成 /dsh-whale/qwen.json 的响应体。
 * {ledgerDays, selfDays} 至少给一个（另一个可传 {}）；cfg 来自 normalizeConfig。
 * quotaHitAt / rateLimitedAt 是账本里存的时间戳，本函数负责判新鲜度与合理性，
 * 调用方不必自己算过期（传了旧值也只会降级成存疑/无）。
 */
export function summarize(input) {
  const arg = input || {}
  const nowMs = isFinite(arg.nowMs) ? arg.nowMs : Date.now()
  const cfg = arg.cfg && typeof arg.cfg === 'object' ? arg.cfg : normalizeConfig(arg.cfg)
  const merged = mergeDays(arg.ledgerDays || {}, arg.selfDays || {})
  const dayKeys = Object.keys(merged.days).sort()

  const anchor = typeof cfg.windowAnchorMs === 'number' && isFinite(cfg.windowAnchorMs) && cfg.windowAnchorMs <= nowMs
    ? { anchorMs: cfg.windowAnchorMs, anchorSource: 'config-exact' }
    : resolveAnchor(cfg.windowAnchor, dayKeys, nowMs)
  const win = currentWindow(anchor.anchorMs, nowMs, cfg.periodDays, cfg.resetAtMs)

  const windowEntries = []
  for (let i = 0; i < win.periodDays; i++) {
    const key = localDayKey(win.startMs + i * DAY_MS)
    const d = merged.days[key]
    if (d) windowEntries.push({ date: key, day: d })
  }

  // 柱子口径：本计费周期分 7 格（左→右），与 used / dayIndex / 倒计时同源。
  // 周期是 7 天时一格就是一天；改成月额度后一格是 ceil(天数/7) 天，**绝不能只画前 7 天**
  // —— 那样柱子合计与 used 又不等价了（09-15 就是被 check-qwen.mjs 抓过这个形状）。
  const todayKey = localDayKey(nowMs)
  const today = merged.days[todayKey]
  const todayMs = dayKeyToMs(todayKey)
  const spanDays = Math.max(1, Math.ceil(win.periodDays / 7))
  const series = []
  for (let i = 0; i < 7; i++) {
    const fromMs = win.startMs + i * spanDays * DAY_MS
    const toMs = Math.min(win.startMs + (i + 1) * spanDays * DAY_MS, win.endMs)
    let cr = 0, tk = 0, cl = 0
    for (let j = 0; j < spanDays; j++) {
      const k = localDayKey(fromMs + j * DAY_MS)
      if (fromMs + j * DAY_MS >= toMs) break
      const d = merged.days[k]
      if (d) { cr += d.credits; tk += d.tokens; cl += d.calls }
    }
    series.push({
      date: localDayKey(fromMs),
      dateFrom: localDayKey(fromMs),
      dateTo: localDayKey(Math.max(fromMs, toMs - DAY_MS)),
      spanDays,
      credits: round(cr, 1),
      tokens: tk,
      calls: cl,
      // 未来格按那一天判：起点带时刻（用了重置卡）时拿它跟今日零点比，会把今天误标成未来
      future: dayKeyToMs(localDayKey(fromMs)) > todayMs,
    })
  }

  // 重置卡：锚点那一天横跨重置时刻，那天重置前已计的量本地拆不开，按配置一次性扣掉。
  // 扣的是「锚点所在那天」而不是「谁在窗口首位」——换到下一个窗口后这条自然落空，不会一直往下扣。
  const subtractKey = localDayKey(anchor.anchorMs)
  if (cfg.anchorSubtract > 0) {
    for (const e of series) {
      if (!e.future && e.dateFrom <= subtractKey && subtractKey <= e.dateTo) {
        e.credits = Math.max(0, round(e.credits - cfg.anchorSubtract, 1))
        break
      }
    }
  }

  // used 用逐日取整后的值相加：保证「柱子合计 == 面板已用」，两边不会差 0.1
  const used = series.reduce((sum, e) => (e.future ? sum : sum + e.credits), 0)
  const usedAll = dayKeys.reduce((s, k) => s + merged.days[k].credits, 0)
  const cap = cfg.cap > 0 ? cfg.cap : DEFAULT_CAP_CREDITS
  const pct = cap > 0 ? clampNum((used / cap) * 100, 0, 999) : 0
  const remaining = cap - used

  const byModelMap = {}
  const unknownModels = new Set()
  for (const entry of windowEntries) {
    const d = entry.day
    for (const model of Object.keys(d.models)) {
      const slot = byModelMap[model] || { credits: 0, tokens: 0, calls: 0 }
      slot.credits += d.models[model].credits
      slot.tokens += d.models[model].tokens
      slot.calls += d.models[model].calls
      byModelMap[model] = slot
    }
    for (const model of Object.keys(d.unknown || {})) unknownModels.add(model)
  }
  const byModel = Object.keys(byModelMap)
    .map((model) => ({
      model,
      credits: round(byModelMap[model].credits, 1),
      tokens: byModelMap[model].tokens,
      calls: byModelMap[model].calls,
    }))
    .sort((a, b) => b.credits - a.credits)

  const windowPayg = windowEntries.reduce((s, e) => s + e.day.payg, 0)
  const totalPayg = dayKeys.reduce((s, k) => s + merged.days[k].payg, 0)
  const level = alertLevel(pct, cfg.warnPct)
  const hasData = merged.source !== 'none'
  // 信号在这里（而不是调用方）做过期与合理性把关：任何一条路径拿到旧账本，
  // 都不可能把「其实还剩三成」显示成已触顶。
  const hitTtl = isFinite(arg.quotaHitTtlMs) ? arg.quotaHitTtlMs : QUOTA_HIT_TTL_MS
  const rawHit = arg.quotaHitAt && isFinite(arg.quotaHitAt) ? Number(arg.quotaHitAt) : null
  const hitFresh = rawHit !== null && nowMs - rawHit <= hitTtl
  // 真触顶：信号新鲜，且估算用量确实接近上限
  const quotaHit = hitFresh && pct >= CAP_CONFIRM_PCT ? rawHit : null
  // 存疑：报错说额度不足，但估算值离上限还远（多半是口径估低或又一类误判）
  const quotaSuspect = hitFresh && quotaHit === null ? rawHit : null
  const rlTtl = isFinite(arg.rateLimitTtlMs) ? arg.rateLimitTtlMs : RATE_LIMIT_TTL_MS
  const rawRl = arg.rateLimitedAt && isFinite(arg.rateLimitedAt) ? Number(arg.rateLimitedAt) : null
  const rateLimited = rawRl !== null && nowMs - rawRl <= rlTtl && quotaHit === null ? rawRl : null
  // 自估过百**不算触顶**：上限可能来自过期档位表、换算系数也还没跟控制台对过表（09-23 两条都不成立），
  // 让自家估算单独有权宣布 exhausted，就等于把「10,000 × 猜的系数」当成阿里云的判决。降到 high 并标出来源。
  const estimateOver = level === 'exhausted' && quotaHit === null
  let effectiveLevel = quotaHit && level === 'ok' ? 'warn' : (estimateOver ? 'high' : level)
  // 对过表就允许说「我方口径与官方差 N 倍」：抄一次官方读数（只有百分比与时刻），跟自估摆在一起。
  // 比值离谱时百分比再高也不配当告警依据 —— 09-23 实测自估 40,934 Cr 对官方 4,936 Cr，差 8.3 倍，
  // 让这种数去喊「即将用尽」和当初喊「已触顶」是同一种错，只是换了个方向。
  const officialCr = cfg.officialPct !== null && cfg.officialPct > 0
    ? (cfg.officialPct / 100) * (cfg.officialCap > 0 ? cfg.officialCap : cap) : null
  const estRatio = officialCr !== null && officialCr > 0 && used > 0 ? used / officialCr : null
  const caliberMismatch = estRatio !== null && (estRatio > 1.5 || estRatio < 0.67)
  if (caliberMismatch && (effectiveLevel === 'high' || effectiveLevel === 'exhausted')) effectiveLevel = 'warn'
  const perDay = used / Math.max(1, win.dayIndex)
  const plan = cfg.planStart ? planWindow(cfg.planStart, nowMs, cap, cfg.priceCny, cfg.planDays, cfg.periodDays) : null

  return {
    ok: hasData,
    estimated: true,
    source: merged.source,
    provider: cfg.provider,
    cap,
    calib: cfg.calib,
    capSource: cfg.capSource,
    calibSource: cfg.calibSource,
    calibNote: cfg.calibNote || null,
    // 抄回来的官方读数（没有就是 null）：前端用它解释「为什么我方百分比与页面不一样」
    official: officialCr !== null ? {
      pct: round(cfg.officialPct, 2),
      credits: round(officialCr, 1),
      atMs: cfg.officialAtMs,
      ratio: estRatio !== null ? round(estRatio, 2) : null,
      mismatch: caliberMismatch,
    } : null,
    used: round(used, 1),
    remaining: round(remaining, 1),
    pct: round(pct, 1),
    usedAllTime: round(usedAll, 1),
    dayIndex: win.dayIndex,
    daysLeft: clampNum(Math.ceil(win.resetInMs / DAY_MS), 0, 7),
    windowIndex: win.index,
    periodDays: win.periodDays,
    windowStart: win.startMs,
    windowStartKey: win.startKey,
    windowEnd: win.endMs,
    resetAt: win.endMs,
    resetInMs: win.resetInMs,
    anchorSource: anchor.anchorSource,
    anchorSubtract: cfg.anchorSubtract > 0 ? cfg.anchorSubtract : null,
    anchorSubtractNote: cfg.anchorSubtractNote || null,
    today: {
      credits: today ? round(today.credits, 2) : 0,
      tokens: today ? today.tokens : 0,
      calls: today ? today.calls : 0,
    },
    series,
    windowDays: windowEntries.map((e) => ({
      date: e.date,
      credits: round(e.day.credits, 1),
      tokens: e.day.tokens,
      calls: e.day.calls,
    })),
    byModel,
    unknownModels: Array.from(unknownModels),
    payg: {
      windowCny: round(windowPayg, 2),
      ledgerCny: round(totalPayg, 2),
      planPriceCny: cfg.priceCny,
      savedCny: round(windowPayg - cfg.priceCny, 2),
      roiPercent: cfg.priceCny > 0 ? round((windowPayg / cfg.priceCny) * 100, 1) : 0,
    },
    // —— 节奏：光有百分比不足以决定"现在敢不敢开大活" ——
    pace: {
      // 本周期日均（Cr/天）：dayIndex 至少 1，避免开局除零
      perDay: round(perDay, 1),
      // 按这个速度到周期末大概烧多少
      projected: round(perDay * 7, 1),
      // 剩余额度还能按日均烧几天；null = 这周还没用量。与 daysLeftToReset 对比就是答案
      daysToCap: perDay > 0 ? round(remaining / perDay, 1) : null,
      daysLeftToReset: clampNum(7 - win.dayIndex + 1, 1, 7),
    },
    // —— 30 天套餐维度：没配 qwenPlanStart 就是 null，UI 绝不自造到期日 ——
    plan: plan
      ? {
          startAt: plan.startMs,
          endAt: plan.endMs,
          totalDays: plan.totalDays,
          dayIndex: plan.dayIndex,
          daysLeft: plan.daysLeft,
          expired: plan.expired,
          capTotal: plan.capTotal,
          usedPct: plan.capTotal > 0 ? round((usedAll / plan.capTotal) * 100, 1) : 0,
          projected: plan.dayIndex > 0 ? round((usedAll / plan.dayIndex) * plan.totalDays, 1) : 0,
          dailyCny: plan.dailyCny,
          priceCny: plan.priceCny,
        }
      : null,
    quotaHitAt: quotaHit,
    // 触顶信号有，但估算用量离上限还远 —— UI 只能说"存疑"，不能喊已触顶
    quotaHitSuspectAt: quotaSuspect,
    // 每分钟限流（429 / TPM）：跟本周剩多少 Credits 无关，单独一个态
    rateLimitedAt: rateLimited,
    quotaHitExpiresAt: hitFresh && rawHit !== null ? rawHit + hitTtl : null,
    capConfirmPct: CAP_CONFIRM_PCT,
    alert: {
      level: effectiveLevel,
      label: caliberMismatch ? '口径未对齐官方读数，百分比先别用'
        : (estimateOver ? '估算已超档位上限（未收到 429）' : (ALERT_LABELS[effectiveLevel] || '')),
      pct: round(pct, 1),
      warnPct: cfg.warnPct,
      estimateOver,
      caliberMismatch,
    },
    note: '估算口径：本地 token 账本 × 按量价×100 Credits；官方控制台另含隐藏消耗项，实际以阿里云为准',
    generatedAt: nowMs,
    error: hasData ? null : 'NO_DATA',
  }
}

/**
 * 告警去重：同一窗口内级别没有升级、且今天已经提示过，就不再冒泡。
 * state: {windowStart, level, dayKey} | null
 */
export function shouldAnnounce(state, level, windowStart, nowMs) {
  if (!level || level === 'ok') return false
  const rank = { warn: 1, high: 2, exhausted: 3 }
  const cur = rank[level] || 0
  if (cur <= 0) return false
  if (!state || typeof state !== 'object') return true
  if (state.windowStart !== windowStart) return true
  const prev = rank[state.level] || 0
  if (cur > prev) return true
  return state.dayKey !== localDayKey(isFinite(nowMs) ? nowMs : Date.now())
}

export function markAnnounced(state, level, windowStart, nowMs) {
  const rank = { warn: 1, high: 2, exhausted: 3 }
  const sameWindow = state && state.windowStart === windowStart
  const prev = sameWindow ? rank[state.level] || 0 : 0
  const cur = rank[level] || 0
  return {
    windowStart,
    level: cur >= prev ? level : state.level,
    dayKey: localDayKey(isFinite(nowMs) ? nowMs : Date.now()),
    at: isFinite(nowMs) ? nowMs : Date.now(),
  }
}
