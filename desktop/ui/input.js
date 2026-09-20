(() => {
  'use strict';
  const bridge = window.whaleDesktop, rendering = window.WhaleRendering;
  if (!bridge || !rendering) return;
  const pet = document.querySelector('.dshwv-img'), root = document.querySelector('.dshwv-root');
  const failedRoleSources = new Set();
  let point = { x: -1, y: -1 }, heldPointer = null, releaseEpoch = 0, interactive = false, keyboardFocus = false, ready = false, lastStorage = '', surfaceExpanded = false, lastWidgetSize = '', lastHitRegion = '', lastSurfaceReason = 'none', lastDiagnosticKey = '';
  const standalone = bridge.standalone === true;
  const testMode = bridge.testMode === true;
  const surfaces = 'dialog[open],.dshwv-menu,.dshwv-menu-btn,.dshwv-rolelist,.dshwv-audiolist,[class*="mask"],.dshwv-qedit,.dshwv-usagepanel,.dshwv-custmenu,.dshwv-custbtn,.dshwv-tplhelp,.dshwv-fxinfo,.dshwv-fxicon,#toast:not([hidden])';
  // A visible hover button belongs to the compact widget hit area. It is not
  // an expanded surface: expanding the native window on hover creates a
  // resize -> coordinate -> hover feedback loop.
  const expandedSurfaces = 'dialog[open],.dshwv-menu.dshwv-menu-open,.dshwv-rolelist.dshwv-rolelist-open,.dshwv-audiolist.dshwv-audiolist-open,[class*="mask"],.dshwv-qedit,.dshwv-usagepanel,.dshwv-custmenu';
  const keyboardSurfaces = 'dialog[open],.dshwv-menu,.dshwv-rolelist,.dshwv-audiolist,[class*="mask"],.dshwv-qedit,.dshwv-usagepanel,.dshwv-custmenu';
  function visible(el) { return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }); }
  function contains(el, p) { const r = el.getBoundingClientRect(); return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom; }
  function imageHit(p) {
    if (!visible(pet)) return false;
    // Alpha hit-testing is preferred, but the native input gate must remain
    // usable while a role image is decoding or its transparent edge is being
    // animated. The image rectangle is the bounded fallback, never the whole
    // BrowserWindow.
    return rendering.hitCache.hit(pet, p.x, p.y, rendering.mirrorScale(root) < 0) || contains(pet, p);
  }
  function hit(p) {
    if ([...document.querySelectorAll('dialog[open]')].some(visible)) return true;
    for (const el of document.querySelectorAll(surfaces)) if (visible(el) && contains(el, p)) return true;
    const target = document.elementFromPoint(p.x, p.y);
    if (target?.closest('.dshwv-pop-open') && !target.closest('[inert]')) return true;
    return imageHit(p);
  }
  function update() {
    const next = heldPointer !== null || hit(point);
    if (next !== interactive) { interactive = next; if (!standalone) bridge.interactive(next); }
  }
  function updateKeyboardFocus() {
    // Menu fades start at opacity 0 and end without a DOM mutation. Use whether
    // the surface accepts input, so keyboard activation follows open/close now.
    const next = [...document.querySelectorAll(keyboardSurfaces)].some(el =>
      el.checkVisibility({ visibilityProperty: true }) && getComputedStyle(el).pointerEvents !== 'none');
    if (next !== keyboardFocus) { keyboardFocus = next; bridge.keyboardFocus(next); }
  }
  function updateSurface() {
    if (!standalone) return;
    const active = [...document.querySelectorAll(expandedSurfaces)].find(el =>
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && getComputedStyle(el).pointerEvents !== 'none');
    const next = !!active;
    const reason = active ? String(active.className || active.tagName || 'expanded-surface').slice(0, 80) : 'none';
    if (next !== surfaceExpanded || reason !== (surfaceExpanded ? lastSurfaceReason : 'none')) {
      surfaceExpanded = next;
      lastSurfaceReason = reason;
      bridge.surface(next, reason);
    }
  }
  function reportHitRegion(force = false) {
    if (!standalone || !pet || !bridge.hitRegion) return;
    const rect = pet.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return;
    const margin = 4;
    const nodes = [pet, ...document.querySelectorAll('.dshwv-pop-open,.dshwv-menu-btn-visible')].filter(el => {
      try {
        if (!visible(el)) return false;
        // The role image and the upstream SVG bubble deliberately use
        // pointer-events:none: the document capture handler owns the gesture.
        // They must still be native hit regions, otherwise an ignored
        // transparent BrowserWindow can only be re-enabled over the menu
        // button and the role becomes impossible to click after a reload or
        // Restore Widget action.
        const delegatedGesture = el === pet || el.matches?.('.dshwv-pop-open');
        return delegatedGesture || getComputedStyle(el).pointerEvents !== 'none';
      } catch { return false; }
    });
    const regions = nodes.map(el => {
      const box = el.getBoundingClientRect();
      return { left: box.left - margin, top: box.top - margin, width: box.width + margin * 2, height: box.height + margin * 2 };
    }).filter(region => region.width > 0 && region.height > 0);
    if (!regions.length) return;
    const key = JSON.stringify(regions.map(region => Object.values(region).map(value => Math.round(value * 2) / 2)));
    if (force || key !== lastHitRegion) { lastHitRegion = key; bridge.hitRegion({ regions }); }
  }
  function reportWidgetSize(forceDiagnostic = false) {
    if (!standalone || !root) return;
    const rect = root.getBoundingClientRect();
    const width = Math.max(root.offsetWidth || 0, Math.abs(rect.width || 0));
    const height = Math.max(root.offsetHeight || 0, Math.abs(rect.height || 0));
    const key = Math.round(width) + 'x' + Math.round(height);
    if (width <= 0 || height <= 0) return;
    if (key !== lastWidgetSize) {
      lastWidgetSize = key;
      const configuredScale = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dshw-scale'));
      const requested = Number.isFinite(configuredScale) ? Math.max(122, Math.min(625, Math.round(250 * configuredScale))) : width;
      bridge.widgetSize({ width, height, requestedWidth: requested, requestedHeight: requested });
    }
    reportHitRegion();
    if (testMode && (forceDiagnostic || key !== lastDiagnosticKey)) {
      lastDiagnosticKey = key;
      const style = getComputedStyle(root);
      const image = pet.getBoundingClientRect();
      const html = document.documentElement.getBoundingClientRect();
      bridge.layoutDiagnostic({
        viewport: { width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
        root: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, display: style.display, visibility: style.visibility, opacity: style.opacity, overflow: style.overflow },
        image: { left: image.left, top: image.top, width: image.width, height: image.height, complete: pet.complete, naturalWidth: pet.naturalWidth, naturalHeight: pet.naturalHeight, display: getComputedStyle(pet).display, visibility: getComputedStyle(pet).visibility, opacity: getComputedStyle(pet).opacity },
        html: { left: html.left, top: html.top, width: html.width, height: html.height },
        scale: Number.parseFloat(style.getPropertyValue('--dshw-scale')) || null,
      });
    }
  }
  function track(e) { point = { x: e.clientX, y: e.clientY }; update(); }
  // Electron forwards mousemove while ignoring input on Windows; pointermove alone is insufficient.
  document.addEventListener('mousemove', track, true);
  document.addEventListener('pointermove', track, true);
  document.addEventListener('pointerdown', e => {
    ++releaseEpoch;
    point = { x: e.clientX, y: e.clientY };
    // The widget's earlier capture listener may already accept this press and
    // start the squish animation. Its pending pointer capture is authoritative:
    // testing the now-moving alpha again must not discard the accepted gesture.
    let accepted = false;
    try { accepted = root.hasPointerCapture(e.pointerId); } catch {}
    if (accepted || hit(point)) heldPointer = e.pointerId;
    update();
  }, true);
  function release(e) {
    if (e?.clientX !== undefined) point = { x: e.clientX, y: e.clientY };
    const epoch = ++releaseEpoch;
    // Finish the application's pointerup/capture handlers before changing the
    // native window's input flags. A pressed/turning sprite may miss this pixel.
    requestAnimationFrame(() => { if (epoch === releaseEpoch) { heldPointer = null; update(); } });
  }
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  document.addEventListener('lostpointercapture', release, true);
  window.addEventListener('blur', () => { ++releaseEpoch; heldPointer = null; point = { x: -1, y: -1 }; update(); });
  bridge.onCursor(p => {
    // Preserve the real pointer during a captured drag; native fallback only discovers hover.
    if (heldPointer === null) {
      point = p; update();
      window.dispatchEvent(new CustomEvent('whale-hover', { detail: p }));
    }
  });
  rendering.onFrame(update);
  if (standalone && bridge.onLayoutRequest) bridge.onLayoutRequest(() => {
    // A size message can be intentionally deferred while native dragging or
    // an expanded surface owns the frame. Do not treat that deferred report
    // as applied; the host explicitly asks for a fresh measurement afterwards.
    lastWidgetSize = '';
    reportWidgetSize(true);
    reportHitRegion(true);
    request();
  });
  if (standalone && bridge.onNativeWidgetSize) bridge.onNativeWidgetSize(value => {
    if (!value || !Number.isFinite(Number(value.width)) || !Number.isFinite(Number(value.height))) return;
    if (value.constrained) root.style.setProperty('--dshw-base', Math.min(Number(value.width), Number(value.height)) + 'px');
    else root.style.removeProperty('--dshw-base');
    lastWidgetSize = '';
    reportWidgetSize(true);
    reportHitRegion(true);
  });
  if (standalone && bridge.onNativeRootOffset) bridge.onNativeRootOffset(value => {
    if (!value || !Number.isFinite(Number(value.left)) || !Number.isFinite(Number(value.top))) return;
    // The compact widget is bottom/right anchored inside the native surface.
    // When the surface grows, the host moves this local root so the visible
    // role keeps the same screen-space bottom-right anchor. The bubble/menu
    // remain in the same DOM and therefore keep the upstream renderer.
    root.style.left = Math.round(Number(value.left)) + 'px';
    root.style.top = Math.round(Number(value.top)) + 'px';
    window.dispatchEvent(new Event('whale-native-root-offset'));
    reportWidgetSize(true);
    reportHitRegion(true);
    rendering.presentFor(220);
  });
  // Layout ownership is deliberately one-way in standalone mode: ResizeObserver
  // and the native resize event report geometry; mutation/animation frames only
  // update hit testing and rendering. This prevents a window-resize -> DOM
  // mutation -> window-resize feedback loop.
  const request = () => { updateKeyboardFocus(); updateSurface(); reportHitRegion(); rendering.presentFor(); };
  new MutationObserver(request).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'src', 'open', 'hidden', 'inert'] });
  document.addEventListener('transitionrun', e => {
    if (e.target.closest('.dshwv-root,.dshwv-position')) rendering.presentFor(600);
  }, true);
  // The native host may resize the BrowserWindow before Chromium dispatches
  // its resize event. Force a fresh geometry report here so the host and the
  // packaged smoke evidence cannot retain the pre-resize viewport.
  window.addEventListener('resize', () => { reportWidgetSize(true); reportHitRegion(true); rendering.presentFor(220); });
  if (standalone && typeof ResizeObserver === 'function') new ResizeObserver(reportWidgetSize).observe(root);
  async function prepare() {
    if (!pet.complete) return;
    if (!pet.naturalWidth) { fallbackRole(); return; }
    const source = pet.currentSrc || pet.src;
    await rendering.hitCache.prepare(source);
    if (!pet.complete || !pet.naturalWidth || (pet.currentSrc || pet.src) !== source) return;
    if (!ready) { ready = true; bridge.ready(); }
    reportWidgetSize(true);
    reportHitRegion(true);
    request();
  }
  function fallbackRole() {
    const source = pet.currentSrc || pet.src;
    if (!source || failedRoleSources.has(source)) return;
    failedRoleSources.add(source);
    window.dispatchEvent(new CustomEvent('whale-role-fallback', { detail: { src: source, reason: 'decode-failed' } }));
  }
  pet.addEventListener('load', prepare);
  pet.addEventListener('error', fallbackRole);
  prepare();
  function save() {
    const values = Object.fromEntries(Object.keys(localStorage).filter(k => /^dshw[-v]/.test(k)).map(k => [k, localStorage.getItem(k)]));
    const encoded = JSON.stringify(values);
    if (encoded !== lastStorage) { lastStorage = encoded; bridge.save(values); }
  }
  // A hidden companion has no editable surfaces. Keep the last snapshot rather
  // than repeatedly serializing localStorage while Codex is minimized.
  setInterval(() => { if (!document.hidden) save(); }, 800);
  document.addEventListener('visibilitychange', save);
  window.addEventListener('beforeunload', save);
  request();
})();
