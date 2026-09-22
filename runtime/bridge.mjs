import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { DATA_HOME, VERSION, readJson, writeJson } from './paths.mjs';

export function pipeName(dataDir = DATA_HOME) {
  const hash = crypto.createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? '\\\\.\\pipe\\codex-whale-' + hash : path.join(dataDir, 'whale-' + hash + '.sock');
}
const ALLOWED = new Map([
  ['/api/status', 'GET'], ['/dsh-whale/balance.json', 'GET'], ['/dsh-whale/usage-records.json', 'GET'], ['/api/show', 'POST'], ['/api/stop', 'POST'],
]);

export async function startBridge(dispatcher, { dataDir = DATA_HOME, onHost = null } = {}) {
  const pipe = pipeName(dataDir), token = crypto.randomBytes(32).toString('hex'), instanceId = crypto.randomUUID();
  if (process.platform !== 'win32' && fs.existsSync(pipe)) {
    let stale = true;
    try {
      const previous = readJson(path.join(dataDir, 'runtime.json'), {});
      if (previous.pipe === pipe && Number.isSafeInteger(previous.pid) && previous.pid > 0) {
        process.kill(previous.pid, 0);
        stale = !await socketResponds(pipe);
      }
    } catch {}
    if (stale) {
      try { fs.unlinkSync(pipe); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); socket.setTimeout(35000, () => socket.destroy());
    let input = '', used = false;
    socket.on('data', async part => {
      if (used) return;
      input += part;
      if (input.length > 65536) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      used = true;
      let reply;
      try {
        const message = JSON.parse(input.slice(0, input.indexOf('\n')));
        const candidate = Buffer.from(typeof message.token === 'string' ? message.token : '');
        if (candidate.length !== token.length || !crypto.timingSafeEqual(candidate, Buffer.from(token))) throw new Error('unauthorized');
        if (message.route === '/internal/host' && message.method === 'POST' && onHost) {
          await onHost(message.body);
          if (!socket.destroyed) socket.end(JSON.stringify({ status: 200, payload: { ok: true } }) + '\n');
          return;
        }
        const url = new URL(message.route, 'whale://widget');
        if (typeof message.route !== 'string' || !message.route.startsWith('/') || message.route.startsWith('//') || ALLOWED.get(url.pathname) !== message.method) throw new Error('unsupported');
        const result = await dispatcher.dispatch(message.route, { method: message.method, body: message.body });
        reply = { status: result.status, payload: JSON.parse(result.body.toString('utf8')) };
      } catch { reply = { status: 403, payload: { ok: false, error: '本地挂件操作未获授权' } }; }
      if (!socket.destroyed) socket.end(JSON.stringify(reply) + '\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  const runtime = { transport: 'local-ipc', pipe, token, pid: process.pid, instanceId, version: VERSION };
  writeJson(path.join(dataDir, 'runtime.json'), runtime);
  async function close() {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    const file = path.join(dataDir, 'runtime.json');
    if (readJson(file, {}).instanceId === instanceId) fs.unlinkSync(file);
  }
  return { ...runtime, server, close };
}

function socketResponds(pipe) {
  return new Promise(resolve => {
    const socket = net.createConnection(pipe);
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(250, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function bridgeRequest(route, { method = 'GET', body, dataDir = DATA_HOME, runtime = null, timeoutMs = 30000 } = {}) {
  const info = runtime || readJson(path.join(dataDir, 'runtime.json'), null);
  if (!info || info.transport !== 'local-ipc' || info.pipe !== pipeName(dataDir)) throw new Error('挂件尚未随 Codex 启动');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(info.pipe); let input = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setEncoding('utf8'); socket.setTimeout(timeoutMs, () => finish(new Error('挂件响应超时')));
    socket.on('error', () => finish(new Error('挂件尚未运行')));
    socket.on('connect', () => socket.write(JSON.stringify({ token: info.token, route, method, body }) + '\n'));
    socket.on('data', data => {
      input += data;
      if (input.length > 8 * 1024 * 1024) return finish(new Error('挂件响应过大'));
      if (!input.includes('\n')) return;
      try { const result = JSON.parse(input.slice(0, input.indexOf('\n'))); finish(null, result.payload); } catch { finish(new Error('挂件响应无效')); }
    });
    socket.on('end', () => { if (!settled) finish(new Error('挂件连接已关闭')); });
  });
}
