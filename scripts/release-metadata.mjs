import fs from 'node:fs';
import path from 'node:path';
import { ROOT, VERSION } from '../runtime/paths.mjs';

export function validateReleaseMetadata({plugin,packageMetadata,lock,runtimeVersion}) {
  const records=[plugin,packageMetadata,lock,lock?.packages?.['']];
  if (!/^\d+\.\d+\.\d+(?:\+[A-Za-z0-9.-]+)?$/.test(runtimeVersion || '') ||
      records.some(record=>record?.name !== 'api-balance-whale' || record.version !== runtimeVersion)) {
    throw new Error('Release metadata mismatch: plugin, package, lockfile and runtime must have the same version.');
  }
  return runtimeVersion;
}

export function verifyReleaseMetadata(root=ROOT) {
  const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8').replace(/^\uFEFF/,''));
  return validateReleaseMetadata({plugin:read('.codex-plugin/plugin.json'),packageMetadata:read('package.json'),
    lock:read('package-lock.json'),runtimeVersion:VERSION});
}
