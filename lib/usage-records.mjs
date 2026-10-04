// Read-only presentation of one observation scope. Model events have no account
// identity and remain a separately labelled local estimate.
import {
  addMoney, sumMoney, beijingDay, dayOffset, daySummary, accountingBooks,
  accountingDays, unassignedBalanceIntervals, LEGACY_BOOK_SCOPE,
} from './accounting.mjs'
const MAX_EXPANDED_GAP_DAYS = 3660

export function buildUsageRecords(ledger, { bookScope, now = Date.now() } = {}) {
  const books = accountingBooks(ledger)
  const selected = bookScope == null ? books.find(book => book.active) : books.find(book => book.scope === bookScope)
  if (bookScope != null && !selected) throw new Error('记账本不存在，请刷新列表后重试')
  const scope = selected && selected.scope
  const events = Array.isArray(ledger.events) ? ledger.events : []
  const today = beijingDay(now)
  const modelsByDay = new Map()
  for (const event of events) {
    if (!modelsByDay.has(event.day)) modelsByDay.set(event.day, new Map())
    const models = modelsByDay.get(event.day)
    const name = String(event.model || '未知')
    models.set(name, addMoney(models.get(name) || 0, Number(event.cost) || 0))
  }
  function forDay(date) {
    const summary = daySummary(ledger, date, scope, now)
    const models = Array.from(modelsByDay.get(date) || [], ([model, cost]) => ({ model, cost, source: 'events', currency: 'CNY' }))
      .sort((a, b) => b.cost - a.cost)
    return { ...summary, date, total: summary.amount, models, modelTotal: sumMoney(models.map(model => model.cost)), modelCurrency: 'CNY' }
  }
  const todayData = forDay(today)
  const days7 = Array.from({ length: 7 }, (_, i) => forDay(dayOffset(today, -i)))
  const total7ByCurrency = {}
  for (const day of days7) if (day.total != null) total7ByCurrency[day.currency] = addMoney(total7ByCurrency[day.currency] || 0, day.total)
  const intervals = unassignedBalanceIntervals(ledger, scope)
  const days = new Set([today, ...accountingDays(ledger, scope)])
  let gapDaysRemaining = MAX_EXPANDED_GAP_DAYS
  let gapDatesTruncated = false
  // Surface days with no samples inside an offline interval as unknown, rather
  // than silently dropping the dates or inventing a zero-consumption day.
  for (const interval of intervals) {
    const endDay = beijingDay(interval.toAt)
    for (let day = dayOffset(beijingDay(interval.fromAt), 1); day < endDay; day = dayOffset(day, 1)) {
      if (gapDaysRemaining <= 0) { gapDatesTruncated = true; break }
      days.add(day)
      gapDaysRemaining--
    }
  }
  if (!selected || scope === LEGACY_BOOK_SCOPE) {
    for (const event of events) if (/^\d{4}-\d{2}-\d{2}$/.test(event.day)) days.add(event.day)
  }
  return {
    ok: true, books, selectedBook: selected || null, unassignedIntervals: intervals, gapDatesTruncated,
    today: todayData, days7,
    total7: Object.hasOwn(total7ByCurrency, todayData.currency) ? total7ByCurrency[todayData.currency] : null,
    total7Currency: todayData.currency, total7ByCurrency,
    all: {
      days: Array.from(days).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort().reverse().map(forDay),
      events: events.slice().sort((a, b) => b.ts - a.ts).slice(0, 500),
    },
  }
}
