import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const shapeSource = await readFile(new URL('../desktop/ui/shape.js', import.meta.url), 'utf8');
const inputSource = await readFile(new URL('../desktop/ui/input.js', import.meta.url), 'utf8');

function surface(classes, x = 100, y = 100) {
  const names = new Set(classes.split(' '));
  const el = {
    names, isConnected: true, hidden: false, visibility: true, opacity: 1,
    pointerEvents: 'auto', animations: [], children: [], parent: null,
    rect: { left: x, top: y, right: x + 100, bottom: y + 100, width: 100, height: 100 },
    classList: { contains: name => names.has(name) },
    matches(selector) {
      return selector.split(',').some(part => {
        const match = /^\.([\w-]+)(?::not\(\.([\w-]+)\))?$/.exec(part);
        return !!match && names.has(match[1]) && (!match[2] || !names.has(match[2]));
      });
    },
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; },
    checkVisibility(options = {}) { return this.visibility && (!options.opacityProperty || this.opacity > 0); },
    getBoundingClientRect() { return this.rect; },
    getAnimations(options) { assert.equal(options.subtree, true); return this.animations; },
    addEventListener() {},
  };
  return el;
}

function animation(endTime = 500, playState = 'running') {
  let resolve, reject;
  const value = {
    playState, pending: false, playbackRate: 1,
    effect: { getComputedTiming: () => ({ endTime }) },
    finished: new Promise((yes, no) => { resolve = yes; reject = no; }),
    finish() { this.playState = 'finished'; resolve(); },
    cancel() { this.playState = 'idle'; reject(new Error('canceled')); },
  };
  return value;
}

function browser(nodes, { input = false, platform = 'win32' } = {}) {
  const frames = new Map(); let sequence = 0, mutation;
  const bridge = { platform, testMode: true, shape() {}, interactive() {}, keyboardFocus() {}, onCursor() {} };
  const document = {
    body: {}, documentElement: {},
    querySelectorAll: selector => nodes.filter(el => el.isConnected && el.matches(selector)),
    querySelector(selector) { return this.querySelectorAll(selector)[0]; },
    elementFromPoint: () => null,
    addEventListener() {},
  };
  const window = {
    whaleDesktop: bridge,
    WhaleRendering: { onFrame() {}, presentFor() {}, mirrorScale: () => 1, hitCache: { hit: () => false } },
    addEventListener() {},
  };
  runInNewContext(input ? inputSource : shapeSource, {
    window, document, innerWidth: 1000, innerHeight: 800,
    requestAnimationFrame: callback => { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { observe() {} unobserve() {} },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} },
    getComputedStyle: el => ({ pointerEvents: el.pointerEvents }),
    setInterval() {},
  });
  return {
    api: input ? window.__whaleInputTest : window.__whaleShapeTest,
    mutation: () => mutation(), pending: () => frames.size,
    frame() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
  };
}

const covers = (api, x = 150, y = 150) => api.status().rectangles.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);

test('closing surfaces retain drawing through the last delayed child animation, then stop scheduling', async () => {
  for (const [base, open] of [['dshwv-pop', 'dshwv-pop-open'], ['dshwv-menu', 'dshwv-menu-open'], ['dshwv-menu-btn', 'dshwv-menu-btn-visible']]) {
    const el = surface(`${base} ${open}`), env = browser([el]);
    assert.equal(covers(env.api), true);
    el.names.delete(open);
    const text = animation(160), tail = animation(925); el.animations = [text, tail];
    env.mutation(); env.frame();
    assert.equal(covers(env.api), true);
    text.finish(); await Promise.resolve(); env.frame();
    assert.equal(covers(env.api), true, 'a completed text fade does not clip the delayed tail');
    el.rect = { left: 250, top: 100, right: 350, bottom: 200, width: 100, height: 100 };
    env.frame(); assert.equal(covers(env.api, 300), true, 'retained surfaces follow animated geometry');
    tail.finish(); await Promise.resolve(); env.frame();
    assert.equal(env.api.status().rectangles.length, 0);
    assert.equal(env.pending(), 0, 'the real animation end terminates the frame loop');
  }
});

test('canceled exit completion never clips a reopened surface', async () => {
  const el = surface('dshwv-pop dshwv-pop-open'), env = browser([el]);
  el.names.delete('dshwv-pop-open');
  const exit = animation(); el.animations = [exit]; env.mutation(); env.frame();
  el.names.add('dshwv-pop-open'); exit.cancel();
  await Promise.resolve(); env.frame();
  assert.equal(covers(env.api), true);
  assert.equal(env.pending(), 0);
});

test('hidden, invisible and removed closing surfaces release their regions immediately', async () => {
  for (const hide of [el => { el.hidden = true; }, el => { el.visibility = false; }, el => { el.isConnected = false; }]) {
    const el = surface('dshwv-pop'), exit = animation(); el.animations = [exit];
    const env = browser([el]); assert.equal(covers(env.api), true);
    hide(el); env.mutation(); env.frame();
    assert.equal(env.api.status().rectangles.length, 0); assert.equal(env.pending(), 0);
    exit.finish(); await Promise.resolve(); env.frame();
    assert.equal(env.api.status().rectangles.length, 0);
  }
});

test('infinite decoration cannot retain a closed surface and paused finite effects do not spin RAF', () => {
  const el = surface('dshwv-pop'); el.animations = [animation(Infinity)];
  const env = browser([el]); assert.equal(covers(env.api), false); assert.equal(env.pending(), 0);
  el.animations = [animation(500, 'paused')]; env.mutation(); env.frame();
  assert.equal(covers(env.api), true); assert.equal(env.pending(), 0);
});

test('native shape lifecycle remains Windows-only', () => {
  assert.equal(browser([surface('dshwv-pop dshwv-pop-open')], { platform: 'darwin' }).api, undefined);
});

test('exit pixels and hover-only space never become input surfaces', () => {
  const pet = surface('dshwv-img', 700, 600), root = surface('dshwv-root');
  const menu = surface('dshwv-menu dshwv-menu-open'), button = surface('dshwv-menu-btn dshwv-menu-btn-visible', 300);
  const panel = surface('dshwv-usagepanel'); panel.parent = menu;
  const env = browser([pet, root, menu, button, panel], { input: true });
  assert.equal(env.api.hit({ x: 150, y: 150 }), true);
  menu.names.delete('dshwv-menu-open');
  assert.equal(env.api.hit({ x: 150, y: 150 }), false, 'a child panel cannot re-enable its closing menu');
  assert.equal(env.api.hit({ x: 350, y: 150 }), true);
  button.names.delete('dshwv-menu-btn-visible');
  assert.equal(env.api.hit({ x: 350, y: 150 }), false, 'the fading button is not clickable');
  button.names.add('dshwv-menu-btn-visible'); button.names.add('dshwv-menu-btn-hidden');
  assert.equal(env.api.hit({ x: 350, y: 150 }), false, 'the hide-button preference wins over visible class');
  button.names.delete('dshwv-menu-btn-hidden'); button.pointerEvents = 'none';
  assert.equal(env.api.hit({ x: 350, y: 150 }), false);
  assert.equal(env.api.hit({ x: 250, y: 150 }), false, 'space between bounded surfaces passes through');
});
