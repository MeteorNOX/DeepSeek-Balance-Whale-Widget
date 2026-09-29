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
    createBufferSource() { const source = { connect() {}, start() { this.started = true; }, stop() { this.stopped = true; } }; sources.push(source); return source; }
  }
  const context = { window: { addEventListener() {} }, AudioContext, fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }), setTimeout: callback => { idle = callback; return 1; }, clearTimeout() {} };
  vm.runInNewContext(read('audio-engine.js'), context);
  return { api: context.window.WhaleAudio, context, sources, contexts: () => contexts, idle: () => idle() };
}
test('zero volume never opens audio hardware or fetches, release interrupts a 20-second press immediately', async () => {
  const f = audioFixture(); await f.api.play({ url: '/press', volume: 0 }); assert.equal(f.contexts(), 0);
  await f.api.play({ channel: 'gesture', url: '/press', volume: .5 }); assert.equal(f.sources[0].started, true);
  await f.api.play({ channel: 'gesture', url: '/release', volume: .5 }); assert.equal(f.sources[0].stopped, true); assert.equal(f.sources[1].started, true);
  f.idle(); assert.equal(f.sources[1].stopped, true);
});
test('gesture presets separate press from rebound without changing root flip', () => {
  const window = {}; vm.runInNewContext(read('gesture.js'), { window }); const body = { style: {} };
  window.WhaleGesture.apply(body, true, 'crisp'); assert.match(body.style.transition, /65ms/); assert.match(body.style.transform, /0.9/);
  window.WhaleGesture.apply(body, false, 'crisp'); assert.match(body.style.transition, /125ms/); assert.equal(body.style.transform, 'scaleY(1) scaleX(1)');
});
test('late decoding cannot resurrect a cancelled gesture', async () => {
  const f = audioFixture(); const playing = f.api.play({ channel: 'gesture', url: '/press' }); f.api.stop('gesture'); await playing; assert.equal(f.sources.length, 0);
});
test('a quick pet click starts both the press and release sounds', async () => {
  const f = audioFixture();
  vm.runInNewContext(read('preferences-v3.js'), f.context);
  f.context.window.WhaleFeedback.play('press', '/press', 1);
  f.context.window.WhaleFeedback.play('release', '/release', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sources.filter(source => source.started).length, 2);
});
