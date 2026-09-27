// 纯逻辑单测：node test/tokenplan-usage.test.mjs
// 覆盖 Token Plan 估算口径、7 天窗口数学、账本合并、告警去重。
import assert from 'node:assert/strict'
import * as TP from '../lib/tokenplan-usage.js'

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok  ' + name)
  } catch (err) {
    console.log('  FAIL ' + name + ' -> ' + (err && err.message))
    process.exitCode = 1
  }
}

const DAY = TP.DAY_MS
const dayKey = (n) => TP.localDayKey(n)

t('priceForModel 与 token_plan_report.py RATES 对齐', () => {
  assert.deepEqual(TP.priceForModel('qwen3.8-flash'), { price: [0.8, 2.7, 0.1], known: true })
  assert.deepEqual(TP.priceForModel('QWEN3.8-MAX'), { price: [12, 36, 1.5], known: true })
  assert.deepEqual(TP.priceForModel('glm-5.2'), { price: [8, 28, 2], known: true })
  // 未知模型：退回 qwen3.8-flash 价目并标 known=false（宁可估高也不漏计）
  const fb = TP.priceForModel('nope-9')
  assert.equal(fb.known, false)
  assert.deepEqual(fb.price, TP.priceForModel('qwen3.8-flash').price)
})

t('estimateUsage：reasoning 并入输出、cacheRead+cacheWrite 并入缓存、Credits=¥×100', () => {
  const e = TP.estimateUsage('qwen3.8-flash', {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    reasoningTokens: 20_000,
    cacheReadTokens: 500_000,
    cacheWriteTokens: 10_000,
  })
  // 输入不含缓存部分：harness 的 inputTokens 已是非缓存输入
  const payg = (1e6 * 0.8 + 120_000 * 2.7 + 510_000 * 0.1) / 1e6
  assert.ok(Math.abs(e.payg - payg) < 1e-9, 'payg ' + e.payg + ' vs ' + payg)
  assert.ok(Math.abs(e.credits - payg * 100) < 1e-9)
  assert.equal(e.tokens, 1e6 + 120_000 + 510_000)
  assert.equal(e.calls, 1)
  assert.equal(e.known, true)
})

t('estimateUsage：未知模型计 0 但标记 known=false；校准系数生效', () => {
  const mystery = TP.estimateUsage('mystery', { inputTokens: 100, outputTokens: 10 })
  assert.equal(mystery.known, false)
  assert.ok(mystery.credits > 0, '未知模型按兜底价目估算而非 0')
  const k = TP.estimateUsage('qwen3.8-flash', { inputTokens: 1_000_000 }, 2)
  assert.ok(Math.abs(k.credits - 0.8 * 100 * 2) < 1e-6)
})

t('parseLedger 只取指定 provider，并把 calls 带出来', () => {
  const doc = {
    days: {
      '2026-09-05': {
        tokenplan: { 'qwen3.8-flash': { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, calls: 3 } },
        deepseek: { 'deepseek-v4-flash': { inputTokens: 9, outputTokens: 9, calls: 9 } },
      },
    },
  }
  const days = TP.parseLedger(doc, 'tokenplan')
  assert.deepEqual(Object.keys(days), ['2026-09-05'])
  assert.equal(days['2026-09-05'].calls, 3)
  assert.ok(days['2026-09-05'].models['qwen3.8-flash'].credits > 0)
})

t('mergeDays 逐日取 max，绝不相加（同一批调用不能计两次）', () => {
  const ledger = { '2026-09-05': { credits: 100, payg: 1, tokens: 1000, calls: 10, models: {}, unknown: {} } }
  const self = { '2026-09-05': { credits: 90, payg: 0.9, tokens: 900, calls: 9, models: {}, unknown: {} } }
  const m = TP.mergeDays(ledger, self)
  assert.equal(m.days['2026-09-05'].credits, 100)
  assert.equal(m.source, 'ledger+live')
})

t('resolveAnchor + currentWindow：锚点即第 1 天，7 天后翻窗口', () => {
  const anchor = Date.UTC(2026, 8, 5, 3, 0, 0)
  const w0 = TP.currentWindow(anchor, anchor)
  assert.equal(w0.dayIndex, 1)
  assert.equal(w0.index, 0)
  const w6 = TP.currentWindow(anchor, anchor + 6 * DAY + 1000)
  assert.equal(w6.dayIndex, 7)
  const w7 = TP.currentWindow(anchor, anchor + 7 * DAY)
  assert.equal(w7.dayIndex, 1)
  assert.equal(w7.index, 1)
  assert.equal(TP.resolveAnchor('bogus', [], anchor).anchorSource, 'now')
  assert.equal(TP.resolveAnchor('', [dayKey(anchor + 3 * DAY)], anchor + 5 * DAY).anchorSource, 'first-usage-day')
})

t('alertLevel 阈值分档', () => {
  assert.equal(TP.alertLevel(69.9, 70), 'ok')
  assert.equal(TP.alertLevel(70, 70), 'warn')
  assert.equal(TP.alertLevel(90, 70), 'high')
  assert.equal(TP.alertLevel(100, 70), 'exhausted')
})


t('summarize：空账本降级为 ok=false + NO_DATA，不抛异常', () => {
  const s = TP.summarize({ ledgerDays: {}, selfDays: {}, cfg: TP.normalizeConfig({}), nowMs: Date.now() })
  assert.equal(s.ok, false)
  assert.equal(s.error, 'NO_DATA')
  assert.equal(s.estimated, true)
  assert.equal(s.cap, 45000, '档位默认值现在抄自控制台订阅总览：Standard = 45,000 Credits / 月')
  assert.equal(s.periodDays, 30)
  assert.equal(s.used, 0)
  assert.equal(s.series.length, 7)
  assert.equal(s.series[0].spanDays, 5, '月周期分 7 格，一格 5 天')
})

t('summarize：窗口/百分比/ROI/按模型排名一次算全', () => {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0)
  const mk = (credits, models) => ({
    credits,
    payg: credits / 100,
    tokens: credits * 1000,
    calls: 5,
    models,
    unknown: {},
  })
  const days = {
    '2026-09-05': mk(300, { 'qwen3.8-flash': { credits: 200, tokens: 1, calls: 4 } }),
    '2026-09-04': mk(100, { 'qwen3.8-max': { credits: 100, tokens: 1, calls: 1 } }),
  }
  const s = TP.summarize({
    ledgerDays: {},
    selfDays: days,
    cfg: TP.normalizeConfig({ qwenCap: 10000, qwenPeriodDays: 7, qwenWindowAnchor: '2026-09-03' }),
    nowMs: now,
  })
  assert.equal(s.ok, true)
  assert.equal(s.anchorSource, 'config')
  assert.equal(s.dayIndex, 3)
  assert.equal(s.used, 400)
  assert.equal(s.remaining, 9600)
  assert.equal(s.pct, 4)
  assert.equal(s.byModel[0].model, 'qwen3.8-flash')
  assert.equal(s.byModel.length, 2)
  assert.ok(Math.abs(s.payg.roiPercent - (4 / 139) * 100) < 0.1, 'roi ' + s.payg.roiPercent)
  assert.equal(s.alert.level, 'ok')
  assert.equal(s.shouldAnnounce === undefined, true) // 由服务端补
})

t('shouldAnnounce：同窗口同级只报一次，升档或换窗可再报', () => {
  const ws = 1_000_000_000
  const now = ws + DAY
  let st = null
  assert.equal(TP.shouldAnnounce(st, 'warn', ws, now), true)
  st = TP.markAnnounced(st, 'warn', ws, now)
  assert.equal(TP.shouldAnnounce(st, 'warn', ws, now + 1000), false)
  assert.equal(TP.shouldAnnounce(st, 'high', ws, now + 1000), true)
  st = TP.markAnnounced(st, 'high', ws, now + 1000)
  assert.equal(TP.shouldAnnounce(st, 'high', ws + 7 * DAY, now + 7 * DAY), true)
  assert.equal(TP.shouldAnnounce(st, 'ok', ws + 7 * DAY, now), false)
})

t('normalizeConfig：越界与脏数据回落默认值', () => {
  const cfg = TP.normalizeConfig({ qwenCap: -5, qwenWarnPct: 900, qwenCalib: 'x', qwenTier: 'pro', qwenWindowAnchor: 123 })
  assert.equal(cfg.cap, 180000) // tier 生效（月度档位表：Pro 180,000/月）
  assert.equal(cfg.warnPct, 100) // 越界先 clamp，不静默回默认
  assert.equal(cfg.calib, 1)
  assert.equal(cfg.windowAnchor, '')
  assert.equal(TP.normalizeConfig({ qwenCap: 2500 }).cap, 2500)
})

t('fmtCreditsShort 单位收敛', () => {
  assert.equal(TP.fmtCreditsShort(999.6), '1000')
  assert.equal(TP.fmtCreditsShort(12345), '12k')
  assert.equal(TP.fmtCreditsShort(1_234_567), '1.23M')
  assert.equal(TP.fmtCreditsShort(0), '0')
})

// —— 触顶 / 限流 判定：本机 2026-09-07 那次误判的回归测试 ——
// 造一份 used/cap 可控的 summarize 输入
const mkDay = (credits) => ({
  credits,
  payg: credits / 100,
  tokens: credits * 1000,
  calls: 3,
  models: { 'qwen3.8-flash': { credits, tokens: credits * 1000, calls: 3 } },
  unknown: {},
})
function sumWith(usedCr, capCr, extra) {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  const key = TP.localDayKey(now)
  return TP.summarize(
    Object.assign(
      {
        ledgerDays: {},
        selfDays: { [key]: mkDay(usedCr) },
        cfg: TP.normalizeConfig({ qwenCap: capCr, qwenPeriodDays: 7, qwenWindowAnchor: key }),
        nowMs: now,
      },
      extra || {},
    ),
  )
}
// 一次真实 turn/end 的报文（每分钟 TPM 打满），逐字照抄
const TPM_429 = {
  message:
    '429: {"message":"Allocated quota exceeded, please increase your quota limit. ' +
    'For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code#token-limit",' +
    '"id":"c82db889-37e8-4c02-9064-4f0253385854","type":"insufficient_quota","code":"insufficient_quota"}',
  code: 'QUOTA',
}

t('classifyFailure：429 限流家族不算触顶，但带硬证据的周额度耗尽必须算（09-15 补）', () => {
  assert.equal(TP.classifyFailure(TPM_429), 'throttle')
  assert.equal(TP.classifyFailure({ message: '429 Too many requests, please slow down', code: 'RATE_LIMITED' }), 'throttle')
  assert.equal(TP.classifyFailure({ message: 'Allocated quota exceeded, please try later', code: 'Throttling.AllocationQuota', status: 429 }), 'throttle')
  // 09-15 补的两类：真·周额度耗尽那条也带 429，但它是 cap（退避重试无解，要换路由）；
  // 而免费额度「用完即停」是 403，早先被兜底判成 cap，其实该归 freeQuota。
  assert.equal(TP.classifyFailure({ message: 'Your token-plan 1-week quota has been exhausted. The quota will reset at 09-19 07:14:00 UTC.', code: 'QuotaExhausted', status: 429 }), 'cap')
  assert.equal(TP.classifyFailure({ message: '403 AllocationQuota.FreeTierOnly', code: 'AllocationQuota.FreeTierOnly', status: 403 }), 'freeQuota')
  // 免费额度与别的 provider 的余额问题都不该进套餐触顶
  assert.equal(TP.classifyFailure({ message: '403: Free quota exhausted. please add funds', code: 'AUTH', status: 403 }), 'freeQuota')
  assert.equal(TP.classifyFailure({ message: 'Insufficient Balance', code: 'QUOTA', status: 402 }), 'cap')
  assert.equal(TP.classifyFailure({ message: '本周套餐额度已用尽，请等待重置', code: 'QUOTA', status: 403 }), 'cap')
  assert.equal(TP.classifyFailure({ message: 'Connection error.', code: 'TRANSPORT' }), 'other')
  assert.equal(TP.classifyFailure({ message: 'no adapter registered for provider "pi-ai"', code: 'NO_ADAPTER' }), 'other')
  assert.equal(TP.classifyFailure(null), 'other')
})

t('summarize：新鲜触顶信号 + 估算只用了 66.5% → 存疑，不算已触顶', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  const s = sumWith(6651.5, 10000, { quotaHitAt: now - 60000 })
  assert.equal(s.pct, 66.5)
  assert.equal(s.quotaHitAt, null, '不该把剩 3348 Cr 显示成已触顶')
  assert.equal(s.quotaHitSuspectAt, now - 60000)
  assert.equal(s.alert.level, 'ok', '存疑不得伪造周额度告警：' + s.alert.level)
})

t('summarize：自估过百但没有 429 → 不许喊触顶，降到 high 并标出是估算', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  const s = sumWith(11000, 10000, { nowMs: now })
  assert.equal(s.pct, 110)
  assert.equal(s.alert.estimateOver, true, '这条要单独说得出来')
  assert.equal(s.alert.level, 'high', '没有硬证据就不配 exhausted：' + s.alert.level)
  assert.ok(s.alert.label.indexOf('未收到 429') >= 0, '标签要说清依据是什么：' + s.alert.label)
})

t('summarize：自估过百 + 新鲜 429 → 这才是触顶，级别与标签都要抬上去', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  const s = sumWith(11000, 10000, { nowMs: now, quotaHitAt: now - 60000 })
  assert.equal(s.quotaHitAt, now - 60000)
  assert.equal(s.alert.estimateOver, false)
  assert.equal(s.alert.level, 'exhausted')
  assert.equal(s.alert.label, '套餐额度已触顶')
})


t('summarize：新鲜触顶信号 + 估算确实接近上限 → 确认触顶并抬级别', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  const s = sumWith(9500, 10000, { quotaHitAt: now - 60000 })
  assert.equal(s.quotaHitAt, now - 60000)
  assert.equal(s.quotaHitSuspectAt, null)
  assert.notEqual(s.alert.level, 'ok', '真触顶至少要 warn')
})

t('summarize：过期的触顶/限流信号不再下发（阈值取模块常量）', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  const stale = sumWith(9500, 10000, {
    quotaHitAt: now - TP.QUOTA_HIT_TTL_MS - 1000,
    rateLimitedAt: now - TP.RATE_LIMIT_TTL_MS - 1000,
  })
  assert.equal(stale.quotaHitAt, null)
  assert.equal(stale.quotaHitSuspectAt, null)
  assert.equal(stale.rateLimitedAt, null)
  // 95% 本身仍要说事：级别由 pct 决定，不靠旧信号
  assert.notEqual(stale.alert.level, 'ok')
})

t('summarize：限流单独成态，既不抬级别也不盖住真实用量', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  const s = sumWith(6651.5, 10000, { rateLimitedAt: now - 60000 })
  assert.equal(s.rateLimitedAt, now - 60000)
  assert.equal(s.quotaHitAt, null)
  assert.equal(s.alert.level, 'ok')
  assert.equal(s.used, 6651.5)
  assert.equal(s.remaining, 3348.5)
  const expired = sumWith(6651.5, 10000, { rateLimitedAt: now - TP.RATE_LIMIT_TTL_MS - 1 })
  assert.equal(expired.rateLimitedAt, null)
  // 真触顶时以触顶为准，限流让位
  const both = sumWith(9900, 10000, { quotaHitAt: now - 60000, rateLimitedAt: now - 60000 })
  assert.ok(both.quotaHitAt)
  assert.equal(both.rateLimitedAt, null)
})

console.log('\n[套餐 30 天与烧钱节奏]')

t('planWindow：起点即今天 → 第 1/30 天、剩 30 天、整期预算按周上限折算', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  const p = TP.planWindow(TP.localDayKey(now), now, 10000, 139, 30)
  assert.equal(p.totalDays, 30)
  assert.equal(p.dayIndex, 1)
  assert.equal(p.daysLeft, 30)
  assert.equal(p.expired, false)
  assert.equal(p.capTotal, Math.round((10000 * 30) / 7))
  assert.equal(p.dailyCny, 4.63)
})

t('planWindow：最后一日 dayIndex=30 剩 1 天，越过 endMs 记 expired', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  const start = TP.localDayKey(now - 29 * DAY)
  const last = TP.planWindow(start, now, 10000, 139, 30)
  assert.equal(last.dayIndex, 30)
  assert.equal(last.daysLeft, 1)
  assert.equal(last.expired, false)
  const gone = TP.planWindow(start, now + 2 * DAY, 10000, 139, 30)
  assert.equal(gone.expired, true)
  assert.equal(gone.daysLeft, 0)
})

t('planWindow：起点为空/格式不对/在未来一律 null（宁可不显示也不编到期日）', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  assert.equal(TP.planWindow('', now, 10000, 139, 30), null)
  assert.equal(TP.planWindow('2026/9/7', now, 10000, 139, 30), null)
  assert.equal(TP.planWindow('明天', now, 10000, 139, 30), null)
  assert.equal(TP.planWindow(TP.localDayKey(now + 7 * DAY), now, 10000, 139, 30), null)
})

t('normalizeConfig：qwenPlanStart 只认 YYYY-MM-DD，planDays 缺省 30', () => {
  assert.equal(TP.normalizeConfig({ qwenPlanStart: '2026-09-05' }).planStart, '2026-09-05')
  assert.equal(TP.normalizeConfig({ qwenPlanStart: '2026-09-05' }).planDays, TP.PLAN_DAYS)
  assert.equal(TP.normalizeConfig({ qwenPlanStart: '2026-9-5' }).planStart, '')
  assert.equal(TP.normalizeConfig({ qwenPlanStart: 20260905 }).planStart, '')
  assert.equal(TP.normalizeConfig({ qwenPlanDays: 60 }).planDays, 60)
})

t('summarize：没配起点 plan 就是 null；配了才有到期与整期进度', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  const key = TP.localDayKey(now)
  const base = { ledgerDays: {}, selfDays: { [key]: mkDay(7000) }, nowMs: now }
  const noPlan = TP.summarize(Object.assign({}, base, { cfg: TP.normalizeConfig({ qwenCap: 10000, qwenWindowAnchor: key }) }))
  assert.equal(noPlan.plan, null)
  const cfg = TP.normalizeConfig({ qwenCap: 10000, qwenWindowAnchor: key, qwenPlanStart: TP.localDayKey(now - 11 * DAY) })
  const withPlan = TP.summarize(Object.assign({}, base, { cfg }))
  assert.equal(withPlan.plan.dayIndex, 12)
  assert.equal(withPlan.plan.daysLeft, 19)
  assert.equal(withPlan.plan.endAt, withPlan.plan.startAt + 30 * DAY)
  assert.equal(withPlan.plan.usedPct, Math.round((7000 / withPlan.plan.capTotal) * 1000) / 10)
  // 整期折算 = 累计 ÷ 套餐已过天数 × 30：第 12 天烧了 7000 → 整期约 17500
  assert.equal(withPlan.plan.projected, Math.round((7000 / 12) * 30 * 10) / 10)
})

t('summarize：pace 给出日均、周期末预测、还能撑几天', () => {
  const s = sumWith(7000, 10000)
  assert.equal(s.pace.perDay, 7000) // 窗口第 1 天 → 日均就是当天用量
  assert.equal(s.pace.projected, 49000)
  assert.equal(s.pace.daysToCap, 0.4) // 剩 3000 ÷ 7000
  assert.equal(s.pace.daysLeftToReset, 7)
})

t('summarize：本周没用量时 pace 不除零、也不吹"还能撑无数天"', () => {
  const s = sumWith(0, 10000)
  assert.equal(s.pace.perDay, 0)
  assert.equal(s.pace.daysToCap, null)
})


// —— 重置卡相关（放在文件末尾：mkDay 等 helper 在前面才已初始化）
// —— 额度重置卡：窗口起点精确到时刻 + 首日一次性扣减（本地账本只到「天」，拆不开只能外部告诉它）
t('parseAnchorMs：纯日期串不当精确锚点用，日期时间串与毫秒数才认', () => {
  assert.equal(TP.parseAnchorMs('2026-09-15'), null)
  assert.equal(TP.parseAnchorMs(''), null)
  assert.equal(TP.parseAnchorMs(null), null)
  assert.equal(TP.parseAnchorMs('2026-09-15T18:05'), new Date('2026-09-15T18:05').getTime())
  assert.equal(TP.parseAnchorMs('2026-09-15 18:05'), new Date('2026-09-15T18:05').getTime())
  assert.equal(TP.parseAnchorMs(1789468000000), 1789468000000)
  assert.equal(TP.parseAnchorMs('1789468000000'), 1789468000000)
  assert.equal(TP.parseAnchorMs('not-a-date'), null)
})

t('summarize：没给精确锚点时绝不退到 epoch（isFinite(null)===true 那条陷阱）', () => {
  const cfg = TP.normalizeConfig({ qwenCap: 10000, qwenWindowAnchor: '2026-09-05' })
  assert.equal(cfg.windowAnchorMs, null)
  const s = TP.summarize({ ledgerDays: {}, selfDays: { '2026-09-15': mkDay(100) }, cfg, nowMs: new Date('2026-09-15T12:00:00').getTime() })
  assert.equal(s.anchorSource, 'config')
  assert.notEqual(s.windowStart, 0)
})

t('summarize：重置卡改窗口起点，并把首日「重置前已计」那部分扣掉', () => {
  const nowMs = new Date('2026-09-15T20:00:00').getTime()
  const days = { '2026-09-12': mkDay(4000), '2026-09-13': mkDay(3000), '2026-09-14': mkDay(2000), '2026-09-15': mkDay(1250) }
  const plain = TP.summarize({
    ledgerDays: days, selfDays: {}, cfg: TP.normalizeConfig({ qwenCap: 10000, qwenPeriodDays: 7 }), nowMs,
  })
  assert.ok(plain.used > 9000, '不设锚点时旧几天的量仍算在本窗口：' + plain.used)
  const reset = TP.summarize({
    ledgerDays: days,
    selfDays: {},
    cfg: TP.normalizeConfig({ qwenCap: 10000, qwenPeriodDays: 7, qwenWindowAnchorExact: '2026-09-15T18:05', qwenAnchorSubtract: 900 }),
    nowMs,
  })
  assert.equal(reset.anchorSource, 'config-exact')
  assert.equal(reset.used, 350)
  assert.equal(reset.pct, 3.5)
  assert.equal(reset.dayIndex, 1)
  assert.ok(reset.resetAt > nowMs && reset.resetAt - nowMs < 7 * 86400000, '下次重置在 7 天内')
  // 柱子首日也必须是扣减后的值，否则「合计==已用」那条同源不变量会破
  const bars = reset.series.filter((e) => !e.future).reduce((x, e) => x + e.credits, 0)
  assert.equal(bars, reset.used)
  assert.equal(reset.anchorSubtract, 900)
})

t('summarize：扣减只作用在窗口首日，跨窗口自动失效', () => {
  const days = { '2026-09-15': mkDay(1250), '2026-09-22': mkDay(500) }
  const s = TP.summarize({
    ledgerDays: days, selfDays: {}, nowMs: new Date('2026-09-23T10:00:00').getTime(),
    cfg: TP.normalizeConfig({ qwenCap: 10000, qwenPeriodDays: 7, qwenWindowAnchorExact: '2026-09-15T18:05', qwenAnchorSubtract: 900 }),
  })
  assert.equal(s.windowStartKey, '2026-09-22')
  assert.equal(s.used, 500, '扣减跟着锚点那天走，换窗口后不该再扣')
  // 换窗口后这条扣减不该再生效（23 日 10:00 距锚点那天的下一个窗口起点还不满一天 -> 新窗口第 1 天）
  assert.equal(s.dayIndex, 1)
})



t('currentWindow：官方给的重置时刻优先，窗口长度跟着套餐走（月额度不再是 7 天）', () => {
  const anchor = new Date('2026-09-05T15:05:52').getTime()
  const resetAt = new Date('2026-10-06T00:00:00').getTime()
  const now = new Date('2026-09-23T16:00:00').getTime()
  const win = TP.currentWindow(anchor, now, 30, resetAt)
  assert.equal(win.endMs, resetAt, '重置点用官方那个 10-06 00:00，不是锚点 + n×30 天')
  assert.ok(win.startMs <= now && win.startMs > now - 31 * TP.DAY_MS, '窗口起点落在本周期内')
  assert.equal(win.periodDays, 30)
  assert.ok(win.dayIndex >= 1 && win.dayIndex <= 30, 'dayIndex 在 1..30：' + win.dayIndex)
  const old = TP.currentWindow(anchor, now, 7, null)
  assert.equal(old.endMs - old.startMs, 7 * TP.DAY_MS, '不给重置时刻时老口径照旧')
})


t('对过表：官方读数与自估差 8 倍 → 不许拿这个百分比去告警，级别降到 warn 并说「口径未对齐」', () => {
  const now = new Date(2026, 8, 23, 16, 10, 0).getTime()
  const key = TP.localDayKey(now)
  const plain = TP.summarize({ ledgerDays: { [key]: mkDay(40934) }, selfDays: {}, cfg: TP.normalizeConfig({ qwenCap: 45000, qwenPeriodDays: 30 }), nowMs: now })
  assert.ok(plain.pct > 90, '样本本身要让老逻辑判成 high：' + plain.pct)
  assert.equal(plain.alert.caliberMismatch, false, '没抄官方读数时无从比对')
  const s = { pct: plain.pct, alert: plain.alert }
  const cfg = TP.normalizeConfig({ qwenCap: 45000, qwenPeriodDays: 30, qwenOfficialPct: 10.97, qwenOfficialAt: '2026-09-23 16:10' })
  assert.ok(cfg.officialPct === 10.97 && cfg.officialCap === 0 && isFinite(cfg.officialAtMs))
  const s2 = TP.summarize({ ledgerDays: { [key]: mkDay(40934) }, selfDays: {}, cfg, nowMs: now })
  assert.equal(s2.official.pct, 10.97)
  assert.equal(s2.official.credits, Math.round(45000 * 0.1097 * 10) / 10)
  assert.ok(s2.official.ratio > 8 && s2.official.ratio < 9.5, '比值要落在 8 倍上下：' + s2.official.ratio)
  assert.equal(s2.official.mismatch, true)
  assert.equal(s2.alert.level, 'warn', '口径没对齐就不配喊即将用尽：' + s2.alert.level)
  assert.ok(s2.alert.label.indexOf('口径未对齐') >= 0, '标签要说人话：' + s2.alert.label)
})

t('对过表但差得不多（0.67~1.5 倍）→ 不触发口径告警，级别照旧', () => {
  const now = new Date(2026, 8, 23, 12, 0, 0).getTime()
  const cfg = TP.normalizeConfig({ qwenCap: 10000, qwenPeriodDays: 7, qwenOfficialPct: 60 })
  const s = TP.summarize({ ledgerDays: { [TP.localDayKey(now)]: mkDay(7300) }, selfDays: {}, cfg, nowMs: now })
  assert.equal(s.official.mismatch, false, '比值 1.05 属于对齐')
  assert.equal(s.alert.caliberMismatch, false)
  assert.equal(s.alert.level, 'warn', '7300/10000 且与官方一致 → 该报 warn：' + s.alert.level)
  // 同一份对齐关系下，真到 high 的用量仍然该报 high —— 比对不许把告警一并废掉
  const hot = TP.normalizeConfig({ qwenCap: 10000, qwenPeriodDays: 7, qwenOfficialPct: 93 })
  const s2 = TP.summarize({ ledgerDays: { [TP.localDayKey(now)]: mkDay(9300) }, selfDays: {}, cfg: hot, nowMs: now })
  assert.equal(s2.official.mismatch, false)
  assert.equal(s2.alert.level, 'high', '对齐时告警级别不许降级：' + s2.alert.level)
})

t('isTokenPlanCall：provider 优先，模型名兜底，百炼同名模型不串账', () => {
  const cfg = TP.normalizeConfig({})
  assert.equal(TP.isTokenPlanCall(cfg, 'tokenplan', 'qwen3.8-flash'), true)
  assert.equal(TP.isTokenPlanCall(cfg, 'bailian', 'qwen3.8-flash'), false)
  assert.equal(TP.isTokenPlanCall(cfg, 'tokenplan', 'glm-5.2'), true) // 套餐里不止 qwen
  assert.equal(TP.isTokenPlanCall(cfg, 'deepseek', 'deepseek-chat'), false)
  assert.equal(TP.isTokenPlanCall(cfg, '', 'qwen3.6-plus'), true)
  assert.equal(TP.isTokenPlanCall({ enabled: false }, 'tokenplan', 'qwen3.8-flash'), false)
})

// —— 上限与校准的出处（2026-09-23：档位表过期把页面的 4.8% 显示成 94.3%，这两条就是让它无处藏）——
t('normalizeConfig：qwenCap 没填 → capSource 说是内置档位表哪一档；填了 → 说 config', () => {
  assert.equal(TP.normalizeConfig({}).capSource, 'tier-table:default')
  assert.equal(TP.normalizeConfig({}).cap, 45000, '默认抄月度档位表')
  assert.equal(TP.normalizeConfig({}).periodDays, 30)
  const pro = TP.normalizeConfig({ qwenTier: 'pro' })
  assert.equal(pro.cap, 180000)
  assert.equal(TP.normalizeConfig({ qwenTier: 'essential' }).cap, 25500)
  assert.equal(pro.capSource, 'tier-table:pro')
  const c = TP.normalizeConfig({ qwenCap: 45000, qwenCalib: 0.2342, qwenCalibNote: '对表 09-23' })
  assert.equal(c.cap, 45000)
  assert.equal(c.capSource, 'config')
  assert.equal(c.calibSource, 'config')
  assert.equal(c.calibNote, '对表 09-23')
  assert.equal(TP.normalizeConfig({ qwenCalib: 0 }).calibSource, 'unset')
})

t('summarize：capSource 与 calibNote 一路带到前端读数（气泡明细靠它说清上限是哪来的）', () => {
  const nowMs = Date.now()
  const key = TP.localDayKey(nowMs)
  const base = { ledgerDays: { [key]: mkDay(4000) }, selfDays: {}, nowMs }
  const a = TP.summarize(Object.assign({}, base, { cfg: TP.normalizeConfig({}) }))
  assert.equal(a.capSource, 'tier-table:default')
  assert.equal(a.calibSource, 'unset')
  const b = TP.summarize(Object.assign({}, base, { cfg: TP.normalizeConfig({ qwenCap: 45000, qwenCalibNote: '控制台 2026-09-23 14:30' }) }))
  assert.equal(b.cap, 45000)
  assert.equal(b.capSource, 'config')
  assert.equal(b.calibNote, '控制台 2026-09-23 14:30')
})

t('两点法：Δ官方 ÷ Δ本地 = 系数（只比增量，与窗口起点无关）', () => {
  const dA = TP.localDayKey(Date.parse('2026-09-20T10:00:00'))
  const dB = TP.localDayKey(Date.parse('2026-09-21T10:00:00'))
  const day = (credits) => ({ credits, payg: credits / 100, tokens: 0, calls: 1, models: {}, unknown: {} })
  const days = { [dA]: day(1000), [dB]: day(3000) }
  const fit = TP.fitOfficialRatio(
    [{ pct: 10, atMs: Date.parse('2026-09-20T00:00:00') }, { pct: 20, atMs: Date.parse('2026-09-22T00:00:00') }],
    days,
    10000,
    {},
  )
  // Δ官方 = 10% × 10000 = 1000；Δ本地 = 09-20 全天 1000 + 09-21 全天 3000 = 4000
  assert.equal(fit.ok, true)
  assert.equal(fit.reason, 'delta')
  assert.equal(fit.officialCredits, 1000)
  assert.equal(fit.localCredits, 4000)
  assert.equal(fit.k, 0.25)
})

t('两点法：Δ 小于 0.5% 视为控制台量化噪声，不给系数', () => {
  const fit = TP.fitOfficialRatio(
    [{ pct: 10, atMs: Date.parse('2026-09-20T00:00:00') }, { pct: 10.2, atMs: Date.parse('2026-09-21T00:00:00') }],
    {},
    45000,
    {},
  )
  assert.equal(fit.ok, false)
  assert.equal(fit.reason, 'quantized')
})

t('两点法：线段里跨了 429 触顶 → 标删失（触顶后的本地量不换官方量）', () => {
  const dA = TP.localDayKey(Date.parse('2026-09-20T00:00:00'))
  const day = (credits) => ({ credits, payg: credits / 100, tokens: 0, calls: 1, models: {}, unknown: {} })
  const fit = TP.fitOfficialRatio(
    [{ pct: 10, atMs: Date.parse('2026-09-20T00:00:00') }, { pct: 60, atMs: Date.parse('2026-09-21T00:00:00') }],
    { [dA]: day(5000) },
    45000,
    { quotaHitAt: Date.parse('2026-09-20T12:00:00') },
  )
  assert.equal(fit.ok, false)
  assert.equal(fit.censored, true)
  assert.equal(fit.reason, 'censored-by-quota-hit')
  assert.equal(fit.k, 4.5) // 22500 / 5000，值算出来但不可用
})

t('normalizeOfficialPoints：列表优先、非法项丢掉、空列表回落单点', () => {
  const cfg = TP.normalizeConfig({
    qwenOfficialPoints: [
      { pct: 10.97, at: '2026-09-23 16:10' },
      { pct: 'x', at: '2026-09-24 00:00' },
      { pct: 100, at: '2026-09-27 22:24' },
    ],
    qwenOfficialPct: 100,
    qwenOfficialAt: '2026-09-27 22:24',
  })
  assert.equal(cfg.officialPoints.length, 2)
  assert.equal(cfg.officialPoints[0].pct, 10.97)
  assert.equal(cfg.officialPoints[1].pct, 100)
  assert.equal(TP.normalizeConfig({ qwenOfficialPct: 42, qwenOfficialAt: '2026-09-27 22:24' }).officialPoints.length, 1)
  assert.equal(TP.normalizeConfig({ qwenOfficialPct: 42 }).officialPoints.length, 0)
})

t('summarize：两次官方读数进 payload 的 implied，单点则没有', () => {
  const nowMs = Date.parse('2026-09-26T12:00:00')
  const d1 = TP.localDayKey(Date.parse('2026-09-24T00:00:00'))
  const d2 = TP.localDayKey(Date.parse('2026-09-25T00:00:00'))
  const day = (credits) => ({ credits, payg: credits / 100, tokens: 0, calls: 1, models: {}, unknown: {} })
  const base = {
    ledgerDays: { [d1]: day(2000), [d2]: day(2000) },
    selfDays: {},
    nowMs,
    cfg: TP.normalizeConfig({
      qwenCap: 45000,
      qwenWindowAnchor: '2026-09-20',
      qwenResetAt: '2026-09-30 00:00',
      qwenOfficialPoints: [{ pct: 10, at: '2026-09-24 00:00' }, { pct: 20, at: '2026-09-26 00:00' }],
    }),
  }
  const out = TP.summarize(base)
  assert.equal(out.officialPoints, 2)
  assert.ok(out.implied, 'implied 应出现在 payload 里')
  // Δ官方 = 10% × 45000 = 4500；Δ本地 = 09-24 + 09-25 = 4000 → k = 1.125
  assert.equal(out.implied.k, 1.125)
  const single = TP.summarize(Object.assign({}, base, {
    cfg: TP.normalizeConfig({ qwenCap: 45000, qwenWindowAnchor: '2026-09-20', qwenResetAt: '2026-09-30 00:00', qwenOfficialPct: 20, qwenOfficialAt: '2026-09-26 00:00' }),
  }))
  assert.equal(single.officialPoints, 1)
  assert.equal(single.implied, null)
})

t('parseLedger：calib 一路带进账本路径（与自估路径同一个系数口径）', () => {
  const doc = { version: 1, days: { '2026-09-20': { tokenplan: { 'qwen3.8-flash': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 } } } } }
  const full = TP.parseLedger(doc, 'tokenplan')
  const half = TP.parseLedger(doc, 'tokenplan', 0.5)
  assert.equal(TP.round(full['2026-09-20'].credits, 3), 80) // 1e6 × 0.8 元/M × 100 = 80 Cr
  assert.equal(TP.round(half['2026-09-20'].credits, 3), 40)
})

t('normalizeConfig：夜间折扣缺省不动（1），填 0.4 才生效；模型表有缺省', () => {
  assert.equal(TP.normalizeConfig({}).nightDiscount, 1)
  assert.equal(TP.normalizeConfig({ qwenNightDiscount: 0.4 }).nightDiscount, 0.4)
  assert.equal(TP.normalizeConfig({ qwenNightDiscount: 1 }).nightDiscount, 1)
  assert.deepEqual(TP.normalizeConfig({}).nightModels, ['qwen3.8-max', 'qwen3.8-flash'])
  assert.deepEqual(TP.normalizeConfig({ qwenNightModels: ['QWEN3.8-MAX'] }).nightModels, ['qwen3.8-max'])
})

t('offPeakFactor：夜间 4 折只打给列出的模型，且只在 22:00–08:00（北京）', () => {
  const cfg = TP.normalizeConfig({ qwenNightDiscount: 0.4 })
  const at = (s) => Date.parse(s) // 本机时区即北京
  assert.equal(TP.offPeakFactor('qwen3.8-flash', at('2026-09-27T23:30:00'), cfg), 0.4)
  assert.equal(TP.offPeakFactor('qwen3.8-flash', at('2026-09-27T07:00:00'), cfg), 0.4)
  assert.equal(TP.offPeakFactor('qwen3.8-flash', at('2026-09-27T12:00:00'), cfg), 1)
  assert.equal(TP.offPeakFactor('glm-5.2', at('2026-09-27T23:30:00'), cfg), 1)
  assert.equal(TP.offPeakFactor('qwen3.8-flash', at('2026-09-27T23:30:00'), TP.normalizeConfig({})), 1)
  assert.equal(TP.offPeakFactor('qwen3.8-flash', at('2026-09-27T23:30:00'), cfg, undefined), 0.4)
})

console.log('\n' + passed + ' passed' + (process.exitCode ? ' (有失败)' : ''))
