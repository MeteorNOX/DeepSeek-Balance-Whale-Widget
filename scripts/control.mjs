import { ensureService, serviceRequest, runningService, launchDesktop } from '../runtime/process.mjs';
import { DATA_HOME, ROOT } from '../runtime/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const command = process.argv[2] || 'open';
try {
  let result;
  if (command === 'open') result = await launchDesktop();
  else if (command === 'desktop' && process.platform === 'darwin') {
    const electron = process.env.ELECTRON_BIN || path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
    if (!fs.existsSync(electron)) throw new Error('未找到 Electron；请先运行 npm install，或设置 ELECTRON_BIN');
    const child = spawn(electron, [path.join(ROOT, 'desktop', 'main.cjs'), '--standalone'], { detached: true, stdio: 'ignore', env: { ...process.env, WHALE_DESKTOP_MODE: 'standalone' } });
    child.unref();
    result = { ok: true, desktop: 'launched', mode: 'standalone' };
  }
  else if (command === 'desktop') result = await launchDesktop();
  else if (command === 'balance') result = await serviceRequest('/dsh-whale/balance.json' + (process.argv.includes('--refresh') ? '?refresh=1' : ''));
  else if (command === 'usage') result = await serviceRequest('/dsh-whale/usage-records.json');
  else if (command === 'status') result = await serviceRequest('/api/status');
  else if (command === 'stop') { const running = await runningService(DATA_HOME); result = running ? await serviceRequest('/api/stop', { method: 'POST', body: {} }) : { ok: true, stopped: true }; }
  else throw new Error('支持 open、desktop、balance、usage、status、stop');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.ok === false) process.exitCode = 1;
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
