import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../runtime/config.mjs';
import { WhaleService } from '../runtime/service.mjs';
import { createDispatcher } from '../runtime/dispatcher.mjs';

const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function fixture(t, fetchImpl) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-selection-'));
  fs.writeFileSync(path.join(folder, 'config.toml'), 'model_provider="fixture"\n[model_providers.fixture]\nbase_url="https://gateway.example.test/v1"\nenv_key="FIXTURE_KEY"\n');
  const config = new ConfigStore({ dataDir: path.join(folder, 'data'), codexHome: folder, env: { FIXTURE_KEY: 'synthetic-private-key' } });
  const clock = { now: 1000 };
  const service = new WhaleService({ config, fetchImpl: fetchImpl || (async url => {
    if (url.endsWith('/dashboard/billing/subscription')) return response({ object: 'billing_subscription', hard_limit_usd: 100, soft_limit_usd: 100, system_hard_limit_usd: 100 });
    if (url.endsWith('/dashboard/billing/usage')) return response({ object: 'list', total_usage: 200 });
    return response({}, 404);
  }), previewNow: () => clock.now });
  t.after(async () => { await service.close(); assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(folder).startsWith('whale-selection-')); fs.rmSync(folder, { recursive: true, force: true }); });
  return { config, service, clock };
}

test('ordinary detected billing candidate can be adopted once without copying secrets or unrelated drafts', async t => {
  const { config, service } = fixture(t);
  const preview = await service.previewBalance({ models: { 'unsaved-model': { input: 1, cachedInput: 1, output: 1 } } }, { redetect: true });
  assert.equal(preview.detection.status, 'candidate'); assert.equal(preview.preview.balance, 98);
  assert.ok(preview.previewId); assert.equal(fs.existsSync(config.file), false);
  assert.ok(!JSON.stringify(preview).includes('synthetic-private-key')); assert.ok(!JSON.stringify(preview).includes('gateway.example.test'));
  const result = service.acceptBalanceSelection(preview.previewId); assert.equal(result.ok, true);
  assert.equal(config.load().connections.length, 1); assert.deepEqual(config.load().models, {});
  const c = config.resolve(); assert.equal(c.balanceConnection.adapter, 'billing'); assert.equal(c.balanceConnection.mapping.confirmed, true);
  assert.equal(c.key, 'synthetic-private-key'); assert.ok(!fs.readFileSync(config.file, 'utf8').includes('synthetic-private-key'));
  const balance = await service.getBalance({ force: true }); assert.equal(balance.totalBalance, 98); assert.equal(balance.todayUsage, 0);
  assert.deepEqual(service.accountNotices().notices, []);
  assert.throws(() => service.acceptBalanceSelection(preview.previewId), /失效/);
});

test('proof is rejected and consumed when saved configuration changes', async t => {
  const { config, service } = fixture(t), preview = await service.previewBalance({});
  config.save({ currency: 'CNY' });
  assert.throws(() => service.acceptBalanceSelection(preview.previewId), /改变/);
  assert.throws(() => service.acceptBalanceSelection(preview.previewId), /失效/);
  assert.equal(config.load().connections.length, 0);
});

test('proof is rejected after credential rotation even without a settings edit', async t => {
  const { config, service } = fixture(t), preview = await service.previewBalance({});
  config.env.FIXTURE_KEY = 'rotated-synthetic-key';
  assert.throws(() => service.acceptBalanceSelection(preview.previewId), /改变/);
  assert.equal(fs.existsSync(config.file), false);
});

test('proof expires after five minutes and cannot be forged or reused from another service', async t => {
  const { config, service, clock } = fixture(t), preview = await service.previewBalance({});
  assert.throws(() => service.acceptBalanceSelection('balance-selection-invalid'), /失效/);
  clock.now += 300001; assert.throws(() => service.acceptBalanceSelection(preview.previewId), /失效/);
  assert.equal(fs.existsSync(config.file), false);
});

test('a newer preview invalidates the previous selection and keeps only the current proof', async t => {
  const { service } = fixture(t), first = await service.previewBalance({}), second = await service.previewBalance({});
  assert.notEqual(first.previewId, second.previewId); assert.equal(service.previewSelections.size, 1);
  assert.throws(() => service.acceptBalanceSelection(first.previewId), /失效/);
  assert.equal(service.acceptBalanceSelection(second.previewId).ok, true);
});

test('adopting a named candidate preserves its identity and unrelated saved connections', async t => {
  const { config, service } = fixture(t);
  config.save({ connections: [
    { id: 'a', name: 'A', baseUrl: 'https://gateway.example.test/v1', keyEnv: 'FIXTURE_KEY', balance: { adapter: 'auto' } },
    { id: 'b', name: 'B', baseUrl: 'https://other.example.test', balance: { adapter: 'none' } },
  ], connectionMode: 'fixed', selectedConnection: 'a' });
  const previous = config.readConnection('b'), preview = await service.previewBalance({});
  assert.ok(preview.previewId); service.acceptBalanceSelection(preview.previewId);
  assert.equal(config.load().connections.length, 2); assert.equal(config.load().selectedConnection, 'a');
  assert.equal(config.readConnection('a').name, 'A'); assert.deepEqual(config.readConnection('b'), previous);
});

test('known quota contract becomes usable automatically with no saved confirmation', async t => {
  const { config, service } = fixture(t, async url => url.endsWith('/api/status') ? response({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD', display_in_currency: true } }) : url.endsWith('/api/usage/token/') ? response({ data: { object: 'token_usage', total_available: 1000000, total_used: 500000, total_granted: 1500000, unlimited_quota: false } }) : response({}, 404));
  const preview = await service.previewBalance({}); assert.equal(preview.detection.status, 'matched');
  assert.equal(preview.preview.balance, 2); assert.equal(preview.canObserve, true); assert.equal(preview.previewId, undefined);
  assert.equal(fs.existsSync(config.file), false);
  assert.equal((await service.getBalance({ force: true })).totalBalance, 2);
});

test('native quota without units and unlimited sentinel do not receive blind confirmation proofs', async t => {
  const { service } = fixture(t, async url => url.endsWith('/api/usage/token/') ? response({ data: { object: 'token_usage', total_available: 1000000, total_used: 500000, total_granted: 1500000, unlimited_quota: false } }) : response({}, 404));
  const preview = await service.previewBalance({}); assert.equal(preview.previewId, undefined);
  assert.equal(preview.detection.needsConfirmation, false); assert.equal(preview.preview.balance, null);
});

test('IPC exposes detection errors and accepts only a server-issued preview token', async t => {
  const { service, config } = fixture(t), dispatcher = createDispatcher({ dataDir: config.dataDir, service, monitor: false, autoRefresh: false });
  t.after(() => dispatcher.close());
  const bad = await dispatcher.dispatch('/api/balance-selection', { method: 'POST', body: { adapter: 'billing' } }); assert.equal(bad.status, 400);
  const queried = await dispatcher.dispatch('/api/balance-preview', { method: 'POST', body: { patch: {}, redetect: true } });
  const preview = JSON.parse(queried.body); assert.ok(preview.previewId);
  const adopted = await dispatcher.dispatch('/api/balance-selection', { method: 'POST', body: { previewId: preview.previewId } });
  assert.equal(adopted.status, 200); assert.equal(JSON.parse(adopted.body).connections.length, 1);
});

test('manual redetection cannot bypass the live provider rate-limit cooldown', async t => {
  let requests = 0;
  const { service } = fixture(t, async () => {
    requests++;
    return new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '300' } });
  });
  const failed = await service.getBalance({ force: true }); assert.equal(failed.code, 'HTTP_429');
  const before = requests;
  await assert.rejects(service.previewBalance({}, { redetect: true }), error => error.code === 'HTTP_429');
  await assert.rejects(service.previewBalance({}, { redetect: true }), error => error.code === 'HTTP_429');
  assert.equal(requests, before);
});
