import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { shutdownCompanion } = require('../desktop/lifecycle.cjs');
const { externalWebUrl } = require('../desktop/external-links.cjs');

test('shutdown still flushes cached state and closes services when the renderer never answers', async () => {
  const calls = [];
  const result = await shutdownCompanion({
    readRenderer: () => new Promise(() => {}),
    saveRenderer: () => calls.push('save'), flushState: () => calls.push('flush'),
    closeBridge: () => calls.push('bridge'), closeDispatcher: () => calls.push('service'),
  }, { timeoutMs: 150, rendererMs: 15 });
  assert.deepEqual(calls, ['flush', 'bridge', 'service']);
  assert.deepEqual(result.stages.map(x => x.status), ['timeout', 'complete', 'complete', 'complete']);
});

test('shutdown has an overall deadline and never saves a late renderer snapshot', async () => {
  const calls = [], start = Date.now(); let answer;
  const result = await shutdownCompanion({
    readRenderer: () => new Promise(resolve => { answer = resolve; }),
    saveRenderer: () => calls.push('late-save'), flushState: () => Promise.reject(new Error('disk unavailable')),
    closeBridge: () => calls.push('bridge'), closeDispatcher: () => new Promise(() => {}),
  }, { timeoutMs: 70, rendererMs: 10, stateMs: 10 });
  answer({ 'dshw-pos': 'outdated' }); await Promise.resolve();
  assert.deepEqual(calls, ['bridge']);
  assert.deepEqual(result.stages.map(x => x.status), ['timeout', 'failed', 'complete', 'timeout']);
  assert.ok(Date.now() - start < 700, 'hung services must not leave the companion alive');
});

test('normal shutdown saves current settings before flushing and draining services', async () => {
  const calls = [], snapshot = { 'dshw-pos': 'latest' };
  const result = await shutdownCompanion({
    readRenderer: () => snapshot, saveRenderer: value => { assert.equal(value, snapshot); calls.push('save'); },
    flushState: () => calls.push('flush'), closeBridge: () => calls.push('bridge'), closeDispatcher: () => calls.push('service'),
  });
  assert.equal(result.clean, true); assert.deepEqual(calls, ['save', 'flush', 'bridge', 'service']);
});

test('external links only accept ordinary credential-free HTTP and HTTPS URLs', () => {
  assert.equal(externalWebUrl('https://example.org/path?q=1#part'), 'https://example.org/path?q=1#part');
  assert.equal(externalWebUrl('http://example.org'), 'http://example.org/');
  for (const value of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,x', 'cmd:thing', '//example.org',
    'https://user:password@example.org', 'https:\\example.org', 'https://example.org\n', ' https://example.org', null, 42]) {
    assert.equal(externalWebUrl(value), null, String(value));
  }
});

test('preload requires a trusted recent user click before exposing external navigation', async () => {
  const source = await fs.readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  const listeners = {}, calls = []; let bridge;
  const ipcRenderer = { sendSync: () => ({}), send: (...args) => calls.push(args), on() {}, invoke: (...args) => { calls.push(args); return Promise.resolve(true); } };
  vm.runInNewContext(source, {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }),
    document: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    localStorage: { getItem: () => null, setItem() {} }, process: { argv: [] },
    navigator: { userActivation: { isActive: true } }, window: { dispatchEvent() {} }, Date, Promise,
  });
  assert.equal(await bridge.openExternal('https://example.org'), false);
  listeners.click({ isTrusted: false, button: 0 });
  assert.equal(await bridge.openExternal('https://example.org'), false);
  listeners.click({ isTrusted: true, button: 0 });
  assert.equal(await bridge.openExternal('https://example.org'), true);
  assert.equal(await bridge.openExternal('https://example.org'), false, 'one click cannot launch repeated external windows');
  assert.equal(calls.filter(x => x[0] === 'whale-open-external').length, 1);
});

async function animationMask(type, frameCount = 2, failedDecoder = false) {
  const source = await fs.readFile(new URL('../desktop/ui/alpha-worker.js', import.meta.url), 'utf8');
  let drawn, decodes = 0, released = 0;
  const frames = [[255, 0, 0, 0], [0, 255, 0, 0]].map(alpha => ({ width: 2, height: 2, alpha, close() { released++; } }));
  const context = { clearRect() {}, drawImage(image) { drawn = image; }, getImageData: () => ({ data: Uint8Array.from(drawn.alpha.flatMap(a => [0, 0, 0, a])) }) };
  const box = {
    OffscreenCanvas: class { getContext() { return context; } },
    fetch: async () => ({ ok: true, blob: async () => ({ type, arrayBuffer: async () => new ArrayBuffer(0) }) }),
    createImageBitmap: async () => frames[0],
    ImageDecoder: class {
      constructor() { if (failedDecoder) throw new Error('unsupported image decoder'); this.tracks = { ready: Promise.resolve(), selectedTrack: { frameCount } }; }
      decode() { decodes++; return Promise.resolve({ image: frames[1] }); }
      close() { released++; }
    },
    self: { postMessage() {} }, Uint8Array, Math, Promise, performance,
  };
  vm.createContext(box); vm.runInContext(source, box);
  const result = await vm.runInContext("decode('memory-role')", box);
  return { alpha: [...new Uint8Array(result.alpha)], decodes, released };
}

test('APNG and GIF masks include opaque pixels from later frames', async () => {
  for (const type of ['image/png', 'image/gif']) {
    const result = await animationMask(type);
    assert.deepEqual(result.alpha, [255, 255, 0, 0]);
    assert.equal(result.decodes, 1); assert.equal(result.released, 3);
  }
});

test('long or unsupported animations keep a bounded clickable fallback instead of passing through visible pixels', async () => {
  const large = await animationMask('image/png', 600);
  assert.deepEqual(large.alpha, [255, 255, 255, 255]); assert.equal(large.decodes, 0);
  const unsupported = await animationMask('image/png', 2, true);
  assert.deepEqual(unsupported.alpha, [255, 255, 255, 255]);
});

test('broken saved role requests fallback once, then announces readiness only for a loaded replacement', async () => {
  const source = await fs.readFile(new URL('../desktop/ui/input.js', import.meta.url), 'utf8');
  const begin = source.indexOf('  async function prepare()'), end = source.indexOf("  pet.addEventListener('load'");
  const events = [], bridgeCalls = [];
  const box = { pet: { complete: true, naturalWidth: 0, currentSrc: 'broken-role' }, failedRoleSources: new Set(), ready: false,
    rendering: { hitCache: { prepare: async () => ({}) } }, bridge: { ready: () => bridgeCalls.push('ready') }, request() {},
    window: { dispatchEvent: event => events.push(event) }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } };
  vm.createContext(box); vm.runInContext(source.slice(begin, end), box);
  await vm.runInContext('prepare(); prepare()', box);
  assert.equal(events.length, 1); assert.equal(events[0].type, 'whale-role-fallback'); assert.equal(bridgeCalls.length, 0);
  box.pet.currentSrc = 'default-role'; box.pet.naturalWidth = 100;
  await vm.runInContext('prepare()', box);
  assert.deepEqual(bridgeCalls, ['ready']);
});

test('an earlier accepted press retains native input after the squish makes its pixel transparent', async () => {
  const source = await fs.readFile(new URL('../desktop/ui/input.js', import.meta.url), 'utf8');
  const start = source.indexOf("  document.addEventListener('pointerdown'"), end = source.indexOf('  function release(');
  let handler, captured = true;
  const enabled = [], box = { releaseEpoch: 0, point: null, heldPointer: null,
    root: { hasPointerCapture: id => captured && id === 1 }, hit: () => false,
    document: { addEventListener: (_name, callback) => { handler = callback; } },
    update: () => enabled.push(box.heldPointer !== null) };
  vm.createContext(box); vm.runInContext(source.slice(start, end), box);
  handler({ pointerId: 1, clientX: 20, clientY: 30 });
  assert.equal(box.heldPointer, 1); assert.deepEqual(enabled, [true]);
  box.heldPointer = null; captured = false;
  handler({ pointerId: 2, clientX: 100, clientY: 100 });
  assert.equal(box.heldPointer, null); assert.deepEqual(enabled, [true, false], 'an unaccepted transparent-area press still passes through');
});

test('macOS keeps the transparent window interactive while a dismissible flyout is open', async () => {
  const source = await fs.readFile(new URL('../desktop/ui/input.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const dismissSurfaces =');
  const end = source.indexOf('  function updateKeyboardFocus()', start);
  const run = (platform, openSelector) => {
    const calls = [];
    const flyout = { checkVisibility: () => true };
    const box = {
      heldPointer: null, externalDrag: false, point: { x: 40, y: 40 }, interactive: false,
      surfaces: '.ordinary-surface', pet: { checkVisibility: () => false }, root: {},
      rendering: { hitCache: { hit: () => false }, mirrorScale: () => 1 },
      document: {
        querySelectorAll: selector => selector.includes(openSelector) ? [flyout] : [],
        elementFromPoint: () => null,
      },
      bridge: { platform, interactive: value => calls.push(value) },
    };
    vm.createContext(box); vm.runInContext(source.slice(start, end), box); vm.runInContext('update()', box);
    return calls;
  };
  for (const selector of ['.dshwv-menu-open', '.dshwv-pop-open', '.whale-account-card']) {
    assert.deepEqual(run('darwin', selector), [true], selector + ' must receive a blank click on macOS');
    assert.deepEqual(run('win32', selector), [], 'Windows keeps native region-based click-through behavior');
  }
});

test('a blank pointer press closes the popup opened from the character body', async () => {
  const source = await fs.readFile(new URL('../assets/whale-widget.js', import.meta.url), 'utf8');
  const start = source.indexOf('    function onDocPointerDown(e)');
  const end = source.indexOf('    function onDocPointerMove(e)', start);
  const run = ({ account = false, scene = null } = {}) => {
    const calls = [];
    const box = {
      menuOpen: false, bubbleShown: !account, bubbleScene: scene,
      document: { querySelector: selector => account && selector === '.whale-account-card' ? {} : null },
      window: { WhaleAccountView: { close: () => calls.push('account') } },
      closeMenu: () => calls.push('menu'), isWhaleHit: () => false,
      hideBubble: () => calls.push('bubble'), hideCostBubble: () => calls.push('cost'),
      hideUsageAlertBubble: () => calls.push('alert'),
    };
    vm.createContext(box); vm.runInContext(source.slice(start, end), box);
    vm.runInContext("onDocPointerDown({target:{closest:()=>null},button:0,pointerType:'mouse'})", box);
    return calls;
  };
  assert.deepEqual(run(), ['bubble']);
  assert.deepEqual(run({ account: true }), ['account']);
  assert.deepEqual(run({ scene: { kind: 'cost' } }), ['cost']);
  assert.deepEqual(run({ scene: { kind: 'alert' } }), ['alert']);
});

test('failed task registration leaves a running installation untouched and cannot print success', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-desktop-audit-'));
  t.after(async () => {
    const resolved = path.resolve(temporary);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('whale-desktop-audit-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const scripts = path.join(temporary, 'scripts'), data = path.join(temporary, 'data'), desktop = path.join(temporary, 'desktop');
  await Promise.all([fs.mkdir(scripts), fs.mkdir(desktop), fs.mkdir(path.join(data, 'desktop-runtime/node_modules/electron/dist'), { recursive: true })]);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const launcher = path.join(temporary, 'launcher.exe');
  await Promise.all([
    fs.writeFile(launcher, ''), fs.writeFile(path.join(data, 'desktop-runtime/node_modules/electron/dist/electron.exe'), ''),
    fs.writeFile(path.join(data, 'follow-config.json'), '{"sentinel":"keep-current-monitor"}'),
    fs.writeFile(path.join(data, 'follow-install.json'), '{"sentinel":"previous-success"}'),
    fs.copyFile(new URL('../scripts/install-follow.ps1', import.meta.url), path.join(scripts, 'install-follow.ps1')),
    fs.writeFile(path.join(scripts, 'build-launcher.ps1'), 'param([string]$DataDir)\nWrite-Output ' + quote(launcher)),
    fs.writeFile(path.join(desktop, 'supervisor.ps1'), 'param([string]$DataDir,[switch]$Stop)\nSet-Content -LiteralPath (Join-Path $DataDir stop-was-called) -Value yes'),
  ]);
  const harness = path.join(temporary, 'simulate-install.ps1');
  await fs.writeFile(harness, `$ErrorActionPreference='Stop'
function Get-ScheduledTask { param($TaskName,$ErrorAction) return $null }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) [pscustomobject]@{Execute=$Execute;Arguments=$Argument} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit,$MultipleInstances,$RestartCount,$RestartInterval,[switch]$StartWhenAvailable) [pscustomobject]@{} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User) [pscustomobject]@{} }
function New-ScheduledTask { param($Action,$Principal,$Settings,$Description,$Trigger) [pscustomobject]@{} }
function Register-ScheduledTask { [CmdletBinding()]param($TaskName,$InputObject,[switch]$Force) Write-Error 'Injected registration failure' }
& ${quote(path.join(scripts, 'install-follow.ps1'))} -DataDir ${quote(data)}
`);
  const executable = path.join(process.env.WINDIR || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', harness], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout, /companion installed/);
  assert.match(result.stderr, /could not register or verify/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'follow-config.json'), 'utf8')), { sentinel: 'keep-current-monitor' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'follow-install.json'), 'utf8')), { sentinel: 'previous-success' });
  assert.equal(await fs.access(path.join(data, 'stop-was-called')).then(() => true, () => false), false);
});

test('task identity accepts a verified old cache but rejects outside installations and different data directories', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-desktop-audit-identity-'));
  t.after(async () => {
    const resolved = path.resolve(temporary);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('whale-desktop-audit-identity-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const codex = path.join(temporary, 'codex'), data = path.join(temporary, 'data');
  const cached = path.join(codex, 'plugins/cache/personal/api-balance-whale/0.4.0+codex.test');
  await Promise.all([fs.mkdir(path.join(cached, '.codex-plugin'), { recursive: true }), fs.mkdir(path.join(cached, 'desktop'), { recursive: true })]);
  await fs.writeFile(path.join(cached, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'api-balance-whale', version: '0.4.0+codex.test' }));
  await fs.writeFile(path.join(cached, 'desktop/supervisor.ps1'), '# Fixture identity only; never executed.');
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const installer = path.join(root, 'scripts/install-follow.ps1'), ownScript = path.join(root, 'desktop/supervisor.ps1');
  const launcher = path.join(data, 'native/WhaleLauncher-0123456789abcdefabcd.exe');
  const cases = [
    { name: 'current source', execute: launcher, args: `--script "${ownScript}" --data "${data}"`, accepted: true },
    { name: 'verified cache', execute: launcher, args: `--script "${path.join(cached, 'desktop/supervisor.ps1')}" --data "${data}"`, accepted: true },
    { name: 'outside installation', execute: launcher, args: `--script "${path.join(temporary, 'outside/desktop/supervisor.ps1')}" --data "${data}"`, accepted: false },
    { name: 'different data', execute: launcher, args: `--script "${ownScript}" --data "${path.join(temporary, 'other-data')}"`, accepted: false },
  ];
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const harness = path.join(temporary, 'inspect-identities.ps1');
  const encoded = Buffer.from(JSON.stringify(cases), 'utf8').toString('base64');
  await fs.writeFile(harness, `$ErrorActionPreference='Stop'
$whaleRoot=${quote(root)}; $DataDir=${quote(data)}; $whaleScript=${quote(ownScript)}
$whaleQuotedData='"'+$DataDir+'"'; $whalePowerShell=Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; $whaleTaskName='Codex API Balance Whale'
$source=Get-Content -LiteralPath ${quote(installer)} -Raw -Encoding UTF8
$start=$source.IndexOf('$whaleTrustedScripts ='); $end=$source.IndexOf('$whaleLauncher = & (Join-Path')
if($start -lt 0 -or $end -le $start){throw 'Identity block not found'}
$block=[scriptblock]::Create($source.Substring($start,$end-$start))
function Get-ScheduledTask {param($TaskName,$ErrorAction) return $script:whaleFakeTask}
$cases=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json
$results=@()
foreach($case in $cases){
  $script:whaleFakeTask=[pscustomobject]@{Actions=@([pscustomobject]@{Execute=$case.execute;Arguments=$case.args})}
  try{& $block;$results+=[pscustomobject]@{name=$case.name;accepted=$true}}catch{$results+=[pscustomobject]@{name=$case.name;accepted=$false}}
}
$results|ConvertTo-Json -Compress
`);
  const executable = path.join(process.env.WINDIR || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', harness], { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, CODEX_HOME: codex } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), cases.map(({ name, accepted }) => ({ name, accepted })));
});
