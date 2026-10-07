import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from '../vendor/smol-toml/dist/index.js';
import { CODEX_HOME, DATA_HOME, readJson, writeJson } from './paths.mjs';
import { balanceSecretNames, validateBalanceRequestUrl } from './balance-contract.mjs';
import { checkFields, cleanUrl, connectionId, environmentName, mergeTables, object, providerHeaders, readEnvironment, safeConnectionInfo, textValue, validateConnection, validateLegacyBinding } from './config-connections.mjs';

export const DEFAULT_CONFIG = {
  provider: 'auto', baseUrl: '', keyEnv: '', profile: '', projectDir: '', currency: 'USD',
  balancePath: '', balanceField: 'data.balance', usedField: '', balanceScale: 1,
  billingUsageDivisor: 100, quotaPerUnit: 500000,
  dashboardUrl: '', monitorSessions: true, refreshSeconds: 60,
  models: {},
  connectionMode: 'follow', selectedConnection: '', connections: [], legacyConnectionBinding: null,
};

// These values remain local to the service. The settings editor receives only
// presence flags and submits a value only when the user explicitly changes it.
export const PRIVATE_SETTING_FIELDS = Object.freeze(['baseUrl', 'keyEnv', 'profile', 'projectDir', 'dashboardUrl', 'balancePath', 'balanceField', 'usedField', 'models']);

function numberIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(label + '超出有效范围');
  return n;
}

export function validateConfig(input) {
  object(input);
  const c = structuredClone(DEFAULT_CONFIG);
  for (const k of Object.keys(c)) if (Object.hasOwn(input, k)) c[k] = input[k];
  if (!['auto', 'billing', 'newapi', 'custom-json', 'deepseek', 'none'].includes(c.provider)) throw new Error('未知余额接口类型');
  c.baseUrl = cleanUrl(String(c.baseUrl || ''), { allowEmpty: true });
  c.dashboardUrl = cleanUrl(String(c.dashboardUrl || ''), { allowEmpty: true });
  c.keyEnv = environmentName(c.keyEnv);
  c.profile = textValue(c.profile, 128, '配置档案');
  c.projectDir = textValue(c.projectDir, 4096, '项目目录');
  c.currency = String(c.currency || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(c.currency)) throw new Error('币种须使用 USD、CNY 等三位代码');
  c.refreshSeconds = numberIn(c.refreshSeconds, 15, 3600, '刷新间隔');
  c.monitorSessions = c.monitorSessions === true;
  c.billingUsageDivisor = numberIn(c.billingUsageDivisor, 0.000001, 1e12, '用量单位换算');
  c.quotaPerUnit = numberIn(c.quotaPerUnit, 0.000001, 1e12, '额度单位换算');
  c.balanceScale = numberIn(c.balanceScale, 0.000000001, 1e12, '余额系数');
  c.balancePath = String(c.balancePath || '');
  if (c.balancePath && (!c.balancePath.startsWith('/') || c.balancePath.startsWith('//') || /[\\#\r\n]/.test(c.balancePath))) throw new Error('余额路径须为当前 API 域名下的绝对路径');
  validateBalanceRequestUrl(c.balancePath, { allowLegacyQuery: true });
  for (const k of ['balanceField', 'usedField']) {
    c[k] = String(c[k] || '');
    if (c[k] && !/^[A-Za-z0-9_.]+$/.test(c[k])) throw new Error('字段路径仅支持字母、数字、下划线和点');
    if (c[k].split('.').some(x => ['__proto__', 'constructor', 'prototype'].includes(x))) throw new Error('字段路径无效');
  }
  if (!c.models || typeof c.models !== 'object' || Array.isArray(c.models)) throw new Error('模型价格须为 JSON 对象');
  const models = {};
  for (const [model, prices] of Object.entries(c.models)) {
    if (!model || model.length > 150 || ['__proto__', 'constructor', 'prototype'].includes(model)) throw new Error('模型名称无效');
    if (!prices || typeof prices !== 'object') throw new Error('模型价格无效');
    models[model] = {};
    for (const field of ['input', 'cachedInput', 'output']) models[model][field] = numberIn(prices[field], 0, 1e9, '模型价格');
    if (prices.cacheWrite !== undefined) models[model].cacheWrite = numberIn(prices.cacheWrite, 0, 1e9, '缓存写入价格');
  }
  c.models = models;
  if (!['follow', 'fixed'].includes(c.connectionMode)) throw new Error('连接模式无效');
  c.selectedConnection = c.selectedConnection ? connectionId(c.selectedConnection) : '';
  if (!Array.isArray(c.connections) || c.connections.length > 64) throw new Error('最多保存 64 个余额连接');
  c.connections = c.connections.map(validateConnection);
  if (new Set(c.connections.map(item => item.id)).size !== c.connections.length) throw new Error('连接编号重复');
  c.legacyConnectionBinding = validateLegacyBinding(c.legacyConnectionBinding);
  if (Buffer.byteLength(JSON.stringify(c)) > 262144) throw new Error('设置内容过大');
  return c;
}

export class ConfigStore {
  constructor({ dataDir = DATA_HOME, codexHome = CODEX_HOME, env = process.env } = {}) {
    this.dataDir = dataDir; this.codexHome = codexHome; this.env = env;
    this.file = path.join(dataDir, 'api-settings.json');
  }
  load() { return validateConfig(readJson(this.file, DEFAULT_CONFIG)); }
  prepare(patch) {
    checkFields(patch, [...Object.keys(DEFAULT_CONFIG).filter(key => key !== 'legacyConnectionBinding'), 'pricingUpdate', 'connectionUpdate', 'connectionDelete']);
    const current = this.load(), input = { ...current };
    for (const key of Object.keys(DEFAULT_CONFIG)) if (Object.hasOwn(patch, key)) input[key] = patch[key];
    if (Object.hasOwn(patch, 'pricingUpdate')) {
      const update = patch.pricingUpdate;
      if (!update || typeof update !== 'object' || Array.isArray(update) || typeof update.model !== 'string' || !update.model.trim() || update.model.length > 150 || ['__proto__', 'prototype', 'constructor'].includes(update.model)) throw new Error('模型名称无效');
      input.models = { ...current.models };
      if (update.prices === null) delete input.models[update.model];
      else input.models[update.model] = update.prices;
    }
    if (Object.hasOwn(patch, 'connections') && (Object.hasOwn(patch, 'connectionUpdate') || Object.hasOwn(patch, 'connectionDelete'))) throw new Error('连接替换和连接编辑不能同时提交');
    if (Object.hasOwn(patch, 'connectionUpdate')) {
      const update = patch.connectionUpdate;
      checkFields(update, ['id', 'value'], '连接编辑'); object(update.value, '连接内容');
      const id = update.id ? connectionId(update.id) : update.value.id ? connectionId(update.value.id) : crypto.randomUUID();
      if (update.value.id && update.value.id !== id) throw new Error('连接编号不能在编辑时改变');
      input.connections = current.connections.map(item => structuredClone(item));
      const index = input.connections.findIndex(item => item.id === id);
      const merged = mergeTables(index < 0 ? { id } : input.connections[index], { ...update.value, id });
      // Request parameter maps and JSON bodies are complete values. Treating an
      // empty map as a table overlay would make removed headers impossible to clear.
      for (const field of ['headers', 'envHeaders', 'query', 'envQuery', 'body']) {
        if (Object.hasOwn(update.value.balance?.request ?? {}, field)) merged.balance.request[field] = structuredClone(update.value.balance.request[field]);
      }
      const value = validateConnection(merged);
      if (index >= 0 && !Object.hasOwn(update.value.balance?.mapping ?? {}, 'confirmed')) {
        const previous = input.connections[index];
        if (JSON.stringify(value.balance) !== JSON.stringify(previous.balance) || value.baseUrl !== previous.baseUrl || value.keyEnv !== previous.keyEnv ||
          value.match.providerId !== previous.match.providerId || value.match.profile !== previous.match.profile) value.balance.mapping.confirmed = false;
      }
      if (index < 0) input.connections.push(value); else input.connections[index] = value;
    }
    if (Object.hasOwn(patch, 'connectionDelete')) {
      const id = connectionId(patch.connectionDelete);
      if (Object.hasOwn(patch, 'connectionUpdate') && patch.connectionUpdate.id === id) throw new Error('不能同时更新和删除相同连接');
      if (!input.connections.some(item => item.id === id)) throw new Error('找不到余额连接');
      input.connections = input.connections.filter(item => item.id !== id);
      if (input.selectedConnection === id) {
        if (input.connectionMode === 'fixed') throw new Error('请先切换连接或跟随模式，再删除当前固定连接');
        input.selectedConnection = '';
      }
    }
    let c = validateConfig(input);
    if (Object.hasOwn(patch, 'baseUrl') || Object.hasOwn(patch, 'keyEnv')) {
      const confirmsBoth = Object.hasOwn(patch, 'baseUrl') && Object.hasOwn(patch, 'keyEnv');
      if (!current.legacyConnectionBinding && (current.baseUrl || current.keyEnv) && !confirmsBoth) throw new Error('旧覆盖尚未绑定来源；请同时确认 API 地址和密钥环境变量，清除时也请同时提交两项，或改用独立连接');
      if (!c.baseUrl && !c.keyEnv) c.legacyConnectionBinding = null;
      else {
        const source = this.readSource(c), binding = this.sourceBinding(source);
        if (current.legacyConnectionBinding && !this.sameBinding(current.legacyConnectionBinding, binding) && !confirmsBoth) throw new Error('Codex 来源已经改变；请同时确认旧 API 地址和密钥环境变量，或改用独立连接');
        c.legacyConnectionBinding = binding;
      }
    }
    c = validateConfig(c);
    if (c.connectionMode === 'fixed' && !c.connections.some(item => item.id === c.selectedConnection)) throw new Error('请选择有效的固定余额连接');
    return c;
  }
  save(patch) {
    const c = this.prepare(patch); writeJson(this.file, c); return c;
  }
  resolveDraft(patch) { return this.resolveSetting(this.prepare(patch)); }
  readConnection(id) {
    const record = this.load().connections.find(item => item.id === connectionId(id));
    if (!record) throw new Error('找不到余额连接');
    return structuredClone(record);
  }
  settingsInfo() {
    const current = this.load(), settings = {}, configured = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (['connections', 'legacyConnectionBinding'].includes(key)) continue;
      if (PRIVATE_SETTING_FIELDS.includes(key)) configured[key] = key === 'models' ? Object.keys(current.models).length > 0 : !!current[key];
      else settings[key] = current[key];
    }
    return { settings, configured, connections: current.connections.map(safeConnectionInfo),
      connectionMode: current.connectionMode, selectedConnection: current.selectedConnection };
  }
  readSource(setting) {
    const file = path.join(this.codexHome, 'config.toml');
    let trusted = {};
    if (fs.existsSync(file)) {
      try { trusted = parse(fs.readFileSync(file, 'utf8')); }
      catch { throw new Error('Codex config.toml 无法解析，请检查配置文件'); }
    }
    let config = mergeTables({}, trusted);
    let projectLoaded = false;
    if (setting.projectDir) {
      const projectFile = path.join(path.resolve(setting.projectDir), '.codex', 'config.toml');
      if (fs.existsSync(projectFile)) {
        let local;
        try { local = parse(fs.readFileSync(projectFile, 'utf8')); } catch { throw new Error('项目 .codex/config.toml 无法解析'); }
        config = mergeTables(config, local);
        projectLoaded = true;
      }
    }
    const profileName = textValue(setting.profile || this.env.CODEX_PROFILE || config.profile || '', 128, '配置档案');
    if (profileName && !config.profiles?.[profileName]) throw new Error('找不到所选 Codex profile');
    const effective = mergeTables(config, profileName ? config.profiles[profileName] : {});
    const id = textValue(effective.model_provider || 'openai', 128, '服务商编号');
    if (id !== 'openai' && !Object.hasOwn(effective.model_providers ?? {}, id)) throw new Error('找不到当前 Codex 服务商配置；不会回退到其他服务商');
    const provider = effective.model_providers?.[id] || {};
    const originalBase = this.providerBase(provider, id);
    // A project can select an existing trusted provider, but cannot create new
    // authority for a destination, environment reference or authorization header.
    const trustedEffective = mergeTables(trusted, profileName && trusted.profiles?.[profileName] ? trusted.profiles[profileName] : {});
    const trustedProvider = trustedEffective.model_providers?.[id] || {};
    const trustedExists = id === 'openai' || Object.hasOwn(trustedEffective.model_providers ?? {}, id);
    const trustedBase = trustedExists ? this.providerBase(trustedProvider, id) : '';
    const authFields = ['env_key', 'experimental_bearer_token', 'http_headers', 'env_http_headers', 'requires_openai_auth'];
    const authChanged = authFields.some(field => JSON.stringify(provider[field] ?? null) !== JSON.stringify(trustedProvider[field] ?? null));
    // Path prefixes may route to different tenants on one origin. A project
    // cannot authorize credentials for a different base path any more than a host.
    const destinationChanged = originalBase !== trustedBase;
    return { id, profileName, effective, provider, trustedProvider, originalBase, projectLoaded, destinationChanged, authChanged };
  }
  providerBase(provider, id) {
    if (provider.base_url) return cleanUrl(provider.base_url);
    if (id === 'openai') return cleanUrl(this.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
    throw new Error('当前 Codex 服务商缺少 API 地址；不会回退到其他服务商');
  }
  sourceBinding(source) { return { providerId: source.id, profile: source.profileName, sourceBaseUrl: source.originalBase }; }
  sameBinding(a, b) { return a.providerId === b.providerId && a.profile === b.profile && a.sourceBaseUrl === b.sourceBaseUrl; }
  resolve() { return this.resolveSetting(this.load()); }
  resolveSetting(setting) {
    let selected, source, baseUrl, id, profileName, effective = {}, authHeaders = {};
    if (setting.connectionMode === 'fixed') {
      selected = setting.connections.find(item => item.id === setting.selectedConnection);
      if (!selected) throw new Error('请选择有效的固定余额连接');
      if (!selected.baseUrl) throw new Error('固定连接须明确填写 API 地址');
      baseUrl = selected.baseUrl; id = selected.match.providerId || 'fixed'; profileName = selected.match.profile;
    } else {
      source = this.readSource(setting);
      ({ id, profileName, effective } = source);
      const matches = setting.connections.filter(item => item.match.providerId === id && item.match.profile === profileName);
      if (matches.length > 1) throw new Error('多个余额连接匹配当前 Codex 来源，请保留一个或选择固定连接');
      selected = matches[0];
      if (selected?.baseUrl && selected.baseUrl !== source.originalBase) throw new Error('余额连接绑定的 API 地址与当前 Codex 来源不一致，请确认连接配置');
      if (!selected && (setting.baseUrl || setting.keyEnv)) {
        if (!setting.legacyConnectionBinding) throw new Error('旧 API 地址或密钥覆盖尚未绑定来源，请重新确认设置或改用固定连接');
        if (!this.sameBinding(setting.legacyConnectionBinding, this.sourceBinding(source))) throw new Error('Codex 来源已经改变；旧 API 地址或密钥覆盖不会自动跟随，请确认连接配置');
      }
      baseUrl = selected ? source.originalBase : setting.baseUrl || source.originalBase;
      const explicitKey = selected?.keyEnv || (!selected ? setting.keyEnv : '');
      const explicitlyBound = selected ? selected.baseUrl === source.originalBase && (explicitKey || selected.balance.request.auth.type !== 'inherit') : explicitKey && !!setting.legacyConnectionBinding;
      if (source.projectLoaded && source.destinationChanged && !explicitlyBound) throw new Error('项目配置更换 API 域名或路径时，请在挂件设置中明确绑定地址及该服务专用的密钥环境变量；不会转发全局密钥');
      if (source.projectLoaded && source.authChanged && !explicitlyBound) throw new Error('项目配置不能新增或改变密钥环境变量及鉴权请求头，请显式绑定该服务连接');
      if (selected && !selected.baseUrl && (selected.keyEnv || (balanceSecretNames(selected.balance).length && !/^https?:\/\//i.test(selected.balance.request.url)))) throw new Error('使用专用密钥或环境变量参数的跟随连接须明确绑定 API 地址，避免来源变化时转发旧凭据');
      if (new URL(baseUrl).origin !== new URL(source.originalBase).origin && !explicitKey) throw new Error('更换 API 域名时请指定该服务自己的密钥环境变量，不能复用原服务密钥');
      if ((!selected || selected.balance.request.auth.type === 'inherit') && !explicitKey && !source.destinationChanged && !source.authChanged && new URL(baseUrl).origin === new URL(source.originalBase).origin) authHeaders = providerHeaders(source.trustedProvider, this.env);
    }
    let key = '', keySource = 'none';
    const explicitKey = selected?.keyEnv || (!selected ? setting.keyEnv : '');
    const provider = source?.trustedProvider || {};
    const mayInherit = setting.connectionMode === 'follow' && (!selected || selected.balance.request.auth.type === 'inherit') && !source.destinationChanged && !source.authChanged;
    const envName = environmentName(explicitKey || (mayInherit ? provider.env_key : ''));
    if (envName) { key = readEnvironment(this.env, envName); if (key) keySource = 'environment'; }
    else if (mayInherit && provider.experimental_bearer_token) { key = provider.experimental_bearer_token; keySource = 'codex-provider'; }
    else if (mayInherit && !provider.env_key && (id === 'openai' || provider.requires_openai_auth === true)) {
      if (readEnvironment(this.env, 'OPENAI_API_KEY')) { key = readEnvironment(this.env, 'OPENAI_API_KEY'); keySource = 'environment'; }
      else {
        const auth = readJson(path.join(this.codexHome, 'auth.json'), {});
        if (typeof auth.OPENAI_API_KEY === 'string') { key = auth.OPENAI_API_KEY; keySource = 'codex-auth'; }
      }
    }
    key = String(key || '').trim().replace(/^Bearer\s+/i, '');
    if (key.length > 16384 || /[\x00-\x1f\x7f]/.test(key)) throw new Error('API 密钥格式无效');
    const balanceConnection = selected?.balance;
    const balanceSecrets = {};
    if (balanceConnection) for (const name of balanceSecretNames(balanceConnection)) balanceSecrets[environmentName(name)] = readEnvironment(this.env, name);
    // Keep legacy ledger IDs stable. New connections include the request and its
    // credentials; amount mapping belongs to a meter identity, not an account.
    const inheritsAuth = balanceConnection?.request.auth.type === 'inherit';
    const legacyHeaders = Object.entries(authHeaders).map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const legacyIdentity = legacyHeaders.length ? JSON.stringify(['provider-headers-v1', baseUrl, key, legacyHeaders]) : baseUrl + '\0' + key;
    const identity = selected ? JSON.stringify([selected.id, baseUrl, inheritsAuth ? key : '', inheritsAuth ? authHeaders : {}, balanceConnection.request, balanceSecrets]) : legacyIdentity;
    const accountId = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
    const host = new URL(baseUrl).hostname;
    const providerName = '当前 API';
    const dashboardUrl = (!selected ? setting.dashboardUrl : '') || (host === 'api.openai.com' ? 'https://platform.openai.com/settings/organization/billing/overview' : new URL(baseUrl).origin);
    const connectionInfo = { mode: setting.connectionMode, id: selected?.id || '', name: selected?.name || 'Codex 配置连接',
      adapter: balanceConnection?.adapter || setting.provider, confirmed: balanceConnection?.mapping.confirmed === true,
      source: selected && setting.connectionMode === 'fixed' ? 'fixed' : 'codex-config',
      sourceLabel: setting.connectionMode === 'fixed' ? '固定余额连接' : '仅已读取的 Codex 配置；不含 CLI 临时覆盖',
      projectLoaded: source?.projectLoaded || false, legacyOverride: !selected && !!(setting.baseUrl || setting.keyEnv) };
    const resolvedSetting = selected ? { ...setting, provider: balanceConnection.adapter, currency: balanceConnection.mapping.currency } : setting;
    return { setting: resolvedSetting, id, model: effective.model || '', profileName, providerName, baseUrl, key, keySource, accountId, dashboardUrl,
      balanceConnection, balanceSecrets, authHeaders, connectionInfo, connectionId: selected?.id || '' };
  }
  publicInfo() {
    const c = this.resolve();
    return { providerName: '当前 API', hasKey: !!c.key || Object.keys(c.authHeaders).length > 0 || Object.values(c.balanceSecrets).some(Boolean), connectionInfo: c.connectionInfo, ...this.settingsInfo() };
  }
}
