import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = name => fs.readFileSync(new URL('../desktop/ui/' + name, import.meta.url), 'utf8');
function audioFixture() {
  const sources = []; let contexts = 0, idle;
  class AudioContext {
    state = 'running'; currentTime = 0;
    constructor() { contexts++; }
    resume() { return Promise.resolve(); } close() { this.state = 'closed'; return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({ duration: 20 }); }
    createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createBufferSource() {
      const source = {
        connect() {},
        start() { this.started = true; },
        stop() { this.stopped = true; queueMicrotask(() => this.onended?.()); },
        finish() { this.endedNaturally = true; this.onended?.(); },
      };
      sources.push(source); return source;
    }
  }
  const timers = new Set();
  const context = {
    window: { addEventListener() {} }, AudioContext,
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    setTimeout: (callback, delay) => {
      if (delay === 60000) { idle = callback; return 1; }
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer); return timer;
    },
    clearTimeout: timer => { if (timer !== 1) { clearTimeout(timer); timers.delete(timer); } },
  };
  vm.runInNewContext(read('audio-engine.js'), context);
  return { api: context.window.WhaleAudio, context, sources, contexts: () => contexts, idle: () => idle(), dispose: () => { for (const timer of timers) clearTimeout(timer); } };
}
test('zero volume never opens audio hardware and a replacement stops the previous channel', async () => {
  const f = audioFixture(); await f.api.play({ url: '/press', volume: 0 }); assert.equal(f.contexts(), 0);
  const press = f.api.play({ channel: 'gesture', url: '/press', volume: .5 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sources[0].started, true);
  const release = f.api.play({ channel: 'gesture', url: '/release', volume: .5 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sources[0].stopped, true); assert.equal(f.sources[1].started, true);
  f.sources[1].finish(); await Promise.all([press, release]);
  f.idle();
});
test('gesture presets separate press from rebound without changing root flip', () => {
  const window = {}; vm.runInNewContext(read('gesture.js'), { window }); const body = { style: {} };
  window.WhaleGesture.apply(body, true, 'crisp'); assert.match(body.style.transition, /65ms/); assert.match(body.style.transform, /0.9/);
  window.WhaleGesture.apply(body, false, 'crisp'); assert.match(body.style.transition, /125ms/); assert.equal(body.style.transform, 'scaleY(1) scaleX(1)');
});
test('macOS gestures commit deterministic held and released shapes without a focused CSS timeline', () => {
  const presents = [];
  const window = { whaleDesktop: { platform: 'darwin', presentFor: ms => presents.push(ms) } };
  vm.runInNewContext(read('gesture.js'), { window });
  const body = { style: {}, get offsetWidth() { return 160; } };
  window.WhaleGesture.apply(body, true, 'balanced');
  assert.equal(body.style.transition, 'none'); assert.equal(body.style.transform, 'scaleY(0.88) scaleX(1.05)');
  window.WhaleGesture.apply(body, false, 'balanced');
  assert.equal(body.style.transition, 'none'); assert.equal(body.style.transform, 'scaleY(1) scaleX(1)');
  assert.deepEqual(presents, [80, 80]);
});
test('late decoding cannot resurrect a cancelled gesture', async () => {
  const f = audioFixture(); const playing = f.api.play({ channel: 'gesture', url: '/press' }); f.api.stop('gesture'); await playing; assert.equal(f.sources.length, 0);
});
test('a quick pet click queues release until press ends naturally without overlap', async () => {
  const f = audioFixture();
  vm.runInNewContext(read('preferences-v3.js'), f.context);
  f.context.window.WhaleFeedback.play('press', '/press', 1);
  f.context.window.WhaleFeedback.play('release', '/release', 1);
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(f.sources.filter(source => source.started).length, 1, 'release must not start while press is audible');
  assert.equal(f.sources[0].stopped, undefined, 'a timer must not truncate the press sound');
  f.sources[0].finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sources.filter(source => source.started).length, 2, 'release starts after the press completion signal');
  f.sources[1].finish();
  f.dispose();
});
test('a new press cancels the previous gesture release queued for playback', async () => {
  const f = audioFixture();
  vm.runInNewContext(read('preferences-v3.js'), f.context);
  f.context.window.WhaleFeedback.play('press', '/press-1', 1);
  f.context.window.WhaleFeedback.play('release', '/release-1', 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  f.context.window.WhaleFeedback.play('press', '/press-2', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sources.filter(source => source.started).length, 2);
  assert.equal(f.sources[0].stopped, true);
  assert.equal(f.sources[1].started, true);
  f.sources[1].finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sources.length, 2, 'the cancelled first release must never start');
  f.dispose();
});
