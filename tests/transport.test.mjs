import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startBridge, bridgeRequest } from '../runtime/bridge.mjs';
import { stripRetiredModules } from '../runtime/migration.mjs';
import { ROOT } from '../runtime/paths.mjs';
import { ConfigStore } from '../runtime/config.mjs';
import { WhaleService } from '../runtime/service.mjs';
import { createDispatcher } from '../runtime/dispatcher.mjs';

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ipc-'));
  const codex = path.join(dir, 'codex'); fs.mkdirSync(codex);
  fs.writeFileSync(path.join(codex, 'config.toml'), 'model_provider="test"\n[model_providers.test]\nbase_url="https://example.test/v1"\nexperimental_bearer_token="NEVER_EXPOSE_TEST_KEY"\n');
  const config = new ConfigStore({ dataDir: path.join(dir, 'data'), codexHome: codex, env: {} });
  const service = new WhaleService({ config, provider: { async balance(c) { return { ok: true, accountId: c.accountId, totalBalance: 10.12345, totalUsed: 0, currency: 'USD', updatedAt: new Date().toISOString() }; } } });
  const server = createDispatcher({ dataDir: config.dataDir, service, monitor: false, autoRefresh: false });
  t.after(async () => {
    await server.close();
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('whale-ipc-'));
    fs.rmSync(resolved, { recursive: true });
  });
  async function request(route, method = 'GET', body) {
    const response = await server.dispatch(route, { method, body });
    return new Response(response.status === 204 ? null : response.body, { status: response.status, headers: response.headers });
  }
  return { server, request, dir, config };
}

test('position reset is authenticated and cannot be invoked as a read', async t=>{
  const {server,config}=await setup(t);let resets=0;
  const bridge=await startBridge(server,{dataDir:config.dataDir,onResetPosition:()=>{resets++;return true;}});t.after(()=>bridge.close());
  const options={dataDir:config.dataDir,method:'POST',body:{}};
  assert.equal((await bridgeRequest('/api/reset-position',{...options,runtime:{...bridge,token:'wrong-token'}})).ok,false);
  assert.equal((await bridgeRequest('/api/reset-position',{dataDir:config.dataDir})).ok,false);assert.equal(resets,0);
  assert.equal((await bridgeRequest('/api/reset-position',options)).ok,true);assert.equal(resets,1);
});

test('local IPC authenticates requests and restricts operations without a TCP port', async t => {
  const { server, request, config } = await setup(t);
  const bridge = await startBridge(server, { dataDir: config.dataDir });
  t.after(() => bridge.close());
  assert.equal(typeof bridge.server.address(), 'string');
  const hostile = await bridgeRequest('/api/status', { dataDir: config.dataDir, runtime: { ...bridge, token: 'wrong-token' } });
  assert.equal(hostile.ok, false);
  const unauthorizedWrite = await bridgeRequest('/api/config', { method: 'PUT', body: {}, dataDir: config.dataDir });
  assert.equal(unauthorizedWrite.ok, false);
  assert.equal((await request('//untrusted.test/api/status')).status, 400);
  assert.equal((await request('/dsh-whale/role-delete.json')).status, 405);
  const status = await bridgeRequest('/api/status', { dataDir: config.dataDir });
  assert.equal(status.transport, 'local-ipc'); assert.equal(status.webpage, false);
  assert.equal(JSON.stringify(status).includes('NEVER_EXPOSE_TEST_KEY'), false);
  const ui = await request('/widget.html');
  assert.ok(ui.headers.get('content-security-policy').includes("object-src 'none'"));
  const content = await ui.text(); assert.equal(content.includes('whale-shell'), false);
});

test('legacy scheduling modules are removed without changing money or custom content', () => {
  const old = { pricingSchedule: { enabled: true }, peakMode: 'default', amount: 0.00123456, items: [{ modules: [{ type: 'text', text: 'preserve me' }, { type: 'peak' }, { type: 'today' }, { type: 'nextpeak' }, { type: 'image', imgId: 'custom' }] }] };
  const result = stripRetiredModules(old);
  assert.equal(result.amount, old.amount);
  assert.deepEqual(result.items[0].modules, [{ type: 'text', text: 'preserve me' }, { type: 'today' }, { type: 'image', imgId: 'custom' }]);
  assert.equal('pricingSchedule' in result, false); assert.equal('peakMode' in result, false);
});

test('supervisor window state requires authenticated local IPC and reaches the lifecycle handler', async t => {
  const { server, config } = await setup(t);
  const received = [];
  const bridge = await startBridge(server, { dataDir: config.dataDir, onHost: state => received.push(state) });
  t.after(() => bridge.close());
  const state = { hostAlive: true, hostPid: 123, visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const rejected = await bridgeRequest('/internal/host', { dataDir: config.dataDir, method: 'POST', body: state, runtime: { ...bridge, token: 'wrong' } });
  assert.equal(rejected.ok, false); assert.equal(received.length, 0);
  const accepted = await bridgeRequest('/internal/host', { dataDir: config.dataDir, method: 'POST', body: state });
  assert.equal(accepted.ok, true); assert.deepEqual(received, [state]);
  await bridgeRequest('/internal/host', { dataDir: config.dataDir, method: 'POST', body: { hostAlive: false } });
  assert.equal(received[1].hostAlive, false);
});

test('all original built-in images, animation, sound and script routes work', async t => {
  const { request } = await setup(t);
  const cases = [
    ['/dsh-whale/image.png', 'image/png'], ['/dsh-whale/rua.gif', 'image/gif'],
    ['/dsh-whale/sound/press.mp3?set=duck', 'audio/mpeg'], ['/dsh-whale/sound/release.mp3?set=fx1', 'audio/mpeg'],
    ['/dsh-whale/audio-fragment.wav?id=ya1', 'audio/mpeg'], ['/dsh-whale/bubble-img.png?id=bimg_petpet', 'image/gif'],
    ['/dsh-whale/bubble-img.png?id=bimg_yue_money', 'image/gif'], ['/dsh-whale/widget.js', 'application/javascript'],
  ];
  for (const [route, contentType] of cases) {
    const response = await request(route); assert.equal(response.status, 200, route);
    assert.ok(response.headers.get('content-type').startsWith(contentType), route);
    assert.ok((await response.arrayBuffer()).byteLength > 100, route);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('original widget settings and bubble sequences survive save and reload', async t => {
  const { request } = await setup(t);
  const settings = { scale: 1.2, vol: 0.3, sound: true, soundSet: 'fx1', usageMode: 'ledger', bubbleOn: true, turnCostOn: true, turnCostCloseMs: 0, scrollGapOn: true, scrollGapPx: 25, menuBtnHide: false, outsideDismissOn: true };
  const saved = await (await request('/dsh-whale/size.json', 'PUT', settings)).json(); assert.equal(saved.ok, true);
  const loaded = await (await request('/dsh-whale/size.json')).json();
  assert.equal(loaded.scale, 1.2); assert.equal(loaded.turnCostCloseMs, 0); assert.equal(loaded.vol, 0.3); assert.equal(loaded.outsideDismissOn, true);
  const bubble = { v: 1, items: [{ kind: 'custom', modules: [{ type: 'text', text: '测试气泡' }, { type: 'balance', tpl: '{balance_api}' }] }], lib: [] };
  assert.equal((await (await request('/dsh-whale/bubble.json', 'PUT', bubble)).json()).ok, true);
  assert.deepEqual((await (await request('/dsh-whale/bubble.json')).json()).config, bubble);
  const usage = await (await request('/dsh-whale/usage-settings.json', 'PUT', { alert: { on: true, below: 2 }, budget: { on: true, amount: 3 } })).json();
  assert.equal(usage.settings.alert.below, 2); assert.equal(usage.settings.budget.amount, 3);
});

test('custom character upload, pin, image retrieval and deletion preserve the original workflow', async t => {
  const { request } = await setup(t);
  const bytes = fs.readFileSync(path.join(ROOT, 'assets', 'DSniang1.png'));
  const result = await (await request('/dsh-whale/roles.json', 'POST', { name: '测试鲸鱼', image: 'data:image/png;base64,' + bytes.toString('base64') })).json();
  assert.equal(result.ok, true);
  const role = result.roles.find(x => x.name === '测试鲸鱼'); assert.ok(role);
  const image = Buffer.from(await (await request('/dsh-whale/role-image.png?id=' + role.id)).arrayBuffer());
  assert.deepEqual(image, bytes);
  const pinned = await (await request('/dsh-whale/role-pin.json', 'POST', { id: role.id, pinned: true })).json();
  assert.ok(pinned.roles.find(x => x.id === role.id).pinnedAt);
  const deleted = await (await request('/dsh-whale/role-delete.json', 'POST', { id: role.id })).json();
  assert.equal(deleted.roles.some(x => x.id === role.id), false);
  assert.equal((await request('/dsh-whale/role-image.png?id=..%2Fconfig')).status, 404);
});

test('custom GIF gallery and sound fragment/group management work', async t => {
  const { request } = await setup(t);
  const gif = fs.readFileSync(path.join(ROOT, 'assets', 'bubble-petpet.gif'));
  const gallery = await (await request('/dsh-whale/bubble-img-upload.json', 'POST', { action: 'upload', name: '测试动图', data: 'data:image/gif;base64,' + gif.toString('base64') })).json();
  assert.equal(gallery.ok, true); const image = gallery.images.find(x => x.name === '测试动图'); assert.ok(image);
  assert.deepEqual(Buffer.from(await (await request('/dsh-whale/bubble-img.png?id=' + image.id)).arrayBuffer()), gif);
  const removed = await (await request('/dsh-whale/bubble-img-upload.json', 'POST', { action: 'delete', id: image.id })).json();
  assert.equal(removed.images.some(x => x.id === image.id), false);
  const wav = Buffer.alloc(48); wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
  const audio = await (await request('/dsh-whale/audio.json', 'POST', { action: 'upload-fragment', name: '测试声音', audio: 'data:audio/wav;base64,' + wav.toString('base64') })).json();
  assert.equal(audio.ok, true); assert.ok(audio.id);
  const saved = await (await request('/dsh-whale/audio.json', 'PUT', { action: 'save-group', name: '测试音效组', press: '', release: audio.id })).json();
  const group = saved.groups.find(x => x.name === '测试音效组'); assert.ok(group);
  assert.equal((await request('/dsh-whale/sound/press.mp3?set=' + group.id)).status, 204);
  assert.deepEqual(Buffer.from(await (await request('/dsh-whale/sound/release.mp3?set=' + group.id)).arrayBuffer()), wav);
  assert.equal((await (await request('/dsh-whale/audio.json', 'POST', { action: 'delete-group', id: group.id })).json()).ok, true);
  assert.equal((await (await request('/dsh-whale/audio.json', 'POST', { action: 'delete-fragment', id: audio.id })).json()).ok, true);
  const mixed = await (await request('/dsh-whale/audio.json', 'PUT', { action: 'save-group', name: '预设片段组合测试', press: 'ya1', release: 'd2' })).json();
  const mixedId = mixed.groups.find(x => x.name === '预设片段组合测试').id;
  assert.equal((await request('/dsh-whale/sound/press.mp3?set=' + mixedId)).headers.get('content-type'), 'audio/mpeg');
});

test('MCP process supports initialization and tool discovery without logging credentials', async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'runtime', 'mcp.mjs')], { env: { ...process.env, WHALE_MCP_NO_AUTOSTART: '1' }, windowsHide: true });
  let output = '', error = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { error += x; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 300)); child.stdin.end();
  const [code] = await once(child, 'close'); assert.equal(code, 0); assert.equal(error, '');
  const messages = output.trim().split('\n').map(JSON.parse);
  assert.equal(messages.find(x => x.id === 1).result.serverInfo.name, 'api-balance-whale');
  assert.deepEqual(messages.find(x => x.id === 2).result.tools.map(x => x.name), ['whale_balance', 'whale_usage', 'whale_status', 'whale_open']);
});
