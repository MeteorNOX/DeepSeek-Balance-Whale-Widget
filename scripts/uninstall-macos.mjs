import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_HOME } from '../runtime/paths.mjs';

if (process.platform !== 'darwin') {
  process.stderr.write('This uninstaller is only for macOS.\n');
  process.exit(1);
}

const configFile = path.join(DATA_HOME, 'follow-config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}
const label = config.label || 'com.api-balance-whale.codex';
const plistPath = config.launchAgentPath || path.join(os.homedir(), 'Library', 'LaunchAgents', label + '.plist');
const domain = 'gui/' + process.getuid();
const service = domain + '/' + label;

if (Object.keys(config).length) {
  config.enabled = false;
  config.uninstalledAt = new Date().toISOString();
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

const loaded = () => spawnSync('/bin/launchctl', ['print', service], { encoding: 'utf8' }).status === 0;
if (loaded()) {
  const bootout = spawnSync('/bin/launchctl', ['bootout', service], { encoding: 'utf8' });
  if (bootout.status !== 0 && loaded()) {
    process.stderr.write((bootout.stderr || bootout.stdout || 'launchctl bootout failed').trim() + '\n');
    process.exit(1);
  }
  for (let attempt = 0; attempt < 25 && loaded(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (loaded()) {
    process.stderr.write('LaunchAgent is still loaded; automatic following was not removed.\n');
    process.exit(1);
  }
}
spawnSync('/bin/launchctl', ['disable', service], { encoding: 'utf8' });
try { fs.unlinkSync(plistPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
process.stdout.write('Automatic following is disabled. Settings, resources and records were retained.\n');
