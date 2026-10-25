import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8')
// Exercise the real startup/lifecycle code with a tiny renderer double. Full
// rendering and visual presence are verified in the actual Desktop application.
const renderStart = source.indexOf('function dshwInit() {')
const renderEnd = source.lastIndexOf('\n}\n// ')
assert.ok(renderStart > 0 && renderEnd > renderStart)
const startupSource = source.slice(0, renderStart) + `function dshwInit() {
  if (window.failRender) throw new Error('render failed')
  window.mountCount = (window.mountCount || 0) + 1
  window.__dshWhaleInit = true
}\n` + source.slice(renderEnd + 2)

function setup({ bodyReady = true, failRender = false } = {}) {
  const listeners = new Map(), timers = new Map(), errors = []
  let nextId = 0
  const window = {
    failRender,
    setTimeout(fn) { const id = ++nextId; timers.set(id, fn); return id },
    clearTimeout(id) { timers.delete(id) },
    setInterval(fn) { const id = ++nextId; timers.set(id, fn); return id },
    clearInterval(id) { timers.delete(id) },
    requestAnimationFrame() { return ++nextId }, cancelAnimationFrame() {},
    fetch: async () => ({ ok: true }),
  }
  const document = {
    body: bodyReady ? {} : null,
    documentElement: {},
    getElementById() { return { querySelector() { return null } } },
    addEventListener(type, callback) { listeners.set(type, callback) },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type) },
  }
  const context = { window, document, AbortController, AbortSignal,
    console: { error(...args) { errors.push(args) } },
    MutationObserver: class { observe() {} disconnect() {} },
  }
  vm.runInNewContext(startupSource, context)
  return { window, document, listeners, timers, errors }
}

test('enable on the Plugins page mounts immediately without a chat composer', () => {
  const h = setup()
  assert.equal(h.window.mountCount, 1)
  assert.equal(h.window.__dshWhaleLifecycle.active, true)
  assert.equal(h.timers.size, 0, 'startup must not poll for a chat input')
})
test('cold startup waits only for body readiness and initializes once', () => {
  const h = setup({ bodyReady: false })
  assert.equal(h.window.mountCount, undefined)
  const ready = h.listeners.get('DOMContentLoaded')
  assert.equal(typeof ready, 'function')
  h.document.body = {}
  ready(); ready()
  assert.equal(h.window.mountCount, 1)
})
test('disable before DOM readiness prevents a late startup', () => {
  const h = setup({ bodyReady: false })
  const ready = h.listeners.get('DOMContentLoaded')
  assert.equal(typeof ready, 'function')
  h.window.__dshWhaleLifecycle.stop('client-disabled')
  h.document.body = {}
  ready?.()
  assert.equal(h.window.mountCount, undefined)
  assert.equal(h.listeners.size, 0)
})
test('initialization failure is reported and clears active markers', () => {
  const h = setup({ failRender: true })
  assert.equal(h.errors.length, 1)
  assert.equal(h.window.__dshWhaleWidget, undefined)
  assert.equal(h.window.__dshWhaleLifecycle.active, false)
  assert.equal(h.window.__dshWhaleLifecycle.reason, 'initialization-failed')
})
