import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DATA_HOME } from '../runtime/paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, 'qa-output', 'provider-connections'));
fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(output, 'fixture-'));
const executable = process.argv[3] || path.join(DATA_HOME, 'desktop-runtime/node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe');
const local = key => path.join(data, key);
for (const name of ['tmp', 'home', 'app-data', 'local-data', 'codex']) fs.mkdirSync(local(name));
// The child receives OS runtime paths plus only synthetic application homes.
// Never inherit Codex profiles, API keys, proxy credentials, or host state.
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'ComSpec', 'PATHEXT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { TEMP: local('tmp'), TMP: local('tmp'), USERPROFILE: local('home'), HOME: local('home'), APPDATA: local('app-data'), LOCALAPPDATA: local('local-data'),
  CODEX_HOME: local('codex'), WHALE_HOME: data, WHALE_DESKTOP_TEST: '1', WHALE_CONNECTIONS_UI_TEST: '1', WHALE_DESKTOP_VERIFY_DIR: output });
const child = spawn(executable, [path.join(root, 'desktop/main.cjs'), '--whale-data=' + data], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
const timer = setTimeout(() => child.kill(), 90000);
const [code] = await once(child, 'close'); clearTimeout(timer);
const file = path.join(output, 'connection-ui.json');
const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { ok: false, error: stderr };
assert.equal(report.dataDir, data, 'this run must produce its own report');
assert.equal(report.ok, true, report.error || stderr); assert.equal(code, 0, stderr);
console.log(JSON.stringify({ ok: true, checks: report.checks, geometrySamples: report.geometry.length, screenshots: report.screenshots, report: file }));
