import crypto from 'node:crypto';
import { decimalDifference } from './money-precision.mjs';
import { VERSION } from './paths.mjs';
import { BALANCE_LIMITS, validateBalanceConnection, validateBalanceRequestUrl } from './balance-contract.mjs';
import { AutoBalanceProbe } from './balance-auto-probe.mjs';

export class ProviderError extends Error {
  constructor(code, message, transient = false) { super(message); this.code = code; this.transient = transient; }
}

export async function readBoundedJsonText(response, maxBytes = 1024 * 1024) {
  const cancel = async () => { try { await response.body?.cancel(); } catch {} };
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) { await cancel(); throw new ProviderError('SHAPE', '余额响应过大'); }
  if (!response.body) return '';
  if (typeof response.body.getReader !== 'function') { await cancel(); throw new ProviderError('SHAPE', '余额接口返回了不支持的响应流'); }
  const reader = response.body.getReader(), chunks = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > maxBytes) { try { await reader.cancel(); } catch {} throw new ProviderError('SHAPE', '余额响应过大'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, count).toString('utf8');
  } catch (error) {
    try { await reader.cancel(); } catch {}
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('NETWORK', '余额响应中断，请稍后刷新', true);
  } finally { reader.releaseLock(); }
}

// JSON scalar amounts only: Number([]), Number(' ') and Number(true) must
// never manufacture a zero or a balance from a response with the wrong shape.
function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
function at(data, key) {
  if (!key) return undefined;
  let d = data;
  for (const part of key.split('.')) {
    if (!d || typeof d !== 'object' || ['__proto__', 'constructor', 'prototype'].includes(part) || !Object.hasOwn(d, part)) return undefined;
    d = d[part];
  }
  return d;
}
function amount(value, factor = 1) { const n = numeric(value); return n === null || !Number.isFinite(n * factor) ? null : n * factor; }
function convertedAmount(value, divisor, factor = 1) { const n = numeric(value); return n === null ? null : amount(n / divisor, factor); }
const configError = message => { throw new ProviderError('CONFIG', message); };
const safeString = (value, label) => { if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) configError(label + '格式无效'); return value; };
const blockedHeader = /^(?:host|cookie|set-cookie|connection|keep-alive|transfer-encoding|content-length|upgrade|trailer|te|proxy-.*|sec-.*)$/i;

function detectionIdentity(c, p, base) {
  // A settings preview may deliberately keep the wallet's accountId stable.
  // Its request or mapping can still change which response shape is accepted.
  return crypto.createHash('sha256').update(JSON.stringify({ accountId: c.accountId, base: base.href, protocol: p,
    legacyUnits: p.legacy ? [c.setting?.billingUsageDivisor, c.setting?.quotaPerUnit] : null })).digest('hex');
}

function protocol(c) {
  if (c.balanceConnection) {
    try { return { ...validateBalanceConnection(c.balanceConnection), legacy: false }; }
    catch { configError('余额连接配置无效，请检查请求参数与字段映射'); }
  }
  const s = c.setting || {};
  if (s.provider === 'custom-json') {
    try { validateBalanceRequestUrl(s.balancePath || '', { allowLegacyQuery: true }); }
    catch { configError('余额路径或查询参数无效；认证参数请使用高级余额连接的 envQuery'); }
  }
  return { adapter: s.provider || 'auto', legacy: true,
    request: { url: s.provider === 'custom-json' ? s.balancePath || '' : '', method: 'GET', auth: { type: 'inherit', keyEnv: '', header: '' }, headers: {}, envHeaders: {}, query: {}, envQuery: {}, body: null },
    mapping: { balanceField: s.balanceField || 'data.balance', usedField: s.usedField || '', unlimitedField: '', unlimitedValue: true, scope: 'custom', currency: s.currency || 'USD', balanceScale: s.balanceScale ?? 1, usedScale: s.balanceScale ?? 1, confirmed: s.provider !== 'auto' } };
}
function baseUrl(c) {
  let u; try { u = new URL(c.baseUrl); } catch { configError('API 地址无效'); }
  if (u.username || u.password || !['https:', 'http:'].includes(u.protocol)) configError('API 地址无效');
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) configError('API 地址须使用 HTTPS');
  // API request query parameters are never copied to a balance request.
  u.search = ''; u.hash = ''; return u;
}
function endpoint(c, p, adapter, suffix = '') {
  const base = baseUrl(c); let u;
  if (p.request.url) {
    if (/[\\\u0000-\u001f\u007f]/.test(p.request.url) || p.request.url.startsWith('//')) configError('余额 URL 无效');
    try { u = new URL(p.request.url, base.href.replace(/\/$/, '') + '/'); } catch { configError('余额 URL 无效'); }
  } else {
    u = new URL(base);
    if (adapter !== 'billing') u.pathname = u.pathname.replace(/\/v\d+(?:\.\d+)?\/?$/i, '/');
  }
  if (u.username || u.password || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) configError('余额 URL 无效或包含凭据');
  // Billing URL is a base directory; the other adapters accept exact endpoints.
  if (adapter === 'billing') u.pathname = u.pathname.replace(/\/$/, '') + '/dashboard/billing/' + suffix;
  else if (!p.request.url) u.pathname = u.pathname.replace(/\/$/, '') + (adapter === 'newapi' ? '/api/usage/token/' : '/user/balance');
  return u;
}
function secret(c, name) {
  const value = c.balanceSecrets && Object.hasOwn(c.balanceSecrets, name) ? c.balanceSecrets[name] : undefined;
  if (typeof value !== 'string' || !value) throw new ProviderError('NO_KEY', '未找到余额请求指定的环境变量');
  return safeString(value, '余额认证环境变量');
}
function requestOptions(c, p, destination) {
  const r = p.request, auth = r.auth, cross = destination.origin !== baseUrl(c).origin;
  if (cross && (!['bearer', 'header'].includes(auth.type) || !auth.keyEnv)) configError('跨域余额查询须明确指定独立的密钥环境变量，不能转发原服务认证');
  if (cross && (Object.keys(r.envHeaders).length || Object.keys(r.envQuery).length)) configError('跨域余额查询不允许附加环境变量请求头或查询参数');
  const headers = new Headers({ Accept: 'application/json', 'User-Agent': 'API-Balance-Whale/' + VERSION });
  const setHeader = (key, value) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || blockedHeader.test(key)) configError('余额请求头无效');
    try { headers.set(key, safeString(value, '余额请求头')); }
    catch { configError('余额请求头格式无效'); }
  };
  if (auth.type === 'inherit') {
    if (cross) configError('余额查询不可跨域继承认证');
    const inherited = new Set(Object.keys(c.authHeaders || {}).map(key => key.toLowerCase()));
    if ([...Object.keys(r.headers), ...Object.keys(r.envHeaders)].some(key => inherited.has(key.toLowerCase()))) configError('余额请求不能覆盖继承的服务商请求头；请移除重复项或选择专用认证');
    for (const [key, value] of Object.entries(c.authHeaders || {})) setHeader(key, value);
    if (c.key && !headers.has('Authorization')) setHeader('Authorization', 'Bearer ' + safeString(c.key, 'API 密钥'));
    if (!c.key && !Object.keys(c.authHeaders || {}).length && !Object.keys(r.envHeaders).length && !Object.keys(r.envQuery).length) throw new ProviderError('NO_KEY', '未找到当前 API 密钥。ChatGPT 订阅登录本身不提供 API 余额；可指定余额认证环境变量。');
  } else if (auth.type === 'bearer') setHeader('Authorization', 'Bearer ' + secret(c, auth.keyEnv));
  else if (auth.type === 'header') setHeader(auth.header, secret(c, auth.keyEnv));
  for (const [key, value] of Object.entries(r.headers)) {
    if (/^authorization$/i.test(key)) configError('余额请求不能覆盖认证头');
    setHeader(key, value);
  }
  for (const [key, name] of Object.entries(r.envHeaders)) {
    if (/^authorization$/i.test(key)) configError('余额请求不能覆盖认证头');
    setHeader(key, secret(c, name));
  }
  for (const [key, value] of Object.entries(r.query)) destination.searchParams.set(key, value);
  for (const [key, name] of Object.entries(r.envQuery)) destination.searchParams.set(key, secret(c, name));
  if (r.body !== null) headers.set('Content-Type', 'application/json');
  let headerBytes = 0; for (const [key, value] of headers) headerBytes += Buffer.byteLength(key + ': ' + value + '\r\n');
  if (headerBytes > BALANCE_LIMITS.headers || [...headers].length > BALANCE_LIMITS.entries) configError('余额请求头过大');
  const address = new URL(destination); address.search = '';
  if (Buffer.byteLength(destination.search) > BALANCE_LIMITS.query || Buffer.byteLength(address.href) > BALANCE_LIMITS.url) configError('余额请求 URL 或查询参数过大');
  const options = { method: r.method, headers: Object.fromEntries(headers), redirect: 'error' };
  if (r.body !== null) options.body = JSON.stringify(r.body);
  return options;
}
function unlimited(p, data, defaultField = '') { const key = p.mapping.unlimitedField || defaultField; return !!key && at(data, key) === (p.mapping.unlimitedField ? p.mapping.unlimitedValue : true); }
function label(scope, isUnlimited) { return isUnlimited ? '当前密钥不限额（非账户余额）' : scope === 'api-key-quota' ? '当前 API 密钥剩余额度' : scope === 'account' ? 'API 账户余额' : '自定义 API 余额'; }

export class BalanceProvider {
  constructor({ fetchImpl = fetch, timeoutMs = 12000, probeTimeoutMs = 3000, probeBudgetMs = 15000, maxProbeRequests = 16, probeBackoff, now = Date.now } = {}) {
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.selections = new WeakMap();
    this.auto = new AutoBalanceProbe({ perRequestTimeoutMs: probeTimeoutMs, budgetMs: probeBudgetMs, maxRequests: maxProbeRequests, backoff: probeBackoff, now,
      request: (c, p, url, { publicRequest, timeoutMs: requestTimeoutMs, signal }) => {
        const target = new URL(url);
        const options = publicRequest ? { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'API-Balance-Whale/' + VERSION } } : requestOptions(c, p, target);
        return this.json(target.href, options, { timeoutMs: requestTimeoutMs, signal });
      } });
    this.detected = this.auto.cache;
  }
  invalidateDetection(c) {
    const identity = detectionIdentity(c, protocol(c), baseUrl(c));
    const plan = this.auto.cache.delete(identity), negative = this.auto.negative.delete(identity);
    return plan || negative;
  }
  selectionFor(result) { const selection = this.selections.get(result); return selection ? structuredClone(selection) : null; }
  async json(url, keyOrOptions, { timeoutMs = this.timeoutMs, signal } = {}) {
    const options = typeof keyOrOptions === 'string' ? { headers: { Authorization: 'Bearer ' + safeString(keyOrOptions, 'API 密钥'), Accept: 'application/json', 'User-Agent': 'API-Balance-Whale/' + VERSION } } : keyOrOptions;
    let response;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    try { response = await this.fetch(url, { ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal }); }
    catch { throw new ProviderError('NETWORK', '余额接口暂时无法连接，请稍后刷新', true); }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      if (response.status === 401 || response.status === 403) throw new ProviderError('AUTH', '当前密钥无权访问此余额接口（HTTP ' + response.status + '）');
      const error = new ProviderError('HTTP_' + response.status, '余额接口返回 HTTP ' + response.status, response.status >= 500 || response.status === 429);
      if (response.status === 429) {
        const retry = response.headers.get('retry-after'), seconds = Number(retry);
        error.retryAfterMs = retry && Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retry || '') - Date.now()) || 30000;
      }
      throw error;
    }
    if (!(response.headers.get('content-type') || '').includes('json')) {
      try { await response.body?.cancel(); } catch {}
      throw new ProviderError('NOT_JSON', '服务商返回了网页或验证页，当前路径不是可用的余额接口');
    }
    const raw = await readBoundedJsonText(response); let data;
    try { data = JSON.parse(raw); } catch { throw new ProviderError('SHAPE', '余额响应不是有效 JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ProviderError('SHAPE', '余额响应须为 JSON 对象');
    if (data.success === false || data.code === false) throw new ProviderError('API_ERROR', '服务商拒绝了余额查询，请检查密钥权限和接口类型');
    return data;
  }
  request(c, p, adapter, suffix) { const url = endpoint(c, p, adapter, suffix), options = requestOptions(c, p, url); return this.json(url.href, options); }
  async billing(c, p = protocol(c)) {
    const [subscription, usage] = await Promise.all([this.request(c, p, 'billing', 'subscription'), this.request(c, p, 'billing', 'usage')]);
    const balanceScale = p.legacy ? 1 : p.mapping.balanceScale;
    const usedScale = p.legacy ? 1 / (c.setting.billingUsageDivisor ?? 100) : p.mapping.usedScale / 100;
    const total = amount(subscription.hard_limit_usd, balanceScale), used = convertedAmount(usage.total_usage, p.legacy ? c.setting.billingUsageDivisor ?? 100 : 100, p.legacy ? 1 : p.mapping.usedScale);
    const declaredSentinel = subscription.object === 'billing_subscription' && numeric(subscription.hard_limit_usd) === 100000000 &&
      numeric(subscription.soft_limit_usd) === 100000000 && numeric(subscription.system_hard_limit_usd) === 100000000;
    const isUnlimited = unlimited(p, subscription) || declaredSentinel;
    if ((!isUnlimited && total === null) || used === null || used < 0) throw new ProviderError('SHAPE', '兼容账单接口缺少有效的额度或消耗字段');
    const balance = isUnlimited ? null : decimalDifference(total, used);
    if (balance !== null && !Number.isFinite(balance)) throw new ProviderError('SHAPE', '余额换算结果超出有效范围');
    return { totalBalance: balance, totalGranted: isUnlimited ? null : total, totalUsed: used, currency: p.legacy ? 'USD' : p.mapping.currency, adapter: 'billing', balanceScope: declaredSentinel ? 'api-key-quota' : p.legacy ? 'account' : p.mapping.scope, unlimited: isUnlimited,
      unitNote: 'total_usage 默认按百分之一换算，再应用已确认的金额单位系数', meter: { balanceField: 'hard_limit_usd-total_usage', usedField: 'total_usage', balanceScale, usedScale, unlimitedField: declaredSentinel ? 'hard_limit_usd' : p.mapping.unlimitedField, unlimitedValue: declaredSentinel ? 100000000 : p.mapping.unlimitedValue } };
  }
  async newapi(c, p = protocol(c)) {
    const payload = await this.request(c, p, 'newapi'), d = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    const balanceScale = p.legacy ? 1 : p.mapping.balanceScale, usedScale = p.legacy ? 1 : p.mapping.usedScale;
    const nativeQuota = ['token_usage', 'credit_summary'].includes(d.object);
    const nativeUnlimited = nativeQuota && d.unlimited_quota === true;
    const isUnlimited = unlimited(p, p.mapping.unlimitedField ? payload : d, 'unlimited_quota') || nativeUnlimited;
    const directDivisor = nativeQuota ? p.legacy ? c.setting.quotaPerUnit ?? 500000 : 500000 : 1;
    let result;
    if (nativeQuota) {
      const available = numeric(d.total_available), used = numeric(d.total_used), granted = numeric(d.total_granted);
      const summary = d.object === 'credit_summary';
      const valid = [available, used, granted].every(Number.isSafeInteger) && used >= 0 &&
        (summary ? used === 0 && granted === available : typeof d.unlimited_quota === 'boolean' && Number.isSafeInteger(available + used) && granted === available + used);
      if (!valid) throw new ProviderError('SHAPE', '原生密钥额度字段须为安全整数，且总额与已用、剩余配额一致');
      const remainingAmount = convertedAmount(available, directDivisor, balanceScale);
      const usedAmount = summary ? null : convertedAmount(used, directDivisor, usedScale);
      const grantedAmount = convertedAmount(granted, directDivisor, balanceScale);
      if (remainingAmount === null || grantedAmount === null || !summary && usedAmount === null) throw new ProviderError('SHAPE', '原始密钥配额换算超出有效范围');
      result = { totalBalance: remainingAmount, totalGranted: isUnlimited ? null : grantedAmount, totalUsed: usedAmount,
        meter: { object: d.object, balanceField: 'total_available', usedField: summary ? '' : 'total_used',
          balanceScale: balanceScale / directDivisor, usedScale: summary ? null : usedScale / directDivisor, counterWindow: summary ? 'balance' : 'lifetime' } };
    } else {
      // Preserve the explicitly selected legacy, unmarked compatibility shape.
      // Its total_* values historically represented already converted amounts.
      const remaining = amount(d.total_available, balanceScale), used = amount(d.total_used, usedScale), total = amount(d.total_granted, balanceScale);
      if ((remaining !== null || isUnlimited) && used !== null) result = { totalBalance: remaining, totalGranted: total, totalUsed: used,
        meter: { object: 'legacy-unmarked', balanceField: 'total_available', usedField: 'total_used', balanceScale, usedScale } };
      else {
        const divisor = p.legacy ? c.setting.quotaPerUnit ?? 500000 : 500000;
        const rawRemaining = convertedAmount(d.remain_quota, divisor, balanceScale), rawUsed = convertedAmount(d.used_quota, divisor, usedScale);
        if (rawRemaining === null && !isUnlimited) throw new ProviderError('SHAPE', '密钥额度接口缺少有效金额；不能将空值当作余额为零');
        result = { totalBalance: rawRemaining, totalUsed: rawUsed, meter: { object: 'legacy-raw-quota', balanceField: 'remain_quota', usedField: 'used_quota', balanceScale: balanceScale / divisor, usedScale: usedScale / divisor } };
      }
    }
    if (result.totalUsed !== null && result.totalUsed < 0) throw new ProviderError('SHAPE', '累计消耗不能为负数');
    return { ...result, totalBalance: isUnlimited ? null : result.totalBalance, currency: p.mapping.currency, adapter: 'newapi', balanceScope: 'api-key-quota', unlimited: isUnlimited,
      meter: { ...result.meter, container: d === payload ? '' : 'data', unlimitedField: nativeUnlimited ? 'unlimited_quota' : p.mapping.unlimitedField || 'unlimited_quota', unlimitedValue: nativeUnlimited ? true : p.mapping.unlimitedField ? p.mapping.unlimitedValue : true } };
  }
  async custom(c, p = protocol(c)) {
    if (!p.request.url) configError('请先配置当前服务的余额路径和金额字段');
    const d = await this.request(c, p, 'custom-json'), m = p.mapping, isUnlimited = unlimited(p, d);
    const balance = amount(at(d, m.balanceField), m.balanceScale), used = m.usedField ? amount(at(d, m.usedField), m.usedScale) : null;
    if ((!isUnlimited && balance === null && (m.balanceField || used === null)) || (m.usedField && (used === null || used < 0))) throw new ProviderError('SHAPE', '所选字段不是有效金额');
    return { totalBalance: isUnlimited ? null : balance, totalUsed: used, currency: m.currency, adapter: 'custom-json', balanceScope: p.legacy ? 'custom' : m.scope, unlimited: isUnlimited,
      meter: { balanceField: m.balanceField, usedField: m.usedField, balanceScale: m.balanceScale, usedScale: m.usedScale, unlimitedField: m.unlimitedField, unlimitedValue: m.unlimitedValue } };
  }
  async deepseek(c, p = protocol(c)) {
    const d = await this.request(c, p, 'deepseek'), infos = d?.balance_infos;
    const chosen = Array.isArray(infos) && (infos.find(x => x?.currency === p.mapping.currency) || infos[0]);
    const balanceScale = p.legacy ? 1 : p.mapping.balanceScale, n = amount(chosen?.total_balance, balanceScale);
    if (n === null || typeof chosen.currency !== 'string' || !/^[A-Z]{3}$/.test(chosen.currency)) throw new ProviderError('SHAPE', '服务商没有返回有效余额或币种');
    return { totalBalance: n, totalUsed: null, currency: chosen.currency, adapter: 'deepseek', balanceScope: 'account', unlimited: false,
      meter: { balanceField: 'balance_infos[currency=' + chosen.currency + '].total_balance', usedField: '', balanceScale, usedScale: 1 } };
  }
  normalize(c, p, result, { verified = false, detection, selection } = {}) {
    const base = baseUrl(c);
    const common = { ok: true, accountId: c.accountId, providerName: c.providerName, baseUrl: base.href.replace(/\/$/, ''), dashboardUrl: c.dashboardUrl, updatedAt: new Date().toISOString() };
    if (!result) return { ...common, totalBalance: null, totalUsed: null, currency: p.mapping.currency, adapter: 'none', balanceScope: p.mapping.scope, balanceLabel: '当前连接不支持余额查询', balanceStatus: 'unsupported', canObserve: false, counter: null, meterId: null, unlimited: false, ...(detection ? { detection } : {}) };
    const confirmed = verified || (p.adapter !== 'auto' && p.mapping.confirmed);
    const counter = result.totalUsed !== null ? 'used' : result.totalBalance !== null ? 'balance' : null;
    const meterId = crypto.createHash('sha256').update(JSON.stringify({ version: 1, adapter: result.adapter, scope: result.balanceScope, currency: result.currency, counter, ...result.meter })).digest('hex');
    const { meter, trust, reason, needsConfirmation, ...publicResult } = result;
    const normalized = confirmed ? { ...common, ...publicResult, balanceLabel: label(result.balanceScope, result.unlimited), balanceStatus: result.unlimited ? 'unlimited' : 'finite', canObserve: counter !== null, counter, meterId } :
      { ...common, ...publicResult, currency: result.currency || p.mapping.currency, totalBalance: null, totalUsed: null, totalGranted: null, balanceLabel: reason || '余额字段与单位尚未确认', balanceStatus: 'unconfirmed', canObserve: false, counter: null, meterId,
        preview: { balance: result.totalBalance, used: result.totalUsed, currency: result.currency, scope: result.balanceScope, adapter: result.adapter } };
    if (detection) normalized.detection = detection;
    if (selection) {
      try { this.selections.set(normalized, validateBalanceConnection(selection)); }
      catch { if (normalized.detection) normalized.detection.needsConfirmation = false; }
    }
    return normalized;
  }
  async balance(c, { redetect = false } = {}) {
    const p = protocol(c), base = baseUrl(c);
    if (p.adapter === 'none') return this.normalize(c, p, null);
    if (!['auto', 'billing', 'newapi', 'deepseek', 'custom-json'].includes(p.adapter)) configError('未知余额接口类型');
    if (p.adapter === 'auto') {
      try {
        const found = await this.auto.run(c, p, detectionIdentity(c, p, base), { redetect });
        return this.normalize(c, p, found.value, { verified: found.value?.trust === 'verified', detection: found.detection, selection: found.selection });
      } catch (error) {
        const safe = error instanceof ProviderError ? error : new ProviderError(error.code || 'NETWORK', error.code ? error.message : '余额自动识别暂时不可用，请稍后重试', error.transient !== false);
        if (error.detection) safe.detection = error.detection;
        throw safe;
      }
    }
    const result = await this[p.adapter === 'custom-json' ? 'custom' : p.adapter](c, p);
    return this.normalize(c, p, result);
  }
}
