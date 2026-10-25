import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function setup() {
  let exports, cleanup, lastMount, reloads = 0, stops = 0
  const scripts = []
  const parent = { appendChild(s) { scripts.push(s); lastMount = s.__dshWhaleMount; s.parentNode = parent }, removeChild(s) { scripts.splice(scripts.indexOf(s), 1); s.parentNode = null } }
  const window = {
    __ModuleLoader__: { load(row) { exports = row.factory(() => {}) } },
    location: { reload() { reloads++ } },
  }
  const document = { body: parent, querySelector() { return scripts[0] }, createElement() { return { dataset: {}, remove() { if (this.parentNode) this.parentNode.removeChild(this) } } } }
  const context = { window, document, globalThis: window, setTimeout: (fn) => fn(), fetch: async () => ({ status: 404 }) }
  vm.runInNewContext(source, context)
  const ctx = { effect(fn) { cleanup = fn() } }
  return { window, scripts, apply() { exports.apply(ctx) }, dispose() { cleanup() }, get reloads() { return reloads }, get stops() { return stops }, loaded() {
    const lifecycle = { owner: lastMount, stop() { stops++; if (window.__dshWhaleLifecycle === lifecycle) { delete window.__dshWhaleWidget; delete window.__dshWhaleLifecycle } } }
    window.__dshWhaleWidget = true; window.__dshWhaleLifecycle = lifecycle
    scripts[0]?.onload?.()
  } }
}
test('disable cleans the loaded widget and script without navigating; enable works again', async () => {
  const h = setup(); h.apply(); h.loaded(); h.dispose()
  await new Promise(setImmediate)
  assert.equal(h.reloads, 0, 'plugin disable must never reload the app')
  assert.equal(h.stops, 1)
  assert.equal(h.scripts.length, 0)
  h.apply(); assert.equal(h.scripts.length, 1)
  h.loaded(); h.dispose(); assert.equal(h.stops, 2)
})
test('disable before script execution cannot mount a late widget', () => {
  const h = setup(); h.apply(); const pending = h.scripts[0]; h.dispose()
  assert.equal(h.scripts.length, 0)
  h.loaded(); pending.onload?.()
  assert.equal(h.window.__dshWhaleWidget, undefined)
  assert.equal(h.stops, 1)
})

test('a late old onload cannot stop a newly enabled instance', () => {
  const h = setup(); h.apply(); const oldScript = h.scripts[0]; h.dispose()
  h.apply(); h.loaded(); const current = h.window.__dshWhaleLifecycle
  oldScript.onload()
  assert.equal(h.window.__dshWhaleLifecycle, current)
  assert.equal(h.stops, 0)
  h.dispose(); assert.equal(h.stops, 1)
})
