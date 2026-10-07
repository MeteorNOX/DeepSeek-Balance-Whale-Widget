import { validateBalanceConnection } from './balance-contract.mjs';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONNECTION_FIELDS = ['id', 'name', 'match', 'baseUrl', 'keyEnv', 'balance'];
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'set-cookie', 'proxy-authorization', 'proxy-authenticate', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive']);

export function object(value, label = '设置') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(label + '必须是 JSON 对象');
  return value;
}

export function checkFields(value, fields, label = '设置') {
  object(value, label);
  if (Object.keys(value).some(key => UNSAFE_KEYS.has(key) || !fields.includes(key))) throw new Error(label + '包含未知字段；密钥只能通过环境变量名引用，不保存密钥');
}

export function textValue(value, max, label, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(label + '无效或过长');
  return value.trim();
}

export function environmentName(value) {
  const name = textValue(value, 128, '密钥环境变量名称');
  if (name && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || UNSAFE_KEYS.has(name))) throw new Error('密钥环境变量名称无效');
  return name;
}

export function cleanUrl(value, { allowEmpty = false } = {}) {
  if (!value && allowEmpty) return '';
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) throw new Error('API 地址无效');
  let u;
  try { u = new URL(value); } catch { throw new Error('API 地址无效'); }
  if (u.username || u.password || u.search || u.hash) throw new Error('API 地址不能包含密钥、查询参数或片段');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('API 地址须使用 HTTPS（本机服务除外）');
  return u.toString().replace(/\/$/, '');
}

// TOML tables overlay recursively. In particular a project profile's model
// must not erase its trusted model_provider or a provider's env_key.
export function mergeTables(base, patch) {
  object(base); object(patch);
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) throw new Error('配置字段无效');
    const table = value && typeof value === 'object' && !Array.isArray(value);
    if (table) {
      object(value);
      const previous = base[key];
      result[key] = mergeTables(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}, value);
    } else result[key] = value;
  }
  return result;
}

export function connectionId(value) {
  const id = textValue(value, 80, '连接编号');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || UNSAFE_KEYS.has(id)) throw new Error('连接编号无效');
  return id;
}

export function validateConnection(input) {
  checkFields(input, CONNECTION_FIELDS, '连接');
  const match = input.match ?? {};
  checkFields(match, ['providerId', 'profile'], '连接来源');
  const id = connectionId(input.id);
  const name = textValue(input.name, 80, '连接名称', '余额连接');
  if (!name) throw new Error('连接名称不能为空');
  return { id, name, match: { providerId: textValue(match.providerId, 128, '服务商编号'), profile: textValue(match.profile, 128, '配置档案') },
    baseUrl: cleanUrl(input.baseUrl ?? '', { allowEmpty: true }), keyEnv: environmentName(input.keyEnv),
    balance: validateBalanceConnection(input.balance ?? { adapter: 'none' }) };
}

export function validateLegacyBinding(input) {
  if (input == null) return null;
  checkFields(input, ['providerId', 'profile', 'sourceBaseUrl'], '旧连接来源');
  return { providerId: textValue(input.providerId, 128, '服务商编号'), profile: textValue(input.profile, 128, '配置档案'), sourceBaseUrl: cleanUrl(input.sourceBaseUrl) };
}

export function safeConnectionInfo(connection) {
  return { id: connection.id, name: connection.name, adapter: connection.balance.adapter,
    confirmed: connection.balance.mapping.confirmed === true, matchedSource: !!connection.match.providerId,
    hasBaseUrl: !!connection.baseUrl, hasKeyEnv: !!connection.keyEnv };
}

export function providerHeaders(provider, env) {
  const result = {}, seen = new Set();
  for (const [field, fromEnvironment] of [['http_headers', false], ['env_http_headers', true]]) {
    const headers = provider[field] ?? {};
    object(headers, '服务商请求头');
    if (Object.keys(headers).length > 32) throw new Error('服务商请求头过多');
    for (const [name, raw] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (name.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || UNSAFE_KEYS.has(lower) || FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-')) throw new Error('服务商请求头名称不安全');
      if (seen.has(lower)) throw new Error('服务商请求头重复');
      seen.add(lower);
      const reference = fromEnvironment ? environmentName(raw) : '';
      if (fromEnvironment && !reference) throw new Error('服务商请求头的环境变量名称不能为空');
      const value = fromEnvironment ? (Object.hasOwn(env, reference) ? env[reference] : '') : raw;
      if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('服务商请求头内容无效');
      if (value) result[name] = value;
    }
  }
  return result;
}

export function readEnvironment(env, name) {
  if (!name || !Object.hasOwn(env, name)) return '';
  const value = env[name];
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('连接密钥环境变量内容无效');
  return value;
}
