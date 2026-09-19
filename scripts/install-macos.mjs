import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA_HOME, ROOT } from '../runtime/paths.mjs';

if (process.platform !== 'darwin') {
  process.stderr.write('This installer is only for macOS.\n');
  process.exit(1);
}

const label = 'com.api-balance-whale.codex';
const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgents, label + '.plist');
const nativeDir = path.join(DATA_HOME, 'native');
const probePath = path.join(nativeDir, 'whale-window-probe');
const electronApp = path.join(DATA_HOME, 'desktop-runtime', 'node_modules', 'electron', 'dist', 'Electron.app');
const electronPath = path.join(electronApp, 'Contents', 'MacOS', 'Electron');
const desktopBundleID = 'com.api-balance-whale.codex.desktop';
const supervisorPath = path.join(ROOT, 'desktop', 'macos', 'supervisor.mjs');
const probeSource = path.join(ROOT, 'desktop', 'macos', 'window-probe.swift');
const homebrewNode = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(file => fs.existsSync(file));
const nodePath = homebrewNode || process.execPath;
const installId = randomUUID();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with status ' + String(result.status));
}

function installDesktopIfNeeded() {
  if (fs.existsSync(electronPath)) return;
  process.stdout.write('Electron desktop runtime is missing; installing it first.\n');
  run(nodePath, [path.join(ROOT, 'scripts', 'install-desktop.mjs')]);
  if (!fs.existsSync(electronPath)) throw new Error('Electron was installed but its macOS executable was not found.');
}

function plistSet(key, value, type = 'string') {
  const plist = path.join(electronApp, 'Contents', 'Info.plist');
  const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Set :' + key + ' ' + value, plist], { encoding: 'utf8' });
  if (set.status === 0) return;
  const add = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Add :' + key + ' ' + type + ' ' + value, plist], { encoding: 'utf8' });
  if (add.status !== 0) throw new Error((add.stderr || set.stderr || 'Unable to update Electron Info.plist').trim());
}

function prepareElectronBundle() {
  plistSet('CFBundleIdentifier', desktopBundleID);
  plistSet('CFBundleName', 'API Balance Whale');
  plistSet('CFBundleDisplayName', 'API Balance Whale');
  plistSet('LSUIElement', 'true', 'bool');
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', electronApp]);
  const stale = path.join(os.homedir(), 'Library', 'Saved Application State', desktopBundleID + '.savedState');
  try { fs.rmSync(stale, { recursive: true, force: true }); } catch {}
}

function compileProbe() {
  fs.mkdirSync(nativeDir, { recursive: true });
  const temporary = probePath + '.tmp';
  const cache = path.join(nativeDir, 'swift-cache');
  fs.mkdirSync(cache, { recursive: true });
  run('/usr/bin/xcrun', ['swiftc', '-O', '-framework', 'AppKit', '-framework', 'CoreGraphics', '-o', temporary, probeSource], {
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: cache, SWIFT_MODULECACHE_PATH: cache },
  });
  run('/usr/bin/codesign', ['--force', '--sign', '-', temporary]);
  fs.renameSync(temporary, probePath);
  fs.chmodSync(probePath, 0o755);
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function writeLaunchAgent() {
  fs.mkdirSync(launchAgents, { recursive: true });
  fs.mkdirSync(DATA_HOME, { recursive: true });
  const program = [
    nodePath,
    supervisorPath,
    '--data-dir',
    DATA_HOME,
    '--plugin-root',
    ROOT,
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>${program.map(value => `<string>${xml(value)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(path.join(DATA_HOME, 'macos-launchagent.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(DATA_HOME, 'macos-launchagent-error.log'))}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist);
}

function launchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'launchctl failed').trim());
  }
  return result;
}

async function reloadLaunchAgent() {
  const uid = process.getuid();
  const domain = 'gui/' + uid;
  const service = domain + '/' + label;
  const loaded = () => launchctl(['print', service], { allowFailure: true }).status === 0;
  if (loaded()) {
    const bootout = launchctl(['bootout', service], { allowFailure: true });
    if (bootout.status !== 0 && loaded()) {
      throw new Error((bootout.stderr || bootout.stdout || 'launchctl bootout failed').trim());
    }
    for (let attempt = 0; attempt < 25 && loaded(); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
    if (loaded()) throw new Error('The previous LaunchAgent did not stop; refusing to report a successful install.');
  }
  launchctl(['enable', domain + '/' + label]);
  if (!loaded()) {
    const bootstrap = launchctl(['bootstrap', domain, plistPath], { allowFailure: true });
    if (bootstrap.status !== 0) {
      throw new Error((bootstrap.stderr || bootstrap.stdout || 'launchctl bootstrap failed').trim());
    }
  }
  launchctl(['kickstart', service]);
}

installDesktopIfNeeded();
prepareElectronBundle();
compileProbe();
writeLaunchAgent();

const config = {
  platform: 'darwin',
  enabled: true,
  mode: 'follow-codex',
  revision: 'macos-v1',
  installId,
  label,
  pluginRoot: ROOT,
  nodePath,
  electronPath,
  probePath,
  launchAgentPath: plistPath,
  bundleId: process.env.WHALE_CODEX_BUNDLE_ID || 'com.openai.codex',
};
fs.writeFileSync(path.join(DATA_HOME, 'follow-config.json'), JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(DATA_HOME, 'follow-install.json'), JSON.stringify({
  ...config,
  installedAt: new Date().toISOString(),
}, null, 2));

try { fs.unlinkSync(path.join(DATA_HOME, 'pause-until-host-exit.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
try { fs.unlinkSync(path.join(DATA_HOME, 'supervisor-state.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await reloadLaunchAgent();

let verified = false;
for (let attempt = 0; attempt < 30; attempt++) {
  const state = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_HOME, 'supervisor-state.json'), 'utf8')); } catch { return null; }
  })();
  const heartbeatAt = Date.parse(state?.heartbeatAt || '');
  let alive = false;
  try { process.kill(Number(state?.pid), 0); alive = true; } catch {}
  if (state?.installId === installId && alive && Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt < 5000 && state.platform === 'darwin') {
    verified = true;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 200));
}
if (!verified) {
  throw new Error('LaunchAgent was installed, but the supervisor did not report ready. See macos-launchagent-error.log.');
}

process.stdout.write('macOS desktop component and automatic following are installed.\n');
process.stdout.write('Open the Codex desktop app; the whale will appear when a Codex window is available.\n');
