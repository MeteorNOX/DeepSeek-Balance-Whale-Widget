import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { ConfigStore } from '../runtime/config.mjs';
import { BalanceProvider, readBoundedJsonText } from '../runtime/providers.mjs';
import { createWidgetHost } from '../lib/widget-host.mjs';
import { MEDIA_POLICY, validateImage, validateWav, decodeMediaDataUrl } from '../lib/media-validation.mjs';
import { atomicResourceWrite, resourcePath, checkMediaBudget } from '../lib/resource-store.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-security-'));
  t.after(() => {
    const root = path.resolve(dir), parent = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(root.startsWith(parent) && path.basename(root).startsWith('whale-security-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return dir;
}
function fail(message = 'test ENOSPC', code = 'ENOSPC') { return Object.assign(new Error(message), { code }); }
function host(t, injectedFs = fs, root = fixture(t)) {
  const routes = new Map();
  createWidgetHost(root, { fs: injectedFs }).apply({ whale: {}, webServer: { register: entry => { routes.set(entry.path, entry.handler); return () => {}; }, tapIndex: () => () => {} }, effect: () => {} });
  return { root, async request(route, method = 'GET', body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { url: route, method });
    let status = 200, result, headers;
    const res = { writeHead(value, h) { status = value; headers = h; }, end(value) { result = value; } };
    await routes.get(route.split('?')[0])(req, res);
    let payload; try { payload = JSON.parse(result); } catch {}
    return { status, headers, payload, bytes: Buffer.isBuffer(result) ? result : Buffer.from(result || '') };
  } };
}

test('settings missing, unreadable and malformed are distinct and failed reads never overwrite data', async t => {
  const root = fixture(t), file = path.join(root, '.dshw-size.json');
  const h = host(t, fs, root);
  const missing = await h.request('/dsh-whale/size.json');
  assert.equal(missing.status, 200); assert.equal(missing.payload.configured, false);
  fs.writeFileSync(file, '{broken');
  const corrupt = await h.request('/dsh-whale/size.json');
  assert.equal(corrupt.status, 500); assert.equal(corrupt.payload.ok, false); assert.match(corrupt.payload.error, /损坏/);
  const failedSave = await h.request('/dsh-whale/size.json', 'PUT', {vol:0.3});
  assert.equal(failedSave.payload.ok, false); assert.equal(fs.readFileSync(file,'utf8'), '{broken');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({scale:1.8,vol:0.7,sound:false}));
  const deniedFs = Object.create(fs); deniedFs.readFileSync = (p,...args) => {if(p===file)throw fail('synthetic permissions','EACCES');return fs.readFileSync(p,...args);};
  const denied = await host(t, deniedFs, root).request('/dsh-whale/size.json');
  assert.equal(denied.status, 500); assert.match(denied.payload.error, /不可读/);
  assert.equal(denied.payload.error.includes('synthetic permissions'),false,'do not expose raw paths or error details');
  const recovered = await h.request('/dsh-whale/size.json');
  assert.equal(recovered.payload.configured,true);assert.equal(recovered.payload.scale,1.8);assert.equal(recovered.payload.sound,false);
});
function crc(bytes) { let c = 0xffffffff; for (const n of bytes) { c ^= n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function chunk(kind, content) { const b = Buffer.alloc(content.length + 12); b.writeUInt32BE(content.length); b.write(kind, 4); content.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, b.length - 4)), b.length - 4); return b; }
function png(width = 1, height = 1, frames = 0) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pieces = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (frames) { const control = Buffer.alloc(8); control.writeUInt32BE(frames); pieces.push(chunk('acTL', control)); }
  let sequence = 0;
  const data = deflateSync(Buffer.from([0, 255, 255, 255, 255]));
  for (let frame = 0; frame < (frames || 1); frame++) {
    if (frames) { const control = Buffer.alloc(26); control.writeUInt32BE(sequence++); control.writeUInt32BE(width, 4); control.writeUInt32BE(height, 8); control.writeUInt16BE(10, 22); pieces.push(chunk('fcTL', control)); }
    if (frame === 0) pieces.push(chunk('IDAT', data));
    else { const prefix = Buffer.alloc(4); prefix.writeUInt32BE(sequence++); pieces.push(chunk('fdAT', Buffer.concat([prefix, data]))); }
  }
  pieces.push(chunk('IEND', Buffer.alloc(0))); return Buffer.concat(pieces);
}
function gif(frames = 1, width = 1, height = 1) {
  const header = Buffer.from('47494638396101000100800000000000ffffff', 'hex'); header.writeUInt16LE(width, 6); header.writeUInt16LE(height, 8);
  const frame = Buffer.from('2c0000000001000100000202440100', 'hex');
  return Buffer.concat([header, ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
}
function wav(seconds = 1) {
  const bytes = Buffer.alloc(44 + 8000 * 2 * seconds); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}
const imageUrl = bytes => 'data:image/png;base64,' + bytes.toString('base64');
const jpegFixture = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDk6KKK908g/9k=';
const webpFixture = 'UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoCAAMAAUAmJaACdLoAA5gA/vD6K/8Q50OdDmYz/uNbc/WIAAA=';

test('project API origin cannot authorize reuse of global or environment credentials', t => {
  const root = fixture(t), project = path.join(root, 'project'); fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.toml'), 'model_provider="openai"\n[model_providers.openai]\nbase_url="https://api.openai.com/v1"\n');
  fs.writeFileSync(path.join(project, '.codex', 'config.toml'), '[model_providers.openai]\nbase_url="https://untrusted.example.test/v1"\nenv_key="GLOBAL_KEY"\n');
  const c = new ConfigStore({ codexHome: root, dataDir: path.join(root, 'data'), env: { OPENAI_API_KEY: 'GLOBAL_TEST_CANARY', GLOBAL_KEY: 'GLOBAL_TEST_CANARY', PROJECT_KEY: 'PROJECT_TEST_CANARY' } });
  c.save({ projectDir: project }); assert.throws(() => c.resolve(), /项目配置更换 API 域名/);
  c.save({ keyEnv: 'PROJECT_KEY' }); const resolved = c.resolve();
  assert.equal(resolved.baseUrl, 'https://untrusted.example.test/v1'); assert.equal(resolved.key, 'PROJECT_TEST_CANARY');
  assert.equal(JSON.stringify(c.publicInfo()).includes('PROJECT_TEST_CANARY'), false);
  assert.equal(fs.readFileSync(c.file, 'utf8').includes('PROJECT_TEST_CANARY'), false);
});

test('same-origin project settings and trusted user profiles remain usable', t => {
  const root = fixture(t), project = path.join(root, 'project'); fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.toml'), 'model_provider="a"\n[model_providers.a]\nbase_url="https://a.example.test/v1"\n[model_providers.b]\nbase_url="https://b.example.test/v1"\nenv_key="B_KEY"\n[profiles.work]\nmodel_provider="b"\n');
  fs.writeFileSync(path.join(project, '.codex', 'config.toml'), 'model="changed-model"\n');
  const c = new ConfigStore({ codexHome: root, dataDir: path.join(root, 'data'), env: { B_KEY: 'TEST_VALUE' } });
  c.save({ projectDir: project, profile: 'work' }); assert.equal(c.resolve().baseUrl, 'https://b.example.test/v1'); assert.equal(c.resolve().model, 'changed-model');
});

test('provider byte limit cancels an oversized chunked body before reading its tail', async () => {
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(128)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await assert.rejects(readBoundedJsonText(new Response(stream), 200), error => error.code === 'SHAPE');
  assert.equal(cancelled, true); assert.equal(pulls, 2);
  let lengthCancelled = false;
  const declared = new Response(new ReadableStream({ cancel() { lengthCancelled = true; } }), { headers: { 'Content-Length': '201' } });
  await assert.rejects(readBoundedJsonText(declared, 200), /响应过大/); assert.equal(lengthCancelled, true);
});

test('provider streaming counts bytes and safely reports body network failures', async () => {
  const body = Buffer.from('{"text":"鲸鱼"}');
  const pieces = [body.subarray(0, 12), body.subarray(12)];
  const stream = new ReadableStream({ pull(c) { pieces.length ? c.enqueue(pieces.shift()) : c.close(); } });
  assert.equal(JSON.parse(await readBoundedJsonText(new Response(stream))).text, '鲸鱼');
  const provider = new BalanceProvider({ fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.error(new Error('raw secret-like server message')); } }), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(provider.json('https://example.test', 'TEST_ONLY'), error => error.code === 'NETWORK' && !error.message.includes('raw secret'));
});

test('real PNG, APNG, GIF and WAV metadata are validated without decoding pixels', () => {
  assert.equal(validateImage(png()).format, 'png');
  assert.equal(validateImage(png(1, 1, 2)).frames, 2);
  assert.equal(validateImage(gif(4)).frames, 4);
  assert.equal(validateWav(wav(2)).duration, 2);
  assert.equal(validateImage(png(1, 1, 2), { mime: 'image/png' }).format, 'apng');
  assert.throws(() => validateImage(png(), { mime: 'image/gif' }), /不一致/);
});

test('JPEG and WebP imports retain their actual format and response MIME', async t => {
  const app = host(t);
  for (const [mime, encoded, extension] of [['image/jpeg', jpegFixture, 'jpg'], ['image/webp', webpFixture, 'webp']]) {
    const bytes = Buffer.from(encoded, 'base64'), metadata = validateImage(bytes, { mime });
    assert.equal(metadata.width, 2); assert.equal(metadata.height, 3);
    const uploaded = await app.request('/dsh-whale/roles.json', 'POST', { name: mime, image: 'data:' + mime + ';base64,' + encoded });
    assert.equal(uploaded.payload.ok, true);
    const role = uploaded.payload.roles.find(item => item.name === mime);
    assert.ok(fs.existsSync(path.join(app.root, 'whale-roles', role.id + '.' + extension)));
    const response = await app.request('/dsh-whale/role-image.png?id=' + role.id);
    assert.equal(response.headers['Content-Type'], mime); assert.deepEqual(response.bytes, bytes);
  }
});

test('malformed headers and oversized dimensions, frames and audio are rejected', () => {
  const broken = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 255, 255, 244, 116, 69, 88, 116]);
  assert.throws(() => validateImage(broken), /PNG/);
  assert.throws(() => validateImage(Buffer.alloc(64, 65)), /有效/);
  const checksum = png(); checksum[40] ^= 1; assert.throws(() => validateImage(checksum), /校验/);
  assert.throws(() => validateImage(png(4097, 1)), /过大/);
  assert.throws(() => validateImage(gif(601)), /动图解码量/);
  assert.throws(() => validateImage(png(1024, 1024, 123)), /动图解码量/);
  assert.throws(() => validateWav(wav(121)), /120 秒/);
  const invalidRate = wav(); invalidRate.writeUInt32LE(1, 28); assert.throws(() => validateWav(invalidRate), /速率/);
  assert.throws(() => decodeMediaDataUrl('data:image/png;base64,' + 'A'.repeat(12), ['image/png'], 4), /过大/);
});

test('upload refuses non-image bytes without creating an index or asset', async t => {
  const app = host(t), result = await app.request('/dsh-whale/roles.json', 'POST', { name: 'bad', image: imageUrl(Buffer.alloc(64, 65)) });
  assert.equal(result.payload.ok, false); assert.equal(result.status, 400);
  assert.equal(fs.existsSync(path.join(app.root, 'whale-roles', 'roles.json')), false);
});

test('corrupt role, audio, image and bubble indexes remain untouched and readable defaults survive', async t => {
  const root = fixture(t), app = host(t, fs, root);
  const cases = [
    ['whale-roles/roles.json', '/dsh-whale/roles.json', { image: imageUrl(png()) }, 'roles'],
    ['whale-audio/audio.json', '/dsh-whale/audio.json', { action: 'save-group', name: 'sample' }, 'groups'],
    ['whale-bubble-imgs/bubble-imgs.json', '/dsh-whale/bubble-img-upload.json', { action: 'upload', data: imageUrl(png()) }, 'images'],
    ['.dshw-bubble.json', '/dsh-whale/bubble.json', { items: [], lib: [] }, 'config'],
  ];
  for (const [relative, route, body] of cases) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{broken');
    const write = await app.request(route, 'POST', body); assert.equal(write.payload.ok, false); assert.match(write.payload.error, /损坏/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    const read = await app.request(route === '/dsh-whale/bubble-img-upload.json' ? '/dsh-whale/bubble-imgs.json' : route);
    assert.equal(read.payload.ok, true); assert.equal(read.payload.editable, false); assert.match(read.payload.warning, /损坏/);
  }
  assert.equal((await app.request('/dsh-whale/image.png')).status, 200);
});

test('ENOSPC reports failure for bubble settings and pinning while retaining old JSON', async t => {
  const root = fixture(t), dir = path.join(root, 'whale-roles'); fs.mkdirSync(dir);
  const roleFile = path.join(dir, 'roles.json'), bubbleFile = path.join(root, '.dshw-bubble.json');
  const roles = JSON.stringify({ roles: [{ id: 'default', name: 'whale', pinnedAt: 1 }] });
  const bubble = JSON.stringify({ v: 1, items: [], lib: [] }); fs.writeFileSync(roleFile, roles); fs.writeFileSync(bubbleFile, bubble);
  const failingFs = Object.create(fs); failingFs.writeFileSync = (file, ...args) => { if (String(file).endsWith('.tmp')) throw fail(); return fs.writeFileSync(file, ...args); };
  const app = host(t, failingFs, root);
  const saved = await app.request('/dsh-whale/bubble.json', 'PUT', { items: [{ kind: 'custom' }], lib: [] }); assert.equal(saved.payload.ok, false);
  const pinned = await app.request('/dsh-whale/role-pin.json', 'POST', { id: 'default', pinned: true }); assert.equal(pinned.payload.ok, false);
  assert.equal(fs.readFileSync(roleFile, 'utf8'), roles); assert.equal(fs.readFileSync(bubbleFile, 'utf8'), bubble);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
});

test('failed import index commit removes only the new asset and preserves existing assets', async t => {
  const root = fixture(t), dir = path.join(root, 'whale-roles'); fs.mkdirSync(dir);
  const original = JSON.stringify({ roles: [{ id: 'default', name: 'whale' }] }); fs.writeFileSync(path.join(dir, 'roles.json'), original);
  const failingFs = Object.create(fs); failingFs.renameSync = (from, to) => { if (String(to) === path.join(dir, 'roles.json')) throw fail(); return fs.renameSync(from, to); };
  const result = await host(t, failingFs, root).request('/dsh-whale/roles.json', 'POST', { name: 'new', image: imageUrl(png()) });
  assert.equal(result.payload.ok, false); assert.equal(fs.readFileSync(path.join(dir, 'roles.json'), 'utf8'), original);
  assert.equal(fs.readdirSync(dir).filter(file => file.endsWith('.png')).length, 0);
});

test('audio and bubble-gallery saves propagate ENOSPC without changing previous indexes', async t => {
  for (const [dirName, indexName, previous, route, body] of [
    ['whale-audio', 'audio.json', { groups: [], fragments: [] }, '/dsh-whale/audio.json', { action: 'upload-fragment', audio: 'data:audio/wav;base64,' + wav().toString('base64') }],
    ['whale-audio', 'audio.json', { groups: [], fragments: [] }, '/dsh-whale/audio.json', { action: 'save-group', name: 'sample' }],
    ['whale-bubble-imgs', 'bubble-imgs.json', { images: [] }, '/dsh-whale/bubble-img-upload.json', { action: 'upload', data: imageUrl(png()) }],
  ]) {
    const root = fixture(t), dir = path.join(root, dirName), index = path.join(dir, indexName); fs.mkdirSync(dir); fs.writeFileSync(index, JSON.stringify(previous));
    const failingFs = Object.create(fs); failingFs.renameSync = (from, to) => { if (to === index) throw fail(); return fs.renameSync(from, to); };
    const result = await host(t, failingFs, root).request(route, 'POST', body);
    assert.equal(result.payload.ok, false); assert.match(result.payload.error, /保存失败/);
    assert.deepEqual(JSON.parse(fs.readFileSync(index, 'utf8')), previous);
    assert.equal(fs.readdirSync(dir).some(name => /\.(png|gif|wav)$/.test(name)), false);
  }
});

test('delete rollback restores the asset and index on both commit and file-removal failures', async t => {
  for (const failure of ['commit', 'unlink']) {
    const root = fixture(t), normal = host(t, fs, root);
    const uploaded = await normal.request('/dsh-whale/roles.json', 'POST', { name: 'kept', image: imageUrl(png()) });
    const id = uploaded.payload.roles.find(role => role.name === 'kept').id;
    const dir = path.join(root, 'whale-roles'), indexFile = path.join(dir, 'roles.json');
    const original = fs.readFileSync(indexFile, 'utf8'); const failingFs = Object.create(fs); let failed = false;
    failingFs.renameSync = (from, to) => { if (!failed && failure === 'commit' && to === indexFile) { failed = true; throw fail(); } return fs.renameSync(from, to); };
    failingFs.unlinkSync = file => { if (!failed && failure === 'unlink' && String(file).endsWith('.delete-pending')) { failed = true; throw fail('test access denied', 'EACCES'); } return fs.unlinkSync(file); };
    const result = await host(t, failingFs, root).request('/dsh-whale/role-delete.json', 'POST', { id });
    assert.equal(result.payload.ok, false); assert.deepEqual(JSON.parse(fs.readFileSync(indexFile, 'utf8')), JSON.parse(original));
    assert.deepEqual(fs.readFileSync(path.join(dir, id + '.png')), png());
    assert.equal(fs.readdirSync(dir).some(file => file.endsWith('.delete-pending')), false);
  }
});

test('gallery traversal and outside-root symlinks cannot read or delete files', async t => {
  const root = fixture(t), dir = path.join(root, 'whale-bubble-imgs'); fs.mkdirSync(dir);
  const victim = path.join(root, 'keep.png'); fs.writeFileSync(victim, png());
  fs.writeFileSync(path.join(dir, 'bubble-imgs.json'), JSON.stringify({ images: [{ id: '../keep', format: 'png' }] }));
  const app = host(t, fs, root);
  assert.equal((await app.request('/dsh-whale/bubble-img.png?id=..%2Fkeep')).status, 404);
  assert.equal((await app.request('/dsh-whale/bubble-img-upload.json', 'POST', { action: 'delete', id: '../keep' })).payload.ok, false);
  assert.equal(fs.existsSync(victim), true);
  assert.throws(() => resourcePath(root, dir, '../keep', 'png'), /编号/);
  const outside = fixture(t), link = path.join(root, 'linked'); fs.symlinkSync(outside, link, 'junction');
  assert.throws(() => resourcePath(root, link, 'test', 'png'), /之外/);
  fs.unlinkSync(link);
});

test('per-library count and cumulative disk budget block only additional imports', t => {
  const root = fixture(t), dir = path.join(root, 'whale-roles'); fs.mkdirSync(dir); const file = path.join(dir, 'old.png'); fs.writeFileSync(file, png());
  assert.throws(() => checkMediaBudget(root, 1, MEDIA_POLICY.maxItemsPerLibrary), /最多 256 项/);
  const budgetFs = Object.create(fs); budgetFs.statSync = p => p === file ? { size: MEDIA_POLICY.maxStorageBytes } : fs.statSync(p);
  assert.throws(() => checkMediaBudget(root, 1, 1, { fs: budgetFs }), /总空间/);
  assert.deepEqual(fs.readFileSync(file), png());
});

test('atomic index write keeps a complete .bak and cleans failed rename temporaries', t => {
  const root = fixture(t), file = path.join(root, 'index.json'); fs.writeFileSync(file, '{"old":true}');
  atomicResourceWrite(file, '{"new":true}', { backup: true }); assert.equal(fs.readFileSync(file + '.bak', 'utf8'), '{"old":true}');
  const failingFs = Object.create(fs); failingFs.renameSync = () => { throw fail(); };
  assert.throws(() => atomicResourceWrite(file, '{"third":true}', { fs: failingFs }), /保存失败/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"new":true}'); assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
});
