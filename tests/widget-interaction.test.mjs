// Run reviewed functions from the shipped client; no DSH, browser profile or network is used.
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import test from 'node:test'

const source = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8')
const lines = source.split(/\r?\n/)
function functionSource(name) {
  const start = lines.findIndex((line) => line.startsWith('function ' + name + '('))
  assert.notEqual(start, -1, 'missing client function: ' + name)
  if (lines[start].endsWith('}')) return lines[start]
  const end = lines.findIndex((line, i) => i > start && line === '}')
  assert.ok(end > start, 'missing function end: ' + name)
  return lines.slice(start, end + 1).join('\n')
}
function sandbox(names, env = {}) {
  const ctx = vm.createContext(env)
  vm.runInContext(names.map(functionSource).join('\n'), ctx)
  return ctx
}
const plain = (value) => JSON.parse(JSON.stringify(value))
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const noop = () => {}

test('expired TTL cancels a retained timer handle and closes exactly once', () => {
  let closed = 0
  const cancelled = []
  const c = sandbox(['bubbleTtlSweep'], {
    Date: { now: () => 6000 }, bubbleTtlTimer: 17, bubbleTtlDeadline: 5000,
    bubbleScene: { kind: 'normal', ttlMs: 5000 },
    clearTimeout: (id) => cancelled.push(id), bubbleAutoClose: () => closed++,
  })
  c.bubbleTtlSweep(); c.bubbleTtlSweep()
  assert.equal(closed, 1)
  assert.deepEqual(cancelled, [17])
  assert.equal(c.bubbleTtlTimer, null)
  assert.equal(c.bubbleTtlDeadline, 0)
})
test('TTL sweep handles lost timers, renewal, permanent waits and cleared scenes', () => {
  for (const [timer, deadline, scene, expected] of [
    [null, 5000, { kind: 'normal', ttlMs: 5000 }, 1],
    [17, 9000, { kind: 'normal', ttlMs: 5000 }, 0],
    [null, 5000, { kind: 'wait', ttlMs: 0 }, 0],
    [null, 5000, null, 0],
    [null, 0, { kind: 'normal', ttlMs: 5000 }, 0],
  ]) {
    let closed = 0
    const c = sandbox(['bubbleTtlSweep'], {
      Date: { now: () => 6000 }, bubbleTtlTimer: timer, bubbleTtlDeadline: deadline,
      bubbleScene: scene, clearTimeout: noop, bubbleAutoClose: () => closed++,
    })
    c.bubbleTtlSweep()
    assert.equal(closed, expected)
  }
})
test('renewal updates the deadline and scene cleanup cancels it during a transition', () => {
  const c = sandbox(['bubbleTtlArmed', 'bubbleTtlClear', 'bubbleResetTtl', 'bubbleClearAll'], {
    Date: { now: () => 6000 }, bubbleTtlTimer: 17, bubbleTtlDeadline: 5000,
    bubbleScene: { kind: 'normal', ttlMs: 5000 },
    clearTimeout: noop, setTimeout: () => 18, bubbleAutoClose: noop,
    bubbleTimer: null, bubbleSwapTimer: null, hintFadeTimer: null, gifFadeTimer: null,
    costBubbleTimer: null, animId: null, animDelayTimer: null, settleTimer: null,
  })
  c.bubbleResetTtl()
  assert.equal(c.bubbleTtlDeadline, 11000)
  c.bubbleClearAll()
  assert.equal(c.bubbleTtlDeadline, 0)
  assert.equal(c.bubbleTtlTimer, null)
})
test('repeated body attachment stays deferred for the whole IME composition', () => {
  const attached = []
  const c = sandbox(['dshwBodyAppend', 'dshwBodyDetach', 'dshwvFlushDeferredBody'], {
    dshwvComposing: true, dshwvDeferredBody: [], dshwBodyNodes: [],
    document: { body: { appendChild: (el) => attached.push(el) } },
  })
  const el = {}
  c.dshwBodyAppend(el); c.dshwBodyAppend(el); c.dshwvFlushDeferredBody()
  assert.equal(attached.length, 0)
  assert.equal(c.dshwvDeferredBody.length, 1)
  c.dshwvComposing = false
  c.dshwvFlushDeferredBody()
  assert.deepEqual(attached, [el])
  assert.equal(c.dshwBodyNodes.length, 1)
})
test('open/edit/save preserves single, choice and option names without sharing module arrays', () => {
  const items = [
    { kind: 'custom', name: 'Balance screen', modules: [{ type: 'text', text: 'old' }] },
    { kind: 'choice', name: 'Choice screen', options: [
      { name: 'Option A', w: 2, item: { kind: 'custom', name: 'Screen A', modules: [] } },
      { w: 5, item: { kind: 'custom', name: 'Screen B', modules: [] } },
    ] },
  ]
  const c = sandbox(['bubbleWithName', 'bubbleIsChoice', 'bubbleChoiceOptions', 'bubbleChoiceWeight',
    'bubbleSingleFromItem', 'openBubbleEditorWithCache', 'bubbleStepToSaved'], {
    bubbleCfg: { items }, bubbleLib: [], bubbleTapAdvance: false, bubbleTapAdvChk: {},
    bubbleEditItems: [], bubbleEditorSnap: null, bubbleMask: { style: {} },
    closeRolePanel: noop, closeAudioGroupPanel: noop, renderBubbleEditor: noop, bubbleRowsCanon: noop,
  })
  c.openBubbleEditorWithCache()
  c.bubbleEditItems[0].modules[0].text = 'edited'
  assert.equal(items[0].modules[0].text, 'old')
  const saved = plain(c.bubbleEditItems.map(c.bubbleStepToSaved))
  assert.equal(saved[0].name, 'Balance screen')
  assert.equal(saved[1].name, 'Choice screen')
  assert.equal(saved[1].options[0].name, 'Option A')
  assert.equal(saved[1].options[0].item.name, 'Screen A')
  assert.equal(saved[1].options[1].item.name, 'Screen B')
  assert.deepEqual(saved[1].options.map((o) => o.w), [2, 5])
  assert.deepEqual(plain(c.bubbleStepToSaved({ kind: 'custom', modules: [] })), { kind: 'custom', modules: [] })
})
function menuSandbox(top, viewport = { w: 400, h: 600 }, content = { w: 250, h: 300 }) {
  const style = {}
  const box = { style,
    get offsetWidth() { return Math.min(content.w, parseFloat(style.maxWidth)) },
    get offsetHeight() { return Math.min(content.h, parseFloat(style.maxHeight)) },
  }
  const c = sandbox(['positionMenu'], {
    root: { getBoundingClientRect: () => ({ left: 0, bottom: top + 150, width: 150, height: 150 }) },
    menuBtn: { getBoundingClientRect: () => ({ left: 120, right: 140, bottom: top + 85 }) },
    menuBox: box, viewport: () => viewport, clamp, widgetTopMin: () => 0,
  })
  c.positionMenu()
  assert.ok(parseFloat(style.top) >= 8)
  assert.ok(parseFloat(style.top) + box.offsetHeight <= viewport.h - 8)
  assert.ok(parseFloat(style.left) >= 8)
  assert.ok(parseFloat(style.left) + box.offsetWidth <= viewport.w - 8)
  return style
}
test('menus open below a top-edge whale and above a bottom-edge whale', () => {
  assert.equal(menuSandbox(0).transformOrigin, 'top left')
  assert.equal(menuSandbox(450).transformOrigin, 'bottom left')
})
test('a large menu is scrollable and kept inside a narrow viewport', () => {
  assert.equal(menuSandbox(0, { w: 180, h: 220 }, { w: 340, h: 800 }).overflowY, 'auto')
})
function pointerEvent(type, pointerId = 7, detail = type === 'click' ? 1 : 0) {
  return { type, pointerId, detail, pointerType: 'touch', button: 0,
    target: { closest: () => null }, prevented: 0, stopped: 0,
    preventDefault() { this.prevented++ }, stopPropagation() { this.stopped++ },
  }
}
function dismissalSandbox() {
  const c = sandbox(['consumeMenuDismissPointer', 'onMenuDismissPointerEnd', 'onDocPointerDown', 'onDocClickStopper'], {
    menuOpen: true, menuDismissPointer: null, isWhaleHit: () => false,
  })
  c.closeMenu = () => { c.menuOpen = false }
  return c
}
test('only the pointer sequence dismissing the menu is consumed', () => {
  const c = dismissalSandbox()
  const down = pointerEvent('pointerdown'), up = pointerEvent('pointerup'), click = pointerEvent('click')
  c.onDocPointerDown(down); c.onMenuDismissPointerEnd(up); c.onDocClickStopper(click)
  for (const e of [down, up, click]) assert.equal(e.prevented, 1)
  assert.equal(c.menuOpen, false)
  const next = pointerEvent('pointerdown')
  c.onDocPointerDown(next)
  const nextClick = pointerEvent('click')
  c.onDocClickStopper(nextClick)
  assert.equal(next.prevented + nextClick.prevented, 0)
})
test('menu dismissal permits keyboard activation, other pointers and gestures after cancel', () => {
  const c = dismissalSandbox()
  c.onDocPointerDown(pointerEvent('pointerdown'))
  for (const e of [pointerEvent('click', 7, 0), pointerEvent('click', 9)]) {
    c.onDocClickStopper(e)
    assert.equal(e.prevented, 0)
  }
  c.onMenuDismissPointerEnd(pointerEvent('pointercancel'))
  assert.equal(c.menuDismissPointer, null)
})
test('legacy MouseEvent click following a touch dismissal is consumed', () => {
  const c = dismissalSandbox()
  c.onDocPointerDown(pointerEvent('pointerdown'))
  const e = pointerEvent('click')
  delete e.pointerId
  c.onDocClickStopper(e)
  assert.equal(e.prevented, 1)
})
function anchorSandbox(initial, saved = null) {
  let stored = saved && JSON.stringify(saved)
  const c = sandbox(['saveAnchorPos', 'applyAnchorPos', 'settle', 'refreshFlip', 'artCenterAt', 'snapBounds', 'express'], {
    state: { ...initial }, viewport: () => ({ w: 600, h: 800 }),
    root: { offsetWidth: 100, offsetHeight: 100, style: {}, classList: { toggle: noop } },
    drag: null, snapConfig: null, widgetTopMin: () => 0, scrollGapOn: true, rightGap: () => 12,
    clamp, clampWidgetTop: (v, hi = Infinity) => clamp(v, 0, hi),
    localStorage: { getItem: () => stored, setItem: (key, value) => { stored = value } },
  })
  return { c, saved: () => JSON.parse(stored) }
}
test('position round trips free axes and edge distances without a storage version migration', () => {
  for (const axes of [[null, null], [null, 'bottom'], ['right', null], ['right', 'bottom']]) {
    const left = axes[0] === null ? 250 : 350 // Free whale faces right even though its nearest edge is left.
    const { c, saved } = anchorSandbox({ left, top: 530, h: axes[0], v: axes[1], flip: false })
    c.saveAnchorPos()
    assert.equal(saved().v, 2)
    c.state = { left: 0, top: 0 }
    assert.equal(c.applyAnchorPos(), true)
    c.settle()
    assert.equal(c.state.left, left)
    assert.equal(c.state.top, 530)
    assert.equal(c.state.h, axes[0])
    assert.equal(c.state.v, axes[1])
    assert.equal(c.state.flip, false)
  }
})
test('old v2 position data still restores its original anchored semantics', () => {
  const { c } = anchorSandbox({}, { v: 2, hAnchor: 'left', hDist: 40, vAnchor: 'top', vDist: 50 })
  assert.equal(c.applyAnchorPos(), true)
  assert.equal(c.state.h, 'left')
  assert.equal(c.state.v, 'top')
  assert.equal(c.state.hOff, 40)
  assert.equal(c.state.vOff, 50)
})
test('audio does not fetch or unlock before configuration, or after a saved mute', () => {
  let contexts = 0
  const fetched = []
  const c = sandbox(['dshwvSoundOff', 'dshwvWarm'], {
    configLoaded: false, soundOn: true,
    dshwvAudio: () => contexts++, dshwvAudioBuffer: (url) => { fetched.push(url); return Promise.resolve() },
  })
  c.dshwvWarm(['press'])
  assert.equal(c.dshwvSoundOff(), true)
  c.configLoaded = true; c.soundOn = false
  c.dshwvWarm(['press'])
  assert.equal(contexts, 0)
  assert.deepEqual(fetched, [])
  c.soundOn = true
  c.dshwvWarm(['press', '', 'release'])
  assert.equal(contexts, 1)
  assert.deepEqual(fetched, ['press', 'release'])
})
