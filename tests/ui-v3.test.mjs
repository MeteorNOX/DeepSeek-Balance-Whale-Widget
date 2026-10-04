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
    createBufferSource() { const source = { connect(gain) { this.gain = gain; }, start(at) { this.started = true; this.at = at; }, stop() { this.stopped = true; } }; sources.push(source); return source; }
  }
  const context = { window: { addEventListener() {} }, AudioContext, fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }), setTimeout: callback => { idle = callback; return 1; }, clearTimeout() {} };
  vm.runInNewContext(read('audio-engine.js'), context);
  return { api: context.window.WhaleAudio, sources, contexts: () => contexts, idle: () => idle() };
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

test('a task audio group schedules both complete slots in order at the selected volume', async () => {
  const f = audioFixture();
  await f.api.play({ channel: 'notice', urls: ['/press', '/release'], volume: .24 });
  assert.equal(f.sources.length, 2);
  assert.deepEqual(f.sources.map(source => source.at), [0, 20]);
  assert.ok(f.sources.every(source => source.gain.gain.value === .24));
  f.api.stop('notice'); assert.ok(f.sources.every(source => source.stopped));
});

test('empty group slots are skipped and muted groups never start audio hardware', async () => {
  const f = audioFixture();
  await f.api.play({ urls: ['/press', '/release'], volume: 0 }); assert.equal(f.contexts(), 0);
  await f.api.play({ urls: ['', '/release'], volume: .5 });
  assert.equal(f.sources.length, 1); assert.equal(f.sources[0].at, 0);
});

test('feedback keeps full group sources, multiplies event/master volumes, and honors silent presets', () => {
  const calls = [], window = { WhaleAudio: { play: value => calls.push(value) } };
  vm.runInNewContext(read('preferences-v3.js'), { window, localStorage: { getItem: () => null } });
  window.WhaleFeedback.play('success', ['/press', '/release'], .3);
  assert.deepEqual(calls[0].urls, ['/press', '/release']); assert.equal(calls[0].volume, .24);
  window.WhaleFeedback.play('success', ['/press', '/release'], 0); assert.equal(calls[1].volume, 0);
  window.WhaleFeedback.play('cancelled', '', 1); assert.equal(calls[2].volume, 0);
});
