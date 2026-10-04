// Synthetic caller-owned ledgers only. No DSH/Codex files, network or installation.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  observeBalance, balanceSummary, daySummary, accountingBooks, accountingDays,
  unassignedBalanceIntervals, partialDayInfo, reconcileBalance, LEGACY_BOOK_SCOPE,
} from '../lib/accounting.mjs'
import { buildUsageRecords } from '../lib/usage-records.mjs'

const at = text => Date.parse(text + '+08:00')
const sample = (ledger, time, balance, scope = 'keyA', currency = 'CNY') =>
  observeBalance(ledger, { at: at(time), balance, scope, currency })
const clone = value => JSON.parse(JSON.stringify(value))

test('midnight net decrease is retained with endpoints, never charged to either day', () => {
  const ledger = {}
  sample(ledger, '2026-10-01T23:59:00', 100)
  sample(ledger, '2026-10-02T00:01:00', 90)
  assert.equal(balanceSummary(ledger, '2026-10-01').amount, 0)
  assert.equal(balanceSummary(ledger, '2026-10-02').amount, 0)
  assert.equal(balanceSummary(ledger, '2026-10-02', 'keyA-CNY', at('2026-10-02T00:01:00')).partialDay, true)
  assert.equal(balanceSummary(ledger, '2026-10-02').unassignedChange, true)
  assert.deepEqual(unassignedBalanceIntervals(ledger), [{
    scope: 'keyA-CNY', currency: 'CNY',
    fromAt: at('2026-10-01T23:59:00'), toAt: at('2026-10-02T00:01:00'),
    fromBalance: 100, toBalance: 90, netChange: -10,
    source: 'balance-net-change', status: 'unassigned',
  }])
  assert.equal(ledger.accounting.books['keyA-CNY'].unassignedIntervals.length, 1)
  sample(ledger, '2026-10-02T00:02:00', 85)
  assert.equal(balanceSummary(ledger, '2026-10-02').amount, 5)
  assert.equal(unassignedBalanceIntervals(ledger)[0].toBalance, 90)
})

test('multi-day offline and net increases/zero stay unknown, not reconstructed consumption', () => {
  for (const balance of [90, 100, 120]) {
    const ledger = {}
    sample(ledger, '2026-10-01T21:00:00', 100)
    sample(ledger, '2026-10-04T08:00:00', balance)
    const gap = unassignedBalanceIntervals(ledger)[0]
    assert.equal(gap.netChange, balance - 100)
    assert.equal(gap.toAt - gap.fromAt, 59 * 3600000)
    for (const day of ['2026-10-02', '2026-10-03']) {
      const summary = daySummary(ledger, day)
      assert.equal(summary.amount, null)
      assert.equal(summary.hasObservation, false)
      assert.equal(summary.partialDay, true)
      assert.equal(summary.source, 'balance-unobserved')
    }
    assert.equal(balanceSummary(ledger, '2026-10-04').amount, 0)
  }
})

test('old v1 endpoints are readable without rewriting days, legacy history, or corrections', () => {
  const ledger = { history: { '2026-09-30': 7 }, events: [] }
  sample(ledger, '2026-10-01T23:50:00', 100)
  sample(ledger, '2026-10-02T00:10:00', 95)
  delete ledger.accounting.books['keyA-CNY'].unassignedIntervals
  const saved = clone(ledger)
  assert.equal(unassignedBalanceIntervals(ledger)[0].netChange, -5)
  accountingBooks(ledger)
  accountingDays(ledger)
  daySummary(ledger, '2026-10-01', 'keyA-CNY', at('2026-10-03T00:00:00'))
  assert.deepEqual(ledger, saved)
  const restored = clone(ledger)
  assert.deepEqual(unassignedBalanceIntervals(restored), unassignedBalanceIntervals(ledger))
  assert.equal(daySummary(restored, '2026-09-30', LEGACY_BOOK_SCOPE).amount, 7)
})

test('duplicate and out-of-order samples do not duplicate or alter the cross-day interval', () => {
  const ledger = {}
  sample(ledger, '2026-10-01T23:59:00', 100)
  sample(ledger, '2026-10-02T00:01:00', 90)
  const saved = clone(ledger)
  sample(ledger, '2026-10-02T00:01:00', 50)
  sample(ledger, '2026-10-01T23:59:30', 70)
  assert.deepEqual(ledger, saved)
  assert.equal(unassignedBalanceIntervals(ledger).length, 1)
})

test('same-day observations retain decreases and credits separately at eight decimals', () => {
  const ledger = {}
  sample(ledger, '2026-10-01T08:00:00', 1)
  sample(ledger, '2026-10-01T09:00:00', 0.9)
  sample(ledger, '2026-10-01T10:00:00', 0.7)
  sample(ledger, '2026-10-01T11:00:00', 1.7)
  const summary = balanceSummary(ledger, '2026-10-01')
  assert.equal(summary.amount, 0.3)
  assert.equal(summary.observedIncrease, 1)
  assert.equal(summary.needsReview, true)
  assert.deepEqual(unassignedBalanceIntervals(ledger), [])
})

test('three keys on one day can each be read without adding or selecting a different writer', () => {
  const ledger = {}
  for (const [scope, amount, hour] of [['keyA', 10, '08'], ['keyB', 5, '09'], ['keyC', 2, '10']]) {
    sample(ledger, '2026-10-01T' + hour + ':00:00', 100, scope)
    sample(ledger, '2026-10-01T' + hour + ':01:00', 100 - amount, scope)
  }
  assert.equal(daySummary(ledger, '2026-10-01').amount, 2)
  const saved = clone(ledger)
  assert.equal(accountingBooks(ledger).length, 3)
  for (const [scope, amount] of [['keyA-CNY', 10], ['keyB-CNY', 5], ['keyC-CNY', 2]]) {
    const summary = daySummary(ledger, '2026-10-01', scope)
    assert.equal(summary.amount, amount)
    assert.equal(summary.scope, scope)
    assert.equal(summary.otherBookAmount, undefined)
  }
  assert.deepEqual(ledger, saved)
  assert.equal(ledger.accounting.active, 'keyC-CNY')
})

test('same key in two currencies stays separate, and key changes create no cross-book delta', () => {
  const ledger = {}
  sample(ledger, '2026-10-01T08:00:00', 100, 'keyA', 'CNY')
  sample(ledger, '2026-10-01T08:01:00', 90, 'keyA', 'CNY')
  sample(ledger, '2026-10-02T08:00:00', 5, 'keyA', 'USD')
  sample(ledger, '2026-10-02T08:01:00', 4, 'keyA', 'USD')
  assert.equal(daySummary(ledger, '2026-10-01').amount, null)
  assert.equal(daySummary(ledger, '2026-10-01', 'keyA-CNY').amount, 10)
  assert.equal(daySummary(ledger, '2026-10-02', 'keyA-USD').amount, 1)
  assert.deepEqual(accountingDays(ledger, 'keyA-CNY'), ['2026-10-01'])
  assert.deepEqual(unassignedBalanceIntervals(ledger, 'keyA-USD'), [])
  assert.deepEqual(unassignedBalanceIntervals(ledger, 'keyA-CNY'), [])
})

test('unobserved scope/day does not replace an unknown value with model estimates or other books', () => {
  const ledger = { events: [{ day: '2026-10-01', cost: 99 }] }
  sample(ledger, '2026-10-01T08:00:00', 100, 'keyA')
  sample(ledger, '2026-10-01T08:01:00', 90, 'keyA')
  sample(ledger, '2026-10-02T08:00:00', 100, 'keyB')
  const summary = daySummary(ledger, '2026-10-01')
  assert.equal(summary.amount, null)
  assert.equal(summary.eventEstimate, 99)
  assert.equal(summary.bookBreakdown[0].amount, 10)
  assert.match(summary.historyHint, /切换/)
})

test('legacy totals including zero remain available as an explicitly separate source', () => {
  const ledger = { history: { '2026-09-30': 0 }, events: [{ day: '2026-09-30', cost: 4 }] }
  sample(ledger, '2026-10-01T08:00:00', 100)
  const summary = daySummary(ledger, '2026-09-30', LEGACY_BOOK_SCOPE)
  assert.equal(summary.amount, 0)
  assert.equal(summary.source, 'legacy')
  assert.equal(summary.eventEstimate, 4)
  assert.ok(accountingBooks(ledger).some(book => book.scope === LEGACY_BOOK_SCOPE))
  assert.deepEqual(ledger.accounting.legacyHistory, { '2026-09-30': 0 })
})

test('coverage handles missing, late, stale and interrupted observations with a fixed clock', () => {
  const day = '2026-10-01'
  assert.equal(partialDayInfo(day, null, at(day + 'T12:00:00')).partialDay, true)
  const row = { firstAt: at(day + 'T00:01:00'), lastAt: at(day + 'T12:00:00') }
  assert.equal(partialDayInfo(day, row, at(day + 'T12:10:00')).partialDay, false)
  assert.equal(partialDayInfo(day, row, at(day + 'T12:10:01')).partialDay, true)
  assert.equal(partialDayInfo(day, { ...row, maxGapMs: 3600000 }, at(day + 'T12:00:00')).partialDay, true)
  assert.equal(partialDayInfo(day, row, at('2026-10-02T00:00:00')).trailingGapMs, 12 * 3600000)
  const ledger = {}
  sample(ledger, day + 'T00:01:00', 100)
  sample(ledger, day + 'T12:00:00', 90)
  assert.equal(daySummary(ledger, day, 'keyA-CNY', at(day + 'T12:00:00')).partialDay, true)
})

test('existing explicit correction remains scoped and does not consume unassigned changes', () => {
  const ledger = {}
  sample(ledger, '2026-10-01T23:59:00', 100)
  sample(ledger, '2026-10-02T00:01:00', 90)
  sample(ledger, '2026-10-02T00:02:00', 95)
  const gaps = unassignedBalanceIntervals(ledger)
  const summary = balanceSummary(ledger, '2026-10-02')
  const input = { day: summary.day, revision: summary.revision, confirmed: true, credits: '10', otherDebits: '0' }
  assert.equal(reconcileBalance(ledger, input).amount, 5)
  assert.throws(() => reconcileBalance(ledger, input), err => err.status === 409)
  assert.deepEqual(unassignedBalanceIntervals(ledger), gaps)
  assert.equal(balanceSummary(ledger, '2026-10-01').amount, 0)
})

test('production records payload is scoped, keeps estimates separate, and surfaces missing dates', () => {
  const ledger = { events: [{ day: '2026-10-02', model: 'flash', cost: 88, ts: at('2026-10-02T12:00:00') }] }
  sample(ledger, '2026-10-01T23:00:00', 100)
  sample(ledger, '2026-10-04T08:00:00', 90)
  sample(ledger, '2026-10-04T08:01:00', 85)
  sample(ledger, '2026-10-04T09:00:00', 50, 'keyB')
  sample(ledger, '2026-10-04T09:01:00', 48, 'keyB')
  const saved = clone(ledger)
  const now = at('2026-10-04T09:02:00')
  assert.equal(buildUsageRecords(ledger, { now }).total7, 2)
  const previous = buildUsageRecords(ledger, { bookScope: 'keyA-CNY', now })
  assert.equal(previous.total7, 5)
  assert.equal(previous.selectedBook.scope, 'keyA-CNY')
  assert.equal(previous.unassignedIntervals[0].netChange, -10)
  const missing = previous.all.days.find(day => day.date === '2026-10-02')
  assert.equal(missing.total, null)
  assert.equal(missing.modelTotal, 88)
  assert.equal(missing.hasObservation, false)
  assert.throws(() => buildUsageRecords(ledger, { bookScope: 'not-a-book', now }), /记账本不存在/)
  assert.deepEqual(ledger, saved)
})

test('extreme stored dates cannot cause unbounded gap expansion or discard real observations', () => {
  const ledger = {}
  sample(ledger, '2000-01-01T12:00:00', 100)
  sample(ledger, '9999-01-01T12:00:00', 90)
  const report = buildUsageRecords(ledger, { now: at('9999-01-01T12:00:00') })
  assert.equal(report.gapDatesTruncated, true)
  assert.equal(report.all.days.length, 3662)
  assert.ok(report.all.days.some(day => day.date === '2000-01-01' && day.hasObservation))
  assert.ok(report.all.days.some(day => day.date === '9999-01-01' && day.hasObservation))
  assert.equal(report.unassignedIntervals[0].fromAt, at('2000-01-01T12:00:00'))
  assert.equal(report.unassignedIntervals[0].toAt, at('9999-01-01T12:00:00'))
})
