import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.2.4';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
export const DATA_HOME = path.resolve(process.env.WHALE_HOME || path.join(CODEX_HOME, 'whale-widget'));

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw new Error('本地数据文件损坏或不可读：' + path.basename(file));
  }
}

export function writeJson(file, data, { fs: fileSystem = fs } = {}) {
  const encoded = JSON.stringify(data, null, 2);
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
  let descriptor, created = false;
  try {
    descriptor = fileSystem.openSync(temp, 'wx', 0o600); created = true;
    fileSystem.writeFileSync(descriptor, encoded);
    fileSystem.closeSync(descriptor); descriptor = undefined;
    // Antivirus/indexing may briefly deny replacement on Windows. Retry only
    // these sharing/access failures, with no sleep or deletion of the target.
    for (let attempt = 0; ; attempt++) {
      try { fileSystem.renameSync(temp, file); break; }
      catch (error) { if (attempt >= 2 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error; }
    }
  } catch (error) {
    if (descriptor !== undefined) { try { fileSystem.closeSync(descriptor); } catch {} }
    if (created) { try { fileSystem.unlinkSync(temp); } catch {} }
    throw error;
  }
}

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

export const rounded = n => Math.round((Number(n) + Number.EPSILON) * 1e8) / 1e8;
