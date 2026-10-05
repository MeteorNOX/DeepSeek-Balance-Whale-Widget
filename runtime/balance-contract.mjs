// Persist only request structure and environment variable names. Secret values
// are resolved by ConfigStore and checked again immediately before a request.
export const BALANCE_LIMITS = Object.freeze({ url: 2048, headers: 8192, query: 4096, body: 32768, entries: 32 });
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const forbiddenHeaders = /^(?:host|authorization|cookie|set-cookie|connection|keep-alive|transfer-encoding|content-length|upgrade|trailer|te|proxy-.*|sec-.*)$/i;
const secretName = /(?:authorization|password|secret|token|api[-_]?key|access[-_]?key|(?:^|[-_.])(?:key|auth|authentication|credentials?)(?:$|[-_.]))/i;
const inlineCredential = /(?:\b(?:bearer|basic)\s+\S+|\bsk-[A-Za-z0-9_-]{6,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:api[-_]?key|access[-_]?token|authorization|password|secret)\s*[:=]\s*\S+)/i;
const fail = message => { throw new Error(message); };
const bytes = value => Buffer.byteLength(value, 'utf8');
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(label + '必须是 JSON 对象');
  if (Object.keys(value).some(k => unsafeKeys.has(k))) fail(label + '包含无效属性');
  return value;
}
function keys(value, allowed, label) { record(value, label); if (Object.keys(value).some(k => !allowed.includes(k))) fail(label + '包含未知属性'); }
function text(value, label, max = 2048) {
  if (typeof value !== 'string' || controls.test(value) || bytes(value) > max) fail(label + '格式无效或过长');
  return value;
}
function literal(value, label, max = 2048) {
  text(value, label, max);
  if (inlineCredential.test(value)) fail(label + '不能保存认证字符串；请使用环境变量引用');
  return value;
}
function env(value, label) { if (typeof value !== 'string' || unsafeKeys.has(value) || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) fail(label + '环境变量名称无效'); return value; }
function scale(value, label) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 1e-12 || value > 1e12) fail(label + '超出有效范围'); return value; }
function field(value, label) {
  text(value, label, 512);
  if (value && (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(value) || value.split('.').some(k => unsafeKeys.has(k)))) fail(label + '路径无效');
  return value;
}
function map(value, label, { headers = false, environment = false } = {}) {
  record(value, label); const out = {}, seen = new Set();
  if (Object.keys(value).length > BALANCE_LIMITS.entries) fail(label + '项目过多');
  for (const [key, input] of Object.entries(value)) {
    text(key, label + '名称', 128);
    if (!key || (headers && (!headerName.test(key) || forbiddenHeaders.test(key)))) fail(label + '名称无效或不允许覆盖认证与传输头');
    if (!headers && !/^[A-Za-z0-9_.~-]+$/.test(key)) fail(label + '名称无效');
    const canonical = headers ? key.toLowerCase() : key;
    if (seen.has(canonical)) fail(label + '包含重复名称'); seen.add(canonical);
    if (!environment && secretName.test(key)) fail(label + '中的认证值须使用环境变量');
    out[key] = environment ? env(input, label) : literal(input, label + '值', 2048);
  }
  if (bytes(JSON.stringify(out)) > (headers ? BALANCE_LIMITS.headers : BALANCE_LIMITS.query)) fail(label + '过大');
  return out;
}
function jsonValue(input, depth = 0, count = { value: 0 }) {
  if (++count.value > 2048 || depth > 16) fail('余额请求 JSON 过于复杂');
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number') { if (!Number.isFinite(input)) fail('余额请求 JSON 数字无效'); return input; }
  if (typeof input === 'string') return literal(input, '余额请求 JSON', BALANCE_LIMITS.body);
  if (Array.isArray(input)) return input.map(v => jsonValue(v, depth + 1, count));
  record(input, '余额请求 JSON'); const out = {};
  for (const [key, value] of Object.entries(input)) {
    text(key, '余额请求 JSON 属性', 128);
    if (secretName.test(key)) fail('余额请求 JSON 不保存认证值；请使用环境变量认证头或参数');
    out[key] = jsonValue(value, depth + 1, count);
  }
  return out;
}
export function validateBalanceRequestUrl(value, { allowLegacyQuery = false } = {}) {
  text(value, '余额 URL', BALANCE_LIMITS.url);
  if (!value) return '';
  if (value !== value.trim() || /[\\#]/.test(value) || value.startsWith('//') || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) fail('余额 URL 格式无效');
  let parsed; try { parsed = new URL(value, 'https://balance.invalid/'); } catch { fail('余额 URL 无效'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) fail('余额 URL 须使用 HTTPS（本机服务除外）');
  if (parsed.username || parsed.password || (!allowLegacyQuery && parsed.search) || parsed.hash) fail('余额 URL 不能包含凭据或查询参数；请使用 query/envQuery');
  if (allowLegacyQuery && parsed.search) {
    const query = Object.create(null);
    for (const [key, entry] of parsed.searchParams) {
      if (Object.hasOwn(query, key)) fail('余额查询参数包含重复名称');
      query[key] = entry;
    }
    map(query, '余额查询参数');
    if (bytes(parsed.search) > BALANCE_LIMITS.query) fail('余额查询参数过大');
  }
  if (!/^https?:\/\//i.test(value) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) fail('余额 URL 格式无效');
  // Inspect encoded path text as well; URL user-info/query checks alone do not
  // catch an accidentally pasted Bearer token or API key in a path segment.
  let decoded = value;
  for (let i = 0; i < 4; i++) {
    literal(decoded, '余额 URL', BALANCE_LIMITS.url);
    let next;
    try { next = decoded.replace(/(?:%[A-Fa-f0-9]{2})+/g, part => decodeURIComponent(part)); }
    catch { fail('余额 URL 编码无效'); }
    if (next === decoded) break;
    decoded = next;
  }
  literal(decoded, '余额 URL', BALANCE_LIMITS.url);
  if (/%[A-Fa-f0-9]{2}/.test(decoded)) fail('余额 URL 编码嵌套过多');
  return value;
}

export function validateBalanceConnection(input = {}) {
  keys(input, ['adapter', 'request', 'mapping'], '余额连接');
  if (Object.values(input).some(v => v === null)) fail('余额连接属性不能为 null');
  const adapter = input.adapter ?? 'auto';
  if (!['auto', 'billing', 'newapi', 'deepseek', 'custom-json', 'none'].includes(adapter)) fail('未知余额接口类型');
  const r = input.request ?? {}, m = input.mapping ?? {};
  keys(r, ['url', 'method', 'auth', 'headers', 'envHeaders', 'query', 'envQuery', 'body'], '余额请求');
  keys(m, ['balanceField', 'usedField', 'unlimitedField', 'unlimitedValue', 'scope', 'currency', 'balanceScale', 'usedScale', 'confirmed'], '余额映射');
  if (Object.entries(r).some(([k, v]) => k !== 'body' && v === null) || Object.values(m).some(v => v === null)) fail('余额请求与映射属性不能为 null');
  const a = r.auth ?? {}; keys(a, ['type', 'keyEnv', 'header'], '余额认证');
  if (Object.values(a).some(v => v === null)) fail('余额认证属性不能为 null');
  const auth = { type: a.type ?? 'inherit', keyEnv: a.keyEnv ?? '', header: a.header ?? '' };
  if (!['inherit', 'bearer', 'header', 'none'].includes(auth.type)) fail('余额认证类型无效');
  if (['bearer', 'header'].includes(auth.type)) env(auth.keyEnv, '余额认证');
  else if (auth.keyEnv !== '') fail('仅专用认证可指定密钥环境变量');
  if (auth.type === 'header') {
    text(auth.header, '余额认证头', 128);
    if (!headerName.test(auth.header) || forbiddenHeaders.test(auth.header)) fail('余额认证头无效；Bearer 认证请使用 bearer 类型');
  } else if (auth.header !== '') fail('只有 header 认证可指定认证头');
  const request = { url: validateBalanceRequestUrl(r.url ?? ''), method: r.method ?? 'GET', auth,
    headers: map(r.headers ?? {}, '余额请求头', { headers: true }), envHeaders: map(r.envHeaders ?? {}, '余额环境请求头', { headers: true, environment: true }),
    query: map(r.query ?? {}, '余额查询参数'), envQuery: map(r.envQuery ?? {}, '余额环境查询参数', { environment: true }), body: jsonValue(r.body ?? null) };
  if (!['GET', 'POST'].includes(request.method)) fail('余额请求仅支持 GET 或 POST');
  if (request.method === 'GET' && request.body !== null) fail('GET 余额请求不能包含 JSON 请求体');
  if (request.body !== null && auth.type === 'header' && auth.header.toLowerCase() === 'content-type') fail('JSON 请求体不能使用 Content-Type 作为认证头');
  if (bytes(JSON.stringify(request.body)) > BALANCE_LIMITS.body) fail('余额请求 JSON 过大');
  for (const pair of [['headers', 'envHeaders'], ['query', 'envQuery']]) {
    const names = [...Object.keys(request[pair[0]]), ...Object.keys(request[pair[1]])].map(k => pair[0] === 'headers' ? k.toLowerCase() : k);
    if (names.length > BALANCE_LIMITS.entries || new Set(names).size !== names.length || (pair[0] === 'headers' && auth.header && names.includes(auth.header.toLowerCase()))) fail('余额请求包含重复参数或项目过多');
  }
  const mapping = { balanceField: field(m.balanceField ?? 'data.balance', '余额字段'), usedField: field(m.usedField ?? '', '消耗字段'),
    unlimitedField: field(m.unlimitedField ?? '', '不限额字段'), unlimitedValue: m.unlimitedValue ?? true,
    scope: m.scope ?? 'account', currency: m.currency ?? 'USD', balanceScale: scale(m.balanceScale ?? 1, '余额系数'), usedScale: scale(m.usedScale ?? 1, '消耗系数'), confirmed: m.confirmed ?? false };
  if (!['account', 'api-key-quota', 'custom'].includes(mapping.scope)) fail('余额范围无效');
  if (typeof mapping.currency !== 'string' || !/^[A-Z]{3}$/.test(mapping.currency)) fail('币种须使用 USD、CNY 等三位代码');
  if (typeof mapping.confirmed !== 'boolean') fail('余额映射确认状态无效');
  if (!['boolean', 'string', 'number'].includes(typeof mapping.unlimitedValue) || (typeof mapping.unlimitedValue === 'number' && !Number.isFinite(mapping.unlimitedValue))) fail('不限额匹配值须为有效标量');
  if (typeof mapping.unlimitedValue === 'string') text(mapping.unlimitedValue, '不限额匹配值', 256);
  if (adapter === 'custom-json' && !request.url) fail('自定义余额接口需要请求 URL');
  if (adapter === 'custom-json' && !mapping.balanceField && !mapping.usedField && !mapping.unlimitedField) fail('自定义余额接口需要金额或不限额字段');
  return { adapter, request, mapping };
}

export function balanceSecretNames(balance) {
  const { request } = validateBalanceConnection(balance);
  return [...new Set([request.auth.keyEnv, ...Object.values(request.envHeaders), ...Object.values(request.envQuery)].filter(Boolean))];
}
