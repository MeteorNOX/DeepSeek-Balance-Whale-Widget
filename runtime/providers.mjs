import { rounded } from './paths.mjs';

export class ProviderError extends Error {
  constructor(code, message, transient = false) { super(message); this.code = code; this.transient = transient; }
}

export async function readBoundedJsonText(response, maxBytes = 1024 * 1024) {
  const cancel = async () => { try { await response.body?.cancel(); } catch {} };
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) { await cancel(); throw new ProviderError('SHAPE', '余额响应过大'); }
  // Real Node/Electron responses expose Web Streams. Do not silently fall
  // back to response.text(), which allocates an unlimited body first.
  if (!response.body) return '';
  if (typeof response.body.getReader !== 'function') { await cancel(); throw new ProviderError('SHAPE', '余额接口返回了不支持的响应流'); }
  const reader = response.body.getReader(), chunks = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new ProviderError('SHAPE', '余额响应过大');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, count).toString('utf8');
  } catch (error) {
    try { await reader.cancel(); } catch {}
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('NETWORK', '余额响应中断，请稍后刷新', true);
  } finally { reader.releaseLock(); }
}

function numeric(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}

function field(data, key) {
  let d = data;
  for (const part of key.split('.')) { if (!d || !Object.hasOwn(d, part)) return null; d = d[part]; }
  return numeric(d);
}

export class BalanceProvider {
  constructor({ fetchImpl = fetch, timeoutMs = 12000 } = {}) { this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.detected = new Map(); }
  async json(url, key) {
    let response;
    try {
      response = await this.fetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', 'User-Agent': 'API-Balance-Whale/0.2.4' }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch { throw new ProviderError('NETWORK', '余额接口暂时无法连接，请稍后刷新', true); }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      if (response.status === 401 || response.status === 403) throw new ProviderError('AUTH', '当前密钥无权访问此余额接口（HTTP ' + response.status + '）');
      throw new ProviderError('HTTP_' + response.status, '余额接口返回 HTTP ' + response.status, response.status >= 500 || response.status === 429);
    }
    if (!(response.headers.get('content-type') || '').includes('json')) {
      try { await response.body?.cancel(); } catch {}
      throw new ProviderError('NOT_JSON', '服务商返回了网页或验证页，当前路径不是可用的余额接口');
    }
    const raw = await readBoundedJsonText(response);
    let data;
    try { data = JSON.parse(raw); } catch { throw new ProviderError('SHAPE', '余额响应不是有效 JSON'); }
    if (data?.success === false || data?.code === false) throw new ProviderError('API_ERROR', '服务商拒绝了余额查询，请检查密钥权限和接口类型');
    return data;
  }
  async billing(c) {
    const base = c.baseUrl.replace(/\/$/, '');
    const [subscription, usage] = await Promise.all([
      this.json(base + '/dashboard/billing/subscription', c.key),
      this.json(base + '/dashboard/billing/usage', c.key),
    ]);
    const total = numeric(subscription.hard_limit_usd);
    const rawUsed = numeric(usage.total_usage);
    if (total === null || rawUsed === null || rawUsed < 0) throw new ProviderError('SHAPE', '兼容账单接口缺少有效的额度或消耗字段');
    const used = rawUsed / c.setting.billingUsageDivisor;
    return { totalBalance: rounded(total - used), totalGranted: total, totalUsed: rounded(used), currency: 'USD', adapter: 'billing', balanceScope: 'api-billing', balanceLabel: 'API 可用余额', unitNote: '账单额度为美元；total_usage 按接口约定除以 ' + c.setting.billingUsageDivisor, unlimited: false };
  }
  async newapi(c) {
    const payload = await this.json(new URL('/api/usage/token', c.baseUrl).href, c.key);
    const d = payload?.data || payload;
    const total = numeric(d.total_granted), used = numeric(d.total_used), remaining = numeric(d.total_available);
    const rawRemaining = numeric(d.remain_quota), rawUsed = numeric(d.used_quota);
    const unlimited = d.unlimited_quota === true;
    if (remaining !== null && used !== null) return { totalBalance: unlimited ? null : remaining, totalGranted: total, totalUsed: used, currency: c.setting.currency, adapter: 'newapi', balanceScope: 'api-key-quota', balanceLabel: unlimited ? '当前密钥不限额（非账户余额）' : '当前 API 密钥剩余额度', unlimited };
    if (rawRemaining !== null || unlimited) return { totalBalance: unlimited ? null : rawRemaining / c.setting.quotaPerUnit, totalUsed: rawUsed === null ? null : rawUsed / c.setting.quotaPerUnit, currency: c.setting.currency, adapter: 'newapi', balanceScope: 'api-key-quota', balanceLabel: unlimited ? '当前密钥不限额（非账户余额）' : '当前 API 密钥剩余额度', unlimited };
    throw new ProviderError('SHAPE', '密钥额度接口缺少有效金额；不能将空值当作余额为零');
  }
  async custom(c) {
    if (!c.setting.balancePath || !c.setting.balanceField) throw new ProviderError('CONFIG', '请先配置当前服务的余额路径和金额字段');
    const url = new URL(c.setting.balancePath, c.baseUrl);
    if (url.origin !== new URL(c.baseUrl).origin) throw new ProviderError('CONFIG', '自定义余额接口必须与 API 地址同域');
    const d = await this.json(url.href, c.key);
    const balance = field(d, c.setting.balanceField);
    const used = c.setting.usedField ? field(d, c.setting.usedField) : null;
    if (balance === null) throw new ProviderError('SHAPE', '所选字段不是有效金额');
    return { totalBalance: rounded(balance * c.setting.balanceScale), totalUsed: used === null ? null : rounded(used * c.setting.balanceScale), currency: c.setting.currency, adapter: 'custom-json', balanceScope: 'custom', balanceLabel: '自定义 API 余额', unlimited: false };
  }
  async deepseek(c) {
    const d = await this.json(new URL('/user/balance', c.baseUrl).href, c.key);
    const infos = d?.balance_infos;
    const chosen = Array.isArray(infos) && (infos.find(x => x.currency === c.setting.currency) || infos[0]);
    const n = numeric(chosen?.total_balance);
    if (n === null) throw new ProviderError('SHAPE', '服务商没有返回有效余额');
    return { totalBalance: n, totalUsed: null, currency: chosen.currency || c.setting.currency, adapter: 'deepseek', balanceScope: 'account', balanceLabel: 'API 账户余额', unlimited: false };
  }
  async balance(c) {
    if (!c.key) throw new ProviderError('NO_KEY', '未找到当前 API 密钥。ChatGPT 订阅登录本身不提供 API 余额；可在设置中指定 API 密钥环境变量。');
    const host = new URL(c.baseUrl).hostname;
    if (host === 'api.openai.com' && c.setting.provider === 'auto') throw new ProviderError('UNSUPPORTED', 'OpenAI 普通 API 密钥没有已验证的余额查询接口。请打开官方账单页面查看；不会把用量或 ChatGPT 订阅额度当作余额。');
    let method = c.setting.provider;
    if (method === 'auto') method = this.detected.get(c.accountId) || (host === 'api.deepseek.com' ? 'deepseek' : 'billing');
    let result;
    try { result = await this[method === 'custom-json' ? 'custom' : method](c); }
    catch (error) {
      const canFallback = c.setting.provider === 'auto' && method === 'billing' && ['HTTP_404', 'HTTP_405', 'NOT_JSON', 'SHAPE'].includes(error.code);
      if (!canFallback) throw error;
      result = await this.newapi(c);
    }
    this.detected.set(c.accountId, result.adapter);
    return { ok: true, ...result, accountId: c.accountId, providerName: c.providerName, baseUrl: c.baseUrl, dashboardUrl: c.dashboardUrl, updatedAt: new Date().toISOString() };
  }
}
