import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bridgeRequest, pipeName } from '../../runtime/bridge.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dataDir = path.resolve(argument('--data-dir', path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'whale-widget')));
const pluginRoot = path.resolve(argument('--plugin-root', scriptRoot));
const configFile = path.join(dataDir, 'follow-config.json');
const stateFile = path.join(dataDir, 'supervisor-state.json');
const followStateFile = path.join(dataDir, 'follow-state.json');
const runtimeFile = path.join(dataDir, 'runtime.json');
const pauseFile = path.join(dataDir, 'pause-until-host-exit.json');
const lockDir = path.join(dataDir, 'macos-supervisor.lock');
const lockOwnerFile = path.join(lockDir, 'owner.json');
const logFile = path.join(dataDir, 'macos-supervisor.log');
const sessionId = randomUUID();

fs.mkdirSync(dataDir, { recursive: true });
const readJson = (file, fallback = {}) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
};
const writeJson = (file, value) => {
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
};
const log = message => {
  const line = new Date().toISOString() + ' ' + message + '\n';
  try { fs.appendFileSync(logFile, line); } catch {}
  process.stderr.write(line);
};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const processAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

function acquireLock() {
  if (fs.existsSync(lockDir)) {
    const existing = readJson(lockOwnerFile, null);
    if (existing && processAlive(Number(existing.pid))) {
      log('another macOS supervisor is already running');
      process.exit(0);
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
  try {
    fs.mkdirSync(lockDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') process.exit(0);
    throw error;
  }
  writeJson(lockOwnerFile, { pid: process.pid, sessionId, startedAt: new Date().toISOString() });
}

function releaseLock() {
  if (readJson(lockOwnerFile, {}).sessionId !== sessionId) return;
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
}

async function stopStaleRuntime() {
  const previous = readJson(runtimeFile, {});
  const pid = Number(previous.pid);
  if (pid > 0 && pid !== process.pid && processAlive(pid)) {
    log('stopping stale Electron process ' + pid);
    try { process.kill(pid, 'SIGTERM'); } catch {}
    for (let attempt = 0; attempt < 20 && processAlive(pid); attempt++) await delay(100);
    if (processAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      for (let attempt = 0; attempt < 10 && processAlive(pid); attempt++) await delay(100);
    }
  }
  if (!processAlive(pid)) {
    try { fs.unlinkSync(runtimeFile); } catch (error) { if (error.code !== 'ENOENT') log('runtime cleanup failed: ' + error.message); }
    const socket = pipeName(dataDir);
    try { fs.unlinkSync(socket); } catch (error) { if (error.code !== 'ENOENT') log('socket cleanup failed: ' + error.message); }
  }
}

const config = readJson(configFile, {});
if (config.platform !== 'darwin' || config.mode !== 'follow-codex' || config.enabled !== true) {
  process.stderr.write('macOS follow configuration is missing, disabled or invalid. Run scripts/install-macos.mjs first.\n');
  process.exit(1);
}
const electronPath = path.resolve(config.electronPath || '');
const probePath = path.resolve(config.probePath || '');
if (!fs.existsSync(electronPath) || !fs.existsSync(probePath)) {
  process.stderr.write('Desktop runtime or window probe is missing. Run scripts/install-macos.mjs first.\n');
  process.exit(1);
}

acquireLock();
await stopStaleRuntime();

let stopping = false;
let shuttingDown = false;
let child = null;
let lastLaunchAt = 0;
let probe = null;
let probeBuffer = '';
let probeGeneration = 0;
let probeRestartTimer = null;
let lastProbeAt = Date.now();
let hostState = { hostAlive: false, hostPid: 0, hostSession: '', window: '0', visible: false, attached: false, nativeFollowing: false, followMode: 'macos-cgwindow-poll' };
let sequence = 0;
let pendingState = null;
let sending = false;
let heartbeat = null;
const startedAt = new Date().toISOString();

function unavailableHostState() {
  return { hostAlive: false, hostPid: 0, hostSession: '', window: '0', visible: false, attached: false, nativeFollowing: false, followMode: 'macos-cgwindow-poll' };
}

function queueHostState(state) {
  pendingState = state;
  void pumpHostState();
}

async function pumpHostState() {
  if (sending) return;
  sending = true;
  try {
    while (pendingState) {
      const state = pendingState;
      pendingState = null;
      try {
        await bridgeRequest('/internal/host', { method: 'POST', body: state, dataDir, timeoutMs: 1500 });
      } catch {
        // The Electron host may not have created its socket yet. The heartbeat
        // retries the latest state without allowing an unbounded queue to form.
      }
      await delay(4);
    }
  } finally {
    sending = false;
  }
}

async function waitForHostDelivery(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while ((pendingState || sending) && Date.now() < deadline) await delay(25);
  return !pendingState && !sending;
}

function pausedFor() {
  const pause = readJson(pauseFile, {});
  if (!Object.keys(pause).length) return false;
  if (!hostState.hostAlive) {
    try { fs.unlinkSync(pauseFile); } catch {}
    return false;
  }
  if (pause.pauseAll === true) return true;
  if (pause.hostSession && hostState.hostSession) return String(pause.hostSession) === String(hostState.hostSession);
  if (pause.hostWindow && hostState.window && hostState.window !== '0') return String(pause.hostWindow) === String(hostState.window);
  if (pause.hostPid && hostState.hostPid) return String(pause.hostPid) === String(hostState.hostPid);
  return false;
}

function startChild() {
  if (stopping || child || !hostState.hostAlive || pausedFor()) return;
  const now = Date.now();
  if (now - lastLaunchAt < 4000) return;
  const main = path.join(pluginRoot, 'desktop', 'main.cjs');
  if (!fs.existsSync(main)) {
    log('desktop/main.cjs is missing');
    return;
  }
  const environment = { ...process.env, WHALE_INITIAL_HOST: JSON.stringify(hostState), WHALE_LAUNCH_TIME: String(now) };
  delete environment.ELECTRON_RUN_AS_NODE;
  let current;
  try {
    current = spawn(electronPath, [main, '--whale-data=' + dataDir, '--supervised'], {
      cwd: pluginRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    log('electron failed to start: ' + error.message);
    return;
  }
  child = current;
  lastLaunchAt = now;
  current.stdout.on('data', data => {
    const text = String(data).trim();
    if (text) log('electron: ' + text.slice(0, 1000));
  });
  current.stderr.on('data', data => {
    const text = String(data).trim();
    if (text) log('electron: ' + text.slice(0, 4000));
  });
  current.on('error', error => {
    log('electron failed to start: ' + error.message);
    if (child === current) child = null;
  });
  current.on('close', (code, signal) => {
    log('electron exited: code=' + String(code) + ' signal=' + String(signal));
    if (child === current) child = null;
  });
}

function waitForExit(running, timeoutMs) {
  if (running.exitCode !== null || running.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    running.once('close', () => { clearTimeout(timer); resolve(true); });
  });
}

async function stopChild() {
  const running = child;
  if (!running) return;
  queueHostState({ hostAlive: false, monitorExit: true, serial: ++sequence });
  await waitForHostDelivery(1800);
  try { running.stdin.end(); } catch {}
  if (await waitForExit(running, 2500)) return;
  try { running.kill('SIGTERM'); } catch {}
  if (await waitForExit(running, 1500)) return;
  try { running.kill('SIGKILL'); } catch {}
  await waitForExit(running, 500);
}

async function handleHostState(state) {
  hostState = state;
  hostState.serial = ++sequence;
  writeJson(followStateFile, {
    childPid: child?.pid || null,
    state: hostState,
    native: { enabled: false, mode: 'CGWindowList polling' },
    at: new Date().toISOString(),
  });
  queueHostState(hostState);
  if (hostState.hostAlive) startChild();
}

function scheduleProbeRestart() {
  if (stopping || probeRestartTimer) return;
  probeRestartTimer = setTimeout(() => {
    probeRestartTimer = null;
    startProbe();
  }, 1500);
  probeRestartTimer.unref?.();
}

function startProbe() {
  if (stopping || probe) return;
  const generation = ++probeGeneration;
  probeBuffer = '';
  lastProbeAt = Date.now();
  const current = spawn(probePath, ['--bundle-id', process.env.WHALE_CODEX_BUNDLE_ID || config.bundleId || 'com.openai.codex'], {
    cwd: pluginRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  probe = current;
  current.stdout.setEncoding('utf8');
  current.stdout.on('data', chunk => {
    if (generation !== probeGeneration) return;
    lastProbeAt = Date.now();
    probeBuffer += chunk;
    const lines = probeBuffer.split('\n');
    probeBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { void handleHostState(JSON.parse(line)); }
      catch { log('invalid window probe output'); }
    }
  });
  current.stderr.on('data', data => log('probe: ' + String(data).trim().slice(0, 4000)));
  current.on('error', error => {
    if (probe === current) probe = null;
    log('window probe failed to start: ' + error.message);
    scheduleProbeRestart();
  });
  current.on('close', (code, signal) => {
    if (probe === current) probe = null;
    if (!stopping) {
      log('window probe exited unexpectedly: code=' + String(code) + ' signal=' + String(signal));
      void handleHostState(unavailableHostState());
      scheduleProbeRestart();
    }
  });
}

function restartProbe(reason) {
  if (stopping) return;
  log('restarting window probe: ' + reason);
  const current = probe;
  probe = null;
  try { current?.kill('SIGTERM'); } catch {}
  void handleHostState(unavailableHostState());
  scheduleProbeRestart();
}

function writeState() {
  writeJson(stateFile, {
    pid: process.pid,
    parentPid: process.ppid,
    sessionId,
    installId: config.installId || null,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    childPid: child?.pid || null,
    probePid: probe?.pid || null,
    hostPid: hostState.hostPid || null,
    hostAlive: !!hostState.hostAlive,
    host: 'node-macos',
    platform: 'darwin',
    pluginRoot,
  });
}

startProbe();
writeState();

heartbeat = setInterval(() => {
  if (stopping) return;
  if (!probe) startProbe();
  else if (Date.now() - lastProbeAt > 5000) restartProbe('no output for 5 seconds');
  queueHostState(hostState);
  if (hostState.hostAlive) startChild();
  writeState();
}, 500);
heartbeat.unref?.();

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  if (probeRestartTimer) clearTimeout(probeRestartTimer);
  log('stopping: ' + signal);
  try { probe?.kill('SIGTERM'); } catch {}
  await stopChild();
  stopping = true;
  releaseLock();
  try { fs.unlinkSync(stateFile); } catch {}
}

process.on('SIGTERM', () => { void shutdown('SIGTERM').finally(() => process.exit(0)); });
process.on('SIGINT', () => { void shutdown('SIGINT').finally(() => process.exit(0)); });
process.on('uncaughtException', error => log('uncaught exception: ' + error.stack));
process.on('unhandledRejection', error => log('unhandled rejection: ' + String(error?.stack || error)));

log('macOS supervisor started for ' + pluginRoot);
