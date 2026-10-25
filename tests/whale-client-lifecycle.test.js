import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8')

// Run the real asset before body readiness to isolate lifecycle behavior.
// Rendering on Plugins and Chat is exercised separately in Desktop E2E.
function createHarness() {
  let nextId = 0
  const timers = new Map(), observers = [], windowListeners = []
  const document = {
    body: null, listeners: [],
    addEventListener(type, listener, options) { this.listeners.push({ type, listener, options }) },
    removeEventListener(type, listener) { this.listeners = this.listeners.filter(x => x.type !== type || x.listener !== listener) },
  }
  const window = {
    setTimeout(fn) { const id = ++nextId; timers.set(id, fn); return id },
    clearTimeout(id) { timers.delete(id) },
    setInterval(fn) { const id = ++nextId; timers.set(id, fn); return id },
    clearInterval(id) { timers.delete(id) },
    requestAnimationFrame() { return ++nextId }, cancelAnimationFrame() {},
    fetch: async () => ({ ok: true }),
  }
  const context = { window, document, AbortController, AbortSignal, console }
  return { window, document, context, timers, observers, windowListeners }
}

function execute(harness) { vm.runInNewContext(source, harness.context, { filename: 'whale-widget.js' }) }

test('explicit stop dominates delayed startup and is idempotent', () => {
  const h = createHarness()
  execute(h)
  const oldLifecycle = h.window.__dshWhaleLifecycle
  assert.equal(oldLifecycle.active, true)
  const ready = h.document.listeners.find(x => x.type === 'DOMContentLoaded').listener
  assert.equal(h.observers.length, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(oldLifecycle.stop('client-disabled'), true)
  assert.equal(oldLifecycle.stop('duplicate-stop'), false)
  assert.equal(oldLifecycle.active, false)
  assert.equal(oldLifecycle.reason, 'client-disabled')
  assert.equal(h.timers.size, 0)
  assert.equal(h.document.listeners.length, 0)
  h.document.body = {}
  ready()
  assert.equal(h.window.__dshWhaleLifecycle, oldLifecycle)
  assert.equal(h.window.__dshWhaleInit, undefined)
})

test('repeated stop from an old instance cannot clear a newer instance', async () => {
  const h = createHarness()
  execute(h)
  const oldLifecycle = h.window.__dshWhaleLifecycle
  oldLifecycle.stop('host-unavailable')
  execute(h)
  const newLifecycle = h.window.__dshWhaleLifecycle
  assert.notEqual(newLifecycle, oldLifecycle)
  assert.equal(newLifecycle.active, true)
  assert.equal(h.window.__dshWhaleWidget, true)
  assert.equal(oldLifecycle.stop('late-old-stop'), false)
  assert.equal(newLifecycle.active, true)
  assert.equal(newLifecycle.stop('client-disabled'), true)
  assert.equal(h.window.__dshWhaleLifecycle, newLifecycle)
  assert.equal(newLifecycle.active, false)
  assert.equal(h.timers.size, 0)
  assert.equal(h.windowListeners.length, 0)
  await new Promise((resolve) => setImmediate(resolve))
})

test('a host route that was never served does not disable the widget', async () => {
  const h = createHarness()
  const calls = []
  h.window.fetch = () => new Promise((resolve) => { calls.push(resolve) })
  h.context.fetch = h.window.fetch
  execute(h)
  const lifecycle = h.window.__dshWhaleLifecycle
  const pending = lifecycle.hostFetch('/dsh-whale/balance.json')
  assert.equal(calls.length, 1)
  calls[0]({ status: 404, ok: false, json: async () => ({ ok: false }) })
  await pending
  assert.equal(lifecycle.active, true, 'an absent optional route must not stop the client')
  lifecycle.stop('test-teardown')
})

test('a stopped client refuses further host requests', async () => {
  const h = createHarness()
  execute(h)
  const lifecycle = h.window.__dshWhaleLifecycle
  lifecycle.stop('client-disabled')
  await assert.rejects(() => lifecycle.hostFetch('/dsh-whale/balance.json'), /whale client stopped/)
})

test('a cancelled script cannot start, even if its response arrives after disable', () => {
  const h = createHarness()
  h.document.currentScript = { __dshWhaleMount: { active: false } }
  execute(h)
  assert.equal(h.window.__dshWhaleLifecycle, undefined)
  assert.equal(h.window.__dshWhaleWidget, undefined)
  assert.equal(h.timers.size, 0)
  assert.equal(h.observers.length, 0)
})

test('stop aborts pending requests while preserving unrelated page listeners', async () => {
  const h = createHarness()
  const external = () => {}
  h.document.addEventListener('pointerdown', external)
  h.window.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  execute(h)
  const lifecycle = h.window.__dshWhaleLifecycle
  const request = lifecycle.hostFetch('/dsh-whale/balance.json')
  lifecycle.stop('client-disabled')
  await assert.rejects(request, { name: 'AbortError' })
  assert.equal(h.document.listeners.some(x => x.listener === external), true)
  assert.deepEqual(JSON.parse(JSON.stringify(lifecycle.resources())), { timers: 0, observers: 0, listeners: 0, nodes: 0, audioContexts: 0 })
})
