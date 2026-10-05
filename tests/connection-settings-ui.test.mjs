import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../desktop/ui/connection-settings.js', import.meta.url), 'utf8');
const exported = { module: { exports: {} } }; vm.runInNewContext(source, exported);
const { makeRecord, newRecord, previewText } = exported.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor() { this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.textContent = ''; this.listeners = new Map(); this.children = []; this.label = { hidden: false }; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  async fire(type) { return this.listeners.get(type)?.({ preventDefault() {} }); }
  closest() { return this.label; }
  append(child) { this.children.push(child); child.remove = () => { this.children = this.children.filter(item => item !== child); }; }
  replaceChildren() { this.children = []; }
  querySelector(selector) { const value = selector.match(/value="([^"]+)"/)?.[1]; return this.children.find(child => child.value === value) || null; }
  focus() {}
}
function ui() {
  const controls = new Map();
  for (const match of source.matchAll(/get\('([^']+)'\)/g)) if (!controls.has(match[1])) controls.set(match[1], new Element());
  for (const name of ['name', 'providerId', 'profile', 'baseUrl', 'keyEnv', 'adapter', 'url', 'method', 'authType', 'authKeyEnv', 'authHeader', 'balanceField', 'usedField', 'scope', 'currency', 'balanceScale', 'usedScale', 'advanced', 'confirmed', 'load', 'new', 'delete', 'previewCurrent']) if (!controls.has(name)) controls.set(name, new Element());
  const section = { querySelector: selector => controls.get(selector.match(/="([^"]+)"/)?.[1]) }, dialog = new Element(), legacy = new Element(), requests = [];
  const record = plain(newRecord('saved')); record.name = '工作连接'; record.baseUrl = 'https://private.example.test/v1'; record.keyEnv = 'PRIVATE_REFERENCE'; record.match.providerId = 'work'; record.balance.adapter = 'custom-json'; record.balance.request.url = 'https://private.example.test/balance'; record.balance.mapping.confirmed = true;
  let response = async url => url.startsWith('/api/connections/') ? { ok: true, connection: record } : { ok: true, balanceStatus: 'unconfirmed', preview: { balance: 12, used: 3, currency: 'USD', scope: 'account', adapter: 'custom-json' }, raw: { credential: 'NEVER_DISPLAY_PROVIDER_BODY' } };
  const window = {}, document = { getElementById: id => id === 'connection-settings' ? section : id === 'settings-dialog' ? dialog : { elements: { namedItem: () => legacy } }, createElement: () => new Element() };
  vm.runInNewContext(source, { window, document, crypto: { randomUUID: () => 'new-id' }, fetch: async (url, options) => { requests.push({ url, options }); return { json: () => response(url, options) }; } });
  const info = { settings: { connectionMode: 'follow', selectedConnection: 'saved' }, connections: [{ id: 'saved', name: record.name, adapter: 'custom-json', confirmed: true }] };
  window.WhaleConnectionSettings.open(info);
  return { controls, window, dialog, legacy, requests, record, info, setResponse: fn => { response = fn; } };
}

test('connection summaries do not load private rules; fixed selection saves without erasing them', () => {
  const { controls, window, requests } = ui();
  assert.equal(requests.length, 0); assert.equal(controls.get('editor').hidden, true); assert.equal(controls.get('baseUrl').value, '');
  controls.get('mode').value = 'fixed';
  assert.deepEqual(plain(window.WhaleConnectionSettings.patch()), { connectionMode: 'fixed', selectedConnection: 'saved' });
});

test('explicit load, rule edit, preview and confirmation are separate from persistence', async () => {
  const { controls, window, requests, record } = ui();
  await controls.get('load').fire('click');
  assert.equal(requests[0].url, '/api/connections/saved'); assert.equal(controls.get('baseUrl').value, record.baseUrl);
  controls.get('balanceScale').value = '0.01'; await controls.get('balanceScale').fire('input');
  assert.equal(controls.get('confirmed').checked, false); assert.equal(controls.get('confirmed').disabled, true);
  assert.equal(window.WhaleConnectionSettings.patch().connectionUpdate.value.balance.mapping.confirmed, false);
  await controls.get('preview').fire('click');
  assert.equal(requests[1].url, '/api/balance-preview'); assert.equal(requests[1].options.method, 'POST');
  assert.equal(controls.get('confirmed').disabled, false); assert.match(controls.get('previewResult').textContent, /12 USD/);
  assert.doesNotMatch(controls.get('previewResult').textContent, /NEVER_DISPLAY|credential|raw/);
  controls.get('confirmed').checked = true; await controls.get('confirmed').fire('change');
  assert.equal(window.WhaleConnectionSettings.patch().connectionUpdate.value.balance.mapping.confirmed, true);
  assert.equal(requests.some(item => item.options.method === 'PUT'), false);
});

test('closing settings while a load is pending cannot expose the late private response', async () => {
  const { controls, dialog, setResponse, record } = ui(); let finish;
  setResponse(() => new Promise(resolve => { finish = resolve; }));
  const loading = controls.get('load').fire('click');
  for (let turn = 0; turn < 8 && !finish; turn++) await Promise.resolve();
  await dialog.fire('close');
  finish({ ok: true, connection: record }); await loading;
  assert.equal(controls.get('baseUrl').value, ''); assert.equal(controls.get('editor').hidden, true);
});

test('current interface preview works without loading or creating a connection', async () => {
  const { controls, window, requests } = ui();
  window.WhaleSettingsDraft = () => ({ provider: 'auto', connectionMode: 'follow', selectedConnection: '' });
  await controls.get('previewCurrent').fire('click');
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/balance-preview');
  assert.equal(JSON.parse(requests[0].options.body).patch.provider, 'auto'); assert.equal(controls.get('editor').hidden, true);
});

test('a queued close event from the previous dialog cannot reset a reopened editor', async () => {
  const { controls, dialog, window, info } = ui();
  window.WhaleConnectionSettings.open(info); dialog.open = true;
  await dialog.fire('close'); await controls.get('new').fire('click');
  controls.get('name').value = '重新打开'; controls.get('providerId').value = 'work';
  assert.equal(window.WhaleConnectionSettings.patch().connectionUpdate.value.name, '重新打开');
});

test('changing follow/fixed mode revokes previous monetary confirmation even before loading rules', async () => {
  const { controls, window } = ui();
  controls.get('mode').value = 'fixed'; await controls.get('mode').fire('change');
  assert.equal(window.WhaleConnectionSettings.patch().connectionUpdate.value.balance.mapping.confirmed, false);
  await controls.get('load').fire('click');
  assert.equal(controls.get('confirmed').checked, false); assert.equal(controls.get('confirmed').disabled, true);
  await controls.get('preview').fire('click'); controls.get('confirmed').checked = true; await controls.get('confirmed').fire('change');
  controls.get('mode').value = 'follow'; await controls.get('mode').fire('change');
  assert.equal(controls.get('confirmed').checked, false); assert.equal(controls.get('previewResult').hidden, true);
  assert.equal(window.WhaleConnectionSettings.patch().connectionUpdate.value.balance.mapping.confirmed, false);
});

test('new connections need a follow source and carry no secret literal field', async () => {
  const { controls, window } = ui(); await controls.get('new').fire('click');
  controls.get('name').value = '新连接';
  assert.throws(() => window.WhaleConnectionSettings.patch(), /provider ID/);
  controls.get('providerId').value = 'work';
  const patch = plain(window.WhaleConnectionSettings.patch());
  assert.equal(patch.connectionUpdate.value.balance.adapter, 'none'); assert.equal(patch.connectionUpdate.value.balance.mapping.confirmed, false);
  assert.equal(patch.connectionUpdate.value.keyEnv, ''); assert.equal(Object.hasOwn(patch.connectionUpdate.value, 'apiKey'), false);
});

test('advanced rules reject typos and invalid JSON; preview never coerces null to zero', () => {
  assert.throws(() => makeRecord('example', { advanced: '{"rawToken":"x"}' }), /未知字段/);
  assert.throws(() => makeRecord('example', { advanced: '[]' }), /JSON 对象/);
  const text = previewText({ preview: { balance: null, used: null, currency: 'USD', scope: 'account', adapter: 'custom-json' }, raw: 'secret' });
  assert.match(text, /预览余额：未知 USD/); assert.doesNotMatch(text, /secret|0 USD/);
});

test('changing authentication type drops inactive credential reference fields', async () => {
  const { controls, window } = ui(); await controls.get('load').fire('click');
  controls.get('authKeyEnv').value = 'BILLING_KEY'; controls.get('authHeader').value = 'api-key';
  controls.get('authType').value = 'none'; await controls.get('authType').fire('input');
  assert.deepEqual(plain(window.WhaleConnectionSettings.patch().connectionUpdate.value.balance.request.auth), { type: 'none', keyEnv: '', header: '' });
});

test('fixed connection saves do not mix legacy endpoint, key or conversion fields into the patch', () => {
  const client = fs.readFileSync(new URL('../desktop/ui/client.js', import.meta.url), 'utf8');
  const collect = client.slice(client.indexOf('  function collectSettings()'), client.indexOf('  window.WhaleSettingsDraft ='));
  const values = { provider: 'billing', currency: 'CNY', baseUrl: 'https://legacy.example.test/v1', keyEnv: 'LEGACY_KEY', balanceScale: '2', billingUsageDivisor: '100', quotaPerUnit: '500000' };
  const context = { privateFields: ['baseUrl', 'keyEnv', 'profile', 'projectDir', 'dashboardUrl', 'balancePath', 'balanceField', 'usedField'], resetFields: new Set(),
    element: name => ({ value: values[name] || '', checked: name === 'monitorSessions' }),
    window: { WhaleConnectionSettings: { patch: () => ({ connectionMode: 'fixed', selectedConnection: 'saved' }) } } };
  const result = vm.runInNewContext(collect + '\ncollectSettings()', context);
  assert.deepEqual(plain(result), { monitorSessions: true, connectionMode: 'fixed', selectedConnection: 'saved' });
});
