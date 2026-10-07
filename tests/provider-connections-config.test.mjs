import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConfigStore, DEFAULT_CONFIG, validateConfig } from '../runtime/config.mjs';

const providers = `model_provider="a"
[model_providers.a]
base_url="https://a.example.test/tenant/v1"
env_key="A_KEY"
[model_providers.b]
base_url="https://b.example.test/v1"
env_key="B_KEY"
[profiles.work]
model_provider="b"
model="original-model"
`;
function fixture(t, toml = providers, env = { A_KEY: 'FAKE_A', B_KEY: 'FAKE_B' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-connections-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('whale-connections-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'config.toml'), toml);
  return new ConfigStore({ codexHome: root, dataDir: path.join(root, 'data'), env });
}
function project(config, toml) {
  const projectDir = path.join(config.codexHome, 'project');
  fs.mkdirSync(path.join(projectDir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.codex', 'config.toml'), toml);
  config.save({ projectDir });
  return projectDir;
}
function record(id = 'wallet-a', patch = {}) {
  return { id, name: '测试钱包', match: { providerId: 'a', profile: '' }, baseUrl: 'https://a.example.test/tenant/v1',
    keyEnv: '', balance: { adapter: 'custom-json', request: { url: '/wallet' }, mapping: { balanceField: 'wallet.remaining', currency: 'CNY', confirmed: true } }, ...patch };
}

test('project partial profile and provider tables preserve trusted provider and credentials', t => {
  const config = fixture(t);
  project(config, '[profiles.work]\nmodel="project-model"\n[model_providers.b]\nbase_url="https://b.example.test/v1"\n');
  config.save({ profile: 'work' });
  const resolved = config.resolve();
  assert.equal(resolved.id, 'b'); assert.equal(resolved.model, 'project-model'); assert.equal(resolved.key, 'FAKE_B');
  assert.equal(resolved.baseUrl, 'https://b.example.test/v1');
  assert.match(resolved.connectionInfo.sourceLabel, /已读取.*CLI/);
});

test('unknown and incomplete providers fail without reading the global key', t => {
  for (const toml of ['model_provider="missing"\n', 'model_provider="empty"\n[model_providers.empty]\nname="Empty"\n']) {
    let reads = 0;
    const env = Object.defineProperty({}, 'OPENAI_API_KEY', { get() { reads++; return 'DO_NOT_USE'; } });
    const config = fixture(t, toml, env);
    assert.throws(() => config.resolve(), /不会回退/); assert.equal(reads, 0);
  }
});

test('project cannot introduce a new environment reference even on the same origin', t => {
  let reads = 0;
  const env = Object.defineProperty({ A_KEY: 'FAKE_A' }, 'NEW_SECRET', { get() { reads++; return 'DO_NOT_READ'; } });
  const config = fixture(t, providers, env);
  project(config, '[model_providers.a]\nenv_key="NEW_SECRET"\n');
  assert.throws(() => config.resolve(), /不能新增或改变/); assert.equal(reads, 0);
});

test('trusted provider headers are retained, and project cannot add environment headers', t => {
  const config = fixture(t, providers + '[model_providers.a.http_headers]\nX-Route="east"\n[model_providers.a.env_http_headers]\nX-Api-Key="HEADER_KEY"\n', { A_KEY: 'FAKE_A', HEADER_KEY: 'FAKE_HEADER' });
  assert.deepEqual(config.resolve().authHeaders, { 'X-Route': 'east', 'X-Api-Key': 'FAKE_HEADER' });
  project(config, '[model_providers.a.env_http_headers]\nX-Other="UNRELATED_SECRET"\n');
  assert.throws(() => config.resolve(), /不能新增或改变/);
});

test('unsafe trusted transport headers and CRLF values are rejected', t => {
  for (const toml of ['[model_providers.a.http_headers]\nHost="other.example.test"\n', '[model_providers.a.env_http_headers]\nX-Route="BAD_HEADER"\n']) {
    const config = fixture(t, providers + toml, { A_KEY: 'FAKE_A', BAD_HEADER: 'a\r\nInjected: true' });
    assert.throws(() => config.resolve(), /请求头/);
  }
});

test('follow matches exact provider and profile, switches complete connections, and keeps legacy fields out', t => {
  const config = fixture(t);
  config.save({ baseUrl: 'https://legacy.example.test/v1', keyEnv: 'LEGACY_KEY' });
  config.save({ connections: [record(), record('wallet-b', { match: { providerId: 'b', profile: 'work' }, baseUrl: 'https://b.example.test/v1', keyEnv: 'B_KEY' })] });
  const first = config.resolve();
  assert.equal(first.connectionId, 'wallet-a'); assert.equal(first.key, 'FAKE_A'); assert.equal(first.baseUrl, 'https://a.example.test/tenant/v1');
  config.save({ profile: 'work' });
  const second = config.resolve();
  assert.equal(second.connectionId, 'wallet-b'); assert.equal(second.key, 'FAKE_B'); assert.equal(second.setting.currency, 'CNY');
  assert.notEqual(first.accountId, second.accountId);
});

test('follow rejects ambiguous and stale source bindings', t => {
  const config = fixture(t);
  config.save({ connections: [record(), record('duplicate')] });
  assert.throws(() => config.resolve(), /多个余额连接/);
  config.save({ connections: [record('stale', { baseUrl: 'https://a.example.test/different/v1' })] });
  assert.throws(() => config.resolve(), /绑定的 API 地址/);
});

test('fixed connection remains independent of unknown active provider and provider secrets', t => {
  let reads = 0;
  const env = Object.defineProperty({ FIXED_KEY: 'FIXED_FAKE', BALANCE_KEY: 'WALLET_FAKE' }, 'OPENAI_API_KEY', { get() { reads++; throw new Error('not selected'); } });
  const config = fixture(t, 'model_provider="does-not-exist"\n', env);
  config.save({ connectionMode: 'fixed', selectedConnection: 'fixed', connectionUpdate: { id: 'fixed', value: record('fixed', {
    baseUrl: 'https://fixed.example.test/v1', keyEnv: 'FIXED_KEY', balance: { adapter: 'custom-json', request: { url: 'https://billing.example.test/wallet', auth: { type: 'bearer', keyEnv: 'BALANCE_KEY' } } },
  }) } });
  const result = config.resolve();
  assert.equal(result.baseUrl, 'https://fixed.example.test/v1'); assert.equal(result.key, 'FIXED_FAKE');
  assert.deepEqual(result.authHeaders, {}); assert.deepEqual(result.balanceSecrets, { BALANCE_KEY: 'WALLET_FAKE' }); assert.equal(reads, 0);
  assert.equal(result.connectionInfo.source, 'fixed');
});

test('connection secrets resolve only declared environment references and rotate account identity', t => {
  let unrelatedReads = 0;
  const env = Object.defineProperty({ A_KEY: 'FAKE_A', BILLING: 'BILL_FAKE', QUERY_SECRET: 'Q_FAKE' }, 'UNRELATED', { get() { unrelatedReads++; throw new Error('not selected'); } });
  const config = fixture(t, providers, env);
  config.save({ connections: [record('wallet', { balance: { adapter: 'custom-json', request: { url: '/balance', auth: { type: 'bearer', keyEnv: 'BILLING' }, envQuery: { account: 'QUERY_SECRET' } } } })] });
  const before = config.resolve();
  assert.deepEqual(before.balanceSecrets, { BILLING: 'BILL_FAKE', QUERY_SECRET: 'Q_FAKE' }); assert.equal(unrelatedReads, 0);
  env.BILLING = 'BILL_ROTATED';
  assert.notEqual(config.resolve().accountId, before.accountId);
});

test('project origin change requires an explicit connection endpoint and dedicated key', t => {
  const config = fixture(t, providers, { A_KEY: 'FAKE_A', PROJECT_KEY: 'PROJECT_FAKE' });
  project(config, '[model_providers.a]\nbase_url="https://project.example.test/v1"\n');
  config.save({ connections: [record('project', { baseUrl: '', keyEnv: 'PROJECT_KEY' })] });
  assert.throws(() => config.resolve(), /项目配置更换 API 域名/);
  config.save({ connectionUpdate: { id: 'project', value: { baseUrl: 'https://project.example.test/v1' } } });
  const resolved = config.resolve();
  assert.equal(resolved.key, 'PROJECT_FAKE'); assert.deepEqual(resolved.authHeaders, {});
});

test('legacy overrides bind at explicit save and cannot follow a different profile', t => {
  const config = fixture(t, providers, { A_KEY: 'FAKE_A', B_KEY: 'FAKE_B', MANUAL_KEY: 'MANUAL_FAKE' });
  config.save({ baseUrl: 'https://manual.example.test/v1', keyEnv: 'MANUAL_KEY' });
  assert.equal(config.resolve().key, 'MANUAL_FAKE');
  config.save({ profile: 'work' });
  assert.throws(() => config.resolve(), /来源已经改变/);
  assert.throws(() => config.save({ keyEnv: 'B_KEY' }), /同时确认/);
  config.save({ baseUrl: '', keyEnv: '' }); assert.equal(config.resolve().key, 'FAKE_B');
});

test('preexisting unbound legacy overrides require explicit confirmation and legacy hash stays stable', t => {
  const config = fixture(t);
  const first = config.resolve();
  assert.equal(first.accountId, crypto.createHash('sha256').update(first.baseUrl + '\0' + first.key).digest('hex').slice(0, 24));
  fs.mkdirSync(config.dataDir); fs.writeFileSync(config.file, JSON.stringify({ ...DEFAULT_CONFIG, keyEnv: 'A_KEY' }));
  assert.throws(() => config.resolve(), /尚未绑定来源/);
  config.save({ baseUrl: '', keyEnv: 'A_KEY' }); assert.equal(config.resolve().accountId, first.accountId);
});

test('unbound legacy migration cannot pair a newly entered key with an old destination', t => {
  const config = fixture(t);
  fs.mkdirSync(config.dataDir);
  fs.writeFileSync(config.file, JSON.stringify({ ...DEFAULT_CONFIG, profile: 'work', baseUrl: 'https://a.example.test/v1', keyEnv: 'A_KEY' }));
  const original = fs.readFileSync(config.file, 'utf8');
  assert.throws(() => config.save({ keyEnv: 'B_KEY' }), /同时确认/);
  assert.throws(() => config.resolveDraft({ baseUrl: 'https://b.example.test/v1' }), /同时确认/);
  assert.equal(fs.readFileSync(config.file, 'utf8'), original);
  config.save({ baseUrl: 'https://b.example.test/v1', keyEnv: 'B_KEY' });
  const resolved = config.resolve();
  assert.equal(resolved.baseUrl, 'https://b.example.test/v1'); assert.equal(resolved.key, 'FAKE_B');
});

test('unbound overrides can be explicitly cleared together without resolving an invalid source', t => {
  const config = fixture(t, 'model_provider="missing"\n');
  fs.mkdirSync(config.dataDir);
  fs.writeFileSync(config.file, JSON.stringify({ ...DEFAULT_CONFIG, baseUrl: 'https://old.example.test/v1', keyEnv: 'OLD_KEY' }));
  config.save({ currency: 'CNY' });
  assert.equal(config.load().legacyConnectionBinding, null);
  assert.throws(() => config.save({ keyEnv: '' }), /同时确认/);
  config.save({ baseUrl: '', keyEnv: '' });
  assert.equal(config.load().baseUrl, ''); assert.equal(config.load().keyEnv, ''); assert.equal(config.load().legacyConnectionBinding, null);
});

test('legacy header credentials rotate account identity and header case/order do not', t => {
  const toml = 'model_provider="headers"\n[model_providers.headers]\nbase_url="https://headers.example.test/v1"\n[model_providers.headers.env_http_headers]\nX-Api-Key="HEADER_KEY"\nX-Tenant="TENANT"\n';
  const config = fixture(t, toml, { HEADER_KEY: 'HEADER_A', TENANT: 'TENANT_A' });
  const first = config.resolve(); assert.equal(first.key, '');
  config.env.HEADER_KEY = 'HEADER_B';
  const rotated = config.resolve(); assert.notEqual(rotated.accountId, first.accountId);
  assert.deepEqual(rotated.authHeaders, { 'X-Api-Key': 'HEADER_B', 'X-Tenant': 'TENANT_A' });
  fs.writeFileSync(path.join(config.codexHome, 'config.toml'), toml.replace('X-Api-Key="HEADER_KEY"\nX-Tenant="TENANT"', 'x-tenant="TENANT"\nx-api-key="HEADER_KEY"'));
  assert.equal(config.resolve().accountId, rotated.accountId);
});

test('project tenant path changes cannot inherit trusted key or header secrets', t => {
  let reads = 0;
  const env = Object.defineProperties({ PROJECT_KEY: 'PROJECT_ONLY' }, {
    A_KEY: { get() { reads++; return 'TRUSTED_ONLY'; } }, HEADER_KEY: { get() { reads++; return 'HEADER_ONLY'; } },
  });
  const config = fixture(t, providers + '[model_providers.a.env_http_headers]\nX-Api-Key="HEADER_KEY"\n', env);
  project(config, '[model_providers.a]\nbase_url="https://a.example.test/other-tenant/v1"\n');
  assert.throws(() => config.resolve(), /项目配置更换 API .*路径/); assert.equal(reads, 0);
  config.save({ keyEnv: 'PROJECT_KEY' });
  const resolved = config.resolve();
  assert.equal(resolved.baseUrl, 'https://a.example.test/other-tenant/v1');
  assert.equal(resolved.key, 'PROJECT_ONLY'); assert.deepEqual(resolved.authHeaders, {}); assert.equal(reads, 0);
});

test('project model-only and equivalent base updates still inherit the trusted connection', t => {
  const config = fixture(t);
  project(config, 'model="project-model"\n[model_providers.a]\nbase_url="https://a.example.test/tenant/v1/"\n');
  const resolved = config.resolve();
  assert.equal(resolved.model, 'project-model'); assert.equal(resolved.key, 'FAKE_A');
  assert.equal(resolved.baseUrl, 'https://a.example.test/tenant/v1');
});

test('changing connection match clears confirmation unless explicitly reconfirmed', t => {
  const config = fixture(t); config.save({ connections: [record()] });
  config.save({ connectionUpdate: { id: 'wallet-a', value: { match: { profile: 'work' } } } });
  assert.equal(config.readConnection('wallet-a').balance.mapping.confirmed, false);
  config.save({ connectionUpdate: { id: 'wallet-a', value: { match: { providerId: 'b' }, balance: { mapping: { confirmed: true } } } } });
  assert.equal(config.readConnection('wallet-a').balance.mapping.confirmed, true);
  config.save({ connectionUpdate: { id: 'wallet-a', value: { name: 'Display name only' } } });
  assert.equal(config.readConnection('wallet-a').balance.mapping.confirmed, true);
});

test('draft previews merge records without creating or changing settings', t => {
  const config = fixture(t);
  const draft = { connectionUpdate: { id: 'draft', value: record('draft') } };
  assert.equal(config.resolveDraft(draft).connectionId, 'draft'); assert.equal(fs.existsSync(config.file), false);
  config.save(draft); const saved = fs.readFileSync(config.file, 'utf8');
  const preview = config.resolveDraft({ connectionUpdate: { id: 'draft', value: { balance: { mapping: { currency: 'EUR' } } } } });
  assert.equal(preview.balanceConnection.mapping.currency, 'EUR'); assert.equal(preview.balanceConnection.request.url, '/wallet');
  assert.equal(fs.readFileSync(config.file, 'utf8'), saved);
});

test('request map edits can clear headers without erasing sibling protocol fields', t => {
  const config = fixture(t);
  config.save({ connections: [record('wallet', { balance: { adapter: 'custom-json', request: { url: '/wallet', headers: { 'X-Route': 'east' }, envHeaders: { 'X-Api-Key': 'HEADER_KEY' }, query: { account: 'demo' } } } })] });
  config.save({ connectionUpdate: { id: 'wallet', value: { balance: { request: { headers: {}, envHeaders: {}, query: {} } } } } });
  const saved = config.readConnection('wallet');
  assert.equal(saved.balance.request.url, '/wallet');
  assert.deepEqual(saved.balance.request.headers, {}); assert.deepEqual(saved.balance.request.envHeaders, {}); assert.deepEqual(saved.balance.request.query, {});
});

test('mapping and unused inference credentials do not change the wallet account identity', t => {
  const config = fixture(t, providers, { A_KEY: 'FAKE_A', BALANCE_KEY: 'WALLET_KEY' });
  config.save({ connections: [record('wallet', { balance: { adapter: 'custom-json', request: { url: '/wallet', auth: { type: 'bearer', keyEnv: 'BALANCE_KEY' } } } })] });
  const before = config.resolve().accountId;
  config.save({ connectionUpdate: { id: 'wallet', value: { balance: { mapping: { currency: 'EUR', balanceScale: 0.01, confirmed: true } } } } });
  assert.equal(config.resolve().accountId, before);
  config.env.A_KEY = 'FAKE_A_ROTATED'; assert.equal(config.resolve().accountId, before);
  config.env.BALANCE_KEY = 'WALLET_KEY_ROTATED'; assert.notEqual(config.resolve().accountId, before);
});

test('explicit connection keys do not inherit an old provider Authorization header', t => {
  const config = fixture(t, providers + '[model_providers.a.http_headers]\nAuthorization="Bearer OLD_FAKE_KEY"\n', { A_KEY: 'FAKE_A', MANUAL_KEY: 'MANUAL_FAKE' });
  config.save({ connections: [record('wallet', { keyEnv: 'MANUAL_KEY' })] });
  const resolved = config.resolve(); assert.equal(resolved.key, 'MANUAL_FAKE'); assert.deepEqual(resolved.authHeaders, {});
});

test('fixed dedicated balance authentication does not require an inference API key', t => {
  const config = fixture(t, 'model_provider="unknown"\n', { BILLING_KEY: 'FAKE_BILLING' });
  config.save({ connectionMode: 'fixed', selectedConnection: 'wallet', connections: [record('wallet', { keyEnv: '', balance: { adapter: 'custom-json', request: { url: '/wallet', auth: { type: 'header', header: 'X-Wallet-Key', keyEnv: 'BILLING_KEY' } } } })] });
  const resolved = config.resolve(); assert.equal(resolved.key, ''); assert.equal(resolved.balanceSecrets.BILLING_KEY, 'FAKE_BILLING');
  assert.equal(config.publicInfo().hasKey, true);
});

test('dedicated follow credentials require a source URL binding before any secret reads', t => {
  let reads = 0;
  const env = Object.defineProperty({}, 'PRIVATE_KEY', { get() { reads++; return 'UNREAD_FAKE'; } });
  const config = fixture(t, providers, env);
  config.save({ connections: [record('wallet', { baseUrl: '', keyEnv: 'PRIVATE_KEY' })] });
  assert.throws(() => config.resolve(), /须明确绑定 API 地址/); assert.equal(reads, 0);
});

test('explicitly bound project balance credentials do not need the provider inference key', t => {
  const config = fixture(t, providers, { BALANCE_KEY: 'FAKE_BALANCE' });
  project(config, '[model_providers.a]\nbase_url="https://project.example.test/v1"\nenv_key="DO_NOT_READ"\n');
  config.save({ connections: [record('wallet', { baseUrl: 'https://project.example.test/v1', balance: { adapter: 'custom-json', request: { url: '/wallet', auth: { type: 'bearer', keyEnv: 'BALANCE_KEY' } } } })] });
  const resolved = config.resolve(); assert.equal(resolved.key, ''); assert.equal(resolved.balanceSecrets.BALANCE_KEY, 'FAKE_BALANCE');
});

test('changing a previously confirmed request or mapping requires a fresh explicit confirmation', t => {
  const config = fixture(t); config.save({ connections: [record()] });
  assert.equal(config.readConnection('wallet-a').balance.mapping.confirmed, true);
  config.save({ connectionUpdate: { id: 'wallet-a', value: { balance: { mapping: { balanceScale: 0.01 } } } } });
  assert.equal(config.readConnection('wallet-a').balance.mapping.confirmed, false);
  config.save({ connectionUpdate: { id: 'wallet-a', value: { balance: { mapping: { confirmed: true } } } } });
  config.save({ connectionUpdate: { id: 'wallet-a', value: { name: '改名' } } });
  assert.equal(config.readConnection('wallet-a').balance.mapping.confirmed, true);
  config.save({ connectionUpdate: { id: 'wallet-a', value: { balance: { request: { url: '/new-wallet' } } } } });
  assert.equal(config.readConnection('wallet-a').balance.mapping.confirmed, false);
});

test('settings summaries omit endpoint and env references while explicit edit returns a secret-free copy', t => {
  const config = fixture(t, providers, { A_KEY: 'FAKE_A', PRIVATE_ENV_REFERENCE: 'PRIVATE_RESOLVED_SECRET' });
  config.save({ connections: [record('private', { keyEnv: 'PRIVATE_ENV_REFERENCE', balance: { adapter: 'custom-json', request: { url: '/PRIVATE_ENDPOINT' } } })] });
  const safe = JSON.stringify(config.publicInfo());
  assert.doesNotMatch(safe, /PRIVATE_ENV_REFERENCE|PRIVATE_RESOLVED_SECRET|PRIVATE_ENDPOINT|example\.test/);
  assert.equal(Object.hasOwn(config.settingsInfo().settings, 'connections'), false);
  const edit = config.readConnection('private'); assert.equal(edit.keyEnv, 'PRIVATE_ENV_REFERENCE');
  assert.doesNotMatch(JSON.stringify(edit), /PRIVATE_RESOLVED_SECRET/);
  edit.name = 'external mutation'; assert.equal(config.readConnection('private').name, '测试钱包');
});

test('invalid connection writes preserve the original settings and enforce stable IDs and limits', t => {
  const config = fixture(t); config.save({ connections: [record()] });
  const original = fs.readFileSync(config.file, 'utf8');
  for (const patch of [
    { connectionUpdate: { id: 'wallet-a', value: { id: 'changed-id' } } },
    { connectionUpdate: { id: 'wallet-a', value: { apiKey: 'DO_NOT_STORE' } } },
    { connectionUpdate: { id: 'wallet-a', value: { balance: { request: { headers: { Authorization: 'DO_NOT_STORE' } } } } } },
    { connections: Array.from({ length: 65 }, (_, i) => record('w' + i)) },
    JSON.parse('{"connectionUpdate":{"id":"wallet-a","value":{"__proto__":{"polluted":true}}}}'),
  ]) {
    assert.throws(() => config.save(patch)); assert.equal(fs.readFileSync(config.file, 'utf8'), original);
  }
  assert.equal({}.polluted, undefined);
  assert.throws(() => validateConfig({ connections: [record('bad/id')] }), /编号/);
});

test('selected fixed connections require explicit replacement before deletion', t => {
  const config = fixture(t);
  config.save({ connections: [record()], connectionMode: 'fixed', selectedConnection: 'wallet-a' });
  assert.throws(() => config.save({ connectionDelete: 'wallet-a' }), /先切换/);
  config.save({ connectionDelete: 'wallet-a', connectionMode: 'follow' });
  assert.deepEqual(config.load().connections, []); assert.equal(config.load().selectedConnection, '');
});

test('legacy safe query parameters survive saving while credential parameters fail before persistence', t => {
  const config = fixture(t);
  config.save({ provider: 'custom-json', balancePath: '/balance?account=demo&currency=USD', balanceField: 'data.balance' });
  assert.equal(config.load().balancePath, '/balance?account=demo&currency=USD');
  const original = fs.readFileSync(config.file, 'utf8');
  for (const balancePath of ['/balance?api_key=SYNTHETIC_INLINE', '/balance?key=SYNTHETIC_INLINE', '/balance?%61pi_key=SYNTHETIC_INLINE',
    '/balance?account=Bearer%20SYNTHETIC_INLINE', '/balance?account=sk-synthetic-credential', '/balance?__proto__=x']) {
    assert.throws(() => config.save({ balancePath }));
    assert.equal(fs.readFileSync(config.file, 'utf8'), original);
  }
});
