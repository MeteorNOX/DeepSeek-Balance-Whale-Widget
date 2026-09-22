import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_HOME, readJson } from './paths.mjs';
import { bridgeRequest } from './bridge.mjs';

export async function runningService(dataDir = DATA_HOME) {
  try { const status = await bridgeRequest('/api/status', { dataDir, timeoutMs: 1500 }); return status.ok ? status : null; } catch { return null; }
}
export async function startSupervisor(dataDir = DATA_HOME) {
  const config = readJson(path.join(dataDir, 'follow-config.json'), {});
  if (process.platform === 'darwin') {
    if (config.platform !== 'darwin' || config.mode !== 'follow-codex' || config.enabled !== true || !config.label) {
      throw new Error('请先运行 scripts/install-macos.mjs 安装 macOS 自动跟随');
    }
    const pause = path.join(dataDir, 'pause-until-host-exit.json');
    if (fs.existsSync(pause)) fs.unlinkSync(pause);
    const domain = 'gui/' + process.getuid();
    try {
      await promisify(execFile)('/bin/launchctl', ['kickstart', domain + '/' + config.label], { timeout: 10000 });
    } catch {
      throw new Error('macOS LaunchAgent 未能启动，请运行“安装 Mac 自动跟随.command”修复');
    }
    return;
  }
  if (config.taskName !== 'Codex API Balance Whale') throw new Error('请运行“安装自动跟随.cmd”以修复独立启动任务');
  const pause = path.join(dataDir, 'pause-until-host-exit.json');
  if (fs.existsSync(pause)) fs.unlinkSync(pause);
  const scheduler = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'schtasks.exe');
  try { await promisify(execFile)(scheduler, ['/Run', '/TN', config.taskName], { windowsHide: true, timeout: 10000 }); }
  catch { throw new Error('Windows 自动跟随任务未能启动，请运行“安装自动跟随.cmd”修复'); }
}
export async function ensureService({ dataDir = DATA_HOME } = {}) {
  let running = await runningService(dataDir);
  if (running) return running;
  await startSupervisor(dataDir);
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 250)); running = await runningService(dataDir); if (running) return running; }
  throw new Error('请先打开 Codex 桌面应用；挂件只跟随该应用运行');
}
export async function serviceRequest(route, options = {}) { return bridgeRequest(route, options); }
export async function launchDesktop({ dataDir = DATA_HOME } = {}) {
  await ensureService({ dataDir });
  return bridgeRequest('/api/show', { method: 'POST', dataDir });
}
export function supervisorStatus(dataDir = DATA_HOME) {
  const config = readJson(path.join(dataDir, 'follow-config.json'), {});
  const installed = process.platform === 'darwin'
    ? config.platform === 'darwin' && config.enabled === true && !!config.label
    : config.taskName === 'Codex API Balance Whale';
  return { installed, ...readJson(path.join(dataDir, 'supervisor-state.json'), {}) };
}
