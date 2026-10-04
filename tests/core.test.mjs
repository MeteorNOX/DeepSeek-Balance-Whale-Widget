import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigStore, DEFAULT_CONFIG, validateConfig } from '../runtime/config.mjs';
import { BalanceProvider } from '../runtime/providers.mjs';
import { UsageLedger } from '../runtime/ledger.mjs';
import { SessionParser } from '../runtime/session-monitor.mjs';
import { WhaleService, estimateUsage } from '../runtime/service.mjs';

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-test-'));
  t.after(() => {
    const resolved = path.resolve(root), parent = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(parent) && path.basename(resolved).startsWith('whale-test-'));
    fs.rmSync(resolved, { recursive: true });
  });
  return root;
}
function config(t, toml = 'model_provider = "custom"\nmodel = "test-model"\n[model_providers.custom]\nbase_url = "https://provider.example/v1"\nexperimental_bearer_token = "TEST_SECRET_DO_NOT_PRINT"\n') {
  const root = temp(t); fs.writeFileSync(path.join(root, 'config.toml'), toml);
  return new ConfigStore({ dataDir: path.join(root, 'data'), codexHome: root, env: {} });
}
const reply = (data, status = 200, contentType = 'application/json') => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': contentType } });

test('Codex provider configuration resolves without exposing the API key', t => {
  const c = config(t);
  assert.equal(c.resolve().key, 'TEST_SECRET_DO_NOT_PRINT');
  assert.equal(c.publicInfo().hasKey, true);
  assert.equal(JSON.stringify(c.publicInfo()).includes('TEST_SECRET_DO_NOT_PRINT'), false);
  c.save({ baseUrl: 'https://another.example/v1' });
  assert.throws(() => c.resolve(), /更换 API 域名/);
});

test('profile and explicit environment selection override defaults', t => {
  const c = config(t, 'model_provider="a"\n[model_providers.a]\nbase_url="https://a.example/v1"\n[model_providers.b]\nbase_url="https://b.example/v1"\nenv_key="B_KEY"\n[profiles.work]\nmodel_provider="b"\nmodel="other-model"\n');
  c.env.B_KEY = 'FAKE_ENV_KEY'; c.save({ profile: 'work' });
  const got = c.resolve();
  assert.equal(got.baseUrl, 'https://b.example/v1'); assert.equal(got.model, 'other-model'); assert.equal(got.key, 'FAKE_ENV_KEY');
});

test('OAuth tokens are never reused as API keys', t => {
  const c = config(t, 'model="example"\n');
  fs.writeFileSync(path.join(c.codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'OAUTH_SECRET' } }));
  assert.equal(c.resolve().key, '');
});

test('configuration rejects credentials, cross-origin paths and invalid prices', t => {
  const c = config(t);
  assert.throws(() => c.save({ apiKey: 'not-allowed' }), /不保存密钥/);
  assert.throws(() => c.save({ baseUrl: 'https://u:p@provider.example' }), /不能包含密钥/);
  assert.throws(() => validateConfig({ balancePath: '//evil.example/api' }), /绝对路径/);
  assert.throws(() => validateConfig({ models: { test: { input: -1, cachedInput: 0, output: 1 } } }), /范围/);
});

test('compatible billing correctly converts cents and preserves decimals', async t => {
  const c = config(t).resolve(); const calls = [];
  const p = new BalanceProvider({ fetchImpl: async (url, options) => { calls.push({ url, options }); return url.endsWith('/subscription') ? reply({ hard_limit_usd: 50 }) : reply({ total_usage: 112.3554 }); } });
  const r = await p.balance(c);
  assert.equal(r.totalBalance, 48.876446); assert.equal(r.totalUsed, 1.123554); assert.equal(r.currency, 'USD');
  assert.equal(calls.length, 2); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls.every(x => x.url.startsWith(c.baseUrl + '/dashboard/billing/')), true);
  assert.equal(JSON.stringify(r).includes(c.key), false);
  p.fetch = async url => url.endsWith('/subscription') ? reply({ hard_limit_usd: 1 }) : reply({ total_usage: 500 });
  assert.equal((await p.balance(c)).totalBalance, -4);
});

test('missing billing values are rejected rather than rendered as zero', async t => {
  const c = config(t); c.save({ provider: 'billing' });
  const p = new BalanceProvider({ fetchImpl: async () => reply({}) });
  await assert.rejects(p.balance(c.resolve()), error => error.code === 'SHAPE');
});

test('unsupported HTML billing routes fall back to a distinct key quota', async t => {
  const c = config(t).resolve();
  const p = new BalanceProvider({ fetchImpl: async url => url.includes('/api/usage/token') ? reply({ data: { total_available: 3, total_used: 2, total_granted: 5 } }) : reply('<html>login</html>', 200, 'text/html') });
  const r = await p.balance(c);
  assert.equal(r.totalBalance, 3); assert.equal(r.balanceScope, 'api-key-quota'); assert.equal(r.adapter, 'newapi');
});

test('unlimited API key quota does not imply unlimited account funds', async t => {
  const c = config(t); c.save({ provider: 'newapi' });
  const p = new BalanceProvider({ fetchImpl: async () => reply({ data: { unlimited_quota: true, used_quota: 500000 } }) });
  const r = await p.balance(c.resolve());
  assert.equal(r.totalBalance, null); assert.equal(r.totalUsed, 1); assert.equal(r.unlimited, true); assert.equal(r.balanceScope, 'api-key-quota');
});

test('custom JSON adapter validates fields and amount scaling', async t => {
  const c = config(t); c.save({ provider: 'custom-json', balancePath: '/my/balance', balanceField: 'wallet.remaining', usedField: 'wallet.spent', balanceScale: 0.01, currency: 'EUR' });
  const p = new BalanceProvider({ fetchImpl: async () => reply({ wallet: { remaining: 1200, spent: 99 } }) });
  const r = await p.balance(c.resolve());
  assert.equal(r.totalBalance, 12); assert.equal(r.totalUsed, 0.99); assert.equal(r.currency, 'EUR');
});

test('authentication failures do not expose provider bodies or fall back', async t => {
  const c = config(t).resolve(); let count = 0;
  const p = new BalanceProvider({ fetchImpl: async () => { count++; return reply({ error: 'echo ' + c.key }, 401); } });
  await assert.rejects(p.balance(c), error => error.code === 'AUTH' && !error.message.includes(c.key));
  assert.equal(count, 2);
});

test('official OpenAI auto mode never calls an unverified balance endpoint', async t => {
  const c = config(t, 'model_provider="openai"\n[model_providers.openai]\nbase_url="https://api.openai.com/v1"\nexperimental_bearer_token="fake-key"\n');
  const p = new BalanceProvider({ fetchImpl: () => { throw new Error('must not request'); } });
  await assert.rejects(p.balance(c.resolve()), error => error.code === 'UNSUPPORTED');
});

test('daily ledger preserves spent amounts across recharges and separates currencies', t => {
  const ledger = new UsageLedger(temp(t)), usd = 'a'.repeat(24) + '-USD', eur = 'a'.repeat(24) + '-EUR';
  const now = new Date(2026, 8, 14, 10).getTime();
  ledger.observe(usd, { totalBalance: 10, totalUsed: 2 }, now);
  ledger.observe(usd, { totalBalance: 9, totalUsed: 3 }, now + 1000);
  ledger.observe(usd, { totalBalance: 109, totalUsed: 3 }, now + 2000);
  ledger.observe(usd, { totalBalance: 108.5, totalUsed: 3.5 }, now + 3000);
  ledger.observe(usd, { totalBalance: 108.5, totalUsed: 3.5 }, now + 4000);
  assert.equal(ledger.records(usd, now).today.total, 1.5);
  assert.equal(ledger.records(eur, now).today.total, 0);
  ledger.observe(usd, { totalBalance: 100, totalUsed: 12 }, now + 86400000);
  assert.equal(ledger.records(usd, now + 86400000).today.total, 8.5);
  assert.equal(ledger.records(usd, now + 86400000).days7[1].total, 1.5);
});

test('balance-only ledger retains consumption after a top-up', t => {
  const ledger = new UsageLedger(temp(t)), scope = 'b'.repeat(24) + '-USD';
  ledger.observe(scope, { totalBalance: 10 }); ledger.observe(scope, { totalBalance: 8 }); ledger.observe(scope, { totalBalance: 20 }); ledger.observe(scope, { totalBalance: 19 });
  assert.equal(ledger.records(scope).today.total, 3);
});

const event = (type, extra = {}) => ({ type: 'event_msg', timestamp: '2026-09-14T10:00:00Z', payload: { type, ...extra } });
const usage = (input, cached, output, reasoning = 0) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning });
test('Codex cumulative token counters deduplicate repeated events and isolate turns', () => {
  const starts = [], ends = [];
  const parser = new SessionParser({ id: 'session-a', defaultModel: 'model', onStart: x => starts.push(x), onEnd: x => ends.push(x) });
  parser.accept(event('task_started', { turn_id: 'one' }));
  parser.accept(event('token_count', { info: { total_token_usage: usage(100, 40, 20, 10), last_token_usage: usage(100, 40, 20, 10) } }));
  parser.accept(event('token_count', { info: { total_token_usage: usage(100, 40, 20, 10), last_token_usage: usage(100, 40, 20, 10) } }));
  parser.accept(event('token_count', { info: { total_token_usage: usage(150, 60, 30, 12) } }));
  parser.accept(event('task_complete', { turn_id: 'one' }));
  parser.accept(event('task_started', { turn_id: 'two' }));
  parser.accept(event('token_count', { info: { total_token_usage: usage(170, 60, 40, 14) } }));
  parser.accept(event('task_complete', { turn_id: 'two' }));
  assert.equal(starts.length, 2); assert.equal(ends.length, 2);
  assert.equal(ends[0].byModel.model.input_tokens, 150); assert.equal(ends[0].byModel.model.output_tokens, 30);
  assert.equal(ends[1].byModel.model.input_tokens, 20); assert.equal(ends[1].byModel.model.output_tokens, 10);
});

test('monitor bootstrap does not replay completed historical turns', () => {
  const starts = [], ends = [];
  const parser = new SessionParser({ id: 'test', defaultModel: 'model', onStart: x => starts.push(x), onEnd: x => ends.push(x) });
  parser.prime([event('task_started', { turn_id: 'old' }), event('task_complete'), event('task_started', { turn_id: 'running' }), event('token_count', { info: { total_token_usage: usage(100, 0, 20) } })]);
  assert.equal(ends.length, 0); assert.equal(starts.length, 1); assert.equal(starts[0].partial, true);
});

test('estimated costs do not double count cached input or reasoning output', () => {
  const settings = validateConfig({ models: { model: { input: 2, cachedInput: 1, output: 4 } } });
  const value = estimateUsage({ model: { input_tokens: 1000000, cached_input_tokens: 400000, output_tokens: 200000, reasoning_output_tokens: 100000, cache_write_input_tokens: 100000 } }, settings, 0);
  assert.equal(value, 2.4);
  assert.equal(estimateUsage({ unknown: usage(100, 0, 30) }, settings, 0), null);
});

test('retired schedule cannot change fees even when a legacy config includes a multiplier', () => {
  const settings = validateConfig({ models: { test: { input: 1, cachedInput: 1, output: 1 } }, pricingSchedule: { enabled: true, multiplier: 100 } });
  assert.equal(Object.hasOwn(settings, 'pricingSchedule'), false);
  const byModel = { test: { input_tokens: 1000000, cached_input_tokens: 0, output_tokens: 0 } };
  assert.equal(estimateUsage(byModel, settings, Date.UTC(2026, 8, 14, 2)), 1);
  assert.equal(estimateUsage(byModel, settings, Date.UTC(2026, 8, 13, 2)), 1);
});

test('turn settlement records interval scope and keeps its sequence after restart', async t => {
  const c = config(t); let used = 0;
  const fake = { async balance(context) { return { ok: true, accountId: context.accountId, totalBalance: 50 - used, totalUsed: used++, currency: 'USD', providerName: 'test', updatedAt: new Date().toISOString() }; } };
  const service = new WhaleService({ config: c, provider: fake });
  service.beginTurn({ id: 'one', turnId: '1', partial: false });
  await service.finishTurn({ id: 'one', turnId: '1', byModel: { model: usage(10, 0, 5) } });
  assert.equal(service.lastTurn().amount, null); assert.equal(service.lastTurn().accountIntervalAmount, 1); assert.equal(service.lastTurn().source, 'token-only'); assert.equal(service.lastTurn().tokens, 15);
  const restarted = new WhaleService({ config: c, provider: fake });
  assert.equal(restarted.lastTurn().seq, 1);
});

test('transient failures keep the last successful balance but auth failures do not', async t => {
  const c = config(t); let mode = 'ok';
  const service = new WhaleService({ config: c, provider: { async balance(context) {
    if (mode !== 'ok') { const error = new Error('request failed'); error.code = mode; error.transient = mode === 'NETWORK'; throw error; }
    return { ok: true, accountId: context.accountId, totalBalance: 4, totalUsed: 1, currency: 'USD' };
  } } });
  await service.getBalance(); mode = 'NETWORK';
  assert.equal((await service.getBalance({ force: true })).stale, true);
  mode = 'AUTH'; assert.equal((await service.getBalance({ force: true })).ok, false);
});


test('billing preserves a positive debit below eight decimal places', async t => {
  const c = config(t); c.save({ provider: 'billing' });
  const p = new BalanceProvider({ fetchImpl: async url => url.endsWith('/subscription') ? reply({ hard_limit_usd: 1 }) : reply({ total_usage: 0.00000001 }) });
  const result = await p.balance(c.resolve());
  assert.equal(result.totalUsed, 1e-10);
  assert.equal(result.totalBalance, 0.9999999999);
});

test('custom scaling retains provider precision instead of truncating tiny balances and debits', async t => {
  const c = config(t); c.save({ provider: 'custom-json', balancePath: '/my/balance', balanceField: 'wallet.remaining', usedField: 'wallet.spent', balanceScale: 0.01, currency: 'USD' });
  const source = { remaining: 0.000000123456789, spent: 0.00000000123456789 };
  const p = new BalanceProvider({ fetchImpl: async () => reply({ wallet: source }) });
  const result = await p.balance(c.resolve());
  assert.equal(result.totalBalance, source.remaining * 0.01);
  assert.equal(result.totalUsed, source.spent * 0.01);
  assert.ok(result.totalBalance > 0 && result.totalBalance < 1e-8);
  assert.ok(result.totalUsed > 0 && result.totalUsed < 1e-10);
});
