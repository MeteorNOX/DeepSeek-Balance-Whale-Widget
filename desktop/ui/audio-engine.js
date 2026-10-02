(() => {
  'use strict';
  let ctx, idle;
  const buffers = new Map(), pending = new Map(), active = new Map(), completions = new Map(), epochs = new Map();
  function context() { if (!ctx || ctx.state === 'closed') ctx = new AudioContext(); return ctx; }
  function touch() { clearTimeout(idle); idle = setTimeout(() => { stop(); buffers.clear(); pending.clear(); const old = ctx; ctx = null; old?.close().catch(() => {}); }, 60000); }
  async function warm(url) {
    if (!url) return null;
    touch();
    if (buffers.has(url)) return buffers.get(url);
    if (pending.has(url)) return pending.get(url);
    const c = context();
    const job = fetch(url).then(r => { if (!r.ok) throw Error('音频读取失败'); return r.arrayBuffer(); }).then(b => c.decodeAudioData(b)).then(b => { buffers.set(url, b); return b; }).finally(() => pending.delete(url));
    pending.set(url, job); return job;
  }
  function stop(channel) {
    for (const key of channel ? [channel] : [...new Set([...active.keys(), ...completions.keys(), ...epochs.keys()])]) {
      epochs.set(key, (epochs.get(key) || 0) + 1);
      const nodes = active.get(key) || [];
      for (const node of nodes) { try { node.stop(); } catch {} }
      completions.get(key)?.();
      active.delete(key);
    }
  }
  async function play({ channel = 'preview', url, preset = 'original', volume = .9 } = {}) {
    stop(channel); const epoch = epochs.get(channel);
    if (!(Number(volume) > 0)) return;
    try {
      const c = context(); touch(); await c.resume();
      const buffer = preset === 'original' ? await warm(url) : null;
      if (epochs.get(channel) !== epoch || c !== ctx) return;
      const gain = c.createGain(); gain.connect(c.destination);
      const now = c.currentTime, nodes = [];
      if (preset === 'original') {
        if (!buffer) { gain.disconnect(); return; }
        const source = c.createBufferSource(); source.buffer = buffer; source.connect(gain);
        gain.gain.value = Math.min(1, volume); nodes.push(source); source.start();
      } else {
        // Original procedural tones: no third-party samples or network assets.
        const tones = { pearl: [660, 880], bubble: [260, 520], glass: [1046, 1318] }[preset] || [440, 660];
        gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(Math.min(1, volume) * .15, now + .012);
        gain.gain.exponentialRampToValueAtTime(.0001, now + .18);
        for (let i = 0; i < tones.length; i++) { const o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(tones[i], now); o.connect(gain); nodes.push(o); o.start(now + i * .035); o.stop(now + .19); }
      }
      active.set(channel, nodes);
      await new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try { gain.disconnect(); } catch {}
          if (active.get(channel) === nodes) active.delete(channel);
          if (completions.get(channel) === finish) completions.delete(channel);
          resolve();
        };
        completions.set(channel, finish);
        nodes[nodes.length - 1].onended = finish;
      });
    } catch { /* Missing or unsupported audio must never block interaction. */ }
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); ctx?.suspend().catch(() => {}); } });
  window.addEventListener('beforeunload', () => { stop(); clearTimeout(idle); ctx?.close().catch(() => {}); });
  window.WhaleAudio = Object.freeze({ warm, play, stop });
})();
