import { decimalDifference } from './money-precision.mjs';

// These parsers recognize response contracts only. They never discover hosts,
// forward credentials, retain response bodies, or infer currency from settings.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numeric = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};
const nonnegative = value => { const n = numeric(value); return n !== null && n >= 0 ? n : null; };
const difference = (a, b) => { const n = decimalDifference(a, b); return Number.isFinite(n) ? n : null; };
const host = baseUrl => { try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return ''; } };
const safeWindow = value => typeof value === 'string' && /^[a-zA-Z0-9 ._:+-]{1,80}$/.test(value) ? value : null;
const result = (adapter, balanceScope, currency, totalBalance, totalUsed, unlimited, meter) => ({
  adapter, balanceScope, currency, totalBalance, totalUsed, unlimited, meter, trust: 'verified',
});
const candidate = (value, reason) => ({ ...value, totalBalance: null, totalUsed: null, currency: null,
  trust: 'candidate', reason, needsConfirmation: false });

function openRouterKey(payload, options) {
  const d = payload.data;
  if (!record(d) || !Object.hasOwn(d, 'limit')) return null;
  const usage = nonnegative(d.usage), unlimited = d.limit === null;
  const limit = nonnegative(d.limit), remaining = numeric(d.limit_remaining);
  if (usage === null || (!unlimited && (limit === null || remaining === null)) ||
      (unlimited && d.limit_remaining !== null && d.limit_remaining !== undefined)) return null;
  const value = result('openrouter-key', 'api-key-quota', 'USD', unlimited ? null : remaining, usage, unlimited, {
    balanceField: 'data.limit_remaining', usedField: 'data.usage', balanceScale: 1, usedScale: 1,
    unlimitedField: 'data.limit', unlimitedValue: null, counterWindow: 'lifetime',
    budgetWindow: safeWindow(d.limit_reset), includeByokInLimit: typeof d.include_byok_in_limit === 'boolean' ? d.include_byok_in_limit : null,
  });
  return host(options.baseUrl) === 'openrouter.ai' ? value : candidate(value, 'OpenRouter 响应来自非官方地址，币种与额度契约尚未证实');
}

function openRouterCredits(payload, options) {
  const d = payload.data;
  if (!record(d)) return null;
  const credits = nonnegative(d.total_credits), usage = nonnegative(d.total_usage);
  if (credits === null || usage === null) return null;
  const balance = difference(credits, usage);
  if (balance === null) return null;
  const value = result('openrouter-credits', 'account', 'USD', balance, usage, false, {
    balanceField: 'data.total_credits-data.total_usage', usedField: 'data.total_usage', balanceScale: 1, usedScale: 1, counterWindow: 'lifetime',
  });
  return host(options.baseUrl) === 'openrouter.ai' ? value : candidate(value, 'OpenRouter 响应来自非官方地址，币种与账户范围尚未证实');
}

function liteLLM(payload) {
  const d = payload.info;
  if (!record(d) || !Object.hasOwn(d, 'max_budget') ||
      ![payload.key, d.key_name, d.token].some(v => typeof v === 'string' && v.length > 0)) return null;
  const spend = nonnegative(d.spend), unlimited = d.max_budget === null, budget = numeric(d.max_budget);
  if (spend === null || (!unlimited && budget === null)) return null;
  const balance = unlimited ? null : difference(budget, spend);
  if (!unlimited && balance === null) return null;
  const duration = safeWindow(d.budget_duration), reset = safeWindow(d.budget_reset_at);
  return result('litellm-key-info', 'api-key-quota', 'USD', balance, spend, unlimited, {
    balanceField: 'info.max_budget-info.spend', usedField: 'info.spend', balanceScale: 1, usedScale: 1,
    unlimitedField: 'info.max_budget', unlimitedValue: null,
    counterWindow: duration || reset ? 'budget-window' : 'lifetime', budgetDuration: duration, budgetResetAt: reset,
  });
}

function siliconFlow(payload, options) {
  const d = payload.data;
  if (!record(d) || numeric(d.balance) === null || numeric(d.chargeBalance) === null) return null;
  const balance = numeric(d.totalBalance);
  if (balance === null) return null;
  const hostname = host(options.baseUrl);
  const currency = hostname === 'api.siliconflow.cn' ? 'CNY' : hostname === 'api.siliconflow.com' ? 'USD' : null;
  const value = result('siliconflow-user-info', 'account', currency, balance, null, false, {
    balanceField: 'data.totalBalance', usedField: '', balanceScale: 1, usedScale: 1, counterWindow: 'balance',
  });
  return currency ? value : candidate(value, '非 SiliconFlow 官方区域地址，响应未提供可证实的币种');
}

function newApi(payload, options) {
  const d = payload.data;
  if (!record(d) || d.object !== 'token_usage' || typeof d.unlimited_quota !== 'boolean') return null;
  const available = numeric(d.total_available), used = nonnegative(d.total_used), granted = numeric(d.total_granted);
  // This endpoint emits Go integer quotas and computes granted from these two
  // exact fields. An object marker alone must not bless mixed units, fractions
  // or numbers already rounded outside JavaScript's safe integer range.
  if (![available, used, granted].every(Number.isSafeInteger) ||
      !Number.isSafeInteger(available + used) || granted !== available + used) return null;
  const m = options.metadata?.data;
  const divisor = record(m) ? numeric(m.quota_per_unit) : null;
  // Native quota is denominated in the base unit. Display CNY exchange rates
  // are only used by billing's display endpoint, not this raw quota endpoint.
  const provenUnit = record(m) && m.display_in_currency !== false &&
    (['USD', 'CNY'].includes(m.quota_display_type) || m.quota_display_type == null && m.display_in_currency === true);
  const valid = divisor !== null && divisor >= 1e-12 && divisor <= 1e12 && Number.isFinite(1 / divisor) && provenUnit &&
    options.metadata?.success !== false && options.metadata?.code !== false && !options.metadata?.error;
  const balance = valid ? available / divisor : null, spend = valid ? used / divisor : null;
  const finite = valid && Number.isFinite(balance) && Number.isFinite(spend);
  const value = result('newapi', 'api-key-quota', finite ? 'USD' : null,
    d.unlimited_quota ? null : balance, spend, d.unlimited_quota, {
      container: 'data', balanceField: 'total_available', usedField: 'total_used',
      balanceScale: finite ? 1 / divisor : null, usedScale: finite ? 1 / divisor : null,
      unlimitedField: 'unlimited_quota', unlimitedValue: true, counterWindow: 'lifetime',
    });
  return finite ? value : candidate(value, '已识别密钥原始 quota，但缺少有效单位元数据，不能作为货币余额');
}

export function parseAutoResponse(protocolId, payload, options = {}) {
  if (!record(payload) || payload.success === false || payload.code === false || payload.error) return null;
  switch (protocolId) {
    case 'openrouter-key': return openRouterKey(payload, options);
    case 'openrouter-credits': return openRouterCredits(payload, options);
    case 'litellm-key-info': return liteLLM(payload);
    case 'siliconflow-user-info': return siliconFlow(payload, options);
    case 'newapi-token-usage': return newApi(payload, options);
    default: return null;
  }
}
