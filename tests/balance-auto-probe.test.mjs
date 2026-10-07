import test from 'node:test';
import assert from 'node:assert/strict';
import { BalanceProvider, ProviderError } from '../runtime/providers.mjs';
import { validateBalanceConnection } from '../runtime/balance-contract.mjs';
import { AUTO_PROTOCOL_REGISTRY, buildAutoCandidates } from '../runtime/balance-auto-probe.mjs';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const miss = () => json({}, 404);
const rawToken = (overrides = {}) => ({ code: true, data: { object: 'token_usage', total_available: 1000000, total_used: 500000, total_granted: 1500000, unlimited_quota: false, ...overrides } });
const metadata = (overrides = {}) => ({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD', display_in_currency: true, ...overrides } });
const context = (balanceConnection, extra = {}) => ({ accountId: 'synthetic-account', providerName: 'Fixture', baseUrl: 'https://example.test/v1', key: 'SYNTHETIC_SECRET', setting: { provider: 'auto', currency: 'USD', quotaPerUnit: 500000, billingUsageDivisor: 100 }, ...(balanceConnection ? { balanceConnection } : {}), ...extra });
const fixture = (route, options = {}) => {
  const calls = [];
  const provider = new BalanceProvider({ ...options, fetchImpl: async (url, init) => { calls.push({ url, init }); return route(new URL(url), init); } });
  return { provider, calls };
};
const nativeRoute = (url, init) => url.pathname.endsWith('/api/usage/token/') ? json(rawToken()) : url.pathname.endsWith('/api/status') ? json(metadata()) : miss();

test('registry records metadata, billing pairs and management requirements without probing management paths', () => {
  assert.equal(AUTO_PROTOCOL_REGISTRY.length, 13);
  assert.equal(AUTO_PROTOCOL_REGISTRY.find(x => x.id === 'site-metadata').auth, 'none');
  const candidates = buildAutoCandidates('https://example.test/proxy/v1', validateBalanceConnection({ adapter: 'auto' }));
  assert.equal(new Set(candidates.map(x => x.id + x.url + (x.usageUrl || ''))).size, candidates.length);
  assert.ok(candidates.every(x => !/\/api\/user\/self|\/credits$/.test(x.url)));
  assert.equal(candidates[0].url, 'https://example.test/proxy/api/usage/token/');
});

test('native raw quota is automatically converted with anonymous metadata then only the hit is refreshed', async () => {
  const { provider, calls } = fixture(nativeRoute);
  const c = context({ adapter: 'auto', request: { envQuery: { tenant: 'TENANT' } } }, { authHeaders: { 'X-Client': 'PRIVATE_CLIENT' }, balanceSecrets: { TENANT: 'PRIVATE_TENANT' } });
  const first = await provider.balance(c);
  assert.equal(first.totalBalance, 2); assert.equal(first.totalUsed, 1); assert.equal(first.currency, 'USD');
  assert.equal(first.canObserve, true); assert.equal(first.counter, 'used'); assert.equal(first.detection.status, 'matched'); assert.equal(first.detection.attempted, 2);
  const metaCall = calls.find(x => new URL(x.url).pathname.endsWith('/api/status'));
  assert.equal(metaCall.init.headers.Authorization, undefined); assert.equal(metaCall.init.headers.authorization, undefined); assert.equal(metaCall.init.headers['X-Client'], undefined);
  assert.equal(new URL(metaCall.url).search, ''); assert.equal(metaCall.init.body, undefined);
  calls.length = 0;
  const second = await provider.balance(c);
  assert.equal(second.detection.cached, true); assert.equal(second.detection.attempted, 1); assert.equal(calls.length, 1);
  assert.equal(second.meterId, first.meterId);
  assert.equal(JSON.stringify(second).includes('PRIVATE_'), false); assert.equal(JSON.stringify(second).includes('SYNTHETIC_SECRET'), false);
});

test('native unlimited keeps a trusted used counter while unknown raw units offer no confirmation proof', async () => {
  for (const known of [true, false]) {
    const { provider } = fixture(url => url.pathname.endsWith('/api/usage/token/') ? json(rawToken({ unlimited_quota: true, total_available: 100000000, total_granted: 100500000 })) : url.pathname.endsWith('/api/status') && known ? json(metadata()) : miss());
    const result = await provider.balance(context());
    assert.equal(result.totalBalance, null);
    if (known) { assert.equal(result.balanceStatus, 'unlimited'); assert.equal(result.totalUsed, 1); assert.equal(result.canObserve, true); }
    else { assert.equal(result.balanceStatus, 'unconfirmed'); assert.equal(result.totalUsed, null); assert.equal(result.detection.needsConfirmation, false); assert.equal(provider.selectionFor(result), null); }
  }
});

test('legacy metadata currency flag can establish native units; contradictory or token display cannot', async () => {
  for (const [meta, expected] of [
    [metadata({ quota_display_type: undefined }), true],
    [metadata({ display_in_currency: false }), false],
    [metadata({ quota_display_type: 'TOKENS' }), false],
  ]) {
    const { provider } = fixture(url => url.pathname.endsWith('/api/usage/token/') ? json(rawToken()) : url.pathname.endsWith('/api/status') ? json(meta) : miss());
    const result = await provider.balance(context()); assert.equal(result.canObserve, expected);
    if (!expected) assert.equal(result.preview.balance, null);
  }
});

test('scope and units changing after metadata expiry produce a different meter', async () => {
  let at = 1000, divisor = 500000;
  const { provider } = fixture(url => url.pathname.endsWith('/api/usage/token/') ? json(rawToken()) : url.pathname.endsWith('/api/status') ? json(metadata({ quota_per_unit: divisor })) : miss(), { now: () => at });
  const first = await provider.balance(context()); divisor = 1000000; at += 61000;
  const second = await provider.balance(context());
  assert.equal(second.totalBalance, 1); assert.notEqual(second.meterId, first.meterId); assert.equal(second.detection.attempted, 2);
});

test('frequent cache hits do not postpone unit metadata verification indefinitely', async () => {
  let at = 1000, divisor = 500000;
  const { provider } = fixture(url => url.pathname.endsWith('/api/usage/token/') ? json(rawToken()) : url.pathname.endsWith('/api/status') ? json(metadata({ quota_per_unit: divisor })) : miss(), { now: () => at });
  await provider.balance(context()); at += 30000;
  assert.equal((await provider.balance(context())).detection.attempted, 1);
  divisor = 1000000; at += 31000;
  const result = await provider.balance(context()); assert.equal(result.detection.attempted, 2); assert.equal(result.totalBalance, 1);
});

test('invalid cached shape triggers bounded rediscovery and uses the new protocol meter', async () => {
  let mode = 'native';
  const { provider, calls } = fixture(url => mode === 'native' ? nativeRoute(url) : url.pathname === '/key/info' ? json({ key: 'opaque-masked-id', info: { max_budget: 8, spend: 3, budget_duration: '1d', budget_reset_at: '2026-10-06T00:00:00Z' } }) : miss());
  const first = await provider.balance(context()); mode = 'lite'; calls.length = 0;
  const second = await provider.balance(context());
  assert.equal(second.adapter, 'litellm-key-info'); assert.equal(second.totalBalance, 5); assert.equal(second.detection.cached, false);
  assert.notEqual(second.meterId, first.meterId); assert.equal(calls.filter(x => new URL(x.url).pathname === '/api/usage/token/').length, 1);
  calls.length = 0; const third = await provider.balance(context()); assert.equal(third.detection.cached, true); assert.equal(calls.length, 1);
});

test('per-candidate auth failures can find another supported ordinary-key endpoint', async () => {
  const { provider, calls } = fixture(url => url.pathname.endsWith('/api/usage/token/') ? json({ message: 'SYNTHETIC_SECRET' }, 403) : url.pathname === '/key/info' ? json({ key: 'masked', info: { max_budget: 10, spend: 2 } }) : miss());
  const result = await provider.balance(context()); assert.equal(result.totalBalance, 8); assert.equal(result.detection.status, 'matched');
  assert.equal(calls.some(x => /\/api\/user\/self|\/credits$/.test(x.url)), false); assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false);
});

test('authentication-only failures carry safe auth classification and do not claim unsupported', async () => {
  const { provider } = fixture(() => json({ error: 'SYNTHETIC_SECRET' }, 401));
  await assert.rejects(provider.balance(context()), error => error instanceof ProviderError && error.code === 'AUTH' && error.detection.status === 'auth' && error.detection.attempted > 1 && !error.message.includes('SYNTHETIC_SECRET'));
});

test('429 aborts the round and suppresses requests during bounded backoff', async () => {
  let at = 1000, limited = true;
  const { provider, calls } = fixture(url => limited ? json({}, 429, { 'retry-after': '2' }) : nativeRoute(url), { now: () => at });
  await assert.rejects(provider.balance(context()), e => e.code === 'HTTP_429' && e.detection.status === 'retry');
  assert.equal(calls.length, 1);
  await assert.rejects(provider.balance(context(), { redetect: true }), e => e.code === 'HTTP_429' && e.detection.attempted === 0);
  await assert.rejects(provider.balance(context({ adapter: 'auto', mapping: { currency: 'CNY' } })), e => e.code === 'HTTP_429' && e.detection.attempted === 0);
  assert.equal(calls.length, 1); at += 2001; limited = false;
  assert.equal((await provider.balance(context())).canObserve, true);
});

test('per-request timeout and whole-round budget bound hung injected fetches', async () => {
  const started = Date.now(); let aborted = 0;
  const { provider, calls } = fixture((url, init) => { init.signal.addEventListener('abort', () => aborted++); return new Promise(() => {}); }, { probeTimeoutMs: 20, probeBudgetMs: 45 });
  await assert.rejects(provider.balance(context()), e => e.transient === true && e.detection.status === 'retry');
  assert.ok(Date.now() - started < 2000); assert.ok(calls.length <= 3); assert.ok(aborted >= 1);
});

test('request cap and server failures remain retryable instead of reporting unsupported', async () => {
  const capped = fixture(() => miss(), { maxProbeRequests: 1 });
  await assert.rejects(capped.provider.balance(context()), e => e.code === 'PROBE_LIMIT' && e.detection.status === 'retry');
  assert.equal(capped.calls.length, 1);
  const failing = fixture(() => json({}, 503));
  await assert.rejects(failing.provider.balance(context()), e => e.transient === true && e.detection.status === 'retry');
  const unavailable = fixture(() => miss());
  const result = await unavailable.provider.balance(context()); assert.equal(result.balanceStatus, 'unsupported'); assert.equal(result.detection.status, 'not-found');
});

test('compatible USD assumption is a private selection proof, never a confirmed balance', async () => {
  const { provider, calls } = fixture(url => url.pathname === '/v1/dashboard/billing/subscription' ? json({ object: 'billing_subscription', hard_limit_usd: 50 }) : url.pathname === '/v1/dashboard/billing/usage' ? json({ object: 'list', total_usage: 100 }) : miss());
  const result = await provider.balance(context());
  assert.equal(result.balanceStatus, 'unconfirmed'); assert.equal(result.preview.balance, 49); assert.equal(result.totalBalance, null);
  assert.equal(result.detection.needsConfirmation, true); assert.match(result.detection.label, /USD.*假设/);
  const selection = provider.selectionFor(result); assert.equal(selection.adapter, 'billing'); assert.equal(selection.request.url, 'https://example.test/v1');
  assert.equal(selection.mapping.confirmed, false); assert.equal(selection.mapping.scope, 'custom'); assert.deepEqual(validateBalanceConnection(selection), selection);
  assert.equal(provider.selectionFor({ ...result }), null); assert.equal(JSON.stringify(result).includes('/dashboard/billing'), false);
  const uniqueRequests = calls.map(x => x.url + ':' + !!x.init.headers.authorization);
  assert.equal(new Set(uniqueRequests).size, uniqueRequests.length);
  selection.mapping.confirmed = true;
  const chosen = await provider.balance(context(selection)); assert.equal(chosen.totalBalance, 49); assert.equal(chosen.canObserve, true);
});

test('100M sentinel is never finite or manually confirmable as huge funds', async () => {
  for (const known of [false, true]) {
    const { provider } = fixture(url => url.pathname.endsWith('/subscription') ? json({ object: 'billing_subscription', hard_limit_usd: 100000000, soft_limit_usd: 100000000, system_hard_limit_usd: 100000000 }) : url.pathname.endsWith('/usage') ? json({ object: 'list', total_usage: 23880 }) : url.pathname.endsWith('/api/status') && known ? json(metadata()) : miss());
    const result = await provider.balance(context()); assert.equal(result.totalBalance, null);
    if (known) { assert.equal(result.balanceStatus, 'unlimited'); assert.equal(result.totalUsed, 238.8); assert.equal(result.balanceScope, 'api-key-quota'); }
    else { assert.equal(result.preview.balance, null); assert.equal(result.detection.needsConfirmation, false); assert.equal(provider.selectionFor(result), null); }
  }
});

test('OpenRouter ordinary keys use key limits, not management credits, and null remains unlimited', async () => {
  const { provider, calls } = fixture(url => url.pathname === '/api/v1/key' ? json({ data: { limit: null, limit_remaining: null, usage: 3, rate_limit: -1 } }) : assert.fail('unexpected management endpoint'));
  const result = await provider.balance(context(undefined, { baseUrl: 'https://openrouter.ai/api/v1' }));
  assert.equal(result.balanceStatus, 'unlimited'); assert.equal(result.totalUsed, 3); assert.equal(result.balanceScope, 'api-key-quota'); assert.equal(calls.length, 1);
  const selection = provider.selectionFor(result); assert.equal(selection.mapping.unlimitedValue, null);
  selection.mapping.confirmed = true; assert.equal((await provider.balance(context(selection, { baseUrl: 'https://openrouter.ai/api/v1' }))).balanceStatus, 'unlimited');
});

test('explicit dedicated OpenRouter credits and official SiliconFlow have supported currency contracts', async () => {
  const credits = fixture(() => json({ data: { total_credits: 20, total_usage: 3 } }));
  const c = context({ adapter: 'auto', request: { url: 'https://openrouter.ai/api/v1/credits', auth: { type: 'bearer', keyEnv: 'MANAGEMENT_KEY' } } }, { baseUrl: 'https://openrouter.ai/api/v1', balanceSecrets: { MANAGEMENT_KEY: 'synthetic-management' } });
  const account = await credits.provider.balance(c); assert.equal(account.totalBalance, 17); assert.equal(account.balanceScope, 'account'); assert.equal(credits.calls.length, 1);
  for (const [hostname, currency] of [['api.siliconflow.cn', 'CNY'], ['api.siliconflow.com', 'USD']]) {
    const sf = fixture(() => json({ data: { balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88' } }));
    const result = await sf.provider.balance(context(undefined, { baseUrl: 'https://' + hostname + '/v1' }));
    assert.equal(result.totalBalance, 88.88); assert.equal(result.currency, currency); assert.equal(result.detection.attempted, 1);
  }
});

test('credit_summary fake zero is excluded and native explicit quotas use the correct raw scale', async () => {
  const { provider } = fixture(() => json({ object: 'credit_summary', total_available: 1000000, total_granted: 1000000, total_used: 0 }));
  const auto = await provider.balance(context()); assert.equal(auto.canObserve, false);
  const explicit = await provider.balance(context({ adapter: 'newapi', mapping: { confirmed: true } }));
  assert.equal(explicit.totalBalance, 2); assert.equal(explicit.totalUsed, null); assert.equal(explicit.counter, 'balance');
});

test('native slash spelling fallback stays bounded and same-origin without following Location', async () => {
  for (const rejection of ['redirect-response', 'redirect-error', 'missing']) {
    const { provider, calls } = fixture(url => {
      if (url.pathname === '/api/usage/token/') {
        if (rejection === 'redirect-error') throw new TypeError('unexpected redirect to untrusted host');
        return rejection === 'redirect-response' ? new Response(null, { status: 307, headers: { location: 'https://untrusted.test/steal' } }) : miss();
      }
      if (url.pathname === '/api/usage/token') return json(rawToken());
      if (url.pathname === '/api/status') return json(metadata());
      return miss();
    });
    const first = await provider.balance(context());
    assert.equal(first.totalBalance, 2); assert.equal(first.detection.attempted, 3);
    assert.ok(calls.every(call => new URL(call.url).origin === 'https://example.test' && call.init.redirect === 'error'));
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/api/usage/token/', '/api/usage/token', '/api/status']);
    calls.length = 0;
    const cached = await provider.balance(context()); assert.equal(cached.detection.cached, true); assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).pathname, '/api/usage/token');
  }
});

test('inconsistent raw quotas cannot become an automatically confirmed monetary balance', async () => {
  const { provider } = fixture(url => /\/api\/usage\/token\/?$/.test(url.pathname) ? json(rawToken({ total_granted: 999999 })) : url.pathname === '/api/status' ? json(metadata()) : miss());
  const result = await provider.balance(context());
  assert.equal(result.canObserve, false); assert.equal(result.totalBalance, null); assert.equal(result.detection.status, 'not-found');
});

test('candidate refresh reuses only its plan and keeps neither amounts nor credentials in the plan cache', async () => {
  let rawUsed = 100;
  const { provider, calls } = fixture(url => url.pathname === '/v1/dashboard/billing/subscription' ? json({ hard_limit_usd: 50 }) : url.pathname === '/v1/dashboard/billing/usage' ? json({ total_usage: rawUsed }) : miss());
  const first = await provider.balance(context()); assert.equal(first.detection.status, 'candidate'); assert.ok(calls.length > 2);
  rawUsed = 200; calls.length = 0;
  const second = await provider.balance(context());
  assert.equal(second.detection.status, 'candidate'); assert.equal(second.detection.cached, true); assert.equal(second.preview.balance, 48);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/v1/dashboard/billing/subscription', '/v1/dashboard/billing/usage']);
  const entry = [...provider.auto.cache.values()][0];
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'item', 'metadata', 'metadataAt', 'trust']);
  assert.equal(JSON.stringify(entry).includes('SYNTHETIC_SECRET'), false); assert.equal('value' in entry, false); assert.equal('selection' in entry, false);
  assert.ok(provider.selectionFor(second));
});

test('candidate plan invalidation rediscovers a recovered stronger endpoint', async () => {
  let mode = 'candidate';
  const { provider, calls } = fixture(url => mode === 'native' ? nativeRoute(url) : url.pathname === '/v1/dashboard/billing/subscription' ? json({ hard_limit_usd: 50 }) : url.pathname === '/v1/dashboard/billing/usage' ? json({ total_usage: 100 }) : miss());
  await provider.balance(context()); mode = 'native'; calls.length = 0;
  const result = await provider.balance(context());
  assert.equal(result.detection.status, 'matched'); assert.equal(result.detection.cached, false); assert.equal(result.totalBalance, 2);
  assert.equal(calls.filter(call => new URL(call.url).pathname === '/v1/dashboard/billing/subscription').length, 1);
});

test('candidate plan TTL is not extended by ordinary refresh and redetect bypasses it', async () => {
  for (const trigger of ['ttl', 'redetect']) {
    let at = 1000, nativeAvailable = false;
    const { provider, calls } = fixture(url => nativeAvailable && /\/api\/usage\/token\/?$/.test(url.pathname) ? json(rawToken()) :
      url.pathname === '/api/status' && nativeAvailable ? json(metadata()) :
      url.pathname === '/v1/dashboard/billing/subscription' ? json({ hard_limit_usd: 50 }) : url.pathname === '/v1/dashboard/billing/usage' ? json({ total_usage: 100 }) : miss(), { now: () => at });
    await provider.balance(context()); nativeAvailable = true; at += 500000;
    const cached = await provider.balance(context()); assert.equal(cached.detection.status, 'candidate'); assert.equal(cached.detection.cached, true);
    calls.length = 0; if (trigger === 'ttl') at += 100001;
    const result = await provider.balance(context(), { redetect: trigger === 'redetect' });
    assert.equal(result.detection.status, 'matched'); assert.equal(result.detection.cached, false); assert.equal(result.totalBalance, 2);
    assert.ok(calls.some(call => new URL(call.url).pathname === '/api/usage/token/'));
  }
});

test('clear not-found is cached for 120 seconds and explicit redetect can recover immediately', async () => {
  for (const trigger of ['ttl', 'redetect']) {
    let at = 1000, available = false;
    const { provider, calls } = fixture(url => available ? nativeRoute(url) : miss(), { now: () => at });
    const initial = await provider.balance(context()); assert.equal(initial.detection.status, 'not-found'); assert.ok(calls.length > 0);
    available = true; calls.length = 0; at += 119999;
    const cached = await provider.balance(context());
    assert.equal(cached.balanceStatus, 'unsupported'); assert.equal(cached.detection.cached, true); assert.equal(cached.detection.attempted, 0); assert.equal(calls.length, 0);
    if (trigger === 'ttl') at += 2;
    const recovered = await provider.balance(context(), { redetect: trigger === 'redetect' });
    assert.equal(recovered.detection.status, 'matched'); assert.equal(recovered.totalBalance, 2);
  }
});

test('auth network server and interrupted rounds never create a negative unsupported cache', async () => {
  for (const kind of ['auth', 'network', 'server', 'limit']) {
    let recovered = false;
    const { provider, calls } = fixture(url => {
      if (recovered) return nativeRoute(url);
      if (kind === 'auth') return json({}, 403);
      if (kind === 'server') return json({}, 503);
      if (kind === 'network') throw new TypeError('synthetic connection failure');
      return miss();
    }, { maxProbeRequests: kind === 'limit' ? 1 : 16 });
    await assert.rejects(provider.balance(context()), error => ['auth', 'retry'].includes(error.detection.status));
    assert.equal(provider.auto.negative.size, 0);
    recovered = true; provider.auto.maxRequests = 16; calls.length = 0;
    const result = await provider.balance(context()); assert.equal(result.detection.status, 'matched'); assert.ok(calls.length > 0);
  }
});

test('preview and live providers can share rate backoff without sharing detection caches', async () => {
  const shared = new Map();
  const live = fixture(() => json({}, 429, { 'retry-after': '30' }), { probeBackoff: shared });
  const preview = fixture(nativeRoute, { probeBackoff: shared });
  await assert.rejects(live.provider.balance(context()), e => e.code === 'HTTP_429');
  assert.equal(live.provider.auto.backoff, shared); assert.equal(preview.provider.auto.backoff, shared);
  assert.notEqual(live.provider.auto.cache, preview.provider.auto.cache); assert.notEqual(live.provider.auto.negative, preview.provider.auto.negative);
  live.provider.invalidateDetection(context()); preview.provider.invalidateDetection(context());
  await assert.rejects(preview.provider.balance(context(), { redetect: true }), e => e.code === 'HTTP_429' && e.detection.attempted === 0);
  assert.equal(preview.calls.length, 0); assert.equal(shared.size, 1);
  const unrelated = fixture(nativeRoute);
  assert.notEqual(unrelated.provider.auto.backoff, shared); assert.equal((await unrelated.provider.balance(context())).canObserve, true);
});

test('invalidateDetection removes only the selected plan or negative hint and retains other accounts', async () => {
  let found = true;
  const { provider } = fixture(url => found ? nativeRoute(url) : miss());
  const first = context(), second = context(undefined, { accountId: 'second-account' });
  await provider.balance(first); await provider.balance(second);
  assert.equal(provider.auto.cache.size, 2); assert.equal(provider.invalidateDetection(first), true); assert.equal(provider.auto.cache.size, 1);
  assert.equal((await provider.balance(second)).detection.cached, true);
  assert.equal((await provider.balance(first)).detection.cached, false);
  provider.invalidateDetection(first); found = false;
  await provider.balance(first); assert.equal(provider.auto.negative.size, 1);
  assert.equal(provider.invalidateDetection(first), true); assert.equal(provider.auto.negative.size, 0);
  assert.equal(provider.auto.cache.size, 1);
});
