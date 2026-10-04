import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createCompletionFeed, createPendingWaits, eventTime } from '../lib/session-events.mjs'

const host = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const client = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8')
function productionFunction(source, name) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => new RegExp('^\\s*function ' + name + '\\(').test(line))
  assert.notEqual(start, -1, name)
  const indent = lines[start].match(/^\s*/)[0]
  const end = lines.findIndex((line, i) => i > start && line === indent + '}')
  assert.ok(end > start, name)
  return lines.slice(start, end + 1).join('\n')
}
const completion = (sessionId, turn = 1, amount = 1) => ({ sessionId, turn, amount, tokens: 12, outcome: 'completed' })

test('the feed retains concurrent and measured-zero completions without duplicates', () => {
  const writes = []
  const feed = createCompletionFeed({ streamId: 'run', initialSeq: 5, onSequence: seq => writes.push(seq) })
  feed.publish(completion('a'))
  feed.publish(completion('b', 1, 0))
  assert.equal(feed.publish(completion('a')), null)
  assert.deepEqual(feed.read(5, 'run').events.map(e => e.amount), [1, 0])
  assert.deepEqual(writes, [6, 7])
  assert.equal(feed.read(7, 'run').events.length, 0)
})

test('fresh clients and restarted hosts align without replaying historical completions', () => {
  const feed = createCompletionFeed({ streamId: 'new', initialSeq: 17 })
  feed.publish(completion('a'))
  for (const [cursor, stream] of [[null, null], [17, 'old'], [19, 'new'], [-1, 'new'], ['bad', 'new']]) {
    const data = feed.read(cursor, stream)
    assert.equal(data.reset, true)
    assert.equal(data.cursor, 18)
    assert.deepEqual(data.events, [])
  }
  assert.equal(feed.read('17', 'new').events.length, 1)
})

test('bounded retention reports a delivery gap instead of silently claiming full history', () => {
  const feed = createCompletionFeed({ streamId: 'run', limit: 2 })
  for (let turn = 1; turn <= 4; turn++) feed.publish(completion('a', turn))
  const data = feed.read(0, 'run')
  assert.equal(data.gap, true)
  assert.deepEqual(data.events.map(e => e.turn), [3, 4])
  assert.equal(feed.read(2, 'run').gap, false)
  assert.equal(feed.publish(completion('a', 2)), null)
})

test('wait ownership survives another session starting, ending, or answering the same call id', () => {
  const waits = createPendingWaits()
  const ask = { type: 'tool/call', time: 100, data: { name: 'ask_user_question', callId: 'same' } }
  waits.update('a', ask, { sessionName: 'A', workspace: '/a' })
  waits.update('b', { type: 'turn/start', data: {} }, { sessionName: 'B' })
  waits.update('b', { type: 'tool/result', data: { message: { callId: 'same' } } })
  waits.update('b', { type: 'turn/end', data: {} })
  assert.equal(waits.snapshot().pending.session, 'a')
  assert.equal(waits.snapshot().sessionName, 'A')
  waits.update('a', { type: 'tool/result', data: { message: { callId: 'same' } } })
  assert.equal(waits.snapshot().pending, null)
})

test('overlapping waits reveal the previous still-pending request when the newest resolves', () => {
  const waits = createPendingWaits()
  waits.update('a', { type: 'approval/asked', data: { id: '1', callId: 'tool-call' } }, { sessionName: 'A' })
  waits.update('b', { type: 'approval/asked', data: { id: '1' } }, { sessionName: 'B' })
  assert.equal(waits.snapshot().pendingCount, 2)
  waits.update('b', { type: 'approval/resolved', data: { id: '1' } })
  assert.equal(waits.snapshot().pending.session, 'a')
  waits.update('a', { type: 'session/title', data: { title: 'Renamed' } })
  assert.equal(waits.snapshot().sessionName, 'Renamed')
  waits.update('a', { type: 'approval/decided', data: { id: '1' } })
  assert.equal(waits.snapshot().pendingCount, 0)
})

test('missing result identifiers cannot dismiss an unrelated pending question', () => {
  const waits = createPendingWaits()
  waits.update('a', { type: 'tool/call', seq: 1, data: { name: 'ask_user_question', callId: 'q' } })
  waits.update('a', { type: 'tool/result', data: {} })
  assert.equal(waits.snapshot().pending.id, 'q')
  waits.update('a', { type: 'turn/end', data: {} })
  assert.equal(waits.snapshot().pending, null)
})

test('a title received before a question remains available without a title service', () => {
  const waits = createPendingWaits()
  waits.update('a', { type: 'session/title', data: { title: 'Known title' } })
  waits.update('b', { type: 'session/title', data: { title: 'Other title' } })
  waits.update('a', { type: 'tool/call', data: { name: 'ask_user_question', callId: 'q' } })
  assert.equal(waits.snapshot().sessionName, 'Known title')
  waits.dispose('a')
  waits.update('a', { type: 'tool/call', data: { name: 'ask_user_question', callId: 'new' } })
  assert.equal(waits.snapshot().sessionName, '')
})

test('late or duplicate lifecycle events cannot clear a newer turn waiting in the same session', () => {
  const waits = createPendingWaits()
  waits.update('a', { type: 'turn/start', seq: 20, data: { turn: 2 } })
  waits.update('a', { type: 'tool/call', seq: 21, data: { turn: 2, name: 'ask_user_question', callId: 'new' } })
  waits.update('a', { type: 'turn/end', seq: 19, data: { turn: 1 } })
  waits.update('a', { type: 'turn/start', seq: 20, data: { turn: 2 } })
  waits.update('a', { type: 'turn/end', data: { turn: 1 } })
  assert.equal(waits.snapshot().pending.id, 'new')
  waits.update('a', { type: 'turn/end', seq: 22, data: { turn: 2 } })
  assert.equal(waits.snapshot().pending, null)
})

function hostFixture() {
  const rows = []
  const pricingTimes = []
  const context = {
    turnAggs: new Map(), completionFeed: createCompletionFeed({ streamId: 'test' }), lastTurn: null,
    eventTime, titleFromService: () => '', pickSessionName: session => session?.title || '',
    appendUsageEvent: event => rows.push(event), apiAttributeEvent: () => {}, refreshCustomPrices: () => {},
    priceFor: () => ({ hit: [1, 2], miss: [1, 2], out: [1, 2] }), customPriceMetaFor: () => null,
    isPeakTime: seconds => { pricingTimes.push(seconds); return false }, addMoney: (a, b) => a + b,
  }
  vm.createContext(context)
  for (const name of ['turnContext', 'newTurnAggregate', 'finalizeTurn', 'handleSessionEvent']) {
    vm.runInContext(productionFunction(host, name), context)
  }
  return { context, rows, pricingTimes }
}
const usageEvent = (turn, seq, tokens, time = 1000) => ({
  type: 'assistant/message', seq, time,
  data: { turn, usage: { inputTokens: tokens, cacheReadTokens: 0, outputTokens: 0 }, message: { source: { model: 'test' } } },
})

test('real host wiring keeps session/workspace identity and uses the usage event time for pricing', () => {
  const { context: c, rows, pricingTimes } = hostFixture()
  c.handleSessionEvent('a', usageEvent(1, 2, 100), { title: 'A', header: { cwd: '/workspace/a' } })
  c.handleSessionEvent('b', usageEvent(1, 2, 200), { title: 'B', header: { cwd: '/workspace/b' } })
  c.handleSessionEvent('a', { type: 'turn/end', time: 2000, data: { turn: 1, reason: { kind: 'completed' } } })
  c.handleSessionEvent('b', { type: 'turn/end', time: 3000, data: { turn: 1, reason: { kind: 'completed' } } })
  const events = c.completionFeed.read(0, 'test').events
  assert.equal(events.length, 2)
  assert.equal(events[0].workspace, '/workspace/a')
  assert.equal(events[1].sessionName, 'B')
  assert.deepEqual(rows.map(row => row.tokens), [100, 200])
  assert.deepEqual(rows.map(row => row.ts), [1000, 1000])
  assert.deepEqual(pricingTimes, [1, 1])
})

test('real host separates measured zero, absent usage, cancellation, and duplicate events', () => {
  const { context: c, rows } = hostFixture()
  c.handleSessionEvent('a', usageEvent(1, 2, 0))
  c.handleSessionEvent('a', usageEvent(1, 2, 0))
  const end = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  c.handleSessionEvent('a', end)
  c.handleSessionEvent('a', end)
  c.handleSessionEvent('b', end)
  c.handleSessionEvent('c', { ...end, data: { turn: 1, reason: { kind: 'aborted' } } })
  const events = c.completionFeed.read(0, 'test').events
  assert.equal(events.length, 3)
  assert.equal(events[0].amount, 0)
  assert.equal(events[1].amount, null)
  assert.equal(events[2].outcome, 'aborted')
  assert.equal(rows.length, 0)
})

test('late old turns cannot flush a newer aggregate', () => {
  const { context: c, rows } = hostFixture()
  c.handleSessionEvent('a', usageEvent(2, 20, 100))
  c.handleSessionEvent('a', { type: 'turn/end', data: { turn: 1 } })
  assert.equal(c.turnAggs.get('a').turn, 2)
  assert.equal(rows.length, 0)
  c.handleSessionEvent('a', { type: 'turn/end', data: { turn: 2, reason: 'completed' } })
  assert.equal(rows.length, 1)
})

test('a turn ending after midnight does not move the existing usage record to the next day', () => {
  const { context: c, rows } = hostFixture()
  const usageAt = Date.parse('2026-10-04T23:59:50+08:00')
  const endedAt = Date.parse('2026-10-05T00:00:10+08:00')
  c.handleSessionEvent('a', usageEvent(1, 1, 100, usageAt))
  c.handleSessionEvent('a', { type: 'turn/end', time: endedAt, data: { turn: 1, reason: 'completed' } })
  assert.equal(rows[0].ts, usageAt)
  assert.equal(c.lastTurn.ts, endedAt)
})

function clientFixture({ storage = new Map(), locks } = {}) {
  const bubbles = [], sounds = [], requests = []
  const context = {
    Promise, console, AbortController, setTimeout, clearTimeout, navigator: locks ? { locks } : {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    turnCursor: { streamId: 'test', seq: 0 }, turnPollBusy: false, lastCostSeq: 0, lastCostAligned: false,
    notificationSeen: Object.create(null), LAST_TURN_URL: '/dsh-whale/last-turn.json',
    soundOn: true, usageSet: { taskEnd: { on: true } }, showCostBubble: amount => bubbles.push(amount),
    playTaskEndSound: () => sounds.push('sound'),
    fetch: url => { requests.push(url); return Promise.resolve({ ok: true, json: async () => context.response }) },
  }
  vm.createContext(context)
  for (const name of ['dshwFetchState', 'rememberTurnCursor', 'dshwPlayNotificationOnce', 'deliverTurnCompletion', 'pollLastTurn']) {
    vm.runInContext(productionFunction(client, name), context)
  }
  return { context, bubbles, sounds, requests }
}

test('real client delivers every retained completion once and does not sound for cancellation', async () => {
  const { context: c, bubbles, sounds } = clientFixture()
  c.response = { ok: true, seq: 3, streamId: 'test', reset: false, events: [
    { ...completion('a'), seq: 1, eventId: 'test:1' },
    { ...completion('b', 1, 0), seq: 2, eventId: 'test:2' },
    { ...completion('c', 1, 2), seq: 3, eventId: 'test:3', outcome: 'aborted' },
  ] }
  await c.pollLastTurn()
  await c.pollLastTurn()
  assert.deepEqual(bubbles, [1, 0, 2])
  assert.equal(sounds.length, 2)
  assert.equal(c.turnCursor.seq, 3)
})

test('real client serializes polls and aligns a reset without inventing a zero-cost bubble', async () => {
  const { context: c, requests, bubbles } = clientFixture()
  c.response = { ok: true, seq: 10, streamId: 'new', reset: true, events: [] }
  await Promise.all([c.pollLastTurn(), c.pollLastTurn()])
  assert.equal(requests.length, 1)
  assert.equal(c.turnCursor.seq, 10)
  c.deliverTurnCompletion({ seq: 11, turn: 1, amount: null, outcome: 'completed' })
  assert.deepEqual(bubbles, [])
})

test('a stalled request times out, releases the poll guard, and allows the next poll', async () => {
  const { context: c } = clientFixture()
  let aborts = 0, timeout
  c.setTimeout = run => { timeout = run; return 1 }
  c.clearTimeout = () => {}
  c.fetch = (_url, options) => {
    options.signal.addEventListener('abort', () => { aborts++ })
    return new Promise(() => {})
  }
  const first = c.pollLastTurn()
  await Promise.resolve()
  timeout()
  await first
  assert.equal(c.turnPollBusy, false)
  assert.equal(aborts, 1)
  c.fetch = async () => ({ ok: true, json: async () => ({ ok: true, seq: 5, streamId: 'new', reset: true, events: [] }) })
  await c.pollLastTurn()
  assert.equal(c.turnCursor.seq, 5)
})

test('clients serialize the entire notification ledger across both same and different event ids', async () => {
  const storage = new Map()
  const tails = new Map(), names = []
  const locks = { request: (id, run) => {
    names.push(id)
    const result = (tails.get(id) || Promise.resolve()).then(run)
    tails.set(id, result.catch(() => {}))
    return result
  } }
  const a = clientFixture({ storage, locks }), b = clientFixture({ storage, locks })
  await Promise.all([
    a.context.dshwPlayNotificationOnce('first', () => a.sounds.push('first')),
    b.context.dshwPlayNotificationOnce('second', () => b.sounds.push('second')),
  ])
  const c = clientFixture({ storage, locks })
  await c.context.dshwPlayNotificationOnce('first', () => c.sounds.push('first-again'))
  await c.context.dshwPlayNotificationOnce('second', () => c.sounds.push('second-again'))
  assert.equal(a.sounds.length + b.sounds.length + c.sounds.length, 2)
  assert.equal(new Set(names).size, 1, 'all events must lock the same shared read/modify/write ledger')
})

test('event timestamps reject malformed values without dropping a valid zero epoch', () => {
  assert.equal(eventTime({ time: 0 }, 99), 0)
  for (const time of [null, '123', NaN, -1, Infinity]) assert.equal(eventTime({ time }, 99), 99)
})
