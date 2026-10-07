import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const { createVisibilityController } = createRequire(import.meta.url)('../desktop/visibility.cjs');
function fixture() {
 let state = { ready: true, standalone: true, host: { hostAlive: false, visible: false, attached: false } }, visible = false;
 const calls = [], pending = [];
 const window = { isDestroyed: () => false, isVisible: () => visible, hide() { visible = false; calls.push('hide'); }, showInactive() { visible = true; calls.push('show'); } };
 const controller = createVisibilityController({ getWindow: () => window, getState: () => state, schedule: f => { pending.push(f); return f; }, cancel: f => { const i = pending.indexOf(f); if (i >= 0) pending.splice(i, 1); } });
 return { controller, calls, set: patch => { state = { ...state, ...patch }; controller.update(); }, visible: () => visible, flush: () => { while (pending.length) pending.shift()(); } };
}
test('standalone displays without Codex and ignores host minimize/modal/epoch changes', () => {
 const f = fixture(); f.controller.update(); assert.equal(f.visible(), true);
 for (let n = 0; n < 100; n++) f.set({ host: { hostAlive: n % 2 === 0, visible: false, modal: true, visibilityRevision: n, hostPid: n } });
 assert.deepEqual(f.calls, ['show']);
});
for (const guard of ['manuallyHidden', 'quitting']) test('standalone respects ' + guard, () => {
 const f = fixture(); f.controller.update(); f.set({ [guard]: true }); f.controller.requestRecovery(); f.flush(); assert.equal(f.visible(), false);
});
test('standalone cannot bypass renderer readiness and switching to follow applies host guards', () => {
 const f = fixture(); f.set({ ready: false }); assert.equal(f.visible(), false);
 f.set({ ready: true }); f.flush(); assert.equal(f.visible(), true);
 f.set({ standalone: false }); f.flush(); assert.equal(f.visible(), false);
});

function mainModeFixture() {
 const source = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
 const calls = [], area = { x: 0, y: 0, width: 1920, height: 1080 };
 const state = { quitting:false, desktopMode: 'follow-codex', desktopBoundsApplied: false, modePending: false, appliedBounds: '', appliedNativeSize: '', dataDir: '/test', path, isMac: false, fixture: false, manuallyHidden: false, hostSequence: -1, hostHeartbeat: 0, lastHost: null, owner: '',
  Number, Date, usesWindowShape: true, visibilityRecorder: { sample() {} }, save: () => calls.push('save'), read: () => ({}), sendCursor: () => {}, updateTray: () => {}, markStartup: () => {}, diagnose: () => {}, toDipRect: x => x,
  screen: { getPrimaryDisplay: () => ({ workArea: area }) },
  window: { isDestroyed:()=>false, setBounds: () => calls.push('bounds'), setPosition: () => calls.push('position'), getBounds: () => area, setAlwaysOnTop: () => calls.push('top'), webContents: { send: event => calls.push(event) } },
  app: { quit: () => calls.push('quit') }, syncNativeViewport: () => '',
  visibility: () => calls.push(state.modePending ? 'hidden-pending' : 'visibility'), show: () => calls.push('show'),
  visibilityController: { requestRecovery: () => calls.push('recover'), observeNativeVisibility: () => false }
 };
 vm.createContext(state);
 vm.runInContext(source.slice(source.indexOf('async function setHost('), source.indexOf('async function importLegacyStorage(')) + source.slice(source.indexOf('function setMode('), source.indexOf('function updateTray(')), state);
 return { state, calls, host: patch => state.setHost({ hostAlive: true, hostPid: 1, window: '1', visible: true, attached: true, nativeFollowing: true, mode: 'follow-codex', ...patch }) };
}

test('reselecting the active mode closes UI without changing geometry or remapping', () => {
 const f = mainModeFixture(); f.state.setMode('follow-codex');
 assert.deepEqual(f.calls, ['whale-desktop-mode']);
});

test('standalone waits for native detach and follow waits for fresh attachment', async () => {
 const f = mainModeFixture(); f.state.setMode('standalone');
 assert.equal(f.state.modePending, true); assert.ok(!f.calls.includes('bounds'));
 await f.host({ serial: 1 }); assert.equal(f.state.modePending, true);
 await f.host({ serial: 2, mode: 'standalone' }); assert.equal(f.state.modePending, true);
 await f.host({ serial: 3, mode: 'standalone', attached: false, nativeFollowing: false });
 assert.equal(f.state.modePending, false); assert.ok(f.calls.includes('bounds'));
 f.calls.length = 0; f.state.setMode('follow-codex');
 await f.host({ serial: 4, mode: 'standalone', attached: false, nativeFollowing: false });
 assert.equal(f.state.modePending, true); assert.ok(!f.calls.includes('whale-desktop-mode'));
 await f.host({ serial: 5 });
 assert.equal(f.state.modePending, false); assert.ok(f.calls.includes('whale-desktop-mode')); assert.ok(f.calls.includes('visibility'));
});
