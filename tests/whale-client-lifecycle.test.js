import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8')

class FakeClassList {
  constructor() { this.values = new Set() }
  add(...values) { values.forEach((value) => this.values.add(value)) }
  remove(...values) { values.forEach((value) => this.values.delete(value)) }
  contains(value) { return this.values.has(value) }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = { setProperty() {}, removeProperty() {} }
    this.classList = new FakeClassList()
    this.attributes = {}
    this.listeners = []
    this.textContent = ''
    this.value = ''
    this.options = []
    this.isConnected = false
    this.offsetWidth = 120
    this.offsetHeight = 80
  }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] || null }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    child.isConnected = this.isConnected || this.tagName === 'HTML'
    this.children.push(child)
    return child
  }
  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    child.isConnected = false
    return child
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
  addEventListener(type, listener, options) { this.listeners.push({ type, listener, options }) }
  removeEventListener(type, listener) { this.listeners = this.listeners.filter((item) => item.listener !== listener || item.type !== type) }
  dispatchEvent(event) {
    for (const item of this.listeners.slice()) if (item.type === event.type) item.listener.call(this, event)
  }
  querySelector(selector) {
    if (this.matches(selector)) return this
    for (const child of this.children) {
      const found = child.querySelector(selector)
      if (found) return found
    }
    return null
  }
  querySelectorAll(selector) {
    const result = []
    if (this.matches(selector)) result.push(this)
    for (const child of this.children) result.push(...child.querySelectorAll(selector))
    return result
  }
  matches(selector) {
    if (selector === 'textarea') return this.tagName === 'TEXTAREA'
    if (selector === '[contenteditable="true"]') return this.attributes.contenteditable === 'true'
    if (selector === '[data-composer-input]') return this.attributes['data-composer-input'] != null
    if (selector === '[data-composer-seat],[data-composer-card]') return this.attributes['data-composer-seat'] != null || this.attributes['data-composer-card'] != null
    if (selector === '[role="textbox"][aria-multiline="true"]') return this.attributes.role === 'textbox' && this.attributes['aria-multiline'] === 'true'
    if (selector === 'svg') return this.tagName === 'SVG'
    if (selector === '.dshwv-bshape') return this.classList.contains('dshwv-bshape')
    if (selector === 'input,select,textarea,button') return ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(this.tagName)
    return false
  }
  getBoundingClientRect() { return { left: 10, top: 10, width: 120, height: 80, right: 130, bottom: 90 } }
  focus() {}
  blur() {}
  click() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getContext() { return { clearRect() {}, drawImage() {} } }
}

function createHarness({ chat = false } = {}) {
  let nextTimer = 1
  const timers = new Map()
  const observers = []
  const windowListeners = []
  const document = new FakeElement('document')
  const html = new FakeElement('html')
  const head = new FakeElement('head')
  const body = new FakeElement('body')
  const root = new FakeElement('div')
  document.documentElement = html
  document.head = head
  document.body = body
  html.isConnected = true
  html.appendChild(head)
  html.appendChild(body)
  body.appendChild(root)
  document.getElementById = (id) => id === 'root' ? root : null
  document.createElement = (tag) => new FakeElement(tag)
  document.createElementNS = (_ns, tag) => new FakeElement(tag)
  document.contains = (node) => node === html || Boolean(node && node.isConnected)
  document.hidden = false
  root.querySelector = function (selector) {
    if (chat && selector === 'textarea') return new FakeElement('textarea')
    return FakeElement.prototype.querySelector.call(this, selector)
  }

  const window = {
    document,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    location: { href: 'http://localhost/' },
    localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    addEventListener(type, listener, options) { windowListeners.push({ type, listener, options }) },
    removeEventListener(type, listener) {
      for (let i = windowListeners.length - 1; i >= 0; i--) if (windowListeners[i].type === type && windowListeners[i].listener === listener) windowListeners.splice(i, 1)
    },
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { kind: 'timeout', fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    setInterval(fn, delay) { const id = nextTimer++; timers.set(id, { kind: 'interval', fn, delay }); return id },
    clearInterval(id) { timers.delete(id) },
    requestAnimationFrame(fn) { const id = nextTimer++; timers.set(id, { kind: 'raf', fn }); return id },
    cancelAnimationFrame(id) { timers.delete(id) },
    fetch() { return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true }), arrayBuffer: async () => new ArrayBuffer(0) }) },
    AudioContext: class { constructor() { this.state = 'suspended'; this.destination = {}; this.currentTime = 0 } resume() {} suspend() {} close() {} },
  }
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this) }
    observe() { this.observing = true }
    disconnect() { this.disconnected = true; this.observing = false }
    trigger() { this.callback([]) }
  }
  const context = {
    window,
    document,
    MutationObserver: FakeMutationObserver,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    Promise,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
    RegExp,
    Error,
    console: { warn() {}, error() {}, log() {} },
    performance: { now: () => Date.now() },
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    fetch: window.fetch,
    isFinite,
  }
  window.window = window
  window.MutationObserver = FakeMutationObserver
  window.AbortController = AbortController
  window.AbortSignal = AbortSignal
  window.URL = URL
  window.URLSearchParams = URLSearchParams
  window.Promise = Promise
  window.console = context.console
  window.setTimeout = window.setTimeout.bind(window)
  window.clearTimeout = window.clearTimeout.bind(window)
  window.setInterval = window.setInterval.bind(window)
  window.clearInterval = window.clearInterval.bind(window)
  window.requestAnimationFrame = window.requestAnimationFrame.bind(window)
  window.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
  window.fetch = window.fetch.bind(window)
  context.globalThis = window
  return { context, window, document, root, timers, observers, windowListeners, setChat(value) { chat = value }, runTimer(id) { const timer = timers.get(id); if (timer) timer.fn() } }
}

function execute(harness) { vm.runInNewContext(source, harness.context, { filename: 'whale-widget.js' }) }

test('explicit stop dominates delayed startup and is idempotent', () => {
  const h = createHarness()
  execute(h)
  const oldLifecycle = h.window.__dshWhaleLifecycle
  assert.equal(oldLifecycle.active, true)
  assert.equal(h.observers.length, 1)
  assert.equal(h.timers.size, 1)
  assert.equal(oldLifecycle.stop('client-disabled'), true)
  assert.equal(oldLifecycle.stop('duplicate-stop'), false)
  assert.equal(oldLifecycle.active, false)
  assert.equal(oldLifecycle.reason, 'client-disabled')
  assert.equal(h.timers.size, 0)
  assert.equal(h.observers[0].disconnected, true)
  h.setChat(true)
  h.observers[0].trigger()
  assert.equal(h.window.__dshWhaleLifecycle, oldLifecycle)
  assert.equal(h.window.__dshWhaleInit, undefined)
})

test('stale instance cannot clean a newer instance and SPA reattach remains live', async () => {
  const h = createHarness()
  execute(h)
  const oldLifecycle = h.window.__dshWhaleLifecycle
  oldLifecycle.stop('host-unavailable')
  h.setChat(true)
  execute(h)
  const newLifecycle = h.window.__dshWhaleLifecycle
  assert.notEqual(newLifecycle, oldLifecycle)
  assert.equal(newLifecycle.active, true)
  assert.equal(h.window.__dshWhaleWidget, true)
  assert.equal(newLifecycle.stop('client-disabled'), true)
  assert.equal(oldLifecycle.stop('late-old-stop'), false)
  assert.equal(h.window.__dshWhaleLifecycle, newLifecycle)
  assert.equal(newLifecycle.active, false)
  assert.equal(h.timers.size, 0)
  assert.equal(h.windowListeners.length, 0)
  await new Promise((resolve) => setImmediate(resolve))
})

test('a host route that was never served does not disable the widget', async () => {
  const h = createHarness({ chat: true })
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

test('route invalidation after a served route stops the client without a host-only API', async () => {
  const h = createHarness({ chat: true })
  const calls = []
  h.window.fetch = () => new Promise((resolve) => { calls.push(resolve) })
  h.context.fetch = h.window.fetch
  execute(h)
  const lifecycle = h.window.__dshWhaleLifecycle
  const served = lifecycle.hostFetch('/dsh-whale/balance.json')
  calls[0]({ status: 200, ok: true, json: async () => ({ ok: false }) })
  await served
  assert.equal(lifecycle.active, true, 'a served host route keeps the client running')
  const gone = lifecycle.hostFetch('/dsh-whale/balance.json')
  calls[1]({ status: 404, ok: false, json: async () => ({ ok: false }) })
  await gone
  assert.equal(lifecycle.active, false)
  assert.equal(lifecycle.reason, 'host-unavailable')
  assert.equal(h.timers.size, 0, 'stop clears every timer this instance owns')
})

test('a stopped client refuses further host requests', async () => {
  const h = createHarness()
  execute(h)
  const lifecycle = h.window.__dshWhaleLifecycle
  lifecycle.stop('client-disabled')
  await assert.rejects(() => lifecycle.hostFetch('/dsh-whale/balance.json'), /whale client stopped/)
})
