import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const renderingSource = read('desktop/ui/render.js'), inputSource = read('desktop/ui/input.js'), shapeSource = read('desktop/ui/shape.js');
const widgetSource = read('assets/whale-widget.js');
function realFunction(source, name, indent = '    ') {
  const start = source.indexOf(indent + 'function ' + name + '('); assert.ok(start >= 0, name);
  const end = source.indexOf('\n' + indent + '}', start) + indent.length + 2;
  return source.slice(start, end);
}
function geometry() {
  let now = 1000, nextTimer = 0, compression = 1, flip = false;
  const timers = new Map(), callbacks = [], changes = [];
  const root = { offsetWidth: 400, offsetHeight: 400, isConnected: true,
    rect: { left: 0, top: 0, width: 400, height: 400 }, getBoundingClientRect() { return this.rect; }, hasPointerCapture: () => false };
  const body = { offsetLeft: 0, offsetTop: 0, offsetParent: root };
  const img = { offsetLeft: 100, offsetTop: 100, offsetWidth: 300, offsetHeight: 300, offsetParent: body,
    src: 'fixture.png', currentSrc: 'fixture.png', isConnected: true, complete: true, naturalWidth: 300,
    checkVisibility: () => true, closest: selector => selector === '.dshwv-root' ? root : null,
    getBoundingClientRect() {
      const r = root.rect, sx = r.width / 400, sy = r.height / 400, stretch = compression === 1 ? 1 : 1.05;
      const localLeft = 200 + (100 - 200) * stretch, width = 300 * stretch * sx, height = 300 * compression * sy;
      const left = r.left + (flip ? 400 - localLeft - 300 * stretch : localLeft) * sx;
      const top = r.top + (400 - 300 * compression) * sy;
      return { left, top, width, height, right: left + width, bottom: top + height };
    } };
  const start = renderingSource.indexOf('    hit(img, x, y, flipped = false'), end = renderingSource.indexOf('\n    }', start) + 6;
  const hit = vm.runInNewContext('({' + renderingSource.slice(start, end) + '})').hit;
  const cache = { stats: { hits: 0 }, key: x => x, entries: new Map([['fixture.png', { done: true,
    mask: { width: 3, height: 3, alpha: new Uint8Array([0, 255, 255, 255, 255, 255, 255, 255, 255]) } }]]), prepare() {}, hit };
  const context = { mirrorScale: () => flip ? -1 : 1, Date, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(renderingSource.slice(renderingSource.indexOf('  function petLayoutRect('), renderingSource.indexOf('  class BubbleRenderer')) + '\nthis.PetInteraction=PetInteraction;', context);
  const api = new context.PetInteraction(cache, { now: () => now,
    timer: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clear: id => timers.delete(id),
    changed: ms => { changes.push(ms); for (const fn of callbacks) fn(); } });
  return { api, root, img, body, cache, timers, callbacks, changes, context, Ctor: context.PetInteraction,
    now: () => now, setNow: x => { now = x; }, compress: x => { compression = x; }, mirror: x => { flip = x; }, flipped: () => flip };
}
function input(g) {
  const events = {}, windows = {}, frames = [], enabled = []; let cursor;
  const listen = (map, name, fn) => { (map[name] ||= []).push(fn); };
  const document = { body: {}, hidden: false, querySelector: s => s === '.dshwv-img' ? g.img : g.root,
    querySelectorAll: () => [], elementFromPoint: () => null, addEventListener: (name, fn) => listen(events, name, fn) };
  const rendering = { petInteraction: g.api, hitCache: g.cache, mirrorScale: () => g.flipped() ? -1 : 1,
    presentFor() {}, onFrame(fn) { this.frame = fn; } };
  const window = { WhaleRendering: rendering, whaleDesktop: { testMode: true, interactive: b => enabled.push(b), keyboardFocus() {}, onCursor(fn) { cursor = fn; } },
    addEventListener: (name, fn) => listen(windows, name, fn), dispatchEvent() {} };
  const box = { window, document, Date: { now: g.now }, requestAnimationFrame: fn => frames.push(fn),
    MutationObserver: class { observe() {} }, getComputedStyle: () => ({ pointerEvents: 'auto' }), CustomEvent: class {} };
  vm.createContext(box); vm.runInContext(inputSource.slice(0, inputSource.indexOf('  async function prepare()')) + '})();', box);
  g.callbacks.push(() => { for (const fn of windows['whale-interaction-geometry'] || []) fn(); });
  return { enabled, api: window.__whaleInputTest, cursor: p => cursor(p),
    event: (name, e) => { for (const fn of events[name] || []) fn(e); },
    hidden: value => { document.hidden = value; for (const fn of events.visibilitychange || []) fn(); },
    window: name => { for (const fn of windows[name] || []) fn(); }, frame: () => { for (const fn of frames.splice(0)) fn(); rendering.frame(); } };
}

test('large-pet upper-edge remains alpha-hit through hold, first release RAF and a rapid second click', () => {
  const g = geometry(), h = input(g), p = { clientX: 250, clientY: 105, pointerId: 1, buttons: 0 };
  h.event('mousemove', p); assert.equal(h.api.status().interactive, true);
  g.api.begin(g.img, g.root, 1); g.compress(.88); g.root.hasPointerCapture = () => true;
  h.event('pointerdown', { ...p, buttons: 1 }); assert.equal(g.cache.hit(g.img, 250, 105), false);
  assert.equal(g.api.hit(g.img, g.root, 250, 105), true);
  g.api.end(1, 140); g.root.hasPointerCapture = () => false;
  h.event('lostpointercapture', p); h.event('pointerup', p); h.frame();
  assert.equal(h.api.status().interactive, true);
  g.setNow(1050); g.api.begin(g.img, g.root, 1); g.root.hasPointerCapture = () => true;
  h.event('pointerdown', { ...p, buttons: 1 }); assert.equal(g.api.holding(), true);
  assert.deepEqual(h.enabled, [true], 'no native ignore interval within the click burst');
});

test('the real widget predicate and native region use the same retained geometry as input routing', () => {
  const g = geometry(); g.api.begin(g.img, g.root, 1); g.compress(.88);
  const predicate = vm.createContext({ img: g.img, root: g.root, WhaleRendering: { petInteraction: g.api } });
  vm.runInContext(realFunction(widgetSource, 'isWhaleHit'), predicate);
  assert.equal(predicate.isWhaleHit({ clientX: 250, clientY: 105 }), true);
  const window = { whaleDesktop: { platform: 'win32', testMode: true, shape() {} }, WhaleRendering: { petInteraction: g.api, onFrame() {} }, addEventListener() {} };
  const document = { body: {}, documentElement: {}, querySelectorAll: selector => selector === '.dshwv-img' ? [g.img] : [], addEventListener() {} };
  vm.runInNewContext(shapeSource, { window, document, innerWidth: 1000, innerHeight: 800, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} unobserve() {} }, MutationObserver: class { observe() {} } });
  const rects = window.__whaleShapeTest.status().rectangles;
  assert.ok(rects.some(r => 250 >= r.x && 250 < r.x + r.width && 105 >= r.y && 105 < r.y + r.height));
  assert.ok(rects.every(r => r.width < 500 && r.height < 500), 'no viewport-wide input backdrop');
});

test('transparent mask pixels remain transparent; cancellation never turns the rest rectangle into a solid hitbox', () => {
  const g = geometry(); g.api.begin(g.img, g.root, 1); g.compress(.88);
  assert.equal(g.api.hit(g.img, g.root, 101, 101), false);
  assert.equal(g.api.hit(g.img, g.root, 250, 105), true);
  g.api.cancel(); assert.equal(g.api.hit(g.img, g.root, 250, 105), false); assert.equal(g.api.protectedBounds(), null);
});

test('late release timers cannot erase a new press, while release timeout ends a stationary protection', () => {
  const g = geometry(); g.api.begin(g.img, g.root, 1); g.api.end(1, 140);
  const old = [...g.timers.values()][0].fn;
  g.api.begin(g.img, g.root, 1); old(); assert.equal(g.api.holding(), true);
  g.api.end(1, 155); g.setNow(1188); assert.equal(g.api.protectedBounds(), null); assert.equal(g.timers.size, 0);
});

test('leaving the alpha footprint, changing role or losing visibility cancels protection promptly', () => {
  const g = geometry(); g.api.begin(g.img, g.root, 1); g.api.end(1, 140); g.api.move({ x: 900, y: 700 }); assert.equal(g.api.protectedBounds(), null);
  g.api.begin(g.img, g.root, 1); g.img.src = 'other.png'; assert.equal(g.api.protectedBounds(), null);
  g.img.src = 'fixture.png'; const h = input(g);
  for (const event of ['blur', 'whale-mode-changing', 'whale-desktop-mode']) {
    g.api.begin(g.img, g.root, 1); h.window(event); assert.equal(g.api.protectedBounds(), null); assert.equal(h.api.status().interactive, false);
  }
  g.api.begin(g.img, g.root, 1); h.hidden(true); assert.equal(g.api.protectedBounds(), null); assert.equal(h.api.status().interactive, false);
});

test('layout geometry follows root translation, scale and mirror without freezing old coordinates', () => {
  const g = geometry(); g.api.begin(g.img, g.root, 1);
  g.root.rect = { left: 40, top: 20, width: 200, height: 200 };
  let r = g.api.protectedBounds(); assert.deepEqual([r.left, r.top, r.width, r.height], [90, 70, 150, 150]);
  g.mirror(true); r = g.api.protectedBounds(); assert.deepEqual([r.left, r.top, r.width, r.height], [40, 70, 150, 150]);
  assert.equal(g.api.hit(g.img, g.root, 115, 73), true);
});

test('old or equal-time native button samples cannot override real pointerup; newer samples still protect external drags', () => {
  const g = geometry(), h = input(g), p = { clientX: 250, clientY: 250, pointerId: 1, buttons: 0 };
  h.event('mousemove', p); g.setNow(1010); h.event('pointerdown', { ...p, buttons: 1 });
  g.setNow(1050); h.event('pointerup', p); h.frame();
  for (const sampledAt of [1005, 1049, 1050, 0, undefined]) {
    h.cursor({ x: 250, y: 250, buttons: 1, sampledAt }); assert.equal(h.api.status().externalDrag, false);
  }
  h.cursor({ x: 250, y: 250, buttons: 1, sampledAt: 1060 }); assert.equal(h.api.status().externalDrag, true); assert.equal(h.api.status().interactive, false);
  h.cursor({ x: 250, y: 250, buttons: 0, sampledAt: 1059 }); assert.equal(h.api.status().externalDrag, true);
  h.cursor({ x: 250, y: 250, buttons: 0, sampledAt: 1070 }); assert.equal(h.api.status().externalDrag, false); assert.equal(h.api.status().interactive, true);
});

test('unexpected lost capture and pointercancel clear the gesture, but stale release RAF cannot clear a newer press', () => {
  const g = geometry(), h = input(g), p = { clientX: 250, clientY: 250, pointerId: 1, buttons: 0 };
  g.api.begin(g.img, g.root, 1); h.event('pointerdown', p); h.event('lostpointercapture', p);
  assert.equal(g.api.protectedBounds(), null); assert.equal(h.api.status().heldPointer, null);
  g.api.begin(g.img, g.root, 1); h.event('pointerdown', p); h.event('pointercancel', p); assert.equal(g.api.protectedBounds(), null);
  g.api.begin(g.img, g.root, 1); h.event('pointerdown', p); g.api.end(1, 140); h.event('pointerup', p);
  g.api.begin(g.img, g.root, 1); h.event('pointerdown', p); h.frame(); assert.equal(h.api.status().heldPointer, 1);
});

test('default browser timer APIs are not invoked with the geometry object as their receiver', () => {
  const g = geometry(), calls = [];
  g.context.setTimeout = function (fn, ms) { assert.equal(this instanceof g.Ctor, false, 'Window timer brand'); calls.push(ms); return 1; };
  g.context.clearTimeout = function () { assert.equal(this instanceof g.Ctor, false, 'Window clearTimer brand'); };
  const api = new g.Ctor(g.cache, { now: g.now });
  assert.equal(api.begin(g.img, g.root, 1), true); api.end(1, 140);
  assert.deepEqual(calls, [172]); assert.equal(api.releasing(1), true); api.cancel(); assert.equal(api.state, null);
});
