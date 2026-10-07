import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.indexOf(`    function ${name}(`);
  assert.ok(start >= 0, `missing production function ${name}`);
  const end = source.indexOf('\n    function ', start + 1);
  assert.ok(end > start);
  // Stop at the function's own closing brace; some functions are followed by
  // listener registration, which should not be executed by this VM harness.
  const close = source.indexOf('\n    }', start);
  assert.ok(close > start && close < end);
  return source.slice(start, close + '\n    }'.length);
}

function harness() {
  const stored = new Map(), writes = [], requests = [];
  const state = { left: 350, top: 150, scale: 1, flip: false, h: null, v: null };
  const context = vm.createContext({
    state, positionIntent: null, drag: null, CLICK_SQ: 16,
    viewport: () => ({ w: 1000, h: 800 }),
    root: { offsetWidth: 100, offsetHeight: 120, classList: { add() {}, toggle() {} }, setPointerCapture() {} },
    positioner: { style: {}, getBoundingClientRect: () => ({ left: 120, top: 90, width: 100, height: 120 }) },
    WhaleRendering: { presentFor() {} },
    snapConfig: { mode: 'ratio', ratio: { L: 5, R: 5, T: 5, B: 5, F: 20 } },
    rightGap: () => 0, scrollGapOn: false, scrollGapPx: 17,
    clamp: (n, low, high) => Math.min(high, Math.max(low, n)),
    localStorage: { getItem: key => stored.get(key) ?? null, setItem(key, value) { stored.set(key, value); writes.push([key, value]); } },
    window: { dispatchEvent() {} }, Event,
    document: { addEventListener() {} }, menuOpen: false,
    isWhaleHit: () => true, pressDown() {}, setWidgetCursor() {},
    onDocPointerUp() {}, onDocPointerCancel() {},
    SIZE_URL: '/size', fetch: async (url, options) => { requests.push({ url, options }); return { json: async () => ({ok:true}) }; },
    requireSaved(data) { assert.equal(data.ok, true); return data; }, assetFailure(error) { throw error; },
    soundOn: true, soundVol: 0.8, soundSet: 'duck', usageMode: 'today', bubbleOn: true,
    turnCostOn: true, turnCostCloseMs: 5000, menuBtnHide: false, outsideDismissOn: false,
    volInput: {}, volPct: {}, pressAudio: null, releaseAudio: null,
  });
  const names = ['express', 'settle', 'snapBounds', 'refreshFlip', 'artCenterAt', 'commitPosition', 'persistPositionIntent', 'applyAnchorPos', 'onDocPointerDown', 'onDocPointerMove', 'configSnapshot', 'createSettingsWriter', 'saveConfig', 'setVol'];
  vm.runInContext(names.map(productionFunction).join('\n'), context);
  const writerStart = source.indexOf('    var settingsWriter ='), writerEnd = source.indexOf('    function saveConfig()', writerStart);
  vm.runInContext(source.slice(writerStart, writerEnd), context);
  return { context, state, stored, writes, requests, run: code => vm.runInContext(code, context) };
}

test('committing free positions respects custom flip lines on either side', () => {
  for (const [left, flipLine, expectedFlip, anchor] of [[350, 20, false, 'left'], [550, 80, true, 'right']]) {
    const h = harness();
    h.state.left = left;
    h.context.snapConfig.ratio.F = flipLine;
    h.state.flip = expectedFlip;
    h.run('settle(); commitPosition();');
    assert.equal(h.state.flip, expectedFlip);
    assert.equal(h.state.left, left);
    assert.equal(JSON.parse(h.stored.get('dshw-pos')).hAnchor, anchor);
    assert.equal(h.writes.length, 1);
  }
});

test('grabbing an unfinished snap animation continues from its painted rectangle', () => {
  const h = harness();
  h.state.left = 0;
  h.state.top = 0;
  h.run('onDocPointerDown({ button: 0, pointerType: "mouse", pointerId: 1, clientX: 160, clientY: 140, preventDefault() {}, stopPropagation() {} });');
  assert.equal(h.context.drag.active, true);
  assert.equal(h.context.drag.origLeft, 120);
  assert.equal(h.context.drag.origTop, 90);
  assert.equal(h.state.left, 120);
  assert.equal(h.state.top, 90);
  assert.equal(h.context.positioner.style.transition, 'none');
  h.run('onDocPointerMove({ clientX: 175, clientY: 160 });');
  assert.equal(h.state.left, 135);
  assert.equal(h.state.top, 110);
  assert.equal(h.writes.length, 0);
});

test('changing volume while temporarily clamped does not overwrite position memory', async () => {
  const h = harness();
  h.run('commitPosition();');
  const saved = h.stored.get('dshw-pos');
  h.context.viewport = () => ({ w: 180, h: 160 });
  h.run('applyAnchorPos(); settle();');
  assert.equal(h.state.left, 80);
  assert.equal(h.state.top, 40);
  h.run('setVol(0.25);');
  await h.run('saveConfig();');
  assert.equal(h.requests.length, 1, 'the preference update really reached saveConfig');
  assert.equal(JSON.parse(h.requests[0].options.body).vol, 0.25);
  assert.equal(h.stored.get('dshw-pos'), saved);
  assert.equal(h.writes.length, 1, 'only the original user position was committed');
  h.context.viewport = () => ({ w: 1000, h: 800 });
  h.run('applyAnchorPos(); settle();');
  assert.equal(h.state.left, 350);
  assert.equal(h.state.top, 150);
});
