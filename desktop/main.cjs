const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, globalShortcut, shell, protocol, session, net, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { UiStateStore } = require('./ui-state-store.cjs');
const { shutdownCompanion } = require('./lifecycle.cjs');
const { externalWebUrl } = require('./external-links.cjs');
const { syncNativeViewport } = require('./native-viewport.cjs');
const { createHeartbeatMonitor } = require('./heartbeat.cjs');
const { acceptsWindowMessage } = require('./ipc-window.cjs');
const { validateWindowShape, EMPTY_SHAPE } = require('./window-shape.cjs');
const { createVisibilityController } = require('./visibility.cjs');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const dataDir = process.argv.find(a => a.startsWith('--whale-data='))?.slice(13);
const fixture = process.env.WHALE_DESKTOP_TEST === '1';
const initialHost = (() => { try { const h = JSON.parse(process.env.WHALE_INITIAL_HOST || 'null'); return h?.hostAlive ? h : null; } catch { return null; } })();
const startupAt = Date.now();
const startup = { revision: 'complete-audit-v1', requestedAt: Number(process.env.WHALE_LAUNCH_TIME) || startupAt, mainAt: startupAt, phases: {} };
const markStartup = phase => { if (startup.phases[phase] == null) startup.phases[phase] = Date.now() - startup.requestedAt; };
markStartup('main');
const isMac = process.platform === 'darwin';
const usesWindowShape = process.platform === 'win32';
let windowShape = null, windowShapeError = null;
const toDipRect = rect => isMac ? rect : screen.screenToDipRect(null, rect);
// Windows layered/region-clipped transparent windows can remain logically
// visible while their GPU surface stops presenting. Use the software path for
// this small companion only; no settings or switches are applied to Codex.
const softwareRendering = process.platform === 'win32' && process.env.WHALE_RENDER_MODE !== 'hardware';
if (softwareRendering) app.disableHardwareAcceleration();
else if (process.platform !== 'win32') app.commandLine.appendSwitch('enable-gpu-rasterization');
if (!dataDir || !path.isAbsolute(dataDir) || (!fixture && !process.argv.includes('--supervised'))) app.exit(1);
protocol.registerSchemesAsPrivileged([{ scheme: 'whale', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
fs.mkdirSync(path.join(dataDir, 'desktop-profile'), { recursive: true });
app.setPath('userData', path.join(dataDir, 'desktop-profile'));
const lock = app.requestSingleInstanceLock();
let window, tray, dispatcher, bridge, lastHost = initialHost, owner = '', appliedBounds = '', rendererReady = false, quitting = false, manuallyHidden = false, hostHeartbeat = Date.now();
const rendererErrors = [];
const fixtureOpenedLinks = [];
let hostSequence = -1;
let appliedNativeSize = '';
const stateFile = path.join(dataDir, 'ui-state.json');
const read = (f, fallback = {}) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; } };
const save = (file, value) => { const temp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file); };
let desktopMode = read(path.join(dataDir, 'follow-config.json')).mode === 'standalone' ? 'standalone' : 'follow-codex';
let desktopBoundsApplied = false, modePending = false;
let recoveryAttempts = 0, recoveryTimer = null, readyTimer = null;
const visibilityHistory = [];
const uiStore = new UiStateStore(stateFile);
const values = () => uiStore.get();
const storeValues = input => uiStore.set(input);
let gpuStatus = null, inputEnabled = false, keyboardFocus = false, testCursor = null, lastCursor = '', presents = 0;
let macPresentTimer = null, macPresentUntil = 0;
const pendingCommands = [];
let trustedGestureAt = 0;
app.on('gpu-info-update', () => {
  gpuStatus = { requestedMode: softwareRendering ? 'software' : 'hardware-auto', hardwareAcceleration: app.isHardwareAccelerationEnabled(), features: app.getGPUFeatureStatus(), electron: process.versions.electron, chromium: process.versions.chrome };
  fs.promises.writeFile(path.join(dataDir, 'render-status.json'), JSON.stringify(gpuStatus, null, 2)).catch(() => {});
});
function invalidate() { if (window && !window.isDestroyed()) { presents++; window.webContents.invalidate(); } }
function presentMacFor(ms) {
  if (!isMac || quitting || !window || window.isDestroyed()) return;
  macPresentUntil = Math.max(macPresentUntil, Date.now() + Math.min(1000, Math.max(0, Number(ms) || 0)));
  if (macPresentTimer) return;
  const tick = () => {
    macPresentTimer = null;
    invalidate();
    if (Date.now() < macPresentUntil) macPresentTimer = setTimeout(tick, 16);
  };
  tick();
}
function applyWindowShape(rects) {
  if (!usesWindowShape || quitting || !window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
  const shape = validateWindowShape(rects, window.getContentBounds());
  if (!shape) return false;
  try {
    window.setShape(shape);
    const recovering = !!windowShapeError;
    windowShape = shape; windowShapeError = null;
    // Changing a native region also changes which transparent compositor pixels
    // may be presented. Submit the existing frame once; never hide/reload it.
    invalidate();
    if (recovering) visibility();
    return true;
  } catch (error) {
    windowShapeError = String(error?.message || error).slice(0, 350);
    diagnose('window-shape-failed');
    // Keep the last successful region. If even the initial shape failed, stay
    // hidden instead of exposing a full-client-area surface or reload looping.
    if (!windowShape) { inputEnabled = false; window.setIgnoreMouseEvents(true, { forward: !usesWindowShape }); window.hide(); }
    return false;
  }
}
function setKeyboardFocus(editing) {
  if (!window || window.isDestroyed() || keyboardFocus === editing) return;
  keyboardFocus = editing;
  if (editing) window.focus();
}
function sendCursor(force = false) {
  if (!window || window.isDestroyed() || !rendererReady || !window.isVisible()) return;
  const bounds = window.getContentBounds(), cursor = screen.getCursorScreenPoint();
  const point = { ...(fixture && testCursor ? testCursor : { x: cursor.x - bounds.x, y: cursor.y - bounds.y }), buttons: lastHost?.mouseButtons || 0, sampledAt: lastHost?.mouseSampleAt || 0 };
  const encoded = point.x + ',' + point.y + ',' + point.buttons;
  if (force || encoded !== lastCursor) { lastCursor = encoded; window.webContents.send('whale-cursor', point); }
}
function setTestCursor(point) { if (fixture) { testCursor = point; sendCursor(true); } }
const visibilityController = createVisibilityController({
  getWindow: () => window,
  getState: () => ({ ready: rendererReady && !modePending && (!usesWindowShape || !!windowShape), host: lastHost, standalone: desktopMode === 'standalone', fixture, manuallyHidden, quitting }),
  onShown: () => {
    if (startup.phases.interactive == null) {
      markStartup('interactive');
      fs.promises.writeFile(path.join(dataDir, 'startup-timings.json'), JSON.stringify(startup, null, 2)).catch(() => {});
    }
  },
});
function visibility() {
  visibilityController.update();
}
function show() {
  manuallyHidden = false;
  // Showing during normal startup must not restart an already loading page.
  if (!rendererReady && !readyTimer && !recoveryTimer && window && !window.isDestroyed() && !window.webContents.isLoading()) {
    recoveryAttempts = 0; recoverRenderer('manual-recovery');
  }
  visibilityController.requestRecovery();
}
function toggle() { if (manuallyHidden) show(); else { manuallyHidden = true; visibility(); } }
function sendCommand(command) {
  if (!window || window.isDestroyed() || !command) return false;
  show();
  if (rendererReady) window.webContents.send('whale-command', command);
  else if (!pendingCommands.includes(command)) pendingCommands.push(command);
  return true;
}
function flushCommands() {
  if (!rendererReady || !window || window.isDestroyed()) return;
  for (const command of pendingCommands.splice(0)) window.webContents.send('whale-command', command);
}
async function showStatusDialog() {
  let provider = {};
  try { provider = dispatcher?.whale?.config?.publicInfo() || {}; } catch {}
  const lines = [
    '平台：' + process.platform,
    '跟随模式：' + (lastHost?.followMode || (lastHost?.nativeFollowing ? 'native' : '等待 Codex')),
    'Codex PID：' + (lastHost?.hostPid || '未检测到'),
    '挂件窗口：' + (window?.isVisible?.() ? '显示' : '隐藏'),
    '桌面模式：' + desktopMode,
    '素材就绪：' + rendererReady,
    '恢复次数：' + recoveryAttempts,
  ];
  await dialog.showMessageBox({
    type: 'info',
    title: '挂件运行状态',
    message: 'API 余额小鲸鱼',
    detail: lines.join('\n'),
    buttons: ['关闭'],
  });
}
function pauseAndQuit() { save(path.join(dataDir, 'pause-until-host-exit.json'), { pauseAll: desktopMode === 'standalone', hostPid: lastHost?.hostPid || 0, hostSession: lastHost?.hostSession || '', hostWindow: lastHost?.window || '0' }); app.quit(); }
function isMainFrame(event) { if(!acceptsWindowMessage(window,event,quitting))return false;try{return event.senderFrame === window.webContents.mainFrame;}catch{return false;} }
async function openWebLink(value, gestureRequired = true) {
  if (gestureRequired && (!trustedGestureAt || Date.now() - trustedGestureAt > 1000)) return false;
  trustedGestureAt = 0;
  let target = value;
  if (value === 'whale://widget/provider-dashboard') {
    try { target = dispatcher.whale.config.resolve().dashboardUrl; } catch { return false; }
  }
  const url = externalWebUrl(target);
  if (!url) return false;
  try {
    if (fixture) fixtureOpenedLinks.push(url);
    else await shell.openExternal(url);
    return true;
  } catch { return false; }
}
async function setHost(host) {
  if (!host || typeof host.hostAlive !== 'boolean') return;
  if (Number.isSafeInteger(host.serial)) { if (host.serial <= hostSequence) return; hostSequence = host.serial; }
  hostHeartbeat = Date.now(); lastHost = host;
  if (host.monitorExit) { app.quit(); return; }
  sendCursor();
  if (modePending) {
    if (host.mode !== desktopMode || (desktopMode === 'standalone' ? host.nativeFollowing || host.attached : host.hostAlive && !host.attached)) return;
    modePending = false;
    window.setAlwaysOnTop(desktopMode === 'standalone' || isMac, 'floating');
    window.webContents.send('whale-desktop-mode', desktopMode);
    updateTray();
  } else if (!isMac && !fixture && host.mode && host.mode !== desktopMode) return;
  if (desktopMode === 'standalone') {
    if (window && !host.nativeFollowing && !host.attached && !desktopBoundsApplied) { window.setBounds(screen.getPrimaryDisplay().workArea); window.setAlwaysOnTop(true, 'floating'); desktopBoundsApplied = true; visibilityController.requestRecovery(); }
    visibility(); return;
  }
  if (!host.hostAlive) { if (window) app.quit(); return; }
  if (!window) return;
  if (host.attached) markStartup('attached');
  // Native events own position. Only Electron may resize its non-resizable
  // viewport; it updates the corresponding native min/max tracking sizes.
  appliedNativeSize = syncNativeViewport(host, window, screen, appliedNativeSize);
  // Stale coordinates never go through setBounds while native following runs.
  if (!host.nativeFollowing && host.visible && host.bounds && [host.bounds.x, host.bounds.y, host.bounds.width, host.bounds.height].every(Number.isFinite)) {
    const rect = toDipRect(host.bounds);
    const key = JSON.stringify(rect);
    if (rect.width > 10 && rect.height > 10 && appliedBounds !== key) {
      const current = window.getBounds();
      if (rect.width !== current.width || rect.height !== current.height) window.setBounds(rect);
      else window.setPosition(rect.x, rect.y);
      appliedBounds = key; sendCursor(true);
    }
  }
  owner = host.window || '';
  visibility();
  if (visibilityController.observeNativeVisibility()) diagnose('native-window-hidden');
}

async function importLegacyStorage() {
  const marker = path.join(dataDir, 'legacy-storage-imported.json');
  if (fs.existsSync(marker) || fixture) return;
  const legacy = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  session.defaultSession.protocol.handle('http', request => new Response(request.url.startsWith('http://127.0.0.1:47321/') ? '<!doctype html><title>Local migration</title>' : '', { status: request.url.startsWith('http://127.0.0.1:47321/') ? 200 : 403, headers: { 'Content-Type': 'text/html' } }));
  try {
    await legacy.loadURL('http://127.0.0.1:47321/');
    const old = await legacy.webContents.executeJavaScript("Object.fromEntries(Object.keys(localStorage).filter(k => /^dshw[-v]/.test(k)).map(k => [k, localStorage.getItem(k)]))");
    storeValues({ ...old, ...values() }); save(marker, { complete: true, at: new Date().toISOString() });
  } finally { legacy.destroy(); session.defaultSession.protocol.unhandle('http'); }
}

if (!lock) app.quit();
else {
  app.on('second-instance', show);
  app.whenReady().then(async () => {
    markStartup('appReady');
    const { createDispatcher, UI_ORIGIN } = await import(pathToFileURL(path.join(root, 'runtime', 'dispatcher.mjs')));
    const { startBridge } = await import(pathToFileURL(path.join(root, 'runtime', 'bridge.mjs')));
    let testOptions = {};
    if (fixture) { const { makeFixture } = await import(pathToFileURL(path.join(root, 'tests', 'desktop-fixture.mjs'))); testOptions = await makeFixture(dataDir); }
    dispatcher = createDispatcher({ dataDir, fetchImpl: (url, options) => net.fetch(url, options), onStop: pauseAndQuit, onShow: show, statusInfo: () => ({ followCodex: desktopMode !== 'standalone', desktopMode, rendererReady, recoveryAttempts, manuallyHidden, platform: process.platform, followMode: lastHost?.followMode || null, hostPid: lastHost?.hostPid || null, visible: !!window?.isVisible(), modePending, windowShape, windowShapeError, windowBounds: window?.getBounds(), visibility: visibilityController.snapshot(), nativeFollowing: !!lastHost?.nativeFollowing, mouseRouting: { forwardedMouseMoves: !usesWindowShape, cursorPollMs: usesWindowShape ? 16 : 50 }, startup, rendering: gpuStatus }), ...testOptions });
    markStartup('dispatcherReady');
    await importLegacyStorage();
    session.defaultSession.protocol.handle('whale', async request => {
      const url = new URL(request.url);
      if (url.host !== 'widget') return new Response('', { status: 403 });
      const result = await dispatcher.dispatch(url.pathname + url.search, { method: request.method, body: ['GET', 'HEAD'].includes(request.method) ? null : Buffer.from(await request.arrayBuffer()), headers: Object.fromEntries(request.headers) });
      return new Response(request.method === 'HEAD' ? null : result.body, { status: result.status, headers: result.headers });
    });
    const firstBounds = initialHost?.bounds;
    const area = firstBounds && ['x','y','width','height'].every(k => Number.isFinite(firstBounds[k])) && firstBounds.width > 10 && firstBounds.height > 10
      ? toDipRect(firstBounds) : screen.getPrimaryDisplay().workArea;
    // WS_EX_TOOLWINDOW keeps the large transparent overlay out of Chromium's
    // native occlusion calculation even while its opaque pixels accept clicks.
    // Keep normal activation: Chromium's non-client handler consumes the first
    // mouse down (MA_NOACTIVATEANDEAT) when CanActivate/focusable is false.
    window = new BrowserWindow({ ...area, ...(isMac ? { acceptFirstMouse: true } : { type: 'toolbar' }), transparent: true, frame: false, thickFrame: false, resizable: false, maximizable: false, fullscreenable: false, backgroundColor: '#00000000', hasShadow: false, skipTaskbar: true, show: false, title: 'API 余额小鲸鱼', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', additionalArguments: fixture ? ['--whale-render-test'] : [] } });
    if (usesWindowShape) applyWindowShape(EMPTY_SHAPE);
    if (isMac) {
      if (app.dock) app.dock.hide();
      window.setAlwaysOnTop(true, 'floating', 1);
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
    window.setAlwaysOnTop(isMac || desktopMode === 'standalone', 'floating');
    if (desktopMode === 'standalone') window.setBounds(screen.getPrimaryDisplay().workArea);
    window.webContents.on('render-process-gone', (_event, details) => { rendererReady = false; visibility(); recoverRenderer('renderer-' + details.reason); });
    window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => { if (isMainFrame && code !== -3) recoverRenderer('load-' + code); });
    markStartup('windowCreated');
    window.once('ready-to-show', () => markStartup('frameReady'));
    if (fixture) window.webContents.on('console-message', (_event, ...args) => { const d = args[0]; if (typeof d === 'object' ? d.level === 'error' : d === 3) rendererErrors.push(typeof d === 'object' ? d.message : args[1]); });
    if (!fixture) process.stdout.write(JSON.stringify({ overlayHandle: window.getNativeWindowHandle().readBigUInt64LE().toString() }) + '\n');
    window.setIgnoreMouseEvents(true, { forward: !usesWindowShape });
    window.on('show', () => { diagnose('window-shown'); invalidate(); sendCursor(true); });
    window.on('hide', () => diagnose('window-hidden'));
    window.on('resize', () => {
      invalidate();
      // Keep the previous region while the renderer lays out the new viewport.
      if (usesWindowShape && !window.webContents.isDestroyed()) window.webContents.send('whale-shape-request');
    });
    window.webContents.on('did-start-loading', () => {
      if(quitting || !window || window.isDestroyed())return;
      rendererReady = false; inputEnabled = false; clearTimeout(readyTimer); readyTimer = setTimeout(() => { if (!rendererReady) recoverRenderer('ready-timeout'); }, 15000);
      if (usesWindowShape) applyWindowShape(EMPTY_SHAPE);
      visibility();
      setKeyboardFocus(false);
      window.setIgnoreMouseEvents(true, { forward: !usesWindowShape });
    });
    window.webContents.setWindowOpenHandler(({ url }) => { openWebLink(url).catch(() => {}); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(UI_ORIGIN + '/')) event.preventDefault(); });
    session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    ipcMain.on('whale-storage', event => { event.returnValue = acceptsWindowMessage(window,event,quitting) ? values() : {}; });
    ipcMain.on('whale-save-storage', (event, input) => { if (acceptsWindowMessage(window,event,quitting)) storeValues(input); });
    ipcMain.on('whale-user-gesture', event => { if (isMainFrame(event)) trustedGestureAt = Date.now(); });
    ipcMain.on('whale-shape', (event, rects) => { if (isMainFrame(event)) applyWindowShape(rects); });
    ipcMain.handle('whale-open-external', (event, url) => isMainFrame(event) ? openWebLink(url) : false);
    ipcMain.handle('whale-command', async (event, command) => {
      if (!isMainFrame(event)) return false;
      if (command === 'desktop') return setMode('standalone');
      if (command === 'follow') return setMode('follow-codex');
      if (command === 'mode') return desktopMode;
      if (command === 'show') { show(); return true; }
      if (command === 'status') { await showStatusDialog(); return true; }
      if (command === 'stop') { pauseAndQuit(); return true; }
      if (command === 'reset-position') return resetPosition();
      if (['balance', 'usage', 'settings'].includes(command)) return sendCommand(command);
      return false;
    });
    ipcMain.on('whale-ready', event => {
      if (!acceptsWindowMessage(window,event,quitting)) return;
      markStartup('imageAndInputReady');
      try { fs.rmSync(path.join(dataDir, 'desktop-error.json'), { force: true }); } catch {}
      clearTimeout(readyTimer); readyTimer = null;
      clearTimeout(recoveryTimer); recoveryTimer = null;
      rendererReady = true; diagnose('ready'); window.webContents.send('whale-desktop-mode', desktopMode); visibility(); flushCommands(); invalidate(); sendCursor(true);
    });
    ipcMain.on('whale-interactive', (event, enabled) => {
      if (!acceptsWindowMessage(window,event,quitting) || (usesWindowShape && !windowShape) || typeof enabled !== 'boolean' || enabled === inputEnabled) return;
      inputEnabled = enabled;
      window.setIgnoreMouseEvents(!enabled, { forward: !usesWindowShape });
    });
    ipcMain.on('whale-keyboard-focus', (event, editing) => {
      if (acceptsWindowMessage(window,event,quitting) && typeof editing === 'boolean') setKeyboardFocus(editing);
    });
    ipcMain.on('whale-present-for', (event, ms) => {
      if (acceptsWindowMessage(window, event, quitting)) presentMacFor(ms);
    });
    // Windows uses the native cursor sampler instead of forwarding ignored mouse
    // messages into Chromium, which must not arbitrate the host cursor.
    const cursorPoll = setInterval(sendCursor, usesWindowShape ? 16 : 50);
    app.once('will-quit', () => clearInterval(cursorPoll));
    const icon = nativeImage.createFromPath(path.join(root, 'assets', 'DSniang1.png')).resize({ width: 24, height: 24 });
    tray = new Tray(icon); tray.setToolTip('API 余额小鲸鱼 · 跟随 Codex');
    updateTray();
    tray.on('double-click', toggle); globalShortcut.register(isMac ? 'Command+Option+W' : 'Control+Alt+W', toggle);
    bridge = await startBridge(dispatcher, { dataDir, onHost: setHost, onMode: setMode, onResetPosition: resetPosition });
    markStartup('bridgeReady');
    await window.loadURL(UI_ORIGIN + '/widget.html').catch(() => recoverRenderer('initial-load-failed'));
    markStartup('pageLoaded');
    if (lastHost) await setHost(lastHost);
    if (fixture) {
      const fixtureModule = process.env.WHALE_VISIBILITY_STRESS === '1' ? 'visibility-stress-fixture.mjs' : process.env.WHALE_DESKTOP_AUDIT === '1' ? 'desktop-audit-fixture.mjs' : 'desktop-fixture.mjs';
      const { verifyDesktop } = await import(pathToFileURL(path.join(root, 'tests', fixtureModule)));
      await verifyDesktop({ app, window, screen, setHost, setTestCursor, dispatcher, dataDir, errors: rendererErrors, openedLinks: fixtureOpenedLinks, renderInfo: () => ({ gpuStatus, presents, inputEnabled, keyboardFocus, windowShape, windowShapeError, visibility: visibilityController.snapshot() }) });
    }
    else {
      const health=createHeartbeatMonitor({lastSeen:()=>hostHeartbeat,onDelayed:()=>diagnose('monitor-heartbeat-delayed'),onRecovered:()=>diagnose('monitor-heartbeat-restored')});
      const supervisorPid=Number(process.env.WHALE_SUPERVISOR_PID);
      const heartbeat=setInterval(()=>{
        const delayed=health.check();
        // Windows GUI Electron stdin can report EOF while its parent lives.
        // Check only the launch-time parent PID, and never terminate that PID.
        if(delayed&&Number.isSafeInteger(supervisorPid)&&supervisorPid>0){try{process.kill(supervisorPid,0);}catch(error){if(error.code==='ESRCH'&&!quitting){diagnose('supervisor-exited');app.quit();}}}
      },2000); app.once('will-quit',()=>clearInterval(heartbeat));
    }
  }).catch(error => { try { save(path.join(dataDir, 'desktop-error.json'), { message: String(error.message).slice(0, 350), at: new Date().toISOString() }); } catch {} app.exit(1); });
  app.on('window-all-closed', () => { if (!quitting && rendererReady) app.quit(); });
  app.on('before-quit', event => {
    clearTimeout(readyTimer); clearTimeout(recoveryTimer); clearTimeout(macPresentTimer); macPresentTimer = null;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    visibilityController.dispose();
    // Do not leave an unresponsive input surface over Codex while saving state.
    try { if (window && !window.isDestroyed()) { window.setIgnoreMouseEvents(true); window.hide(); } } catch {}
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true;
      globalShortcut.unregisterAll(); tray?.destroy();
      // Cleanup above replaces renderer beforeunload: an unresponsive renderer
      // must not be asked to approve quitting a second time.
      app.exit(0);
    };
    const watchdog = setTimeout(finish, 6500);
    shutdownCompanion({
      readRenderer: () => window && !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed?.()
        ? window.webContents.executeJavaScript("Object.fromEntries(Object.keys(localStorage).filter(k => /^dshw[-v]/.test(k)).map(k => [k, localStorage.getItem(k)]))") : null,
      saveRenderer: storeValues,
      flushState: () => uiStore.flush(),
      closeBridge: () => bridge?.close(),
      closeDispatcher: () => dispatcher?.close(),
    }).then(result => {
      try { save(path.join(dataDir, 'desktop-shutdown.json'), { at: new Date().toISOString(), ...result }); } catch {}
    }).catch(() => {}).finally(() => { clearTimeout(watchdog); finish(); });
  });
}

function diagnose(reason) { try {
  const entry={reason,desktopMode,ready:rendererReady,manuallyHidden,recoveryAttempts,hostAlive:!!lastHost?.hostAlive,hostVisible:!!lastHost?.visible,modal:!!lastHost?.modal,attached:!!lastHost?.attached,shapeCount:windowShape?.length||0,at:new Date().toISOString()};
  visibilityHistory.push(entry);if(visibilityHistory.length>24)visibilityHistory.shift();
  save(path.join(dataDir,'visibility-status.json'),{...entry,history:visibilityHistory});
} catch {} }
function resetPosition() {
  if(quitting||!window||window.isDestroyed())return false;
  if(rendererReady)window.webContents.send('whale-command','reset-position');
  else if(!pendingCommands.includes('reset-position'))pendingCommands.push('reset-position');
  return true;
}
function recoverRenderer(reason) {
  diagnose(reason);
  if (quitting || recoveryTimer || recoveryAttempts >= 3 || !window || window.isDestroyed()) return;
  recoveryAttempts++;
  recoveryTimer = setTimeout(() => { recoveryTimer = null; if (!quitting && !rendererReady && !window.isDestroyed()) window.webContents.reload(); }, 500 * recoveryAttempts);
}
function setMode(mode) {
  if(quitting || !window || window.isDestroyed())return false;
  if (!['standalone', 'follow-codex'].includes(mode)) return false;
  if (desktopMode === mode) { window.webContents.send(modePending ? 'whale-desktop-mode-changing' : 'whale-desktop-mode', mode); return true; }
  window.webContents.send('whale-desktop-mode-changing', mode);
  save(path.join(dataDir, 'follow-config.json'), { ...read(path.join(dataDir, 'follow-config.json')), mode }); desktopMode = mode; desktopBoundsApplied = false;
  appliedBounds = ''; appliedNativeSize = '';
  if (!isMac && !fixture) {
    // Native ownership must finish changing before Electron changes geometry.
    modePending = true; manuallyHidden = false; visibility(); return true;
  }
  if (mode === 'standalone') { window.setBounds(screen.getPrimaryDisplay().workArea); window.setAlwaysOnTop(true, 'floating'); }
  else { window.setAlwaysOnTop(isMac, 'floating'); if (lastHost) void setHost({ ...lastHost, serial: undefined }); }
  window.webContents.send('whale-desktop-mode', mode); show(); updateTray(); return true;
}
function updateTray() {
  if (!tray) return;
  tray.setToolTip('API 余额小鲸鱼 · ' + (desktopMode === 'standalone' ? '独立桌面' : '跟随 Codex'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏小鲸鱼', click: toggle }, { label: '恢复显示小鲸鱼', click: show },
    { label: '进入桌面', type: 'radio', checked: desktopMode === 'standalone', click: () => setMode('standalone') },
    { label: '跟随 Codex', type: 'radio', checked: desktopMode === 'follow-codex', click: () => setMode('follow-codex') },
    { label: '刷新余额', click: () => sendCommand('balance') }, { label: '查看用量记录', click: () => sendCommand('usage') },
    { label: 'API 设置', click: () => sendCommand('settings') }, { label: '查看运行状态', click: showStatusDialog },
    { type: 'separator' }, { label: desktopMode === 'standalone' ? '退出（手动启动后恢复）' : '本次退出（下次打开 Codex 恢复）', click: pauseAndQuit }
  ]));
}
