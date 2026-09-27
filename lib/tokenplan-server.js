// 阿里 Token Plan（订阅套餐）周额度：独立成模块，index.js 只负责接线
// （import + API_TEMPLATES 一条模板 + apply() 里一次 installTokenPlan）。
// 上游挂件改版时这三处好挑，用量口径与信号判定全在本文件与 tokenplan-usage.js 里。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as TP from './tokenplan-usage.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
// 配置自家一份文件：挂件的 .dshw-size.json 由上游整份重写（白名单外键一律丢），
// 0.2.x 时代存在 size 文件里的 qwen* 键必须搬家，否则用户改一次设置就把套餐配置弄丢
const CFG_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-tokenplan.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-tokenplan.json'),
]
const SIZE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-size.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-size.json'),
]
const LEDGER_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-qwen.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-qwen.json'),
]
const USAGE_LEDGER_CANDIDATES = [
  path.join(DSH_HOME, 'dsh-usage', 'usage-ledger.json'),
  path.join(DSH_HOME, 'profiles', 'web', 'dsh-usage', 'usage-ledger.json'),
]
const PLAN_STATE_CANDIDATES = [
  path.join(os.homedir(), 'token-plan-tools', 'state', 'state.json'),
]
const SUMMARY_TTL_MS = 30000
const CFG_KEYS = [
  'qwenEnabled', 'qwenCap', 'qwenWarnPct', 'qwenCalib', 'qwenTier',
  'qwenWindowAnchor',
  'qwenWindowAnchorExact', 'qwenAnchorSubtract', 'qwenAnchorSubtractNote', 'qwenProvider', 'qwenModels',
  'qwenPlanStart', 'qwenPlanDays', 'qwenPlanPriceCny',
]

function readJson(p) {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    return null
  }
}
function firstJson(cands) {
  for (const p of cands) {
    const parsed = readJson(p)
    if (parsed) return parsed
  }
  return null
}
function writeJson(cands, obj) {
  const body = JSON.stringify(obj)
  for (const p of cands) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body, 'utf8')
      return true
    } catch (err) {}
  }
  return false
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// 上游把 plan.level 当自由文本尾巴拼在「已用 x% · y天后重置」后面，
// 所以这里放套餐独有的读数：剩余 Credits、周期第几天、套餐第几天
function planLevelText(p) {
  const left = Number(p.remaining)
  const bits = [left > 0 ? TP.fmtCreditsShort(left) + ' Cr' : '已超 ' + TP.fmtCreditsShort(-left) + ' Cr']
  if (isFinite(Number(p.dayIndex))) bits.push('周第 ' + p.dayIndex + '/7')
  if (p.plan) bits.push(p.plan.expired ? '套餐已到期' : '套餐第 ' + p.plan.dayIndex + '/' + p.plan.totalDays)
  return bits.join(' · ')
}

// 第一次跑（新装/升级）：从旧 size 文件继承 qwen* 配置，再从每日报告的 state 拿套餐起点
function seedConfig() {
  const size = firstJson(SIZE_CANDIDATES) || {}
  const out = { version: 1 }
  for (const k of CFG_KEYS) if (size[k] !== undefined && size[k] !== null) out[k] = size[k]
  if (!DATE_RE.test(String(out.qwenPlanStart || ''))) {
    const st = firstJson(PLAN_STATE_CANDIDATES)
    if (st && typeof st.subscribed === 'string' && DATE_RE.test(st.subscribed)) out.qwenPlanStart = st.subscribed
  }
  return out
}

export function installTokenPlan(ctx, deps) {

  let cfgRaw = null
  let cfgAt = 0
  let ledger = null
  let ledgerDirty = false
  let flushTimer = null
  let summaryCache = null
  const sessionRoute = new Map() // sessionId -> {provider, model}（区分 tokenplan 与百炼按量上的同名模型）
  const seen = new Set() // 已入账的 sessionId:turn:step，防重启回放重复计

  function config() {
    const now = Date.now()
    if (cfgRaw && now - cfgAt < 5000) return cfgRaw
    let own = firstJson(CFG_CANDIDATES)
    if (!own || typeof own !== 'object') {
      own = seedConfig()
      writeJson(CFG_CANDIDATES, own)
    }
    cfgRaw = own
    cfgAt = now
    return cfgRaw
  }
  function cfgNormalized() {
    return TP.normalizeConfig(config())
  }
  function invalidate() {
    cfgAt = 0
    summaryCache = null
  }

  function readLedger() {
    if (ledger) return ledger
    let led = null
    for (const p of LEDGER_CANDIDATES) {
      const parsed = readJson(p)
      if (parsed && parsed.days && typeof parsed.days === 'object') {
        led = parsed
        break
      }
    }
    if (!led) led = { version: 1, days: {} }
    if (typeof led.days !== 'object' || led.days === null) led.days = {}
    // 脏标记升级：0.2.11 之前把 429 限流也记成触顶，没带 kind 的旧标记一律当未知
    if (led.quotaHitAt && !led.quotaHitKind) {
      led.quotaHitAt = null
      led.quotaHitCode = null
      markDirty()
    }
    ledger = led
    return led
  }
  function markDirty() {
    ledgerDirty = true
    summaryCache = null
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        flush()
      }, 2000)
      if (flushTimer.unref) flushTimer.unref()
    }
  }
  function flush() {
    if (!ledgerDirty || !ledger) return
    if (writeJson(LEDGER_CANDIDATES, ledger)) ledgerDirty = false
  }

  function accumulate(model, est) {
    if (!est || !(est.credits > 0)) return
    const led = readLedger()
    const key = TP.localDayKey(Date.now())
    const day = led.days[key] || { credits: 0, payg: 0, tokens: 0, calls: 0, models: {}, unknown: {} }
    day.credits += est.credits
    day.payg += est.payg
    day.tokens += est.tokens
    day.calls += est.calls
    const slot = day.models[model] || { credits: 0, tokens: 0, calls: 0 }
    slot.credits += est.credits
    slot.tokens += est.tokens
    slot.calls += est.calls
    day.models[model] = slot
    if (!est.known) day.unknown[model] = true
    led.days[key] = day
    const keys = Object.keys(led.days).sort()
    while (keys.length > 40) delete led.days[keys.shift()]
    markDirty()
  }

  // 失败信号分三态：429/TPM 限流 ≠ 周额度触顶；免费额度耗尽与套餐无关
  function noteFailure(sessionId, reason) {
    try {
      const cfg = cfgNormalized()
      const route = sessionRoute.get(sessionId)
      if (!route || route.provider !== cfg.provider) return
      const err = reason && reason.error
      if (!err || typeof err !== 'object') return
      const kind = TP.classifyFailure(err)
      if (kind !== 'cap' && kind !== 'throttle') return
      const led = readLedger()
      const stamp = String(err.code || err.status || '').slice(0, 40)
      const now = Date.now()
      if (kind === 'throttle') {
        led.rateLimitedAt = now
        led.rateLimitCode = stamp
      } else {
        led.quotaHitAt = now
        led.quotaHitCode = stamp
        led.quotaHitKind = 'cap'
        led.quotaHitPct = Number(summarize().pct) || 0
      }
      markDirty()
    } catch (err) {}
  }

  function onEvent(session, event) {
    try {
      const sessionId = session && session.id ? session.id : 'default'
      const type = event && event.type
      const d = event && event.data
      if (!d || typeof d !== 'object') return
      if (type === 'request/context' || type === 'model/selection') {
        if (typeof d.provider === 'string' || typeof d.model === 'string') {
          sessionRoute.set(sessionId, { provider: String(d.provider || ''), model: String(d.model || '') })
        }
        return
      }
      if (type === 'turn/end') {
        if (d.reason && d.reason.kind === 'error') noteFailure(sessionId, d.reason)
        return
      }
      if (type !== 'assistant/message') return
      const turn = Number(d.turn)
      const usage = d.usage
      if (!usage || typeof usage !== 'object' || !isFinite(turn)) return
      const step = Number(d.step)
      const route = sessionRoute.get(sessionId)
      const messageModel = d.message && d.message.source ? d.message.source.model : ''
      const model = messageModel || (route ? route.model : '')
      const provider = route ? route.provider : ''
      const cfg = cfgNormalized()
      if (!cfg.enabled || !TP.isTokenPlanCall(cfg, provider, model)) return
      if (!isFinite(step)) return
      const key = sessionId + ':' + turn + ':' + step
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 20000) seen.clear()
      accumulate(model, TP.estimateUsage(model, usage, cfg.calib))
    } catch (err) {
      if (process.env.WHALE_DEBUG) console.error('[whale] tokenplan event failed:', err && err.stack)
    }
  }

  function usageLedgerDays(provider) {
    for (const p of USAGE_LEDGER_CANDIDATES) {
      const parsed = readJson(p)
      if (parsed && parsed.days && typeof parsed.days === 'object') return TP.parseLedger(parsed, provider)
    }
    return {}
  }

  function summarize(force) {
    const now = Date.now()
    if (!force && summaryCache && now - summaryCache.at < SUMMARY_TTL_MS) return summaryCache.payload
    const led = readLedger()
    const cfg = cfgNormalized()
    let stale = false
    if (led.quotaHitAt && now - led.quotaHitAt > TP.QUOTA_HIT_TTL_MS) {
      led.quotaHitAt = null
      led.quotaHitCode = null
      led.quotaHitKind = null
      stale = true
    }
    if (led.rateLimitedAt && now - led.rateLimitedAt > TP.RATE_LIMIT_TTL_MS) {
      led.rateLimitedAt = null
      led.rateLimitCode = null
      stale = true
    }
    if (stale) markDirty()
    let anchor = cfg.windowAnchor
    if (!anchor) {
      const st = firstJson(PLAN_STATE_CANDIDATES)
      if (st && typeof st.subscribed === 'string' && DATE_RE.test(st.subscribed)) anchor = st.subscribed
    }
    const ledgerDays = usageLedgerDays(cfg.provider)
    const payload = TP.summarize({
      ledgerDays,
      selfDays: led.days,
      cfg: Object.assign({}, cfg, { windowAnchor: anchor }),
      nowMs: now,
      quotaHitAt: led.quotaHitAt,
      rateLimitedAt: led.rateLimitedAt,
    })
    payload.ledgerSource = Object.keys(ledgerDays).length ? 'dsh-usage' : 'none'
    payload.quotaHitCode = String(led.quotaHitCode || '')
    payload.rateLimitCode = String(led.rateLimitCode || '')
    summaryCache = { at: now, payload }
    return payload
  }

  function withAnnounce() {
    const base = summarize()
    const led = readLedger()
    const now = Date.now()
    const announce = TP.shouldAnnounce(led.alert, base.alert.level, base.windowStart, now)
    const payload = Object.assign({}, base, { alert: Object.assign({}, base.alert, { shouldAnnounce: announce }) })
    if (announce) {
      led.alert = TP.markAnnounced(led.alert, base.alert.level, base.windowStart, now)
      markDirty()
    }
    return payload
  }

  function json(res, code, obj) {
    res.writeHead(code, JSON_HEADERS)
    res.end(JSON.stringify(obj))
  }
  async function readBody(req) {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) break
    }
    return body
  }
  const disposers = []
  disposers.push(ctx.on('session/event', (session, event) => onEvent(session, event)))
  disposers.push(ctx.on('session/disposed', (session) => {
    if (session && session.id) sessionRoute.delete(session.id)
  }))

  // 上游 v0.3.0 把所有自定义路由套进 connection 的信任栅栏（无浏览器 cookie 一律 401），
  // 所以这两条**故意不套** registerRoute：它们只出本地估算的用量数字，不含密钥、不含余额，
  // 与 0.2.x 时代的 /dsh-whale/qwen.json 同口径；脚本侧（scripts/check-tokenplan.mjs）
  // 也靠这两条免鉴权路由验收。配置改文件 ~/.dsh/.dshw-tokenplan.json（5 秒内自动生效），
  // 不提供写路由 —— 写面一律留在栅栏后面。
  const PUBLIC = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-whale/tokenplan.json',
    handler: async (req, res) => {
      res.writeHead(200, PUBLIC)
      try {
        res.end(JSON.stringify(Object.assign({ ok: true }, withAnnounce(), { chain: await chainStatus() })))
      } catch (err) {
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
    },
  }))

  // 与上游「订阅额度」同形的读数（也是本地那条短路取的数据）；留着是给脚本验收用的镜像
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-whale/tokenplan-quota.json',
    handler: async (req, res) => {
      res.writeHead(200, PUBLIC)
      try { res.end(JSON.stringify(await planSnapshot())) } catch (err) {
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
    },
  }))

  // 接线自检：模板在不在、短路通不通、凭据解析得到吗（只回布尔与文案，不回密钥）
  async function chainStatus() {
    const tpl = (deps && deps.templates && deps.templates.tokenplan) || null
    let hasKey = null
    try {
      const cred = await ctx.credentials.resolve((tpl && tpl.keyRef) || 'TOKENPLAN_API_KEY')
      hasKey = !!(cred && cred.value)
    } catch (err) { hasKey = false }
    return {
      templateMounted: !!(tpl && tpl.quota && (tpl.quota.source === 'estimate' || tpl.quota.local)),
      templateName: tpl ? String(tpl.name || '') : '',
      hasKey,
    }
  }

  // 上游 plan 对象同形：{ ok, usedPct, remainPct, resetAt, level }，多余字段它不读
  async function planSnapshot() {
    const p = summarize()
    if (!p || !isFinite(Number(p.pct))) return { ok: false, error: 'Token Plan 用量暂不可用', source: 'estimate' }
    const usedPct = Math.max(0, Math.min(100, Math.round(Number(p.pct) * 10) / 10))
    return {
      ok: true,
      usedPct,
      // 出处是协议字段而不是注释：读的人不必翻代码就知道这数是接口读的还是本地折的。
      // reliability 只说它靠什么撑住，不给数值 —— 数值阈值归仓库定（见 issue #170）；
      // 下面两个原始出处字段一并带出，谁都能自己复核这个标签。
      source: 'estimate',
      reliability: p.calibSource === 'config' ? 'calibrated'
        : String(p.capSource || '').indexOf('tier-table:default') === 0 ? 'tier-table-default'
        : String(p.capSource || '').indexOf('tier-table:') === 0 ? 'tier-table'
        : String(p.capSource || '') === 'config' ? 'user-cap' : 'unknown',
      capSource: p.capSource,
      calibSource: p.calibSource,
      remainPct: Math.round((100 - usedPct) * 10) / 10,
      resetAt: p.resetAt,
      level: planLevelText(p),
      estimated: true,
      cap: p.cap,
      used: p.used,
      remaining: p.remaining,
      note: p.note,
    }
  }

  // 退出前补一次盘，别把最后 2 秒内的账丢掉
  ctx.on('exit', () => {
    if (flushTimer) clearTimeout(flushTimer)
    flush()
  })

  return { dispose, summarize, planSnapshot, config: cfgNormalized, reload: invalidate }

  function dispose() {
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d()
      } catch (err) {}
    }
    flush()
  }
}
