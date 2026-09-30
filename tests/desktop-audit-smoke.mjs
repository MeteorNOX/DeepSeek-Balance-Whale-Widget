import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ROOT, DATA_HOME } from '../runtime/paths.mjs';

const output = path.resolve(process.argv[2] || path.join(ROOT, 'qa-desktop-audit'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-desktop-audit-live-'));
fs.mkdirSync(path.join(dataDir, 'whale-roles'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'ui-state.json'), JSON.stringify({
  'dshw-role': 'broken_saved_role',
  // Seed a genuine saved interior anchor, so later startup settle() does not
  // restore the default edge anchor over the test's deliberate placement.
  'dshw-pos': JSON.stringify({ v: 2, hAnchor: 'left', hDist: 140, vAnchor: 'top', vDist: 140 }),
}));
fs.writeFileSync(path.join(dataDir, 'whale-roles', 'roles.json'), JSON.stringify({ version: 1, roles: [
  { id: 'default', name: '小鲸鱼', pinnedAt: 1, createdAt: 0 },
  { id: 'broken_saved_role', name: 'Missing role fixture', format: 'png', createdAt: 1 },
  { id: 'role_audit_apng', name: 'Two-frame APNG fixture', format: 'apng', createdAt: 2 },
] }));
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length, 0); result.write(name, 4, 'ascii'); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4); return result;
}
const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
const animation = Buffer.alloc(8); animation.writeUInt32BE(2, 0);
function frame(sequence) { const bytes = Buffer.alloc(26); bytes.writeUInt32BE(sequence, 0); bytes.writeUInt32BE(2, 4); bytes.writeUInt32BE(1, 8); bytes.writeUInt16BE(1, 20); bytes.writeUInt16BE(10, 22); return bytes; }
const second = Buffer.alloc(4); second.writeUInt32BE(2);
fs.writeFileSync(path.join(dataDir, 'whale-roles', 'role_audit_apng.png'), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('acTL', animation), chunk('fcTL', frame(0)),
  chunk('IDAT', zlib.deflateSync(Buffer.from([0, 40, 80, 220, 255, 0, 0, 0, 0]))), chunk('fcTL', frame(1)),
  chunk('fdAT', Buffer.concat([second, zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0, 40, 80, 220, 255]))])), chunk('IEND', Buffer.alloc(0)),
]));
const electronDist = path.join(DATA_HOME, 'desktop-runtime/node_modules/electron/dist');
const executable = process.platform === 'darwin'
  ? path.join(electronDist, 'Electron.app/Contents/MacOS/Electron')
  : process.platform === 'linux'
    ? path.join(electronDist, 'electron')
    : path.join(electronDist, 'electron.exe');
const env = { ...process.env, WHALE_DESKTOP_TEST: '1', WHALE_DESKTOP_AUDIT: '1', WHALE_DESKTOP_VERIFY_DIR: output };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [path.join(ROOT, 'desktop/main.cjs'), '--whale-data=' + dataDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let diagnostics = ''; child.stdout.resume(); child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-3000); });
const timeout = setTimeout(() => child.kill(), 30000);
const [code] = await once(child, 'close'); clearTimeout(timeout);
const reportFile = path.join(output, 'desktop-audit.json');
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { ok: false, error: diagnostics, dataDir };
assert.equal(code, 0, JSON.stringify(report)); assert.equal(report.ok, true, JSON.stringify(report));
const shutdown = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop-shutdown.json'), 'utf8'));
assert.equal(shutdown.stages.find(stage => stage.name === 'renderer-state').status, 'timeout');
assert.equal(shutdown.stages.find(stage => stage.name === 'service-close').status, 'complete');
report.checks.push('an actually stalled Electron renderer still closes the isolated companion after flushing state and closing services');
report.shutdown = shutdown;
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report) + '\n');
