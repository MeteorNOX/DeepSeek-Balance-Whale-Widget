import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const { createVisibilityRecorder } = createRequire(import.meta.url)('../desktop/visibility-recorder.cjs');

test('passive recording bounds memory and disk writes; reports preserve pre-focus state', () => {
  let at = 0, visible = false, reads = 0; const files = new Map(); let writes = 0;
  const recorder = createVisibilityRecorder({ now: () => at,
    read: () => { reads++; return { visible }; },
    write: (name, value) => { files.set(name, structuredClone(value)); writes++; },
  });
  for (at = 0; at < 130000; at += 10) recorder.sample();
  assert.equal(reads, 130); assert.equal(writes, 13);
  const first = recorder.report(); assert.equal(first.slot, 1);
  const saved = files.get('visibility-report-1.json');
  assert.equal(saved.history.length, 120); assert.equal(saved.history.at(-1).visible, false);
  visible = true; at += 1000; recorder.sample();
  assert.equal(files.get('visibility-report-1.json').history.at(-1).visible, false);
  recorder.report(); recorder.report(); recorder.report();
  assert.equal([...files.keys()].filter(n => n.startsWith('visibility-report-')).length, 3);
});

test('recorder tolerates unavailable windows without creating a fake healthy sample', () => {
  let report; const recorder = createVisibilityRecorder({ read: () => null, write: (_name, data) => { report = data; } });
  recorder.sample(); recorder.report(); assert.deepEqual(report.history, []);
});

test('Windows occlusion switches apply before startup and preserve preexisting disabled features; macOS untouched', () => {
  const source = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  const bootstrap = source.slice(source.indexOf('const softwareRendering ='), source.indexOf('if (!dataDir'));
  for (const platform of ['win32', 'darwin']) {
    const switches = new Map([['disable-features', 'ExistingFeature']]); let disabled = false;
    const state = { process: { platform, env: {} }, app: { disableHardwareAcceleration() { disabled = true; }, commandLine: { getSwitchValue: k => switches.get(k) || '', appendSwitch: (k, v) => switches.set(k, v) } } };
    vm.runInNewContext(bootstrap, state);
    assert.equal(disabled, platform === 'win32');
    assert.equal(switches.get('disable-features'), platform === 'win32' ? 'ExistingFeature,CalculateNativeWinOcclusion' : 'ExistingFeature');
    assert.equal(switches.has('disable-backgrounding-occluded-windows'), platform === 'win32');
    assert.equal(switches.has('enable-gpu-rasterization'), platform === 'darwin');
  }
});
