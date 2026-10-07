const { contextBridge, ipcRenderer } = require('electron');
const saved = ipcRenderer.sendSync('whale-storage');
try { for (const [key, value] of Object.entries(saved)) if (localStorage.getItem(key) == null) localStorage.setItem(key, value); } catch {}
let trustedClickAt = 0;
for (const eventName of ['click', 'auxclick']) document.addEventListener(eventName, event => {
  if (!event.isTrusted || (event.button !== 0 && event.button !== 1)) return;
  trustedClickAt = Date.now(); ipcRenderer.send('whale-user-gesture');
}, true);
contextBridge.exposeInMainWorld('whaleDesktop', {
  platform: process.platform,
  ready: () => ipcRenderer.send('whale-ready'),
  keyboardFocus: value => ipcRenderer.send('whale-keyboard-focus', !!value),
  interactive: value => ipcRenderer.send('whale-interactive', !!value),
  presentFor: ms => ipcRenderer.send('whale-present-for', Number.isFinite(ms) ? ms : 0),
  shape: rects => ipcRenderer.send('whale-shape', rects),
  onCursor: callback => ipcRenderer.on('whale-cursor', (_event, point) => callback(point)),
  save: values => ipcRenderer.send('whale-save-storage', values),
  command: command => ipcRenderer.invoke('whale-command', command),
  openExternal: value => {
    if (!trustedClickAt || Date.now() - trustedClickAt > 1000 || !navigator.userActivation.isActive || typeof value !== 'string') return Promise.resolve(false);
    trustedClickAt = 0;
    return ipcRenderer.invoke('whale-open-external', value);
  },
  testMode: process.argv.includes('--whale-render-test'),
});
ipcRenderer.on('whale-settings', () => window.dispatchEvent(new Event('whale-open-settings')));
ipcRenderer.on('whale-command', (_event, command) => {
  const events = {
    balance: 'whale-refresh',
    usage: 'whale-open-usage',
    settings: 'whale-open-settings',
    'reset-position': 'whale-reset-position',
  };
  if (events[command]) window.dispatchEvent(new Event(events[command]));
});

ipcRenderer.on('whale-desktop-mode', (_event, mode) => window.dispatchEvent(new CustomEvent('whale-desktop-mode', { detail: mode })));
ipcRenderer.on('whale-desktop-mode-changing', () => window.dispatchEvent(new Event('whale-mode-changing')));
ipcRenderer.on('whale-shape-request', () => window.dispatchEvent(new Event('whale-shape-request')));
