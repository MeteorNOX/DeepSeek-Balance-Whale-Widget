import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_HOME } from '../runtime/paths.mjs';

const runtimeDir = path.join(DATA_HOME, 'desktop-runtime');
const candidates = [];
if (process.platform === 'darwin') {
  for (const npmLink of ['/opt/homebrew/bin/npm', '/usr/local/bin/npm']) {
    if (!fs.existsSync(npmLink)) continue;
    try {
      const real = fs.realpathSync(npmLink);
      if (path.basename(real) === 'npm-cli.js') candidates.push(real);
      candidates.push(path.resolve(path.dirname(real), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    } catch {}
  }
}
candidates.push(
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
);
if (process.platform === 'win32') {
  const lookup = spawnSync('where.exe', ['npm.cmd'], { encoding: 'utf8', windowsHide: true });
  for (const line of (lookup.stdout || '').trim().split(/\r?\n/)) if (line) candidates.push(path.join(path.dirname(line), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
} else if (!candidates.some(file => fs.existsSync(file))) {
  const lookup = spawnSync('/usr/bin/which', ['npm'], { encoding: 'utf8' });
  const npmPath = (lookup.stdout || '').trim();
  if (npmPath) {
    try {
      const real = fs.realpathSync(npmPath);
      if (path.basename(real) === 'npm-cli.js') candidates.unshift(real);
      candidates.push(path.resolve(path.dirname(real), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      candidates.push(path.resolve(path.dirname(fs.realpathSync(npmPath)), '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      const root = spawnSync(npmPath, ['root', '-g'], { encoding: 'utf8' });
      if (root.status === 0) candidates.push(path.join((root.stdout || '').trim(), 'npm', 'bin', 'npm-cli.js'));
    } catch {}
  }
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) candidates.unshift(process.env.npm_execpath);
}
const npm = candidates.find(file => fs.existsSync(file));
if (!npm) { process.stderr.write('请先安装包含 npm 的 Node.js 24 或更新版本。\n'); process.exit(1); }
fs.mkdirSync(runtimeDir, { recursive: true });
let result = spawnSync(process.execPath, [npm, '--prefix', runtimeDir, '--cache', path.join(DATA_HOME, 'npm-cache'), 'install', '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact', 'electron@44.3.0'], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status || 1);
result = spawnSync(process.execPath, [path.join(runtimeDir, 'node_modules', 'electron', 'install.js')], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status || 1);
process.stdout.write('桌面组件安装完成。可以启动桌面挂件。\n');
