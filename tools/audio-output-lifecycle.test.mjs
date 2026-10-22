import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.WIDGET_SOURCE || new URL('../assets/whale-widget.js', import.meta.url), 'utf8');
const engine = source.slice(source.indexOf('var dshwvAudioCtx ='), source.indexOf('var MIN_SCALE ='));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function extract(name) {
  const begin = source.indexOf('function ' + name + '(');
  assert.ok(begin >= 0, name);
  let end = source.indexOf('{', begin) + 1, depth = 1;
  for (; depth; end++) { if (source[end] === '{') depth++; else if (source[end] === '}') depth--; }
  return source.slice(begin, end);
}
function harness(options = {}) {
  let now = 100, next = 0;
  const timers = new Map(), outputs = [], offlines = [], nodes = [], fetches = [], warnings = [];
  const listeners = { document: {}, window: {} };
  const listen = where => (event, fn) => (listeners[where][event] ||= []).push(fn);
  const buffer = { duration: 1, sampleRate: 10, numberOfChannels: 1, length: 10, getChannelData: () => Float32Array.from([0, .2, .5, -.5, 1, -1, 0, 0, 0, 0]) };
  class Offline {
    constructor() { offlines.push(this); }
    decodeAudioData(raw, success, failure) {
      const job = options.decode ? options.decode(raw) : Promise.resolve(buffer);
      Promise.resolve(job).then(success, failure);
      return job;
    }
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { duration: length / sampleRate, sampleRate, numberOfChannels: channels, length, getChannelData: n => data[n] };
    }
  }
  class Context {
    constructor() { this.state = options.suspended ? 'suspended' : 'running'; this.resumes = 0; this.closes = 0; this.destination = { context: this }; outputs.push(this); }
    get currentTime() { return now / 1000; }
    resume() { this.resumes++; return Promise.resolve(options.resume?.()).then(() => { if (this.state !== 'closed') this.state = 'running'; }); }
    close() { this.closes++; this.state = 'closed'; return options.close ? options.close() : Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    decodeAudioData(raw, success, failure) { return new Offline().decodeAudioData(raw, success, failure); }
    createGain() { return { context: this, gain: { value: 1 }, connect(target) { assert.equal(target.context, this.context); }, disconnect() { this.disconnected = true; } }; }
    createBufferSource() {
      const node = { context: this, connect(target) { assert.equal(target.context, this.context); }, disconnect() { this.disconnected = true; }, stop() { this.stopped = true; }, start(...args) { if (options.startThrows) throw Error('device unavailable'); this.started = args; } };
      nodes.push(node); return node;
    }
  }
  const field = () => ({ value: '', style: {}, focus() {} });
  const s = { window: { AudioContext: Context, OfflineAudioContext: options.noOffline ? undefined : Offline, addEventListener: listen('window') },
    document: { hidden: false, addEventListener: listen('document'), removeEventListener() {} },
    console: { warn: (...args) => warnings.push(args) }, performance: { now: () => now }, Date, Promise, ArrayBuffer, Float32Array, DataView, Blob, Set,
    soundOn: true, setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async url => { fetches.push(url); return { ok: url !== 'missing', status: url === 'missing' ? 404 : url === 'empty' ? 204 : 200, arrayBuffer: async () => new ArrayBuffer(128) }; },
    audioCropCtx: null, audioCropGeneration: 0, audioCropPreviewNode: null, audioCropBuffer: null, audioCropTarget: 'press', audioCropFileBase: '',
    audioCropMask: { style: { display: 'none' } }, audioCropName: field(), audioCropStart: field(), audioCropEnd: field(), audioCropStartNum: field(), audioCropEndNum: field(), audioCropZoomRange: field(), audioCropZoomNum: field(),
    drawAudioCrop() {}, updateAudioCropOkState() {}, dshwLayerUp() {}, alert: message => warnings.push(message) };
  vm.createContext(s); vm.runInContext(engine, s);
  for (const name of ['openAudioCrop', 'audioCropRange', 'hideAudioCrop', 'stopAudioCropPreview', 'previewAudioCrop', 'cancelAudioCropWork', 'encodeWav']) {
    if (source.includes('function ' + name + '(')) vm.runInContext(extract(name), s);
  }
  const cropEvents = source.indexOf("window.addEventListener('blur', cancelAudioCropWork)");
  if (cropEvents >= 0) vm.runInContext(source.slice(cropEvents, source.indexOf('// 编码 WAV', cropEvents)), s);
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  async function advance(ms) {
    const target = now + ms;
    await flush();
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
    }
    now = target; await flush();
  }
  const dispatch = (where, event) => { for (const fn of listeners[where][event] || []) fn({}); };
  const warm = async url => { s.dshwvWarm([url]); await flush(); };
  const play = async (url = 'press', setup = () => {}) => { const el = s.dshwvSound(url); setup(el); await el.play(); await flush(); return el; };
  const hide = () => { s.document.hidden = true; dispatch('document', 'visibilitychange'); };
  const show = () => { s.document.hidden = false; dispatch('document', 'visibilitychange'); };
  return { s, outputs, offlines, nodes, fetches, warnings, flush, advance, dispatch, warm, play, hide, show, buffer };
}

test('initialization, settings preheat, ordinary input and repeated returns never open output', async () => {
  const h = harness();
  await h.warm('press'); await h.warm('press'); await h.warm('release');
  h.dispatch('document', 'pointerdown'); h.dispatch('document', 'keydown');
  for (let i = 0; i < 5; i++) { h.hide(); h.show(); await h.warm('press'); }
  assert.equal(h.outputs.length, 0); assert.equal(h.offlines.length, 1); assert.equal(h.fetches.length, 2);
});
test('empty, missing, HTTP 204, zero volume, disabled and hidden sounds never acquire output', async () => {
  const h = harness();
  await h.play(''); await h.play('missing'); await h.play('empty');
  await h.play('press', el => { el.volume = 0; }); await h.play('press', el => { el.volume = Infinity; });
  h.s.soundOn = false; await h.play(); h.s.soundOn = true; h.hide(); await h.play();
  assert.equal(h.outputs.length, 0);
});
test('cached click starts synchronously and closes only after its natural end', async () => {
  const h = harness(); await h.warm('press');
  const el = h.s.dshwvSound('press'); el.play();
  assert.equal(h.nodes.length, 1); assert.ok(h.nodes[0].started);
  await h.advance(2000); assert.equal(h.outputs[0].closes, 0);
  h.nodes[0].onended(); await h.advance(249); assert.equal(h.outputs[0].closes, 0);
  await h.advance(1); assert.equal(h.outputs[0].closes, 1); assert.ok(h.nodes[0].disconnected);
});
test('multiple voices and scheduled release share output until all finish', async () => {
  const h = harness(); await h.warm('press'); await h.warm('release');
  await h.play(); const release = h.s.dshwvSound('release'); release.playAt(.7);
  assert.ok(h.nodes[1].started[0] > h.nodes[0].started[0]);
  h.nodes[0].onended(); await h.advance(500); assert.equal(h.outputs[0].closes, 0);
  h.nodes[1].onended(); await h.advance(250); assert.equal(h.outputs[0].closes, 1);
});
test('notification after idle opens fresh output with cached audio and no input unlock', async () => {
  const h = harness(); await h.play(); h.nodes[0].onended(); await h.advance(250);
  await h.play(); assert.equal(h.outputs.length, 2); assert.equal(h.nodes.length, 2); assert.equal(h.fetches.length, 1);
});
test('hide stops active and scheduled nodes; return never resumes or replays them', async () => {
  const h = harness(); await h.play(); await h.warm('release');
  const release = h.s.dshwvSound('release'); release.playAt(.8);
  h.hide(); assert.equal(h.outputs[0].closes, 1); assert.ok(h.nodes.every(n => n.stopped && n.disconnected));
  h.show(); await h.advance(2000); assert.equal(h.outputs.length, 1); assert.equal(h.nodes.length, 2); assert.equal(h.outputs[0].resumes, 0);
  await h.play(); assert.equal(h.outputs.length, 2);
});
test('decode completing after hide and return cannot open output', async () => {
  const job = deferred(), h = harness({ decode: () => job.promise });
  await h.play(); h.hide(); h.show(); job.resolve(h.buffer); await h.flush();
  assert.equal(h.outputs.length, 0); assert.equal(h.s.dshwvAudioPending.size, 0);
});
test('resume completing after hide and return cannot start old sound', async () => {
  const job = deferred(), h = harness({ suspended: true, resume: () => job.promise });
  await h.play(); assert.equal(h.outputs[0].resumes, 1); h.hide(); h.show(); job.resolve(); await h.flush();
  assert.equal(h.outputs[0].closes, 1); assert.equal(h.nodes.length, 0);
});
test('unresolved autoplay resume times out and releases output', async () => {
  const job = deferred(), h = harness({ suspended: true, resume: () => job.promise });
  await h.play(); await h.advance(1250); assert.equal(h.outputs[0].closes, 1);
  job.resolve(); await h.flush(); assert.equal(h.nodes.length, 0);
});
test('a stopped obsolete resume cannot block a new context idle release', async () => {
  const job = deferred(), h = harness({ suspended: true, resume: () => h.outputs.length === 1 ? job.promise : Promise.resolve() });
  await h.play(); h.hide(); h.show(); await h.flush(); await h.play('release');
  assert.equal(h.nodes.length, 1); h.nodes[0].onended(); await h.advance(250);
  assert.equal(h.outputs[1].closes, 1); job.resolve(); await h.flush(); assert.equal(h.nodes.length, 1);
});
test('new playback waits for old output close to finish', async () => {
  const job = deferred(), h = harness({ close: () => job.promise });
  await h.play(); h.nodes[0].onended(); await h.advance(250); await h.play('release');
  assert.equal(h.outputs.length, 1); job.resolve(); await h.flush(); assert.equal(h.outputs.length, 2); assert.equal(h.nodes.length, 2);
});
test('pause, source replacement and global mute cancel decode requests', async () => {
  for (const action of ['pause', 'source', 'mute']) {
    const job = deferred(), h = harness({ decode: () => job.promise }); const el = await h.play();
    if (action === 'pause') el.pause();
    if (action === 'source') el.src = 'new';
    if (action === 'mute') { h.s.soundOn = false; h.s.dshwvAudioSuspendNow(); h.s.soundOn = true; }
    job.resolve(h.buffer); await h.flush(); assert.equal(h.outputs.length, 0);
  }
});
test('alternate audio route succeeds without a redundant output context', async () => {
  const h = harness(); await h.play('missing', el => { el._alt = 'release'; });
  assert.equal(h.outputs.length, 1); assert.equal(h.nodes.length, 1); assert.deepEqual(h.fetches, ['missing', 'release']);
});
test('resume rejection and source start failure release output without stale playback', async () => {
  for (const options of [{ suspended: true, resume: () => Promise.reject(Error('unavailable')) }, { startThrows: true }]) {
    const h = harness(options); await h.play(); await h.advance(250);
    assert.equal(h.outputs[0].closes, 1); assert.equal(h.s.dshwvAudioActive.size, 0); assert.equal(h.s.dshwvAudioPending.size, 0);
  }
});
test('no offline decoder means no fallback to real-time output', async () => {
  const h = harness({ noOffline: true }); await h.warm('press'); await h.play(); assert.equal(h.outputs.length, 0);
});
test('pagehide and unload release active output', async () => {
  for (const event of ['pagehide', 'beforeunload']) { const h = harness(); await h.play(); h.dispatch('window', event); assert.equal(h.outputs[0].closes, 1); }
});
test('crop import, PCM export and closing the panel require no output', async () => {
  const h = harness(); h.s.openAudioCrop(new ArrayBuffer(128), 'sample.wav'); await h.flush();
  assert.equal(h.s.audioCropMask.style.display, 'flex'); assert.equal(h.outputs.length, 0);
  const bytes = await h.s.encodeWav(h.s.audioCropBuffer).arrayBuffer(); assert.equal(bytes.byteLength, 64);
  assert.equal(new DataView(bytes).getInt16(48, true), 16383);
  h.s.hideAudioCrop(); assert.equal(h.outputs.length, 0);
});
test('crop preview uses shared playback lifecycle, ends, and can play again', async () => {
  const h = harness(); h.s.openAudioCrop(new ArrayBuffer(128), 'sample.wav'); await h.flush();
  h.s.previewAudioCrop(); await h.flush(); assert.equal(h.outputs.length, 1); assert.equal(h.nodes.length, 1);
  h.nodes[0].onended(); await h.advance(250); assert.equal(h.outputs[0].closes, 1);
  h.s.previewAudioCrop(); await h.flush(); assert.equal(h.outputs.length, 2); assert.equal(h.nodes.length, 2);
  h.s.hideAudioCrop(); await h.advance(250); assert.equal(h.outputs[1].closes, 1);
});
test('closing a crop panel while import is decoding cannot reopen it later', async () => {
  const job = deferred(), h = harness({ decode: () => job.promise });
  h.s.openAudioCrop(new ArrayBuffer(128), 'sample.wav'); h.s.hideAudioCrop(); job.resolve(h.buffer); await h.flush();
  assert.equal(h.s.audioCropMask.style.display, 'none'); assert.equal(h.s.audioCropBuffer, null); assert.equal(h.outputs.length, 0);
});
test('crop blur, hidden page and unload cancel late import and any preview', async () => {
  for (const event of ['blur', 'visibilitychange', 'beforeunload']) {
    const job = deferred(), h = harness({ decode: () => job.promise });
    h.s.openAudioCrop(new ArrayBuffer(128), 'late.wav');
    if (event === 'visibilitychange') { h.hide(); h.show(); } else h.dispatch('window', event);
    job.resolve(h.buffer); await h.flush();
    assert.equal(h.s.audioCropMask.style.display, 'none'); assert.equal(h.outputs.length, 0);
    h.s.openAudioCrop(new ArrayBuffer(128), 'next.wav'); await h.flush(); h.s.previewAudioCrop(); await h.flush();
    assert.equal(h.nodes.length, 1);
    if (event === 'visibilitychange') h.hide(); else h.dispatch('window', event);
    await h.advance(250); assert.equal(h.outputs[0].closes, 1); assert.ok(h.nodes[0].stopped);
  }
});
test('an obsolete source ending cannot release a newer playback', async () => {
  const h = harness(), el = await h.play(); const oldEnded = h.nodes[0].onended;
  el.currentTime = 0; el.play(); oldEnded(); await h.advance(250);
  assert.equal(h.nodes.length, 2); assert.equal(h.outputs[0].closes, 0); assert.equal(h.s.dshwvAudioActive.size, 1);
  h.nodes[1].onended(); await h.advance(250); assert.equal(h.outputs[0].closes, 1);
});
test('volume muted during decode drops the pending request without output', async () => {
  const job = deferred(), h = harness({ decode: () => job.promise }), el = await h.play();
  el.volume = 0; job.resolve(h.buffer); await h.flush(); assert.equal(h.outputs.length, 0); assert.equal(h.s.dshwvAudioPending.size, 0);
});
