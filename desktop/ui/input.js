(() => {
  'use strict';
  const bridge = window.whaleDesktop, rendering = window.WhaleRendering;
  if (!bridge || !rendering) return;
  const pet = document.querySelector('.dshwv-img'), root = document.querySelector('.dshwv-root');
  const failedRoleSources = new Set();
  let pointerEventAt=0, nativeButtonsAt=0, releasedPointer=null;
  let point = { x: -1, y: -1 }, heldPointer = null, releaseEpoch = 0, interactive = false, keyboardFocus = false, ready = false, lastStorage = '', externalDrag = false;
  const surfaces = '.whale-account-card,dialog[open],.dshwv-menu-open,.dshwv-menu-btn-visible:not(.dshwv-menu-btn-hidden),.dshwv-rolelist,.dshwv-audiolist,.dshwv-qedit,.dshwv-usagepanel,.dshwv-custmenu,.dshwv-custbtn,.dshwv-tplhelp,.dshwv-fx-info,#toast:not([hidden])';
  const keyboardSurfaces = 'dialog[open],.dshwv-menu-open,.dshwv-rolelist,.dshwv-audiolist,[class*="mask"],.dshwv-qedit,.dshwv-usagepanel,.dshwv-custmenu,.dshwv-fx-info';
  function visible(el) { return !!el?.isConnected && !el.hidden && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }); }
  function acceptsInput(el) {
    if (!visible(el) || el.closest('[inert]') || getComputedStyle(el).pointerEvents === 'none') return false;
    // Child panels may remain painted during the parent menu's exit animation.
    const menu = el.closest('.dshwv-menu');
    return !menu || menu.classList.contains('dshwv-menu-open');
  }
  function contains(el, p) { const r = el.getBoundingClientRect(); return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom; }
  function hit(p) {
    for (const el of document.querySelectorAll(surfaces)) if (acceptsInput(el) && contains(el, p)) return true;
    // Transparent modal backdrops are not input surfaces. Only the bounded
    // content card may intercept the host pointer, matching the native region.
    function cardHit(el,depth=0){
      if(!visible(el))return false;const r=el.getBoundingClientRect();
      if(depth<3&&r.width>=innerWidth*.95&&r.height>=innerHeight*.95)return [...el.children].some(c=>cardHit(c,depth+1));
      return acceptsInput(el)&&contains(el,p);
    }
    for(const mask of document.querySelectorAll('[class*="mask"]'))if(visible(mask)&&[...mask.children].some(c=>cardHit(c)))return true;
    const target = document.elementFromPoint(p.x, p.y);
    if (target?.closest('.dshwv-pop-open') && !target.closest('[inert]')) return true;
    return visible(pet) && (rendering.petInteraction ? rendering.petInteraction.hit(pet, root, p.x, p.y) :
      rendering.hitCache.hit(pet, p.x, p.y, rendering.mirrorScale(root) < 0));
  }
  function update() {
    rendering.petInteraction?.move(point);
    const next = heldPointer !== null || rendering.petInteraction?.holding() || !externalDrag && hit(point);
    if (next !== interactive) { interactive = next; bridge.interactive(next); }
  }
  function updateKeyboardFocus() {
    // Menu fades start at opacity 0 and end without a DOM mutation. Use whether
    // the surface accepts input, so keyboard activation follows open/close now.
    const next = [...document.querySelectorAll(keyboardSurfaces)].some(el =>
      el.checkVisibility({ visibilityProperty: true }) && getComputedStyle(el).pointerEvents !== 'none');
    if (next !== keyboardFocus) { keyboardFocus = next; bridge.keyboardFocus(next); }
  }
  function track(e) { pointerEventAt=Date.now(); point = { x: e.clientX, y: e.clientY }; externalDrag = heldPointer === null && Number(e.buttons) > 0; update(); }
  // Real movement events are handled while interactive. Ignored Windows areas
  // use bridge.onCursor below and do not forward host mouse events to Chromium.
  document.addEventListener('mousemove', track, true);
  document.addEventListener('pointermove', track, true);
  document.addEventListener('pointerdown', e => {
    pointerEventAt = Date.now(); releasedPointer = null;
    externalDrag = false;
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
    pointerEventAt = Date.now(); releasedPointer = e?.pointerId ?? null;
    externalDrag = false;
    if (e?.clientX !== undefined) point = { x: e.clientX, y: e.clientY };
    const epoch = ++releaseEpoch;
    // Finish the application's pointerup/capture handlers before changing the
    // native window's input flags. A pressed/turning sprite may miss this pixel.
    requestAnimationFrame(() => { if (epoch === releaseEpoch) { heldPointer = null; update(); } });
  }
  function cancelInteraction() {
    pointerEventAt = Date.now(); releasedPointer = null;
    ++releaseEpoch; heldPointer = null; externalDrag = false; point = { x: -1, y: -1 };
    rendering.petInteraction?.cancel(); update();
  }
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', cancelInteraction, true);
  document.addEventListener('lostpointercapture', e => {
    // Normal pointerup releases native capture before its DOM click. A later
    // lost-capture event belongs to that release, not to a new cancellation.
    if (root.hasPointerCapture?.(e.pointerId) || releasedPointer === e.pointerId || rendering.petInteraction?.releasing(e.pointerId)) return;
    cancelInteraction();
  }, true);
  window.addEventListener('blur', cancelInteraction);
  bridge.onCursor(p => {
    // Preserve the real pointer during a captured drag; native fallback only discovers hover.
    if (heldPointer === null) {
      // Coordinates are sampled now, while buttons may come from an older
      // native heartbeat. Never let a late down sample override a real up.
      if (typeof p.buttons === 'number' && Number.isFinite(p.sampledAt) && p.sampledAt > Math.max(pointerEventAt, nativeButtonsAt)) {
        nativeButtonsAt = p.sampledAt; externalDrag = p.buttons > 0;
      }
      point = p; update();
      window.dispatchEvent(new CustomEvent('whale-hover', { detail: externalDrag ? {x:-1,y:-1} : p }));
    }
  });
  window.addEventListener('whale-mode-changing', cancelInteraction);
  window.addEventListener('whale-desktop-mode', cancelInteraction);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelInteraction(); });
  window.addEventListener('whale-interaction-geometry', update);
  rendering.onFrame(update);
  if(bridge.testMode)window.__whaleInputTest={hit,status:()=>({interactive,heldPointer,externalDrag,pointerEventAt,nativeButtonsAt})};
  const request = () => { updateKeyboardFocus(); rendering.presentFor(); };
  new MutationObserver(request).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'src', 'open', 'hidden', 'inert'] });
  document.addEventListener('transitionrun', e => {
    if (e.target.closest('.dshwv-root,.dshwv-position')) rendering.presentFor(600);
  }, true);
  window.addEventListener('resize', () => rendering.presentFor(220));
  async function prepare() {
    if (!pet.complete) return;
    if (!pet.naturalWidth) { fallbackRole(); return; }
    const source = pet.currentSrc || pet.src;
    await rendering.hitCache.prepare(source);
    if (!pet.complete || !pet.naturalWidth || (pet.currentSrc || pet.src) !== source) return;
    if (!ready) { ready = true; bridge.ready(); }
    request();
  }
  function fallbackRole() {
    const source = pet.currentSrc || pet.src;
    if (!source || failedRoleSources.has(source)) return;
    failedRoleSources.add(source);
    if (/\/dsh-whale\/image\.png(?:\?|$)/.test(source)) {
      // Network-independent visible emergency art: do not wait forever for ready.
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 160;
      const c = canvas.getContext('2d'); c.fillStyle = '#6184cf'; c.beginPath(); c.ellipse(78, 95, 60, 42, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.moveTo(125, 94); c.lineTo(158, 65); c.lineTo(154, 112); c.closePath(); c.fill();
      c.fillStyle = 'white'; c.beginPath(); c.arc(53, 86, 8, 0, Math.PI * 2); c.fill(); c.fillStyle = '#203170'; c.beginPath(); c.arc(51, 86, 4, 0, Math.PI * 2); c.fill();
      pet.src = canvas.toDataURL('image/png'); pet.alt = '小鲸鱼恢复占位图';
      if (!ready) { ready = true; bridge.ready(); }
      window.whaleToast?.('内置角色无法读取，已使用恢复占位图。可重新选择角色或修复安装。');
      request(); return;
    }
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
  window.addEventListener('whale-position-committed', save);
  window.addEventListener('beforeunload', save);
  request();
})();
