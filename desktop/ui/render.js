(() => {
  'use strict';

  let frameRequest = 0, presentUntil = 0;
  const frameListeners = new Set();
  function presentFor(ms = 0) {
    presentUntil = Math.max(presentUntil, performance.now() + ms);
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(function present(now) {
      // Keep the pending marker during callbacks: reentrant requests extend this
      // loop instead of starting another one. Chromium presents its own frames.
      try { for (const listener of frameListeners) listener(); }
      finally { frameRequest = 0; }
      if (now < presentUntil) frameRequest = requestAnimationFrame(present);
    });
  }
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

  // Alpha is only consulted for input. Chromium owns visual alpha/compositing.
  class AlphaHitCache {
    constructor() {
      this.entries = new Map();
      this.jobs = new Map();
      this.serial = 0;
      this.bytes = 0;
      this.stats = { decodes: 0, hits: 0, failures: 0 };
      this.worker = new Worker('/alpha-worker.js');
      this.worker.onmessage = ({ data }) => {
        const job = this.jobs.get(data.id);
        if (!job) return;
        this.jobs.delete(data.id);
        clearTimeout(job.timer);
        const mask = data.alpha ? { width: data.width, height: data.height, alpha: new Uint8Array(data.alpha) } : null;
        job.entry.mask = mask;
        job.entry.done = true;
        if (mask) { this.bytes += mask.alpha.byteLength; this.stats.decodes++; }
        else this.stats.failures++;
        job.resolve(mask);
        this.trim();
        presentFor();
      };
      this.worker.onerror = () => {
        for (const job of this.jobs.values()) {
          clearTimeout(job.timer); job.entry.done = true; job.resolve(null);
        }
        this.stats.failures += this.jobs.size;
        this.jobs.clear();
      };
    }
    key(src) { return new URL(src, location.href).href; }
    prepare(src) {
      const key = this.key(src);
      let entry = this.entries.get(key);
      if (entry) {
        this.entries.delete(key); this.entries.set(key, entry);
        return entry.promise;
      }
      entry = { done: false, mask: null };
      entry.promise = new Promise(resolve => {
        const id = ++this.serial;
        const timer = setTimeout(() => {
          if (!this.jobs.delete(id)) return;
          entry.done = true; this.stats.failures++; resolve(null);
        }, 12000);
        this.jobs.set(id, { entry, resolve, timer });
        this.worker.postMessage({ id, src: key });
      });
      this.entries.set(key, entry);
      this.trim();
      return entry.promise;
    }
    trim() {
      for (const [key, entry] of this.entries) {
        if (this.entries.size <= 8 && this.bytes <= 8 * 1024 * 1024) break;
        if (!entry.done) continue;
        this.bytes -= entry.mask?.alpha.byteLength || 0;
        this.entries.delete(key);
      }
    }
    hit(img, x, y, flipped = false, rect = null) {
      if (!img?.complete || !img.naturalWidth) return false;
      const r = rect || img.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5 || x < r.left || y < r.top || x >= r.right || y >= r.bottom) return false;
      const entry = this.entries.get(this.key(img.currentSrc || img.src));
      if (!entry) { this.prepare(img.currentSrc || img.src); return false; }
      if (!entry.done) return false;
      // Decode failure retains a clickable image rectangle, never a visual clip.
      if (!entry.mask) return true;
      const { width, height, alpha } = entry.mask;
      const u = (x - r.left) / r.width;
      const px = Math.min(width - 1, Math.floor((flipped ? 1 - u : u) * width));
      const py = Math.min(height - 1, Math.floor((y - r.top) / r.height * height));
      this.stats.hits++;
      return alpha[py * width + px] > 10;
    }
  }

  // Input must not shrink with the decorative press/rebound transform. Walk
  // layout offsets (not painted body bounds), then apply the root's placement,
  // scale and mirror. This follows dragging/resizing without retaining old
  // screen coordinates or turning the transparent window into a backdrop.
  function petLayoutRect(img, root) {
    const r = root.getBoundingClientRect();
    let x = 0, y = 0, node = img;
    for (let depth = 0; node && node !== root && depth < 8; depth++) {
      x += node.offsetLeft; y += node.offsetTop; node = node.offsetParent;
    }
    if (node !== root || !(root.offsetWidth > 0) || !(root.offsetHeight > 0)) return null;
    const sx = r.width / root.offsetWidth, sy = r.height / root.offsetHeight;
    const width = img.offsetWidth * sx, height = img.offsetHeight * sy;
    const left = mirrorScale(root) < 0 ? r.left + r.width - (x + img.offsetWidth) * sx : r.left + x * sx;
    const top = r.top + y * sy;
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return { left, top, right: left + width, bottom: top + height, width, height };
  }
  class PetInteraction {
    constructor(cache, { now = Date.now, timer = (fn, ms) => setTimeout(fn, ms), clear = id => clearTimeout(id), changed = () => {} } = {}) {
      this.cache = cache; this.now = now; this.timer = timer; this.clear = clear; this.changed = changed;
      this.state = null; this.generation = 0; this.timeout = null;
    }
    begin(img, root, pointerId) {
      if (!petLayoutRect(img, root)) return false;
      this.clear(this.timeout); this.timeout = null; ++this.generation;
      this.state = { img, root, pointerId, source: img.src, currentSource: img.currentSrc || img.src, phase: 'held', deadline: 0 };
      this.changed(0); return true;
    }
    end(pointerId, releaseMs) {
      if (!this.state || this.state.pointerId !== pointerId) return;
      const duration = Math.max(0, Math.min(500, Number(releaseMs) || 0)) + 32;
      this.clear(this.timeout); const generation = ++this.generation;
      this.state.phase = 'releasing'; this.state.deadline = this.now() + duration;
      this.timeout = this.timer(() => { if (generation === this.generation) this.cancel(); }, duration);
      this.changed(duration);
    }
    cancel() {
      if (!this.state) return;
      ++this.generation; this.clear(this.timeout); this.timeout = null; this.state = null; this.changed(0);
    }
    protectedBounds(img = this.state?.img, root = this.state?.root) {
      const state = this.state;
      if (!state) return null;
      if (state.img !== img || state.root !== root || img?.isConnected === false || root?.isConnected === false ||
          img.src !== state.source || (img.currentSrc || img.src) !== state.currentSource ||
          state.phase === 'releasing' && this.now() >= state.deadline) { this.cancel(); return null; }
      return petLayoutRect(img, root);
    }
    hit(img, root, x, y) {
      const protectedRect = this.protectedBounds(img, root), flipped = mirrorScale(root) < 0;
      return this.cache.hit(img, x, y, flipped) || !!protectedRect && this.cache.hit(img, x, y, flipped, protectedRect);
    }
    releasing(pointerId) {
      return !!this.protectedBounds() && this.state?.pointerId === pointerId && this.state.phase === 'releasing';
    }
    holding() {
      return !!this.protectedBounds() && this.state?.phase === 'held';
    }
    move(point) {
      const state = this.state;
      if (state?.phase === 'releasing' && !this.hit(state.img, state.root, point.x, point.y)) this.cancel();
    }
  }

  class BubbleRenderer {
    constructor(container, gifUrl) {
      this.container = container;
      this.epoch = 0;
      this.switching = false;
      this.hasFrame = false;
      this.animations = [];
      this.layers = [0, 1].map(index => {
        const root = document.createElement('div');
        root.className = 'dshwv-frame';
        root.dataset.buffer = String(index);
        root.style.opacity = '0';
        root.inert = true;
        root.setAttribute('aria-hidden', 'true');
        const parts = { root };
        for (const kind of ['label', 'amount', 'hint']) {
          const el = document.createElement('div');
          el.className = 'dshwv-' + kind;
          parts[kind] = el; root.appendChild(el);
        }
        parts.gif = document.createElement('img');
        parts.gif.className = 'dshwv-gif'; parts.gif.alt = '';
        parts.gif.draggable = false; parts.gif.src = gifUrl;
        parts.gif.style.display = 'none'; root.appendChild(parts.gif);
        container.appendChild(root);
        return parts;
      });
      [this.front, this.back] = this.layers;
      // Scale/viewport changes and money-text updates use the same layout path
      // as the initial hidden-buffer commit. Fitting changes no content nodes.
      this.resizeObserver = new ResizeObserver(() => this.fitAll());
      this.resizeObserver.observe(container);
      this.contentObserver = new MutationObserver(() => {
        if (this.hasFrame && !this.switching) this.fit(this.front);
      });
      this.contentObserver.observe(container, { childList: true, characterData: true, subtree: true });
    }
    fit(parts) {
      const root = parts.root;
      root.style.setProperty('--whale-fit-scale', '1');
      const width = this.container.clientWidth, height = this.container.clientHeight;
      if (width <= 0 || height <= 0) return;
      // Reflow at each candidate scale so text keeps using the full safe width;
      // shrinking an already-wrapped stack would create a tiny unreadable column.
      // Every candidate preserves the original content and relative font sizes.
      const fits = scale => {
        root.style.setProperty('--whale-fit-scale', String(scale));
        return Math.max(root.scrollWidth, root.offsetWidth) * scale <= width + 0.5 &&
          Math.max(root.scrollHeight, root.offsetHeight) * scale <= height;
      };
      let scale = 1;
      if (!fits(1)) {
        let low = 0, high = 1;
        for (let i = 0; i < 13; i++) {
          const candidate = (low + high) / 2;
          if (fits(candidate)) low = candidate; else high = candidate;
        }
        scale = Math.max(low, 0.0001);
      }
      root.style.setProperty('--whale-fit-scale', String(scale));
      root.dataset.fitScale = String(scale);
    }
    fitAll() {
      for (const parts of this.layers) this.fit(parts);
      presentFor();
    }
    cancel() {
      ++this.epoch;
      this.switching = false;
      for (const animation of this.animations) animation.cancel();
      this.animations.length = 0;
      this.front.root.style.opacity = this.hasFrame ? '1' : '0';
      this.back.root.style.opacity = '0';
      this.front.root.inert = !this.hasFrame;
      this.back.root.inert = true;
      this.front.root.setAttribute('aria-hidden', String(!this.hasFrame));
      this.back.root.setAttribute('aria-hidden', 'true');
    }
    reset(parts) {
      // Only the hidden buffer is edited. The four legacy nodes are reused.
      window.WhaleMoney?.clearBindings(parts.root);
      for (const child of [...parts.root.children]) {
        if (![parts.label, parts.amount, parts.hint, parts.gif].includes(child)) child.remove();
      }
      for (const kind of ['label', 'amount', 'hint']) {
        const el = parts[kind];
        el.className = 'dshwv-' + kind; el.removeAttribute('style');
        el.textContent = ''; el.removeAttribute('title');
      }
      parts.gif.style.display = 'none';
      parts.root.style.setProperty('--whale-fit-scale', '1');
    }
    async ready(parts) {
      const images = [...parts.root.querySelectorAll('img')].filter(img => img.style.display !== 'none');
      const ready = Promise.all([document.fonts.ready, ...images.map(img => img.decode())]);
      let timer;
      try {
        await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Bubble assets not ready')), 4000); })]);
      } finally { clearTimeout(timer); }
      // Layout and paint opportunity for the complete back buffer, before fade.
      await nextFrame();
      this.fit(parts);
      await nextFrame();
    }
    async open(build, onReady) {
      this.cancel();
      const epoch = this.epoch;
      const incoming = this.back, outgoing = this.front;
      this.switching = true;
      try {
        this.reset(incoming);
        build(incoming);
        await this.ready(incoming);
        if (epoch !== this.epoch) return false;
        onReady?.();
        const fade = this.hasFrame;
        outgoing.root.inert = true;
        if (fade) {
          this.animations = [
            outgoing.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease', fill: 'forwards' }),
            incoming.root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease', fill: 'forwards' }),
          ];
          presentFor(220);
          await Promise.all(this.animations.map(animation => animation.finished));
          if (epoch !== this.epoch) return false;
        }
        incoming.root.style.opacity = '1'; outgoing.root.style.opacity = '0';
        for (const animation of this.animations) animation.cancel();
        this.animations.length = 0;
        this.front = incoming; this.back = outgoing; this.hasFrame = true;
        incoming.root.inert = false; outgoing.root.inert = true;
        incoming.root.setAttribute('aria-hidden', 'false'); outgoing.root.setAttribute('aria-hidden', 'true');
        this.switching = false;
        presentFor();
        return true;
      } catch (error) {
        if (epoch === this.epoch) {
          this.cancel();
          // A failed decode keeps the last complete frame instead of blanking it.
          this.container.dispatchEvent(new CustomEvent('whale-frame-error', { detail: { message: error.message } }));
        }
        return false;
      }
    }
    close() {
      this.cancel();
      this.front.root.inert = true;
      // Retain the outgoing pixels for the bubble's closing opacity animation.
      presentFor(320);
    }
  }

  const hitCache = new AlphaHitCache();
  function mirrorScale(root) {
    const transform = getComputedStyle(root).transform;
    return transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).a;
  }
  const petInteraction = new PetInteraction(hitCache, { changed: ms => {
    presentFor(ms);
    window.dispatchEvent(new Event('whale-interaction-geometry'));
  } });
  window.WhaleRendering = Object.freeze({ BubbleRenderer, hitCache, petInteraction, mirrorScale, presentFor, onFrame: listener => { frameListeners.add(listener); return () => frameListeners.delete(listener); } });
})();
