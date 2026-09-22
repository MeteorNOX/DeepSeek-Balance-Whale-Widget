import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_HOME } from '../runtime/paths.mjs';

if (process.platform !== 'darwin') {
  process.stderr.write('This diagnostic is only for macOS.\n');
  process.exit(1);
}

const probe = path.join(DATA_HOME, 'native', 'whale-window-probe');
if (!fs.existsSync(probe)) {
  process.stderr.write('Window probe is not installed. Run scripts/install-macos.mjs first.\n');
  process.exit(1);
}
let configuredBundle = '';
try {
  configuredBundle = JSON.parse(fs.readFileSync(path.join(DATA_HOME, 'follow-config.json'), 'utf8')).bundleId || '';
} catch {}
const result = spawnSync(probe, ['--once', '--bundle-id', process.env.WHALE_CODEX_BUNDLE_ID || configuredBundle || 'com.openai.codex'], { encoding: 'utf8' });
if (result.status !== 0) {
  process.stderr.write(result.stderr || 'Window probe failed.\n');
  process.exit(result.status || 1);
}
process.stdout.write(result.stdout);
