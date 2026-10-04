import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ROOT, DATA_HOME } from '../runtime/paths.mjs';

const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'whale-position-report-')));
fs.mkdirSync(output, { recursive: true });
let dataDir;
const reports = [];
const executable = path.join(DATA_HOME, 'desktop-runtime/node_modules/electron/dist/electron.exe');
for (const phase of ['bottom', 'interior', 'restart']) {
  if (phase !== 'restart') dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-position-data-'));
  if (phase !== 'restart') fs.writeFileSync(path.join(dataDir, 'ui-state.json'), JSON.stringify({ 'dshw-pos': JSON.stringify({ v: 2, hAnchor: 'left', hDist: phase === 'bottom' ? 0 : 200, vAnchor: phase === 'bottom' ? 'bottom' : 'top', vDist: phase === 'bottom' ? 0 : 100 }) }));
  const env = { ...process.env, WHALE_DESKTOP_TEST: '1', WHALE_POSITION_MEMORY: '1', WHALE_POSITION_PHASE: phase, WHALE_DESKTOP_VERIFY_DIR: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [path.join(ROOT, 'desktop/main.cjs'), '--whale-data=' + dataDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let diagnostic = ''; child.stdout.resume(); child.stderr.on('data', b => { diagnostic = (diagnostic + b).slice(-6000); });
  const timeout = setTimeout(() => child.kill(), 45000);
  const [code] = await once(child, 'close'); clearTimeout(timeout);
  const reportFile = path.join(output, 'position-' + phase + '.json');
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { ok: false, diagnostic };
  reports.push(report);
  fs.writeFileSync(path.join(output, 'position-memory.json'), JSON.stringify({ ok: reports.every(r => r.ok) && code === 0, dataDir, reports }, null, 2));
  assert.equal(code, 0, JSON.stringify(report)); assert.equal(report.ok, true, JSON.stringify(report));
  if (phase === 'interior' || phase === 'restart') {
    const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'ui-state.json'), 'utf8'));
    const dragged = JSON.parse(fs.readFileSync(path.join(output, 'drag-expected.json'), 'utf8'));
    assert.equal(disk['dshw-pos'], dragged.saved, 'graceful shutdown flushes dragged anchor to ui-state.json');
  }
}
process.stdout.write(JSON.stringify({ ok: true, output, dataDir, checks: reports.flatMap(r => r.checks) }) + '\n');
