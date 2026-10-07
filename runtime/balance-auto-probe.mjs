import { decimalDifference } from './money-precision.mjs';
import { parseAutoResponse } from './balance-auto-parsers.mjs';

// Source-backed registrations, not thirteen independent brands or a promise
// to send thirteen requests. Billing parts form pairs; metadata is anonymous;
// management-only registrations are never probed with an inherited API key.
export const AUTO_PROTOCOL_REGISTRY = Object.freeze([
  { id: 'newapi-token-usage', path: '/api/usage/token/', aliases: Object.freeze(['/api/usage/token']), kind: 'balance', auth: 'api-key' },
  { id: 'billing-subscription', path: '/dashboard/billing/subscription', kind: 'billing-part', auth: 'api-key' },
  { id: 'billing-usage', path: '/dashboard/billing/usage', kind: 'billing-part', auth: 'api-key' },
  { id: 'billing-v1-subscription', path: '/v1/dashboard/billing/subscription', kind: 'billing-part', auth: 'api-key' },
  { id: 'billing-v1-usage', path: '/v1/dashboard/billing/usage', kind: 'billing-part', auth: 'api-key' },
  { id: 'site-metadata', path: '/api/status', kind: 'metadata', auth: 'none' },
  { id: 'dashboard-user', path: '/api/user/self', kind: 'explicit-only', auth: 'management-key' },
  { id: 'openrouter-credits', path: '/api/v1/credits', kind: 'explicit-only', auth: 'management-key' },
  { id: 'openrouter-key', path: '/api/v1/key', kind: 'balance', auth: 'api-key' },
  { id: 'litellm-key-info', path: '/key/info', kind: 'balance', auth: 'api-key' },
  { id: 'siliconflow-cn', path: '/v1/user/info', host: 'api.siliconflow.cn', kind: 'balance', auth: 'api-key' },
  { id: 'siliconflow-com', path: '/v1/user/info', host: 'api.siliconflow.com', kind: 'balance', auth: 'api-key' },
  { id: 'deepseek', path: '/user/balance', kind: 'balance', auth: 'api-key' },
].map(Object.freeze));

const LABELS = Object.freeze({ 'newapi-token-usage': '原生密钥额度', billing: '兼容账单额度',
  'openrouter-key': 'OpenRouter 密钥额度', 'openrouter-credits': 'OpenRouter 账户余额',
  'litellm-key-info': 'LiteLLM 密钥预算', 'siliconflow-user-info': 'SiliconFlow 账户余额', deepseek: 'API 账户余额' });
const numeric = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, transient = false) => Object.assign(new Error(message), { code, transient });
const retryCode = code => ['NETWORK', 'PROBE_TIMEOUT', 'PROBE_DEADLINE', 'PROBE_LIMIT'].includes(code) || /^HTTP_5\d\d$/.test(code);
const authCode = code => ['AUTH', 'NO_KEY', 'HTTP_401', 'HTTP_403'].includes(code);
const fatalCode = code => ['CONFIG', 'NO_KEY', 'HTTP_429', 'PROBE_DEADLINE', 'PROBE_LIMIT'].includes(code);
const unique = values => [...new Set(values)];
function address(origin, root, path) { return new URL((root + path).replace(/\/{2,}/g, '/'), origin).href; }

export function buildAutoCandidates(baseUrl, protocol) {
  const base = new URL(baseUrl); base.search = ''; base.hash = '';
  const exact = protocol.request.url ? new URL(protocol.request.url, base.href.replace(/\/$/, '') + '/') : null;
  const origin = exact?.origin || base.origin, original = (exact?.pathname || base.pathname).replace(/\/$/, '');
  const prefix = original.replace(/\/v\d+(?:\.\d+)?$/i, '');
  const roots = unique([prefix, '']);
  const item = (id, path, root = prefix) => ({ id, url: exact?.href || address(origin, root, path), metadataUrl: address(origin, root, '/api/status') });
  const pair = (root, versioned) => ({ id: 'billing',
    url: address(origin, root, (versioned ? '/v1' : '') + '/dashboard/billing/subscription'),
    usageUrl: address(origin, root, (versioned ? '/v1' : '') + '/dashboard/billing/usage'),
    billingBase: address(origin, root, versioned ? '/v1' : '/').replace(/\/$/, ''), metadataUrl: address(origin, root, '/api/status') });
  let candidates;
  if (base.hostname === 'api.openai.com' && !exact) return [];
  if (exact?.hostname === 'openrouter.ai' && exact.pathname === '/api/v1/credits' &&
      ['bearer', 'header'].includes(protocol.request.auth.type) && protocol.request.auth.keyEnv) candidates = [item('openrouter-credits', '')];
  else if (base.hostname === 'openrouter.ai' && !exact) candidates = [item('openrouter-key', '/api/v1/key', '')];
  else if (base.hostname === 'api.deepseek.com' && !exact) candidates = [item('deepseek', '/user/balance', '')];
  else if (['api.siliconflow.cn', 'api.siliconflow.com'].includes(base.hostname) && !exact) candidates = [item('siliconflow-user-info', '/v1/user/info', '')];
  else {
    candidates = roots.flatMap(root => {
      const primary = item('newapi-token-usage', '/api/usage/token/', root), alias = new URL(primary.url);
      // A bounded spelling alias for this registered route only. Never follow
      // a Location header, and never alter its origin or invent another path.
      if (!/\/api\/usage\/token\/?$/.test(alias.pathname)) return [primary];
      alias.pathname = alias.pathname.endsWith('/') ? alias.pathname.slice(0, -1) : alias.pathname + '/';
      return [primary, { ...primary, url: alias.href }];
    });
    for (const root of roots) candidates.push(item('litellm-key-info', '/key/info', root), item('deepseek', '/user/balance', root), pair(root, true), pair(root, false));
    for (const root of roots) candidates.push(item('siliconflow-user-info', '/v1/user/info', root));
    if (exact) {
      candidates.unshift(item('openrouter-key', ''), item('openrouter-credits', ''));
      candidates = candidates.filter(c => c.id !== 'openrouter-credits' ||
        exact.hostname === 'openrouter.ai' && exact.pathname === '/api/v1/credits' &&
        ['bearer', 'header'].includes(protocol.request.auth.type) && !!protocol.request.auth.keyEnv);
      // An explicit auto URL historically defines a billing base, while native
      // parsers treat it as an exact endpoint. No independent host is invented.
      const explicitPair = pair(original, false); candidates.unshift(explicitPair);
    }
  }
  const seen = new Set();
  return candidates.filter(c => { const id = c.id + '\0' + c.url + '\0' + (c.usageUrl || ''); if (seen.has(id)) return false; seen.add(id); return true; });
}

function metadataSummary(payload) {
  if (!plain(payload?.data) || payload.success === false || payload.code === false || payload.error) return null;
  const d = payload.data;
  return { success: true, data: { quota_per_unit: numeric(d.quota_per_unit),
    quota_display_type: ['USD', 'CNY', 'TOKENS'].includes(d.quota_display_type) ? d.quota_display_type : null,
    display_in_currency: typeof d.display_in_currency === 'boolean' ? d.display_in_currency : null,
    usd_exchange_rate: numeric(d.usd_exchange_rate) } };
}

function parseDeepseek(payload, currency) {
  if (payload?.error || typeof payload?.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) return null;
  const chosen = payload.balance_infos.find(row => row?.currency === currency) || payload.balance_infos[0];
  if (!plain(chosen) || !['USD', 'CNY'].includes(chosen.currency)) return null;
  const balance = numeric(chosen.total_balance);
  if (balance === null) return null;
  return { adapter: 'deepseek', balanceScope: 'account', currency: chosen.currency, totalBalance: balance, totalUsed: null, unlimited: false, trust: 'verified',
    meter: { balanceField: 'balance_infos[currency=' + chosen.currency + '].total_balance', usedField: '', balanceScale: 1, usedScale: 1, counterWindow: 'balance' } };
}

function parseBilling(subscription, usage, metadata) {
  if (!plain(subscription) || !plain(usage) || subscription.error || usage.error) return null;
  const total = numeric(subscription.hard_limit_usd), rawUsed = numeric(usage.total_usage);
  if (total === null || rawUsed === null || rawUsed < 0) return null;
  const m = metadata?.data;
  const display = ['USD', 'CNY'].includes(m?.quota_display_type) ? m.quota_display_type :
    !m?.quota_display_type && m?.display_in_currency === true ? 'USD' : null;
  const sentinel = total === 100000000;
  const declaredSentinel = sentinel && subscription.object === 'billing_subscription' &&
    numeric(subscription.soft_limit_usd) === total && numeric(subscription.system_hard_limit_usd) === total;
  const used = rawUsed / 100;
  if (!Number.isFinite(used)) return null;
  const unitKnown = !!display && m?.display_in_currency !== false;
  const unknownRaw = m?.quota_display_type === 'TOKENS' || m?.display_in_currency === false;
  // All three known forks use this exact value for unlimited tokens. The
  // strict shape plus display metadata establish a usable key-used counter;
  // without that evidence it still must never become a huge finite balance.
  if (declaredSentinel && unitKnown) return { adapter: 'billing', balanceScope: 'api-key-quota', currency: display,
    totalBalance: null, totalUsed: used, unlimited: true, trust: 'verified',
    meter: { balanceField: 'hard_limit_usd', usedField: 'total_usage', balanceScale: 1, usedScale: 0.01,
      unlimitedField: 'hard_limit_usd', unlimitedValue: 100000000, counterWindow: 'lifetime', scopeEvidence: 'declared-unlimited-token' } };
  const balance = sentinel || unknownRaw ? null : decimalDifference(total, used);
  if (balance !== null && !Number.isFinite(balance)) return null;
  return { adapter: 'billing', balanceScope: 'custom', currency: display || 'USD', totalBalance: balance,
    totalUsed: sentinel || unknownRaw ? null : used, unlimited: declaredSentinel, trust: 'candidate',
    needsConfirmation: !sentinel && !unknownRaw,
    reason: sentinel ? '兼容接口返回不限额哨兵，不能作为账户资金；单位未充分证实' : unknownRaw ?
      '兼容账单使用原始配额，尚无可确认的货币单位' : unitKnown ?
      '兼容账单额度范围未声明，请核对账户或密钥范围' : '兼容账单按 USD 和美分用量假设预览，请核对原始单位与额度范围',
    meter: { balanceField: 'hard_limit_usd-total_usage', usedField: 'total_usage', balanceScale: 1, usedScale: 0.01,
      counterWindow: 'lifetime', scopeEvidence: 'unspecified-compatible-billing' } };
}

function selectionForValue(value, candidate, p) {
  if (value.trust === 'candidate' && !value.needsConfirmation) return null;
  const request = structuredClone(p.request);
  request.url = candidate.id === 'billing' ? candidate.billingBase : candidate.url;
  const mapping = { balanceField: 'data.balance', usedField: '', unlimitedField: '', unlimitedValue: true,
    scope: value.balanceScope, currency: value.currency, balanceScale: 1, usedScale: 1, confirmed: false };
  if (candidate.id === 'billing') {
    if (value.unlimited) { mapping.unlimitedField = 'hard_limit_usd'; mapping.unlimitedValue = 100000000; }
    return { adapter: 'billing', request, mapping };
  }
  if (candidate.id === 'deepseek') return { adapter: 'deepseek', request, mapping };
  if (candidate.id === 'newapi-token-usage') Object.assign(mapping, { balanceField: 'data.total_available', usedField: 'data.total_used',
    balanceScale: value.meter.balanceScale, usedScale: value.meter.usedScale, unlimitedField: 'data.unlimited_quota' });
  else if (candidate.id === 'openrouter-key') Object.assign(mapping, { balanceField: 'data.limit_remaining', usedField: 'data.usage', unlimitedField: 'data.limit', unlimitedValue: null });
  else if (candidate.id === 'siliconflow-user-info') mapping.balanceField = 'data.totalBalance';
  else return null; // Difference expressions and budget windows have no exact custom mapping.
  return { adapter: 'custom-json', request, mapping };
}

export class AutoBalanceProbe {
  constructor({ request, perRequestTimeoutMs = 3000, budgetMs = 15000, maxRequests = 16, cacheTtlMs = 600000, metadataTtlMs = 60000, negativeTtlMs = 120000, backoff = new Map(), now = Date.now } = {}) {
    this.request = request; this.perRequestTimeoutMs = perRequestTimeoutMs; this.budgetMs = budgetMs; this.maxRequests = maxRequests;
    this.cacheTtlMs = cacheTtlMs; this.metadataTtlMs = metadataTtlMs; this.negativeTtlMs = negativeTtlMs;
    this.now = now; this.cache = new Map(); this.negative = new Map(); this.backoff = backoff;
  }
  remember(map, key, value) { map.delete(key); map.set(key, value); if (map.size > 128) map.delete(map.keys().next().value); }
  async run(c, p, identity, { redetect = false } = {}) {
    const started = this.now(), memo = new Map(), errors = [];
    const rateIdentity = c.accountId + '\0' + new URL(c.baseUrl).origin;
    let attempted = 0, current = null, candidateResult = null, interrupted = false;
    const detection = (status, cached = false, value = null) => ({ status, protocolId: current?.id || '',
      label: status === 'candidate' && current?.id === 'billing' && value?.needsConfirmation ? '兼容账单（' + value.currency + ' 假设，需核对范围）' : LABELS[current?.id] || '自动识别余额接口',
      attempted, cached, needsConfirmation: status === 'candidate' && value?.needsConfirmation === true, ...(value?.reason ? { reason: value.reason } : {}) });
    const classified = (error, status = retryCode(error.code) || error.code === 'HTTP_429' ? 'retry' : 'auth') => {
      error.detection = detection(status); return error;
    };
    if ((this.backoff.get(rateIdentity) || 0) > started) throw classified(fail('HTTP_429', '余额接口正在限流退避，请稍后重试', true));
    if (redetect) { this.cache.delete(identity); this.negative.delete(identity); }
    const negativeAt = this.negative.get(identity);
    if (negativeAt !== undefined && started - negativeAt < this.negativeTtlMs) return { value: null, selection: null, detection: detection('not-found', true) };
    this.negative.delete(identity);
    const request = async (url, publicRequest = false) => {
      const key = (publicRequest ? 'public:' : 'auth:') + url;
      if (memo.has(key)) return memo.get(key);
      const remaining = this.budgetMs - (this.now() - started);
      if (remaining <= 0) throw fail('PROBE_DEADLINE', '余额探测尚未完成，请稍后重试', true);
      if (attempted >= this.maxRequests) throw fail('PROBE_LIMIT', '已达到本轮余额探测请求上限，请稍后重试', true);
      const timeoutMs = Math.max(1, Math.min(this.perRequestTimeoutMs, remaining)), controller = new AbortController();
      attempted++;
      const promise = (async () => {
        let timer;
        try {
          return await Promise.race([
            this.request(c, p, url, { publicRequest, timeoutMs, signal: controller.signal }),
            new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail('PROBE_TIMEOUT', '余额接口响应超时，请稍后重试', true)); }, timeoutMs); }),
          ]);
        } finally { clearTimeout(timer); }
      })();
      memo.set(key, promise); return promise;
    };
    const readMetadata = async (item, cached) => {
      if (typeof cached?.metadataAt === 'number' && this.now() - cached.metadataAt < this.metadataTtlMs) return { metadata: cached.metadata, metadataAt: cached.metadataAt };
      try { return { metadata: metadataSummary(await request(item.metadataUrl, true)), metadataAt: this.now() }; }
      catch (error) { errors.push(error); if (fatalCode(error.code)) throw error; return { metadata: null, metadataAt: this.now() }; }
    };
    const attempt = async (item, cached = null) => {
      current = item;
      const primary = await request(item.url);
      let metadata = null, metadataAt = null, value = null;
      if (item.id === 'billing') {
        // Validate enough shape before spending a second request on this pair.
        if (numeric(primary?.hard_limit_usd) === null) return null;
        const usage = await request(item.usageUrl);
        if (numeric(usage?.total_usage) === null) return null;
        ({ metadata, metadataAt } = await readMetadata(item, cached));
        value = parseBilling(primary, usage, metadata);
      } else if (item.id === 'deepseek') value = parseDeepseek(primary, p.mapping.currency);
      else {
        value = parseAutoResponse(item.id, primary, { baseUrl: item.url });
        if (item.id === 'newapi-token-usage' && value) {
          ({ metadata, metadataAt } = await readMetadata(item, cached));
          value = parseAutoResponse(item.id, primary, { baseUrl: item.url, metadata });
        }
      }
      if (!value) return null;
      const selection = selectionForValue(value, item, p);
      if (!selection) value.needsConfirmation = false;
      return { value, item, selection, metadata, metadataAt };
    };
    const finish = (found, cached = false) => {
      current = found.item;
      return { value: found.value, selection: found.selection, detection: detection(found.value.trust === 'verified' ? 'matched' : 'candidate', cached, found.value) };
    };
    const rememberPlan = (found, at = this.now()) => {
      // Keep only the request plan and public unit metadata. Amounts, response
      // bodies, selection descriptors and resolved credentials are never cached.
      this.remember(this.cache, identity, { item: found.item, metadata: found.metadata, metadataAt: found.metadataAt, trust: found.value.trust, at });
    };
    const handle = error => {
      errors.push(error);
      if (error.code === 'HTTP_429') {
        this.remember(this.backoff, rateIdentity, this.now() + Math.max(1000, Math.min(error.retryAfterMs || 30000, 3600000)));
        throw classified(error, 'retry');
      }
      if (['CONFIG', 'NO_KEY'].includes(error.code)) throw classified(error, 'auth');
      if (['PROBE_DEADLINE', 'PROBE_LIMIT'].includes(error.code)) interrupted = true;
    };
    const cached = this.cache.get(identity);
    if (cached && started - cached.at < this.cacheTtlMs) {
      try {
        const found = await attempt(cached.item, cached);
        if (found && (found.value.trust === 'verified' || cached.trust === 'candidate')) {
          const temporary = errors.find(error => retryCode(error.code));
          if (temporary) throw temporary;
          // The plan TTL starts at discovery, not at every ordinary refresh.
          rememberPlan(found, cached.at); return finish(found, true);
        }
        if (found) candidateResult = found;
      } catch (error) {
        handle(error);
        if (retryCode(error.code)) throw classified(error, 'retry');
      }
      this.cache.delete(identity);
    } else if (cached) this.cache.delete(identity);
    for (const item of buildAutoCandidates(c.baseUrl, p)) {
      if (interrupted) break;
      try {
        const found = await attempt(item);
        if (found?.value.trust === 'verified') {
          // Do not keep response bodies, API keys, or personally identifying fields.
          rememberPlan(found);
          return finish(found);
        }
        if (found && (!candidateResult || found.selection && !candidateResult.selection)) candidateResult = found;
      } catch (error) { handle(error); }
    }
    if (candidateResult) { rememberPlan(candidateResult); return finish(candidateResult); }
    const temporary = errors.find(error => retryCode(error.code));
    if (temporary || interrupted) throw classified(fail(temporary?.code || 'PROBE_DEADLINE', '余额探测未完成，接口暂不可用，请稍后重试', true), 'retry');
    if (errors.some(error => authCode(error.code))) throw classified(fail('AUTH', '已尝试的余额接口未授予此凭据查询权限', false), 'auth');
    current = null;
    const clearMismatch = error => ['HTTP_404', 'HTTP_405', 'NOT_JSON', 'SHAPE', 'REDIRECT'].includes(error.code) || /^HTTP_30[12378]$/.test(error.code);
    if (errors.every(clearMismatch)) this.remember(this.negative, identity, this.now());
    return { value: null, selection: null, detection: detection('not-found') };
  }
}
