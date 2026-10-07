import test from 'node:test';
import assert from 'node:assert/strict';
import { BalanceProvider } from '../runtime/providers.mjs';
import { validateBalanceConnection, balanceSecretNames, BALANCE_LIMITS } from '../runtime/balance-contract.mjs';

const reply = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const context = (balance, extra = {}) => ({ accountId: 'fixture-account', providerName: 'Fixture', baseUrl: 'https://api.example/proxy/v1', key: 'SYNTHETIC_API_KEY', dashboardUrl: 'https://api.example', setting: { provider: 'auto', currency: 'USD', billingUsageDivisor: 100, quotaPerUnit: 500000, balanceScale: 1 }, ...(balance ? { balanceConnection: balance } : {}), ...extra });
const custom = (mapping = {}, request = {}) => ({ adapter: 'custom-json', request: { url: '/wallet', ...request }, mapping: { balanceField: 'wallet.remaining', usedField: 'wallet.spent', confirmed: true, ...mapping } });
const provider = (data, calls = []) => new BalanceProvider({ fetchImpl: async (url, options) => { calls.push({ url, options }); return reply(typeof data === 'function' ? data(url, options) : data); } });
const billing = url => url.endsWith('/subscription') ? { hard_limit_usd: 100000000 } : { total_usage: 23880 };
const shape = error => error.code === 'SHAPE';
const config = error => error.code === 'CONFIG';

// All requests use an injected fetch; this suite never reaches a real provider.
test('balance connection normalizes defaults, stays pure and lists only referenced env names', () => {
  const input = custom({}, { auth: { type: 'header', header: 'X-Api-Key', keyEnv: 'BILLING_KEY' }, envHeaders: { 'X-Tenant': 'TENANT_ID' }, envQuery: { account: 'TENANT_ID' } });
  const original = structuredClone(input), result = validateBalanceConnection(input);
  assert.deepEqual(input, original); assert.equal(result.request.method, 'GET'); assert.equal(result.request.body, null);
  assert.deepEqual(balanceSecretNames(result), ['BILLING_KEY', 'TENANT_ID']); assert.equal(result.mapping.usedScale, 1);
  assert.equal(validateBalanceConnection({}).adapter, 'auto');
});

test('validation rejects malformed prototypes, controls, inline credentials and dangerous headers', () => {
  for (const input of [null, [], { mapping: null }, { adapter: 'missing' }, { request: { auth: { type: 'inherit', keyEnv: 'KEY' } } },
    { request: { auth: { type: 'bearer', keyEnv: '__proto__' } } }, { request: { envQuery: { a: 'constructor' } } },
    { request: { headers: { Authorization: 'inline-secret' } } }, { request: { headers: { Host: 'other.test' } } },
    { request: { headers: { 'Proxy-Authorization': 'x' } } }, { request: { headers: { 'sec-fetch-site': 'x' } } },
    { request: { headers: { 'X-Api-Key': 'secret' } } }, { request: { headers: { 'X-Tenant': 'a\r\nb' } } },
    { request: { query: { api_key: 'secret' } } }, { request: { headers: JSON.parse('{"__proto__":"x"}') } },
    { request: { method: 'DELETE' } }, { request: { body: { hello: 'world' } } },
    { request: { method: 'POST', body: { nested: { password: 'secret' } } } },
    { mapping: { balanceField: 'constructor.value' } }, { mapping: { usedField: 'data..balance' } },
    { mapping: { balanceScale: '1' } }, { mapping: { usedScale: Infinity } }, { mapping: { confirmed: 'true' } },
    { request: { headers: { Accept: 'a', accept: 'b' } } }, { request: { query: { a: 'x' }, envQuery: { a: 'ENV' } } },
    { request: { auth: { type: 'header', keyEnv: 'KEY', header: 'Authorization' } } },
    { request: { auth: { type: 'header', keyEnv: 'KEY', header: 'X-Auth' }, envHeaders: { 'x-auth': 'OTHER' } } },
    { unexpected: 'ignored?' }, { request: { extra: true } }, { mapping: { currency: '<x>' } },
  ]) assert.throws(() => validateBalanceConnection(input));
  assert.throws(() => validateBalanceConnection(Object.create({ adapter: 'auto' })));
  for (const url of ['//evil.test/wallet', 'https://u:p@evil.test/wallet', 'https://evil.test/wallet?key=x', 'https://evil.test/#fragment', 'http://evil.test/wallet', 'file:///wallet', '/a\\b', '/%0d%0a']) assert.throws(() => validateBalanceConnection(custom({}, { url })));
});

test('request and mapping budgets reject oversized inputs before any network access', async () => {
  for (const input of [custom({}, { url: '/' + 'a'.repeat(2048) }), custom({}, { headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['X-' + i, 'a'])) }),
    custom({}, { query: { a: 'a'.repeat(2049) } }), custom({}, { method: 'POST', body: 'a'.repeat(BALANCE_LIMITS.body) })]) assert.throws(() => validateBalanceConnection(input));
  const p = provider({ wallet: { remaining: 1, spent: 0 } });
  await assert.rejects(p.balance(context(custom({}, { auth: { type: 'bearer', keyEnv: 'BIG' } }), { balanceSecrets: { BIG: 'a'.repeat(9000) } })), config);
  await assert.rejects(p.balance(context(custom({}, { envQuery: { account: 'BIG' } }), { balanceSecrets: { BIG: 'a'.repeat(5000) } })), config);
});

test('custom amount parsing accepts only finite decimal numeric scalars and preserves debt and zero', async () => {
  for (const invalid of [null, '', ' ', '\t', [], [0], [1], {}, true, false, 'NaN', 'Infinity', '0x10', ' 1', '1 ']) {
    await assert.rejects(provider({ wallet: { remaining: invalid, spent: 0 } }).balance(context(custom())), shape);
    await assert.rejects(provider({ wallet: { remaining: 1, spent: invalid } }).balance(context(custom())), shape);
  }
  for (const value of [0, '0', '-12.25', '1.234e-10']) {
    const result = await provider({ wallet: { remaining: value, spent: '0' } }).balance(context(custom()));
    assert.equal(result.totalBalance, Number(value)); assert.equal(result.totalUsed, 0); assert.equal(result.balanceStatus, 'finite');
  }
  await assert.rejects(provider({ wallet: { remaining: 1e308, spent: 0 } }).balance(context(custom({ balanceScale: 1e12 }))), shape);
});

test('billing rejects non-numeric额度 and usage instead of coercing arrays or booleans', async () => {
  for (const invalid of [[], [1], ' ', {}, true]) {
    await assert.rejects(provider(url => url.endsWith('/subscription') ? { hard_limit_usd: invalid } : { total_usage: 0 }).balance(context({ adapter: 'billing', mapping: { confirmed: true } })), shape);
    await assert.rejects(provider(url => url.endsWith('/subscription') ? { hard_limit_usd: 1 } : { total_usage: invalid }).balance(context({ adapter: 'billing', mapping: { confirmed: true } })), shape);
  }
});

test('unknown auto billing is only a redacted preview even when someone sets confirmed=true', async () => {
  for (const balance of [undefined, { adapter: 'auto', mapping: { confirmed: true } }]) {
    const result = await provider(billing).balance(context(balance));
    assert.equal(result.balanceStatus, 'unconfirmed'); assert.equal(result.totalBalance, null); assert.equal(result.totalUsed, null); assert.equal(result.totalGranted, null);
    assert.equal(result.canObserve, false); assert.equal(result.counter, null); assert.equal(result.preview.balance, null);
    assert.equal(result.detection.needsConfirmation, false);
    assert.deepEqual(Object.keys(result.preview).sort(), ['adapter', 'balance', 'currency', 'scope', 'used']);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_API_KEY'), false);
  }
});

test('explicit contracts require confirmation while explicit legacy adapters retain known conversions', async () => {
  const p = provider(billing);
  const unconfirmed = await p.balance(context({ adapter: 'billing' }));
  assert.equal(unconfirmed.balanceStatus, 'unconfirmed');
  const confirmed = await p.balance(context({ adapter: 'billing', mapping: { confirmed: true } }));
  assert.equal(confirmed.balanceStatus, 'finite'); assert.equal(confirmed.totalUsed, 238.8); assert.equal(confirmed.counter, 'used');
  const legacy = await p.balance(context(undefined, { setting: { provider: 'billing', billingUsageDivisor: 100, currency: 'USD' } }));
  assert.equal(legacy.totalUsed, confirmed.totalUsed); assert.equal(legacy.canObserve, true);
});

test('auto fallback identifies the actual adapter without sharing confirmation or meter identity', async () => {
  const c = context({ adapter: 'auto', mapping: { confirmed: true } });
  let route = 'billing'; const p = new BalanceProvider({ fetchImpl: async url => route === 'billing' ? reply(billing(url)) : url.includes('/api/usage/token/') ? reply({ data: { object: 'token_usage', total_available: 2000000, total_used: 500000, total_granted: 2500000, unlimited_quota: false } }) : url.endsWith('/api/status') ? reply({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } }) : new Response('<html/>', { headers: { 'content-type': 'text/html' } }) });
  const first = await p.balance(c); route = 'newapi'; const second = await p.balance(c), third = await p.balance(c);
  assert.equal(second.adapter, 'newapi'); assert.equal(second.balanceStatus, 'finite'); assert.equal(second.totalBalance, 4); assert.notEqual(first.meterId, second.meterId); assert.equal(second.meterId, third.meterId); assert.equal(second.balanceScope, 'api-key-quota'); assert.equal(third.detection.cached, true);
});

test('DeepSeek auto verifies the documented shape and ignores arbitrary custom scaling', async () => {
  const p = provider(url => url.includes('/other') ? { data: { balance: 999 } } : { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34' }] });
  const result = await p.balance(context(undefined, { baseUrl: 'https://api.deepseek.com/v1' }));
  assert.equal(result.balanceStatus, 'finite'); assert.equal(result.totalBalance, 12.34); assert.equal(result.counter, 'balance');
  const modified = await p.balance(context({ adapter: 'auto', request: { url: '/other' } }, { baseUrl: 'https://api.deepseek.com/v1' }));
  assert.equal(modified.balanceStatus, 'unsupported');
  const converted = await p.balance(context({ adapter: 'auto', mapping: { balanceScale: 2 } }, { baseUrl: 'https://api.deepseek.com/v1' }));
  assert.equal(converted.balanceStatus, 'finite'); assert.equal(converted.totalBalance, 12.34);
});

test('none and official OpenAI auto return unsupported without a key or a network request', async () => {
  const p = new BalanceProvider({ fetchImpl: async () => { assert.fail('must not fetch'); } });
  for (const c of [context({ adapter: 'none' }, { key: '' }), context(undefined, { key: '', baseUrl: 'https://api.openai.com/v1' })]) {
    const result = await p.balance(c); assert.equal(result.ok, true); assert.equal(result.balanceStatus, 'unsupported'); assert.equal(result.totalBalance, null); assert.equal(result.canObserve, false);
  }
});

test('unlimited quotas use exact declared values and retain an independently valid used counter', async () => {
  const p = provider({ data: { unlimited_quota: true, used_quota: 500000 } });
  const result = await p.balance(context({ adapter: 'newapi', mapping: { confirmed: true } }));
  assert.equal(result.balanceStatus, 'unlimited'); assert.equal(result.totalBalance, null); assert.equal(result.totalUsed, 1); assert.equal(result.canObserve, true); assert.equal(result.counter, 'used');
  const native = await provider({ data: { unlimited_quota: true, total_used: 2 } }).balance(context({ adapter: 'newapi', mapping: { confirmed: true } }));
  assert.equal(native.totalUsed, 2); assert.notEqual(native.meterId, result.meterId);
  const empty = await provider({ data: { unlimited_quota: true } }).balance(context({ adapter: 'newapi', mapping: { confirmed: true } }));
  assert.equal(empty.balanceStatus, 'unlimited'); assert.equal(empty.canObserve, false); assert.equal(empty.counter, null);
  const customResult = await provider({ wallet: { mode: 'unlimited', spent: 3 } }).balance(context(custom({ unlimitedField: 'wallet.mode', unlimitedValue: 'unlimited' })));
  assert.equal(customResult.balanceStatus, 'unlimited'); assert.equal(customResult.totalUsed, 3);
  await assert.rejects(provider({ wallet: { mode: true, spent: 3 } }).balance(context(custom({ unlimitedField: 'wallet.mode', unlimitedValue: 'true' }))), shape);
});

test('large numeric balances are finite under a confirmed contract, never inferred as unlimited', async () => {
  const result = await provider({ wallet: { remaining: 99999761.2, spent: 0 } }).balance(context(custom()));
  assert.equal(result.balanceStatus, 'finite'); assert.equal(result.totalBalance, 99999761.2); assert.equal(result.unlimited, false);
});

test('custom used-only contracts and distinct used scales retain independently meaningful counters', async () => {
  const result = await provider({ wallet: { spent: 500 } }).balance(context(custom({ balanceField: '', usedScale: 0.01 })));
  assert.equal(result.totalBalance, null); assert.equal(result.totalUsed, 5); assert.equal(result.counter, 'used'); assert.equal(result.canObserve, true);
});

test('meter identity includes field, currency, scope and both conversions but excludes current amounts', async () => {
  const data = { wallet: { remaining: 5, spent: 2, other: 4 } }, p = provider(data);
  const first = await p.balance(context(custom()));
  for (const mapping of [{ balanceField: 'wallet.other' }, { usedField: 'wallet.other' }, { currency: 'EUR' }, { scope: 'custom' }, { balanceScale: 2 }, { usedScale: 2 }]) assert.notEqual((await p.balance(context(custom(mapping)))).meterId, first.meterId);
  data.wallet.remaining = 1; data.wallet.spent = 6;
  assert.equal((await p.balance(context(custom()))).meterId, first.meterId); assert.match(first.meterId, /^[a-f0-9]{64}$/);
});

test('default adapter routes preserve proxy prefixes and only billing retains the terminal API version', async () => {
  for (const [adapter, expected, data] of [
    ['billing', ['/proxy/v1/dashboard/billing/subscription', '/proxy/v1/dashboard/billing/usage'], billing],
    ['newapi', ['/proxy/api/usage/token/'], { data: { total_available: 5, total_used: 0 } }],
    ['deepseek', ['/proxy/user/balance'], { balance_infos: [{ total_balance: 5, currency: 'USD' }] }],
  ]) {
    const calls = []; await provider(data, calls).balance(context({ adapter, mapping: { confirmed: true } }));
    assert.deepEqual(calls.map(c => new URL(c.url).pathname), expected);
  }
});

test('explicit billing URL is a base directory; all other explicit URLs are exact endpoints', async () => {
  for (const [adapter, url, paths, data] of [
    ['billing', '/accounting', ['/accounting/dashboard/billing/subscription', '/accounting/dashboard/billing/usage'], billing],
    ['newapi', 'quota', ['/proxy/v1/quota'], { data: { total_available: 5, total_used: 0 } }],
    ['deepseek', 'https://api.example/my-wallet', ['/my-wallet'], { balance_infos: [{ total_balance: 5, currency: 'USD' }] }],
    ['custom-json', '/custom', ['/custom'], { wallet: { remaining: 5, spent: 0 } }],
  ]) {
    const calls = []; await provider(data, calls).balance(context({ adapter, request: { url }, mapping: { confirmed: true, balanceField: 'wallet.remaining', usedField: 'wallet.spent' } }));
    assert.deepEqual(calls.map(c => new URL(c.url).pathname), paths);
  }
});

test('same-origin inherited provider headers work and API request query parameters are never copied', async () => {
  const calls = []; await provider({ wallet: { remaining: 5, spent: 0 } }, calls).balance(context(custom({}, { query: { period: 'month' } }), { baseUrl: 'https://api.example/proxy/v1?api-version=secret-inference-version', authHeaders: { 'X-Tenant': 'tenant', Authorization: 'Bearer SYNTHETIC_HEADER_KEY' } }));
  assert.equal(new URL(calls[0].url).search, '?period=month'); assert.equal(calls[0].options.headers['x-tenant'], 'tenant'); assert.equal(calls[0].options.headers.authorization, 'Bearer SYNTHETIC_HEADER_KEY');
});

test('cross-origin balance requests require a dedicated key and never inherit provider headers', async () => {
  const calls = [], c = context(custom({}, { url: 'https://billing.example/wallet', auth: { type: 'bearer', keyEnv: 'BILLING_KEY' } }), { authHeaders: { 'X-Tenant': 'PRIVATE_TENANT', Authorization: 'Bearer SYNTHETIC_PROVIDER_HEADER' }, balanceSecrets: { BILLING_KEY: 'SYNTHETIC_BILLING_KEY' } });
  const result = await provider({ wallet: { remaining: 4, spent: 1 } }, calls).balance(c);
  assert.equal(calls[0].url, 'https://billing.example/wallet'); assert.equal(calls[0].options.headers.authorization, 'Bearer SYNTHETIC_BILLING_KEY');
  assert.equal(calls[0].options.headers['x-tenant'], undefined); assert.equal(JSON.stringify(calls).includes('SYNTHETIC_API_KEY'), false); assert.equal(JSON.stringify(result).includes('SYNTHETIC_BILLING_KEY'), false);
  for (const auth of [{ type: 'inherit' }, { type: 'none' }]) await assert.rejects(provider({}).balance(context(custom({}, { url: 'https://billing.example/wallet', auth }))), config);
});

test('cross-origin env header/query bypasses, redirects and malformed environment values fail closed', async () => {
  for (const extra of [{ envHeaders: { 'X-Tenant': 'TENANT' } }, { envQuery: { tenant: 'TENANT' } }]) {
    const c = context(custom({}, { url: 'https://billing.example/wallet', auth: { type: 'bearer', keyEnv: 'BILLING_KEY' }, ...extra }), { balanceSecrets: { BILLING_KEY: 'key', TENANT: 'tenant' } });
    await assert.rejects(provider({}).balance(c), config);
  }
  await assert.rejects(provider({}).balance(context(custom({}, { auth: { type: 'bearer', keyEnv: 'BILLING_KEY' } }), { balanceSecrets: { BILLING_KEY: 'a\r\nb' } })), config);
  await assert.rejects(provider({}).balance(context(custom({}, { auth: { type: 'bearer', keyEnv: 'MISSING' } }))), error => error.code === 'NO_KEY');
  const p = new BalanceProvider({ fetchImpl: async (url, options) => { assert.equal(options.redirect, 'error'); throw new TypeError('redirect to secret-url'); } });
  await assert.rejects(p.balance(context(custom())), error => error.code === 'NETWORK' && !error.message.includes('secret-url'));
});

test('POST JSON, custom header auth, env query, signal and response bounds stay explicit', async () => {
  const calls = [], c = context(custom({}, { method: 'POST', auth: { type: 'header', header: 'X-Balance-Key', keyEnv: 'BALANCE_KEY' }, headers: { 'X-Account': 'selected' }, envQuery: { tenant: 'TENANT' }, body: { period: { type: 'month' }, includeUsed: true } }), { key: '', balanceSecrets: { BALANCE_KEY: 'SYNTHETIC_BALANCE', TENANT: 'SYNTHETIC_TENANT' } });
  await provider({ wallet: { remaining: 5, spent: 1 } }, calls).balance(c);
  const { options } = calls[0]; assert.equal(options.method, 'POST'); assert.equal(options.headers['x-balance-key'], 'SYNTHETIC_BALANCE'); assert.equal(options.headers.authorization, undefined);
  assert.equal(options.headers['content-type'], 'application/json'); assert.deepEqual(JSON.parse(options.body), { period: { type: 'month' }, includeUsed: true });
  assert.equal(new URL(calls[0].url).searchParams.get('tenant'), 'SYNTHETIC_TENANT'); assert.ok(options.signal instanceof AbortSignal); assert.equal(options.redirect, 'error');
});

test('same-origin auth none supports public endpoints without accidentally sending a key', async () => {
  const calls = []; await provider({ wallet: { remaining: 2, spent: 0 } }, calls).balance(context(custom({}, { auth: { type: 'none' } }), { authHeaders: { Authorization: 'must-not-send' } }));
  assert.equal(calls[0].options.headers.authorization, undefined);
});

test('explicit adapters never seed or overwrite automatic detection for the same account', async () => {
  const calls = [], p = provider(url => url.endsWith('/wallet') ? { wallet: { remaining: 5, spent: 1 } } : billing(url), calls);
  await p.balance(context(custom()));
  const result = await p.balance(context());
  assert.equal(result.adapter, 'billing'); assert.equal(result.balanceStatus, 'unconfirmed');
  assert.equal(calls[0].url, 'https://api.example/wallet');
  assert.ok(calls.slice(1).some(call => call.url.endsWith('/dashboard/billing/subscription')));
  assert.ok(calls.slice(1).every(call => !call.url.endsWith('/wallet'))); assert.ok(calls.length <= 17);
});

test('auto detection is isolated when the same account previews a different mapping or request', async () => {
  for (const modified of [
    { adapter: 'auto', mapping: { unlimitedField: 'unlimited_plan', unlimitedValue: true } },
    { adapter: 'auto', request: { url: '/other-billing' } },
  ]) {
    const calls = [], p = provider(url => {
      if (url.endsWith('/api/usage/token/')) return { data: { object: 'token_usage', total_available: 2000000, total_used: 500000, total_granted: 2500000, unlimited_quota: false } };
      if (url.endsWith('/api/status')) return { success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } };
      if (url.includes('/other-billing/')) return url.endsWith('/subscription') ? { hard_limit_usd: 50 } : { total_usage: 100 };
      return {};
    }, calls);
    const initial = await p.balance(context({ adapter: 'auto' }));
    assert.equal(initial.adapter, 'newapi'); calls.length = 0;
    const changed = await p.balance(context(modified));
    assert.equal(changed.detection.cached, false);
    if (modified.request) { assert.equal(changed.adapter, 'billing'); assert.equal(changed.balanceStatus, 'unconfirmed'); assert.ok(calls.some(call => call.url.includes('/other-billing/dashboard/billing/'))); }
    else { assert.equal(changed.adapter, 'newapi'); assert.equal(changed.totalBalance, 4); assert.equal(calls.length, 2); }
    calls.length = 0;
    const originalAgain = await p.balance(context({ adapter: 'auto' }));
    assert.equal(originalAgain.adapter, 'newapi'); assert.equal(calls.length, 1);
  }
});

test('dedicated auth headers cannot be replaced by differently cased header maps or JSON content type', () => {
  for (const maps of [{ headers: { 'x-balance-id': 'replacement' } }, { envHeaders: { 'X-BALANCE-ID': 'OTHER' } }]) {
    assert.throws(() => validateBalanceConnection(custom({}, { auth: { type: 'header', keyEnv: 'KEY', header: 'X-Balance-ID' }, ...maps })), /重复/);
  }
  assert.throws(() => validateBalanceConnection(custom({}, { method: 'POST', auth: { type: 'header', keyEnv: 'KEY', header: 'cOnTeNt-TyPe' }, body: {} })), /Content-Type/);
});

test('inherited provider headers cannot be silently overridden through request maps', async () => {
  for (const maps of [{ headers: { 'x-client-id': 'replacement' } }, { envHeaders: { 'X-CLIENT-ID': 'OTHER' } }]) {
    let requested = false;
    const p = new BalanceProvider({ fetchImpl: async () => { requested = true; return reply({ wallet: { remaining: 1, spent: 0 } }); } });
    await assert.rejects(p.balance(context(custom({}, maps), { authHeaders: { 'X-Client-ID': 'provider-auth' }, balanceSecrets: { OTHER: 'replacement' } })), config);
    assert.equal(requested, false);
  }
});

test('literal authentication strings and credential aliases cannot be hidden in generic request fields', () => {
  for (const request of [
    { query: { q: 'Bearer SYNTHETIC_CREDENTIAL' } }, { headers: { 'X-Context': 'Basic U1lOVEhFVElDX0NSRURFTlRJQUw=' } },
    { method: 'POST', body: { context: ['sk-synthetic-credential'] } }, { method: 'POST', body: 'Bearer SYNTHETIC_CREDENTIAL' },
    { method: 'POST', body: { auth: 'opaque-value' } }, { query: { key: 'opaque-value' } },
    { url: '/wallet/sk-synthetic-credential' }, { url: '/wallet/Bearer%20SYNTHETIC_CREDENTIAL' },
    { url: '/wallet/%2542earer%2520SYNTHETIC_CREDENTIAL' },
  ]) assert.throws(() => validateBalanceConnection(custom({}, request)));
  const valid = validateBalanceConnection(custom({}, { query: { account: 'business-account' }, envQuery: { api_key: 'BALANCE_KEY' }, method: 'POST', body: { period: 'month' } }));
  assert.equal(valid.request.envQuery.api_key, 'BALANCE_KEY');
});

test('legacy balance URLs cannot bypass the dedicated query and credential configuration', async () => {
  let requested = false;
  const p = new BalanceProvider({ fetchImpl: async () => { requested = true; return reply({ data: { balance: 1 } }); } });
  for (const balancePath of ['/wallet?api_key=SYNTHETIC_INLINE', '/wallet/sk-synthetic-credential']) {
    await assert.rejects(p.balance(context(undefined, { setting: { provider: 'custom-json', balancePath, balanceField: 'data.balance', balanceScale: 1, currency: 'USD' } })), config);
  }
  assert.equal(requested, false);
});

test('the resolved URL has its own byte budget after relative path expansion', async () => {
  let requested = false;
  const p = new BalanceProvider({ fetchImpl: async () => { requested = true; return reply({ wallet: { remaining: 1, spent: 0 } }); } });
  await assert.rejects(p.balance(context(custom({}, { url: 'wallet' }), { baseUrl: 'https://api.example/' + 'p'.repeat(BALANCE_LIMITS.url) })), config);
  assert.equal(requested, false);
});

test('legacy harmless URL query remains usable while new connections require structured query fields', async () => {
  const calls = [], p = provider({ data: { balance: 7 } }, calls);
  const result = await p.balance(context(undefined, { setting: { provider: 'custom-json', balancePath: '/balance?account=demo', balanceField: 'data.balance', balanceScale: 1, currency: 'USD' } }));
  assert.equal(result.totalBalance, 7); assert.equal(new URL(calls[0].url).search, '?account=demo');
  assert.throws(() => validateBalanceConnection(custom({}, { url: '/balance?account=demo' })), /query/);
});

test('explicit native token_usage converts raw quota before mapping scales and honors legacy divisor', async () => {
  const payload = { data: { object: 'token_usage', total_available: 1000000, total_used: 500000, total_granted: 1500000, unlimited_quota: false } };
  const p = provider(url => url.endsWith('/api/status') ? { success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } } : payload);
  const auto = await p.balance(context()); assert.equal(auto.totalBalance, 2); assert.equal(auto.totalUsed, 1);
  const explicit = await p.balance(context({ adapter: 'newapi', mapping: { confirmed: true } }));
  assert.equal(explicit.totalBalance, auto.totalBalance); assert.equal(explicit.totalUsed, auto.totalUsed);
  const scaled = await p.balance(context({ adapter: 'newapi', mapping: { confirmed: true, balanceScale: 2, usedScale: 3 } }));
  assert.equal(scaled.totalBalance, 4); assert.equal(scaled.totalUsed, 3);
  const legacy = await p.balance(context(undefined, { setting: { provider: 'newapi', quotaPerUnit: 1000000, currency: 'USD' } }));
  assert.equal(legacy.totalBalance, 1); assert.equal(legacy.totalUsed, 0.5);
  const raw = await p.newapi(context({ adapter: 'newapi', mapping: { confirmed: true } }));
  assert.equal(raw.meter.object, 'token_usage'); assert.equal(raw.meter.balanceScale, 1 / 500000);
});

test('explicit native token_usage rejects invalid raw contracts rather than falling back to other fields', async () => {
  const data = { object: 'token_usage', total_available: 1000000, total_used: 500000, total_granted: 1500000, unlimited_quota: false, remain_quota: 1000000, used_quota: 500000 };
  for (const patch of [{ total_granted: 7 }, { total_available: 0.5, total_granted: 500000.5 }, { total_used: true },
    { total_available: Number.MAX_SAFE_INTEGER + 1 }, { unlimited_quota: 'true' }, { total_available: [] }]) {
    await assert.rejects(provider({ data: { ...data, ...patch } }).balance(context({ adapter: 'newapi', mapping: { confirmed: true } })), shape);
  }
});

test('explicit credit_summary uses only converted balance and unlimited summaries never observe', async () => {
  const data = { object: 'credit_summary', total_available: 1000000, total_granted: 1000000, total_used: 0 };
  const p = provider(data), c = context({ adapter: 'newapi', mapping: { confirmed: true } });
  const finite = await p.balance(c); assert.equal(finite.totalBalance, 2); assert.equal(finite.totalUsed, null); assert.equal(finite.counter, 'balance');
  const raw = await p.newapi(c); assert.equal(raw.meter.object, 'credit_summary'); assert.equal(raw.meter.usedField, ''); assert.equal(raw.meter.usedScale, null);
  const unlimited = await provider({ ...data, unlimited_quota: true }).balance(c);
  assert.equal(unlimited.totalBalance, null); assert.equal(unlimited.totalUsed, null); assert.equal(unlimited.canObserve, false); assert.equal(unlimited.counter, null);
  await assert.rejects(provider({ ...data, total_used: 1 }).balance(c), shape);
  const legacy = await provider({ data: { total_available: 2, total_used: 1, total_granted: 3 } }).balance(c);
  assert.equal(legacy.totalBalance, 2); assert.equal(legacy.totalUsed, 1); assert.notEqual(legacy.meterId, finite.meterId);
});
