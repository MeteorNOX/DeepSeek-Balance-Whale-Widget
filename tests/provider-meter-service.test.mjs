import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../runtime/config.mjs';
import { WhaleService } from '../runtime/service.mjs';
import { createDispatcher } from '../runtime/dispatcher.mjs';
import { safeSample } from '../runtime/turn-journal.mjs';

const reply = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-meter-service-'));
  fs.writeFileSync(path.join(root, 'config.toml'), 'model_provider="test"\n[model_providers.test]\nbase_url="https://gateway.example.test/v1"\nenv_key="TEST_KEY"\n');
  const config = new ConfigStore({ dataDir: path.join(root, 'data'), codexHome: root, env: { TEST_KEY: 'synthetic-test-secret' } });
  const services = [], make = extra => { const service = new WhaleService({ config, ...options, ...extra }); services.push(service); return service; };
  t.after(async () => {
    for (const service of services) await service.close({ timeoutMs: 30 });
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('whale-meter-service-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, config, make };
}
const sample = (context, used, meter = 'a'.repeat(64), more = {}) => ({ ok: true, accountId: context.accountId, currency: 'USD',
  adapter: 'billing', balanceScope: 'account', balanceStatus: 'finite', canObserve: true,
  meterId: meter, counter: 'used', totalUsed: used, totalBalance: 1000 - used, ...more });

test('auto detection of a synthetic huge quota never writes a monetary ledger', async t => {
  const { config, make } = fixture(t, { fetchImpl: async url => reply(url.includes('/subscription') ? { hard_limit_usd: 100000000 } : { total_usage: 23880 }) });
  const service = make(), result = await service.getBalance({ force: true });
  assert.equal(result.balanceStatus, 'unconfirmed'); assert.equal(result.totalBalance, null);
  assert.equal(result.preview.balance, 99999761.2); assert.equal(result.todayUsage, 0);
  assert.deepEqual(service.accountNotices().notices, []);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'ledgers')), false);
});

test('actual adapter identity changes start a baseline and do not create the false 499 debit', async t => {
  let meter = 'a'.repeat(64), used = 1;
  const { make } = fixture(t, { provider: { balance: async c => sample(c, used, meter) } });
  const service = make(); await service.getBalance({ force: true });
  meter = 'b'.repeat(64); used = 500;
  assert.equal((await service.getBalance({ force: true })).todayUsage, 0);
  assert.deepEqual(service.accountNotices().notices, []);
  used = 501; assert.equal((await service.getBalance({ force: true })).todayUsage, 1);
  assert.equal(service.accountNotices().notices[0].amount, 1);
});

test('new verified meter does not subtract old unversioned observations or alter old totals', async t => {
  const { config, make } = fixture(t, { provider: { balance: async c => sample(c, 500) } });
  const service = make(), scope = service.scope(config.resolve(), 'USD');
  const prior = service.ledger.load(scope); prior.date = new Date().toLocaleDateString('en-CA');
  prior.observed = 7; prior.observedExact = '7'; prior.lastObservation = { used: 1, balance: 99999999, at: 1 };
  service.ledger.save(scope, prior);
  const result = await service.getBalance({ force: true });
  assert.equal(result.todayUsage, 7); assert.equal(service.ledger.load(scope).lastObservation.used, 500);
  assert.deepEqual(service.accountNotices().notices, []);
});

test('meter identity and unconfirmed status survive the turn journal projection', () => {
  const value = safeSample(sample({ accountId: 'a'.repeat(24) }, 3, 'b'.repeat(64), { canObserve: false, balanceStatus: 'unconfirmed', key: 'synthetic-hidden', baseUrl: 'https://hidden.example.test' }));
  assert.equal(value.canObserve, false); assert.equal(value.meterId, 'b'.repeat(64));
  assert.equal(value.counter, 'used'); assert.equal(value.balanceStatus, 'unconfirmed');
  assert.ok(!JSON.stringify(value).includes('hidden'));
});

test('turn intervals cannot cross actual adapter identities', async t => {
  let meter = 'a'.repeat(64), used = 1;
  const { make } = fixture(t, { provider: { balance: async c => sample(c, used, meter) } });
  const service = make(), turn = { id: 'fixture:turn', sessionId: 'fixture', turnId: 'turn' };
  service.beginTurn(turn); await service.turns.get(turn.id).start;
  meter = 'b'.repeat(64); used = 500;
  await service.finishTurn({ ...turn, outcome: 'completed', byModel: {}, notify: false });
  assert.equal(service.ledger.find(service.activeScope, turn).accountIntervalAmount, null);
  assert.equal(service.usageRecords().today.total, 0);
});

test('confirmed notices restore their actual meter after restart without another HTTP query', async t => {
  let used = 0;
  const { make } = fixture(t, { provider: { balance: async c => sample(c, used) } });
  const first = make(); await first.getBalance({ force: true }); used = .25; await first.getBalance({ force: true });
  const notice = first.accountNotices().notices[0]; await first.close();
  const second = make(); assert.equal(second.accountNotices().notices[0].id, notice.id);
  second.ackAccountNotices([notice.id]); assert.deepEqual(second.accountNotices().notices, []);
});

test('unconfirmed readings cannot write, issue old notices or accept their acknowledgments', async t => {
  let used = 0, confirmed = true;
  const { make } = fixture(t, { provider: { balance: async c => sample(c, used, 'a'.repeat(64), { canObserve: confirmed, balanceStatus: confirmed ? 'finite' : 'unconfirmed' }) } });
  const service = make(); await service.getBalance({ force: true }); used = .25; await service.getBalance({ force: true });
  const notice = service.accountNotices().notices[0];
  const file = service.ledger.file(service.activeScope), before = fs.readFileSync(file);
  confirmed = false; used = 500; await service.getBalance({ force: true });
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(service.accountNotices().notices, []);
  assert.throws(() => service.ackAccountNotices([notice.id]), /口径/);
});

test('preview is detached from live settings, adapter detection, ledger and notifications', async t => {
  let used = 100, calls = 0;
  const { config, make } = fixture(t, { fetchImpl: async url => { calls++; return reply(url.includes('/subscription') ? { hard_limit_usd: 100 } : { total_usage: used }); } });
  config.save({ provider: 'billing' }); const service = make(); await service.getBalance({ force: true });
  const files = [config.file, service.ledger.file(service.activeScope)], before = files.map(file => fs.readFileSync(file));
  const detected = new Map(service.provider.detected); used = 10000;
  const preview = await service.previewBalance({ provider: 'billing' });
  assert.equal(preview.preview.used, 100); assert.ok(calls >= 4);
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
  assert.deepEqual(service.provider.detected, detected); assert.deepEqual(service.accountNotices().notices, []);
  assert.ok(!JSON.stringify(preview).includes('synthetic-test-secret'));
});

test('draft targeting an unmatched follow connection fails before making a request', async t => {
  let calls = 0;
  const { config, make } = fixture(t, { fetchImpl: async () => { calls++; return reply({}); } });
  const service = make();
  await assert.rejects(service.previewBalance({ connectionUpdate: { id: 'other', value: { name: 'other', match: { providerId: 'elsewhere', profile: '' }, balance: { adapter: 'none' } } } }), /未匹配/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(config.file), false);
});

test('preview IPC returns sanitized data and never persists a draft connection', async t => {
  const { config, make } = fixture(t, { fetchImpl: async () => reply({ wallet: { amount: 12.5 } }) });
  const service = make(), dispatcher = createDispatcher({ dataDir: config.dataDir, service, monitor: false, autoRefresh: false });
  t.after(() => dispatcher.close());
  const response = await dispatcher.dispatch('/api/balance-preview', { method: 'POST', body: { patch: { connectionMode: 'fixed', selectedConnection: 'draft', connectionUpdate: { id: 'draft', value: {
    name: '演示连接', baseUrl: 'https://example.test/v1', balance: { adapter: 'custom-json', request: { url: '/wallet', auth: { type: 'none' } }, mapping: { balanceField: 'wallet.amount', confirmed: false } },
  } } } } });
  const result = JSON.parse(response.body); assert.equal(response.status, 200); assert.equal(result.preview.balance, 12.5);
  assert.equal(fs.existsSync(config.file), false); assert.equal(fs.existsSync(path.join(config.dataDir, 'ledgers')), false);
  assert.ok(!response.body.toString().includes('example.test'));
  for (const route of ['/balance-view.js', '/connection-settings.js']) assert.equal((await dispatcher.dispatch(route)).status, 200);
});
