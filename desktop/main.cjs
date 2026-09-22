const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, globalShortcut, shell, protocol, session, net, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { UiStateStore } = require('./ui-state-store.cjs');
const { shutdownCompanion } = require('./lifecycle.cjs');
const { externalWebUrl } = require('./external-links.cjs');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const dataDir = process.argv.find(a => a.startsWith('--whale-data='))?.slice(13);
const fixture = process.env.WHALE_DESKTOP_TEST === '1';
const initialHost = (() => { try { const h = JSON.parse(process.env.WHALE_INITIAL_HOST || 'null'); return h?.hostAlive ? h : null; } catch { return null; } })();
const startupAt = Date.now();
const startup = { revision: 'codex-0.2.4', requestedAt: Number(process.env.WHALE_LAUNCH_TIME) || startupAt, mainAt: startupAt, phases: {} };
const markStartup = phase => { if (startup.phases[phase] == null) startup.phases[phase] = Date.now() - startup.requestedAt; };
markStartup('main');
const isMac = process.platform === 'darwin';
const toDipRect = rect => isMac ? rect : screen.screenToDipRect(null, rect);
// Leave device/driver safety checks to Chromium; do not bypass the GPU blocklist.
app.commandLine.appendSwitch('enable-gpu-rasterization');
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
const uiStore = new UiStateStore(stateFile);
const values = () => uiStore.get();
const storeValues = input => uiStore.set(input);
let gpuStatus = null, inputEnabled = false, keyboardFocus = false, testCursor = null, lastCursor = '', presents = 0;
const pendingCommands = [];
let trustedGestureAt = 0;
app.on('gpu-info-update', () => {
  gpuStatus = { hardwareAcceleration: app.isHardwareAccelerationEnabled(), features: app.getGPUFeatureStatus(), electron: process.versions.electron, chromium: process.versions.chrome };
  fs.promises.writeFile(path.join(dataDir, 'render-status.json'), JSON.stringify(gpuStatus, null, 2)).catch(() => {});
});
function invalidate() { if (window && !window.isDestroyed()) { presents++; window.webContents.invalidate(); } }
function setKeyboardFocus(editing) {
  if (!window || window.isDestroyed() || keyboardFocus === editing) return;
  keyboardFocus = editing;
  if (editing) window.focus();
}
function sendCursor(force = false) {
  if (!window || window.isDestroyed() || !rendererReady || !window.isVisible()) return;
  const bounds = window.getContentBounds(), cursor = screen.getCursorScreenPoint();
  const point = fixture && testCursor ? testCursor : { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
  const encoded = point.x + ',' + point.y;
  if (force || encoded !== lastCursor) { lastCursor = encoded; window.webContents.send('whale-cursor', point); }
}
function setTestCursor(point) { if (fixture) { testCursor = point; sendCursor(true); } }
function visibility() {
  if (!window || window.isDestroyed()) return;
  if (rendererReady && lastHost?.visible && (fixture || lastHost.attached) && !manuallyHidden) {
    if (!window.isVisible()) window.showInactive();
    if (startup.phases.interactive == null) {
      markStartup('interactive');
      fs.promises.writeFile(path.join(dataDir, 'startup-timings.json'), JSON.stringify(startup, null, 2)).catch(() => {});
    }
  } else window.hide();
}
function show() { manuallyHidden = false; visibility(); }
function toggle() { manuallyHidden = !manuallyHidden; visibility(); }
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
    '服务商：' + (provider.providerName || '未配置'),
    'API 地址：' + (provider.baseUrl || '未配置'),
  ];
  await dialog.showMessageBox({
    type: 'info',
    title: '挂件运行状态',
    message: 'API 余额小鲸鱼',
    detail: lines.join('\n'),
    buttons: ['关闭'],
  });
}
// 0.2.0: re-assert the decision instead of relying on a single IPC message. The
// host heartbeat already arrives every second and visibility() is idempotent, so
// this repairs any dropped, out-of-order or zero-handle state without changing
// the intended hide-on-minimize behaviour. The timer starts with the window.
function assertVisibility() {
  if (!lastHost || lastHost.hostAlive === false) return;
  visibility();
}
function pauseAndQuit() {
  if (isMac) {
    save(path.join(dataDir, 'pause-until-host-exit.json'), {
      pauseAll: true,
      hostPid: lastHost?.hostPid || 0,
      hostSession: lastHost?.hostSession || '',
      hostWindow: lastHost?.window || '0',
    });
  } else if (lastHost?.hostPid) {
    save(path.join(dataDir, 'pause-until-host-exit.json'), { hostPid: lastHost.hostPid });
  }
  app.quit();
}
function isMainFrame(event) { return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame; }
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
  // 0.2.0: an older serial is stale for geometry only. The supervisor restarts
  // its counter at 1 whenever it restarts, so dropping the whole message used to
  // freeze the widget's visibility state forever; accept the snapshot for
  // lifecycle, lastHost and visibility, and never apply stale bounds.
  let staleSnapshot = false;
  if (Number.isSafeInteger(host.serial)) {
    if (host.serial <= hostSequence) staleSnapshot = true;
    else hostSequence = host.serial;
  }
  hostHeartbeat = Date.now(); lastHost = host;
  if (!host.hostAlive) { if (window) app.quit(); return; }
  if (!window) return;
  if (staleSnapshot) { visibility(); return; }
  if (host.attached) markStartup('attached');
  // Native events own position. Only Electron may resize its non-resizable
  // viewport; it updates the corresponding native min/max tracking sizes.
  if (host.nativeFollowing && host.visible && host.bounds && ['width','height','x','y'].every(k => Number.isFinite(host.bounds[k]))) {
    const current = window.getBounds();
    const scale = Number.isFinite(host.dpi) && host.dpi >= 96 ? host.dpi / 96 : screen.getDisplayMatching(current).scaleFactor;
    const width = Math.round(host.bounds.width / scale), height = Math.round(host.bounds.height / scale);
    const sizeKey = [host.window, width, height, scale].join(':');
    // getBounds encloses fractional DIP edges and can differ by one DIP as x
    // changes. Compare requested sizes, not that rounded result, on heartbeats.
    if (width > 10 && height > 10 && sizeKey !== appliedNativeSize) {
      if (width !== current.width || height !== current.height) window.setBounds({ ...current, width, height });
      appliedNativeSize = sizeKey;
    }
  }
  if (!host.nativeFollowing) appliedNativeSize = '';
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
    dispatcher = createDispatcher({ dataDir, fetchImpl: (url, options) => net.fetch(url, options), onStop: pauseAndQuit, onShow: show, statusInfo: () => ({ followCodex: true, platform: process.platform, followMode: lastHost?.followMode || null, hostPid: lastHost?.hostPid || null, visible: !!window?.isVisible(), nativeFollowing: !!lastHost?.nativeFollowing, startup, rendering: gpuStatus }), ...testOptions });
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
    if (isMac) {
      if (app.dock) app.dock.hide();
      window.setAlwaysOnTop(true, 'floating', 1);
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
    markStartup('windowCreated');
    window.once('ready-to-show', () => markStartup('frameReady'));
    if (fixture) window.webContents.on('console-message', (_event, ...args) => { const d = args[0]; if (typeof d === 'object' ? d.level === 'error' : d === 3) rendererErrors.push(typeof d === 'object' ? d.message : args[1]); });
    if (!fixture) process.stdout.write(JSON.stringify({ overlayHandle: window.getNativeWindowHandle().readBigUInt64LE().toString() }) + '\n');
    window.setIgnoreMouseEvents(true, { forward: true });
    window.on('show', () => { invalidate(); sendCursor(true); });
    window.on('resize', invalidate);
    // 0.2.0: an un-minimize, a restore from the taskbar or a re-show must land on
    // the same visibility decision immediately rather than waiting for the next
    // supervisor sample.
    window.on('restore', assertVisibility);
    window.on('show', assertVisibility);
    // A dead renderer would otherwise leave rendererReady false forever, because
    // until 0.2.0 nothing observed the crash.
    window.webContents.on('render-process-gone', (_event, details) => {
      rendererReady = false; inputEnabled = false;
      try { window.setIgnoreMouseEvents(true, { forward: true }); } catch {}
      try { fs.writeFileSync(path.join(dataDir, 'renderer-gone.json'), JSON.stringify({ at: new Date().toISOString(), reason: details?.reason || 'unknown' }, null, 2)); } catch {}
      if (!quitting && !window.isDestroyed()) setTimeout(() => { if (!window.isDestroyed()) window.webContents.reload(); }, 500);
    });
    window.webContents.on('did-start-loading', () => {
      rendererReady = false; inputEnabled = false;
      setKeyboardFocus(false);
      window.setIgnoreMouseEvents(true, { forward: true });
    });
    window.webContents.setWindowOpenHandler(({ url }) => { openWebLink(url).catch(() => {}); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(UI_ORIGIN + '/')) event.preventDefault(); });
    session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    ipcMain.on('whale-storage', event => { event.returnValue = event.sender === window.webContents ? values() : {}; });
    ipcMain.on('whale-save-storage', (event, input) => { if (event.sender === window.webContents) storeValues(input); });
    ipcMain.on('whale-user-gesture', event => { if (isMainFrame(event)) trustedGestureAt = Date.now(); });
    ipcMain.handle('whale-open-external', (event, url) => isMainFrame(event) ? openWebLink(url) : false);
    ipcMain.handle('whale-command', async (event, command) => {
      if (!isMainFrame(event)) return false;
      if (command === 'status') { await showStatusDialog(); return true; }
      if (command === 'stop') { pauseAndQuit(); return true; }
      if (['balance', 'usage', 'settings'].includes(command)) return sendCommand(command);
      return false;
    });
    ipcMain.on('whale-ready', event => {
      if (event.sender !== window.webContents) return;
      markStartup('imageAndInputReady');
      try { fs.rmSync(path.join(dataDir, 'desktop-error.json'), { force: true }); } catch {}
      rendererReady = true; visibility(); flushCommands(); invalidate(); sendCursor(true);
    });
    ipcMain.on('whale-interactive', (event, enabled) => {
      if (event.sender !== window.webContents || typeof enabled !== 'boolean' || enabled === inputEnabled) return;
      inputEnabled = enabled;
      window.setIgnoreMouseEvents(!enabled, { forward: true });
    });
    ipcMain.on('whale-keyboard-focus', (event, editing) => {
      if (event.sender === window.webContents && typeof editing === 'boolean') setKeyboardFocus(editing);
    });
    const cursorPoll = setInterval(sendCursor, 50);
    visibilityWatchdog = setInterval(assertVisibility, 1000);
    if (visibilityWatchdog.unref) visibilityWatchdog.unref();
    app.once('will-quit', () => { clearInterval(cursorPoll); clearInterval(visibilityWatchdog); visibilityWatchdog = null; });
    const icon = nativeImage.createFromPath(path.join(root, 'assets', 'DSniang1.png')).resize({ width: 24, height: 24 });
    tray = new Tray(icon); tray.setToolTip('API 余额小鲸鱼 · 跟随 Codex');
    const trayTemplate = [{ label: '显示 / 隐藏小鲸鱼', click: toggle }];
    if (isMac) {
      trayTemplate.push({ label: '命令', submenu: [
        { label: '刷新余额', accelerator: 'Command+R', click: () => sendCommand('balance') },
        { label: '查看用量记录', click: () => sendCommand('usage') },
        { label: '查看运行状态', click: () => { void showStatusDialog(); } },
        { type: 'separator' },
        { label: 'API 设置', click: () => sendCommand('settings') },
        { label: '停止当前挂件', click: pauseAndQuit },
      ] });
    } else {
      trayTemplate.push({ label: 'API 设置', click: () => { show(); window.webContents.send('whale-settings'); } });
    }
    trayTemplate.push({ type: 'separator' }, { label: '本次退出挂件（下次打开 Codex 恢复）', click: pauseAndQuit });
    tray.setContextMenu(Menu.buildFromTemplate(trayTemplate));
    tray.on('double-click', toggle); globalShortcut.register(isMac ? 'Command+Option+W' : 'Control+Alt+W', toggle);
    bridge = await startBridge(dispatcher, { dataDir, onHost: setHost });
    markStartup('bridgeReady');
    await window.loadURL(UI_ORIGIN + '/widget.html');
    markStartup('pageLoaded');
    if (lastHost) await setHost(lastHost);
    if (fixture) {
      const fixtureModule = process.env.WHALE_DESKTOP_AUDIT === '1' ? 'desktop-audit-fixture.mjs' : 'desktop-fixture.mjs';
      const { verifyDesktop } = await import(pathToFileURL(path.join(root, 'tests', fixtureModule)));
      await verifyDesktop({ app, window, screen, setHost, setTestCursor, dispatcher, dataDir, errors: rendererErrors, openedLinks: fixtureOpenedLinks, renderInfo: () => ({ gpuStatus, presents, inputEnabled, keyboardFocus }) });
    }
    else { const heartbeat = setInterval(() => { if (Date.now() - hostHeartbeat > 6000) app.quit(); }, 2000); app.once('will-quit', () => clearInterval(heartbeat)); }
  }).catch(error => { try { save(path.join(dataDir, 'desktop-error.json'), { message: String(error.message).slice(0, 350), at: new Date().toISOString() }); } catch {} app.exit(1); });
  app.on('window-all-closed', () => { if (!quitting && rendererReady) app.quit(); });
  app.on('before-quit', event => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
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
