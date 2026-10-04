// Balance observations are not a transaction API. Keep them separate from
// token estimates and require explicit credits/debits for reconciliation.
export const ACCOUNTING_VERSION = 1
export const LEGACY_BOOK_SCOPE = '__legacy__'
const SCALE = 100000000

export function moneyUnits(value) {
  const n = Number(value)
  const units = Math.round(n * SCALE)
  if (!Number.isFinite(n) || !Number.isSafeInteger(units)) throw new Error('金额无效或超出可记账范围')
  return units
}

export function preciseMoney(value) { return moneyUnits(value) / SCALE }
export function addMoney(a, b) { return sumMoney([a, b]) }
export function sumMoney(values) {
  let units = 0
  for (const value of values) units += moneyUnits(value)
  if (!Number.isSafeInteger(units)) throw new Error('金额合计超出可记账范围')
  return units / SCALE
}

export function beijingDay(time = Date.now()) {
  const d = new Date(Number(time) + 8 * 3600000)
  if (!Number.isFinite(d.getTime())) throw new Error('无效的观测时间')
  return d.toISOString().slice(0, 10)
}

export function dayOffset(day, offset) {
  return beijingDay(Date.parse(day + 'T00:00:00+08:00') + offset * 86400000)
}

// v789（issue #184）：partialDay 改为**按实际观测缺口就地计算**，不再是硬编码 true。
//   为什么要有这个：记账只发生在「客户端界面开着 + 余额能取到」的时候，任一条不成立就完全不观测；
//   跨零点的那一段（新建当日行时 openingUnits 直接取"此刻余额"）会被新当天的起点吞掉，
//   于是「今日已用」长期显示一个明显偏小的数字，而界面上**没有任何"这是部分数据"的提示**。
//   标出首尾、当前快照过旧和新记录中的同日长间隔。阈值没有触发也不等于完整账单：
//   两次余额快照之间可能同时发生充值与消费；跨日端点另存为待归属区间。
const PARTIAL_GAP_MS = 10 * 60 * 1000
function partialDayOf(day, row, now) {
  try {
    const start = Date.parse(String(day) + 'T00:00:00+08:00')
    if (!Number.isFinite(start)) return true
    const end = start + 86400000
    const first = row && row.firstAt != null ? Number(row.firstAt) : NaN
    const last = row && row.lastAt != null ? Number(row.lastAt) : NaN
    if (!Number.isFinite(first) || !Number.isFinite(last)) return true
    const beforeGap = first - start
    const afterGap = Math.min(Number(now), end) - last
    return beforeGap > PARTIAL_GAP_MS || afterGap > PARTIAL_GAP_MS || Number(row.maxGapMs) > PARTIAL_GAP_MS
  } catch (err) { return true }
}
export function partialDayInfo(day, row, now = Date.now()) {
  const start = Date.parse(String(day) + 'T00:00:00+08:00')
  const partialDay = partialDayOf(day, row, now)
  const first = row && row.firstAt != null ? Number(row.firstAt) : NaN
  const last = row && row.lastAt != null ? Number(row.lastAt) : NaN
  return {
    partialDay,
    // 给界面用：从几点才开始有观测（缺口在起点）/ 那天几点之后就没再观测（缺口在末尾）
    observedFromMs: Number.isFinite(first) ? first : null,
    observedToMs: Number.isFinite(last) ? last : null,
    leadingGapMs: Number.isFinite(first) && Number.isFinite(start) ? Math.max(0, first - start) : null,
    trailingGapMs: Number.isFinite(last) && Number.isFinite(start) && now >= start + 86400000 ? Math.max(0, start + 86400000 - last) : 0,
    staleGapMs: Number.isFinite(last) && now < start + 86400000 ? Math.max(0, now - last) : 0,
    internalGapMs: Number(row && row.maxGapMs) || 0,
  }
}

function currentBook(ledger, scope = ledger.accounting && ledger.accounting.active) {
  const a = ledger.accounting
  return a && a.version === ACCOUNTING_VERSION && a.books && Object.hasOwn(a.books, scope) && a.books[scope]
}

// Enumerate observation scopes without treating key rotation as account identity.
function booksOf(ledger) {
  const a = ledger.accounting
  if (!a || a.version !== ACCOUNTING_VERSION || !a.books) return []
  const out = []
  for (const scope of Object.keys(a.books)) {
    const book = a.books[scope]
    if (!book || !book.days) continue
    out.push({ scope, book, active: scope === a.active, lastAt: Number(book.lastAt) || 0 })
  }
  return out
}

// 某一天在各记账本里的明细：当前本排最前，其余按"最近观测"倒序
export function bookBreakdown(ledger, day, now = Date.now()) {
  const rows = []
  for (const { scope, book, active, lastAt } of booksOf(ledger)) {
    const row = book.days[day]
    if (!row) continue
    rows.push({
      scope, currency: book.currency, active, lastAt,
      amount: preciseMoney(observedAmount(row)),
      firstObservedAt: row.firstAt, lastObservedAt: row.lastAt,
      needsReview: row.creditUnits > (row.correction ? row.correction.creditUnits : 0),
      ...partialDayInfo(day, row, now),
    })
  }
  return rows.sort((a, b) => (a.active === b.active ? (b.lastAt - a.lastAt) : (a.active ? -1 : 1)))
}

// 所有记账本的日期并集（原来只返回当前本的天数 ⇒ 换 key 后旧日期不进列表）
export function accountingDays(ledger, scope) {
  if (scope === LEGACY_BOOK_SCOPE) return Object.keys(ledger.accounting ? ledger.accounting.legacyHistory || {} : ledger.history || {}).sort()
  const set = new Set()
  for (const entry of booksOf(ledger)) {
    if (scope !== undefined && scope !== entry.scope) continue
    for (const d of Object.keys(entry.book.days || {})) set.add(d)
  }
  return Array.from(set).sort()
}

// A key fingerprint is an observation scope, not proof of account identity.
// Browsing never changes the active writer or merges amounts across scopes.
export function accountingBooks(ledger) {
  const books = booksOf(ledger).map(({ scope, book, active, lastAt }) => ({
    scope, currency: book.currency, active, lastAt, dayCount: Object.keys(book.days).length,
  })).sort((a, b) => Number(b.active) - Number(a.active) || b.lastAt - a.lastAt)
  const legacyDays = accountingDays(ledger, LEGACY_BOOK_SCOPE)
  if (legacyDays.length) books.push({ scope: LEGACY_BOOK_SCOPE, currency: 'CNY', active: !books.length, source: 'legacy', dayCount: legacyDays.length })
  return books
}

function intervalBetween(before, after) {
  const netUnits = after.openingUnits - before.lastUnits
  if (!Number.isSafeInteger(netUnits)) throw new Error('跨日余额变化超出可记账范围')
  return {
    fromAt: before.lastAt, toAt: after.firstAt,
    fromBalanceUnits: before.lastUnits, toBalanceUnits: after.openingUnits, netUnits,
  }
}

// Preserve endpoint facts only: neither consumption nor a daily allocation can
// be inferred from a cross-midnight net change (credits may mask consumption).
// Older v1 books already retain these endpoints. Derive their missing intervals
// without rewriting any historical day or correction.
export function unassignedBalanceIntervals(ledger, scope = ledger.accounting && ledger.accounting.active) {
  const book = currentBook(ledger, scope)
  if (!book) return []
  const byId = new Map()
  const rows = Object.values(book.days).sort((a, b) => a.firstAt - b.firstAt)
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].lastAt < rows[i].firstAt) {
      const interval = intervalBetween(rows[i - 1], rows[i])
      byId.set(interval.fromAt + ':' + interval.toAt, interval)
    }
  }
  for (const interval of book.unassignedIntervals || []) byId.set(interval.fromAt + ':' + interval.toAt, interval)
  return Array.from(byId.values()).sort((a, b) => a.fromAt - b.fromAt).map(interval => ({
    scope, currency: book.currency, fromAt: interval.fromAt, toAt: interval.toAt,
    fromBalance: interval.fromBalanceUnits / SCALE, toBalance: interval.toBalanceUnits / SCALE,
    netChange: interval.netUnits / SCALE, source: 'balance-net-change', status: 'unassigned',
  }))
}

function observedAmount(day) {
  const c = day.correction
  return (c ? c.amountUnits + day.debitUnits - c.debitUnits : day.debitUnits) / SCALE
}

function revisionOf(ledger, day, scope = ledger.accounting.active) {
  return [scope, day.day, day.firstAt, day.lastUnits,
    day.debitUnits, day.creditUnits, day.revision || 0].join(':')
}

export function balanceSummary(ledger, day = beijingDay(), scope = ledger.accounting && ledger.accounting.active, now = Date.now()) {
  const book = currentBook(ledger, scope)
  const row = book && book.days && book.days[day]
  if (!row) return null
  const correction = row.correction
  const needsReview = row.creditUnits > (correction ? correction.creditUnits : 0)
  const source = needsReview ? 'balance-needs-review' : correction ? 'balance-corrected' : 'balance-observed'
  return {
    day, scope, active: scope === ledger.accounting.active, hasObservation: true,
    amount: preciseMoney(observedAmount(row)), currency: book.currency, source,
    label: needsReview ? '已观测消费 · 待核对余额调整' : correction ? '已校正消费' : '已观测消费',
    firstObservedAt: row.firstAt, lastObservedAt: row.lastAt,
    openingBalance: row.openingUnits / SCALE, currentBalance: row.lastUnits / SCALE,
    observedDecrease: row.debitUnits / SCALE, observedIncrease: row.creditUnits / SCALE,
    needsReview, revision: revisionOf(ledger, row, scope),
    ...partialDayInfo(day, row, now),
    credits: correction ? correction.creditsUnits / SCALE : null,
    otherDebits: correction ? correction.otherDebitsUnits / SCALE : null,
    correctedAt: correction ? correction.at : null,
  }
}

// Mutates the caller-owned ledger; this module itself never reads or writes files.
export function observeBalance(ledger, snapshot) {
  const at = Number(snapshot.at ?? Date.now())
  const day = beijingDay(at)
  const units = moneyUnits(snapshot.balance)
  const currency = String(snapshot.currency || 'CNY').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('余额币种无效')
  const scope = String(snapshot.scope || 'default')
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(scope)) throw new Error('账户标识无效')
  const context = scope + '-' + currency
  let a = ledger.accounting
  if (!a || a.version !== ACCOUNTING_VERSION) {
    // Legacy totals have no trustworthy recharge metadata. Preserve them for
    // reference; begin a new explicitly timed observation window.
    a = ledger.accounting = {
      version: ACCOUNTING_VERSION, active: context, books: {}, migratedAt: at,
      legacyHistory: { ...(ledger.history || {}) },
    }
  }
  a.books ||= {}
  let book = a.books[context]
  if (!book) book = a.books[context] = { currency, days: {} }
  // Ignore duplicate/out-of-order samples, including a late sample from yesterday.
  if (book.lastAt != null && at <= book.lastAt) return balanceSummary(ledger, ledger.date)
  a.active = context
  let row = book.days[day]
  if (!row) {
    row = book.days[day] = {
      day, firstAt: at, lastAt: at, openingUnits: units, lastUnits: units,
      debitUnits: 0, creditUnits: 0, revision: 0, correction: null,
    }
    if (book.lastAt != null) {
      const previous = book.days[beijingDay(book.lastAt)]
      if (previous) {
        book.unassignedIntervals ||= []
        book.unassignedIntervals.push(intervalBetween(previous, row))
      }
    }
  } else {
    const delta = row.lastUnits - units
    if (delta > 0) row.debitUnits += delta
    if (delta < 0) row.creditUnits -= delta
    row.maxGapMs = Math.max(Number(row.maxGapMs) || 0, at - row.lastAt)
    row.lastUnits = units
    row.lastAt = at
  }
  book.lastAt = at
  ledger.date = day
  // Compatibility fields for the existing UI and old settings writers.
  ledger.dayStart = row.openingUnits / SCALE
  ledger.lastBalance = row.lastUnits / SCALE
  const summary = balanceSummary(ledger, day)
  ledger.todayUsage = summary.amount
  ledger.history ||= {}
  ledger.history[day] = summary.amount
  return summary
}

function adjustmentUnits(value, required = false) {
  if (value === '' || value === null || value === undefined) {
    if (required) throw new Error('请填写本统计区间的累计到账金额，未充值请填 0')
    return 0
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(value))) {
    throw new Error('金额须为非负数，最多保留 8 位小数')
  }
  const units = moneyUnits(value)
  if (units < 0) throw new Error('金额不能为负数')
  return units
}

export function reconcileBalance(ledger, input, now = Date.now()) {
  const day = String(input.day || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('请选择有效的记账日期')
  const book = currentBook(ledger)
  const row = book && book.days && book.days[day]
  if (!row) throw new Error('这一天没有余额观测记录，无法校正')
  if (input.revision !== revisionOf(ledger, row)) {
    const err = new Error('余额或校正记录已更新，请重新打开校正窗口后核对金额')
    err.status = 409
    throw err
  }
  if (input.action !== 'reset' && input.confirmed !== true) throw new Error('请先确认已核对本统计区间的全部余额调整')
  let correction = null
  if (input.action !== 'reset') {
    const creditsUnits = adjustmentUnits(input.credits, true)
    const otherDebitsUnits = adjustmentUnits(input.otherDebits)
    const amountUnits = row.openingUnits + creditsUnits - otherDebitsUnits - row.lastUnits
    if (!Number.isSafeInteger(amountUnits) || amountUnits < 0) {
      throw new Error('校正后消费为负或超出范围，请核对统计起点与累计到账金额')
    }
    correction = {
      at: Number(now), creditsUnits, otherDebitsUnits, amountUnits,
      debitUnits: row.debitUnits, creditUnits: row.creditUnits,
    }
  }
  row.correctionLog ||= []
  row.correctionLog.push({ at: Number(now), previous: row.correction, next: correction })
  if (row.correctionLog.length > 50) row.correctionLog.splice(0, row.correctionLog.length - 50)
  row.correction = correction
  row.revision = (row.revision || 0) + 1
  const summary = balanceSummary(ledger, day)
  ledger.history ||= {}
  ledger.history[day] = summary.amount
  if (ledger.date === day) ledger.todayUsage = summary.amount
  return summary
}

export function eventEstimate(ledger, day) {
  return sumMoney((Array.isArray(ledger.events) ? ledger.events : [])
    .filter(e => e.day === day).map(e => Number(e.cost) || 0))
}

export function daySummary(ledger, day, scope = ledger.accounting && ledger.accounting.active, now = Date.now()) {
  const observed = balanceSummary(ledger, day, scope, now)
  const estimate = eventEstimate(ledger, day)
  const books = bookBreakdown(ledger, day, now)
  const common = { eventEstimate: estimate, eventCurrency: 'CNY', bookBreakdown: books, bookCount: books.length }
  if (observed) {
    return {
      ...observed, ...common,
      historyHint: books.length > 1 ? '本日另有 ' + (books.length - 1) + ' 个记账本，请切换查看；账户与币种不合并' : '',
    }
  }
  const book = currentBook(ledger, scope)
  if (book) {
    return {
      day, scope, amount: null, currency: book.currency, hasObservation: false,
      source: 'balance-unobserved', label: '本账本当日未观测', partialDay: true, ...common,
      historyHint: books.length ? '其它记账本有本日记录，请切换查看；未观测不表示消费为零' : '',
    }
  }
  // An explicit historical total (even zero) wins over a conflicting estimate.
  const history = ledger.accounting ? ledger.accounting.legacyHistory : ledger.history
  const h = history && history[day]
  const hasHistory = typeof h === 'number' && Number.isFinite(h)
  return {
    day, amount: hasHistory ? preciseMoney(h) : estimate, currency: 'CNY',
    source: hasHistory ? 'legacy' : 'events', label: hasHistory ? '旧版记录 · 未校正' : '本地估算',
    partialDay: true, ...common,
  }
}
