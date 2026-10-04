import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'
import { observeBalance, balanceSummary, daySummary } from '../lib/accounting.mjs'

const source = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8')
const lines = source.split(/\r?\n/)
function clientFunction(name) {
  const start = lines.findIndex(line => line.startsWith('function ' + name + '('))
  assert.ok(start >= 0)
  const end = lines.findIndex((line, i) => i > start && line === '}')
  assert.ok(end > start)
  return lines.slice(start, end + 1).join('\n')
}

test('real default and template bubble paths display coverage and keep unknown distinct from zero', () => {
  const ledger = {}
  const t = Date.parse('2026-10-01T12:00:00+08:00')
  observeBalance(ledger, { scope: 'test', balance: 100, at: t })
  const ctx = vm.createContext({
    state: { balance: 100, status: 'ok', currency: 'CNY' }, shown: 100,
    costBubbleActive: false, bubbleRandomActive: false,
    amountEl: {}, hintEl: {}, fmt: (value, currency) => value.toFixed(2) + ' ' + currency,
    bubbleIsModelMod: () => false,
  })
  ctx.setHint = text => { ctx.lastHint = text }
  vm.runInContext([
    'applyUsageSummary', 'bubbleTodayValue', 'bubbleTodayText', 'bubbleContentTokenMap',
    'bubbleContentText', 'bubbleRowContentOf', 'accountingTime', 'usageCoverageText', 'render',
  ].map(clientFunction).join('\n'), ctx)
  ctx.applyUsageSummary(balanceSummary(ledger, '2026-10-01', 'test-CNY', t))
  ctx.render()
  assert.match(ctx.lastHint, /0\.00 CNY · 部分观测/)
  assert.match(ctx.hintEl.title, /部分观测/)
  assert.match(ctx.bubbleRowContentOf({ type: 'today' }).txt, /部分观测/)
  assert.match(ctx.bubbleRowContentOf({ type: 'today', tpl: '今日 {expense_ds}' }).txt, /部分观测/)
  ctx.applyUsageSummary(daySummary(ledger, '2026-10-02', 'test-CNY', t))
  ctx.render()
  assert.equal(ctx.state.todayUsage, null)
  assert.match(ctx.lastHint, /未观测/)
  assert.doesNotMatch(ctx.lastHint, /0\.00/)
  assert.equal(ctx.bubbleContentTokenMap({ type: 'today' }).expense_ds, '未观测')
  // Both server-response paths must use the same consumer exercised above.
  assert.match(source, /applyUsageSummary\(data\.accounting \|\|/)
  assert.match(source, /applyUsageSummary\(d\.today\)/)
})
