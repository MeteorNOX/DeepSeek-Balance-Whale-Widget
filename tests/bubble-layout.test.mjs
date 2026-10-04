import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const lines = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8').split(/\r?\n/)
function code(name) {
  const start = lines.findIndex((s) => s.startsWith('function ' + name + '('))
  assert.ok(start >= 0)
  const end = lines.findIndex((s, i) => i > start && s === '}')
  assert.ok(end > start)
  return lines.slice(start, end + 1).join('\n')
}
const ctx = vm.createContext({})
vm.runInContext(code('bubbleTextRectFits') + '\n' + code('bubbleFitText'), ctx)
const centered = (w, h) => ({ left: 454 - w / 2, right: 454 + w / 2, top: 247 - h / 2, bottom: 247 + h / 2 })

test('ellipse containment checks block corners, not only its center or total width', () => {
  assert.equal(ctx.bubbleTextRectFits(centered(500, 100)), true)
  assert.equal(ctx.bubbleTextRectFits(centered(500, 400)), false)
  assert.equal(ctx.bubbleTextRectFits({ left: NaN, right: 10, top: 10, bottom: 20 }), false)
})
test('the entire scroll viewport lies within the inset ellipse', () => {
  assert.equal(ctx.bubbleTextRectFits(centered(510, 290)), true)
})
function fixture(rect, mirrored = false) {
  const classes = new Set()
  const attrs = {}
  const svg = {
    getScreenCTM: () => ({ inverse: () => ({}) }),
    createSVGPoint: () => ({ x: 0, y: 0, matrixTransform() { return { x: mirrored ? 908 - this.x : this.x, y: this.y } } }),
  }
  const el = {
    parentNode: { querySelector: () => svg }, children: [{
      getBoundingClientRect: () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }),
      scrollWidth: 100, clientWidth: 100,
    }],
    classList: { remove: (v) => classes.delete(v), toggle: (v, on) => on ? classes.add(v) : classes.delete(v) },
    scrollTop: 30, setAttribute: (k, v) => { attrs[k] = v }, removeAttribute: (k) => { delete attrs[k] },
  }
  return { el, classes, attrs }
}
test('overflow enters a keyboard-accessible region and retains scroll position on updates', () => {
  const f = fixture(centered(500, 400))
  ctx.bubbleFitText(f.el, false)
  assert.ok(f.classes.has('dshwv-text-scroll'))
  assert.equal(f.el.scrollTop, 30)
  assert.equal(f.attrs.tabindex, '0')
  assert.equal(f.attrs.role, 'region')
  ctx.bubbleFitText(f.el, true)
  assert.equal(f.el.scrollTop, 0)
})
test('short content leaves overflow mode and needs no extra tab stop', () => {
  const f = fixture(centered(300, 100))
  f.classes.add('dshwv-text-scroll'); f.attrs.tabindex = '0'
  ctx.bubbleFitText(f.el, false)
  assert.equal(f.classes.has('dshwv-text-scroll'), false)
  assert.equal(f.attrs.tabindex, undefined)
})
test('mirror transforms do not invert the rectangle containment test', () => {
  const f = fixture(centered(500, 400), true)
  ctx.bubbleFitText(f.el, false)
  assert.equal(f.classes.has('dshwv-text-scroll'), true)
})
