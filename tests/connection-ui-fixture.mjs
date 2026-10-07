import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { ConfigStore } from '../runtime/config.mjs';
import { WhaleService } from '../runtime/service.mjs';
import { BalanceProvider } from '../runtime/providers.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixtureKeys = { SOURCE_KEY: 'SYNTHETIC-SOURCE-ONLY', FIXTURE_A: 'SYNTHETIC-A-ONLY', FIXTURE_B: 'SYNTHETIC-B-ONLY', BILLING_A: 'SYNTHETIC-BILLING-A-ONLY', BILLING_B: 'SYNTHETIC-BILLING-B-ONLY' };
export async function makeFixture(dataDir) {
  const codexHome = path.join(dataDir, 'fixture-codex'); fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider="fixture"\n[model_providers.fixture]\nbase_url="https://source.example.test/proxy/v1"\nenv_key="SOURCE_KEY"\n');
  fs.writeFileSync(path.join(dataDir, '.dshw-size.json'), JSON.stringify({ scale: 1, sound: false, vol: 0, bubbleOn: true, turnCostOn: false }));
  const config = new ConfigStore({ dataDir, codexHome, env: { ...fixtureKeys } });
  const control = { requests: [], pending: false, release: null, autoMode: 'trusted' };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url), headers = new Headers(options.headers);
    assert.ok(parsed.hostname.endsWith('.example.test'), 'no external request destination');
    control.requests.push({ url: parsed.origin + parsed.pathname, method: options.method || 'GET', headerNames: [...headers.keys()] });
    if (parsed.pathname === '/late-preview') { control.pending = true; await new Promise(resolve => { control.release = resolve; }); control.pending = false; }
    let payload;
    if (control.autoMode === 'trusted' && parsed.pathname.endsWith('/api/usage/token/')) payload = { code: true, data: { object: 'token_usage', total_available: 1000000, total_used: 500000, total_granted: 1500000, unlimited_quota: false } };
    else if (control.autoMode === 'trusted' && parsed.pathname.endsWith('/api/status')) payload = { success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD', display_in_currency: true } };
    else if (control.autoMode === 'candidate' && parsed.pathname.endsWith('/dashboard/billing/subscription')) payload = { object: 'billing_subscription', hard_limit_usd: 100, soft_limit_usd: 100, system_hard_limit_usd: 100 };
    else if (control.autoMode === 'candidate' && parsed.pathname.endsWith('/dashboard/billing/usage')) payload = { object: 'list', total_usage: 200 };
    else if (parsed.pathname === '/balance-a' || parsed.pathname === '/late-preview') {
      assert.equal(headers.get('authorization'), 'Bearer ' + fixtureKeys.BILLING_A, 'independent billing credential must be used');
      assert.equal(options.method, 'POST'); assert.equal(JSON.parse(options.body).account, 'fixture');
      payload = { data: { balance: 1234.5, used: 12.25 }, ignored: { confidential: 'SYNTHETIC-RESPONSE-MUST-NOT-RENDER' } };
    } else if (parsed.pathname === '/balance-b') {
      assert.equal(headers.get('authorization'), 'Bearer ' + fixtureKeys.BILLING_B);
      payload = { data: { balance: 25, used: 5 } };
    } else if (parsed.pathname === '/quota') {
      payload = { data: { total_available: 35.5, total_used: 2, total_granted: 37.5 } };
    } else if (parsed.pathname === '/unlimited') {
      payload = { data: { unlimited_quota: true, used_quota: 1000000 } };
    } else return new Response(JSON.stringify({ error: 'synthetic route not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  };
  const service = new WhaleService({ config, provider: new BalanceProvider({ fetchImpl, timeoutMs: 15000 }) });
  service.connectionUiFixture = control;
  return { service, monitor: false, autoRefresh: false, fetchImpl, fxFetchImpl: async () => new Response(JSON.stringify({ amount: 1, base: 'USD', date: new Date().toISOString().slice(0, 10), rates: { CNY: 7 } }), { headers: { 'content-type': 'application/json' } }) };
}

export async function verifyDesktop({ app, window, screen, setHost, dispatcher, dataDir, errors }) {
  const output = path.resolve(process.env.WHALE_DESKTOP_VERIFY_DIR), checks = [], geometry = [], screenshots = [];
  const ev = code => window.webContents.executeJavaScript(code), service = dispatcher.whale, control = service.connectionUiFixture;
  const c = name => `[data-connection="${name}"]`;
  const wait = async (code, label, timeout = 10000) => { const until = Date.now() + timeout; while (Date.now() < until) { if (await (typeof code === 'function' ? code() : ev(code))) return; await delay(50); } throw Error('Timed out: ' + label); };
  const ready = async () => { await wait('window.__whaleRenderTest && window.WhaleConnectionSettings && document.querySelector(".dshwv-img")?.naturalWidth > 0', 'real renderer ready'); await wait('!__whaleRenderTest.status().busy', 'initial balance settled'); };
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const field = (name, value) => ev(`(()=>{const input=document.querySelector(${JSON.stringify(c(name))});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event(${JSON.stringify(['mode', 'selection'].includes(name) ? 'change' : 'input')},{bubbles:true}));})()`);
  const openSettings = async () => { await ev('window.dispatchEvent(new Event("whale-open-settings"))'); await wait('document.querySelector("#settings-dialog").open', 'settings opened'); };
  const reloadSave = async () => { const loaded = once(window.webContents, 'did-finish-load'); await ev('document.querySelector("#settings-form").requestSubmit()'); await Promise.race([loaded, delay(8000).then(() => { throw Error('Save did not reload'); })]); await ready(); };
  const preview = async () => { await click(c('preview')); await wait(`!document.querySelector(${JSON.stringify(c('preview'))}).disabled && !document.querySelector(${JSON.stringify(c('previewResult'))}).hidden`, 'preview rendered'); };
  const confirm = async () => { assert.equal(await ev(`document.querySelector(${JSON.stringify(c('confirmed'))}).disabled`), false, 'preview enables explicit confirmation'); await click(c('confirmed')); };
  const persisted = () => {
    const files = [], collect = dir => { if (!fs.existsSync(dir)) return; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) collect(full); else files.push(full); } };
    const settings = path.join(dataDir, 'api-settings.json'); if (fs.existsSync(settings)) files.push(settings); collect(path.join(dataDir, 'ledgers'));
    return Object.fromEntries(files.sort().map(file => [path.relative(dataDir, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  };
  const capture = async name => { const filename = name + '.png'; fs.writeFileSync(path.join(output, filename), (await window.webContents.capturePage()).toPNG()); screenshots.push(filename); };
  const formGeometry = async name => {
    const metric = await ev(`(()=>{const d=document.querySelector('#settings-dialog'),s=d.querySelector('.settings-content'),r=d.getBoundingClientRect();const bad=[...d.querySelectorAll('input,select,textarea,button')].filter(e=>e.checkVisibility()).filter(e=>{const b=e.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1;}).map(e=>e.name||e.dataset.connection||e.id);return {viewport:[innerWidth,innerHeight],dialog:r.toJSON(),scrollWidth:s.scrollWidth,clientWidth:s.clientWidth,overflowControls:bad};})()`);
    assert.ok(metric.dialog.left >= 0 && metric.dialog.right <= metric.viewport[0] + 1, 'dialog fits viewport');
    assert.ok(metric.scrollWidth <= metric.clientWidth + 1, 'settings must not scroll horizontally'); assert.deepEqual(metric.overflowControls, []); geometry.push({ name, ...metric });
  };
  const host = async (width, height) => { const area = screen.getPrimaryDisplay().workArea; await setHost({ hostAlive: true, hostPid: 123456, window: '0', visible: true, attached: true, bounds: screen.dipToScreenRect(null, { x: area.x + 24, y: area.y + 24, width, height }) }); await delay(100); };
  async function buildConnection(name, suffix, adapter = 'custom-json') {
    await click(c('new')); await field('mode', 'fixed');
    for (const [key, value] of Object.entries({ name, baseUrl: `https://source-${suffix}.example.test/proxy/v1`, keyEnv: suffix === 'a' ? 'FIXTURE_A' : 'FIXTURE_B', adapter,
      url: `https://billing-${suffix}.example.test/balance-${suffix}`, authType: 'bearer', authKeyEnv: suffix === 'a' ? 'BILLING_A' : 'BILLING_B', balanceField: 'data.balance', usedField: 'data.used', currency: 'USD', scope: suffix === 'a' ? 'account' : 'api-key-quota', method: suffix === 'a' ? 'POST' : 'GET' })) await field(key, value);
    if (suffix === 'a') await field('advanced', JSON.stringify({ headers: { 'X-Tenant': 'fixture' }, query: { version: 'v1' }, envHeaders: {}, envQuery: {}, body: { account: 'fixture' }, unlimitedField: '', unlimitedValue: true }, null, 2));
    const selected = await ev(`document.querySelector(${JSON.stringify(c('selection'))}).value`);
    assert.equal(await ev('WhaleConnectionSettings.patch().connectionUpdate?.id'), selected, 'new connection preview must target its own draft');
    return selected;
  }
  async function showBalance(name, expected, { small = false } = {}) {
    await host(small ? 380 : 900, small ? 360 : 720);
    await ev(`document.querySelector('#settings-dialog').close();__whaleRenderTest.close();__whaleRenderTest.scale(1);__whaleRenderTest.place(${small ? 40 : 240},${small ? 100 : 260},false);__whaleRenderTest.refresh(true)`);
    await wait('!__whaleRenderTest.status().busy', 'balance response');
    await ev('__whaleRenderTest.queue([{kind:"normal"}]);__whaleRenderTest.open()');
    await wait('!__whaleRenderTest.status().switching && __whaleRenderTest.status().shown', 'default money bubble'); await delay(440);
    const metric = await ev(`(()=>{const p=document.querySelector('.dshwv-pop').getBoundingClientRect(),frame=document.querySelector('.dshwv-frame[aria-hidden="false"]');const cx=p.left+p.width*454/1026,cy=p.top+p.height*248/700,rx=p.width*354/1026,ry=p.height*213/700;const rows=[...frame.children].filter(e=>getComputedStyle(e).display!=='none'&&e.textContent).map(e=>{const b=e.getBoundingClientRect();return {text:e.textContent,ellipse:Math.max(...[b.left,b.right].flatMap(x=>[b.top,b.bottom].map(y=>((x-cx)/rx)**2+((y-cy)/ry)**2)))};});return {text:frame.textContent,rows,viewport:[innerWidth,innerHeight]};})()`);
    const labels = { 'balance-account-normal': '账户可用余额', 'balance-unconfirmed-small': '余额查询', 'balance-unsupported-small': '余额查询', 'balance-key-quota-normal': '密钥剩余额度', 'balance-unlimited-small': '密钥额度' };
    assert.equal(metric.rows[0].text, labels[name], 'default bubble uses the concise monetary scope title');
    assert.ok(metric.text.includes(expected), name + ': ' + metric.text); assert.ok(metric.rows.every(row => row.ellipse <= 1.03), 'all default money rows fit ellipse'); geometry.push({ name, ...metric });
    await capture(name);
    await ev('WhaleDashboard.refresh(true)'); await wait(`document.querySelector('.whale-overview-data').textContent.includes(${JSON.stringify(expected)})`, 'dashboard money state');
    assert.equal(await ev('document.querySelector(".whale-dashboard-label").textContent'), labels[name], 'dashboard and bubble share their concise scope title');
  }
  try {
    assert.equal(dispatcher.watcher, null, 'live sessions disabled');
    const nativeIgnore = window.setIgnoreMouseEvents.bind(window); window.setIgnoreMouseEvents = () => nativeIgnore(true, { forward: false }); window.setIgnoreMouseEvents();
    await host(900, 720); await ready(); await delay(250);
    await openSettings(); const beforePreview = persisted();
    assert.equal(await ev('document.querySelector("[name=provider]").value'), 'auto');
    await click(c('previewCurrent')); await wait(`!document.querySelector(${JSON.stringify(c('currentResult'))}).hidden`, 'automatic preview');
    assert.deepEqual(persisted(), beforePreview, 'automatic preview does not save settings or ledger');
    assert.equal(await ev(`document.querySelector(${JSON.stringify(c('editor'))}).hidden`), true);
    assert.equal(await ev(`document.querySelector(${JSON.stringify(c('useCandidate'))}).hidden`), true, 'trusted protocol needs no manual confirmation');
    assert.match(await ev(`document.querySelector(${JSON.stringify(c('status'))}).textContent`), /无需手工配置/);
    assert.equal((await service.getBalance({ force: true })).totalBalance, 2, 'trusted native raw quota converts from public unit metadata');
    checks.push('default automatic native protocol validates public USD unit metadata and previews without settings or ledger writes or manual JSON');
    control.autoMode = 'candidate'; const beforeDetection = persisted();
    await click(c('redetect')); await wait(`!document.querySelector(${JSON.stringify(c('redetect'))}).disabled && !document.querySelector(${JSON.stringify(c('useCandidate'))}).hidden`, 'candidate has a direct confirmation action');
    assert.deepEqual(persisted(), beforeDetection, 'redetection only previews until the user chooses its candidate');
    assert.match(await ev(`document.querySelector(${JSON.stringify(c('currentResult'))}).textContent`), /说明：.*USD.*假设/, 'candidate explains its unverified unit assumption');
    assert.equal(await ev(`document.querySelector(${JSON.stringify(c('useCandidate'))}).textContent`), '确认并使用');
    await ev(`document.querySelector(${JSON.stringify(c('currentResult'))}).scrollIntoView({block:'start'})`); await capture('automatic-candidate-confirmation');
    const selected = once(window.webContents, 'did-finish-load'); await click(c('useCandidate'));
    await Promise.race([selected, delay(8000).then(() => { throw Error('Candidate selection did not reload'); })]); await ready();
    assert.equal((await service.getBalance({ force: true })).totalBalance, 98, 'proof-bound candidate selection survives renderer reload');
    checks.push('ordinary redetection shows a usable candidate action; using its one-time proof selects and saves the detected protocol without advanced configuration');
    await openSettings();
    const idA = await buildConnection('合成账单 A', 'a'); const beforeNamedPreview = persisted(); await preview();
    assert.deepEqual(persisted(), beforeNamedPreview, 'named preview is read-only');
    assert.equal(await ev('document.body.textContent.includes("SYNTHETIC-RESPONSE-MUST-NOT-RENDER")'), false);
    await confirm(); await formGeometry('settings-normal'); await capture('settings-normal'); await reloadSave();
    let a = service.config.readConnection(idA); assert.equal(a.balance.mapping.confirmed, true); assert.equal(service.config.load().selectedConnection, idA);
    assert.equal((await service.getBalance({ force: true })).totalBalance, 1234.5);
    assert.ok(control.requests.some(request => request.url === 'https://billing-a.example.test/balance-a' && request.method === 'POST'));
    checks.push('fixed POST connection uses an independent environment credential; preview, confirmation, save and real renderer reload succeed');
    await openSettings(); assert.equal(await ev(`document.querySelector(${JSON.stringify(c('baseUrl'))}).value`), ''); await click(c('load'));
    await wait(`!document.querySelector(${JSON.stringify(c('editor'))}).hidden`, 'explicit rule load');
    await field('mode', 'follow'); assert.equal(await ev(`document.querySelector(${JSON.stringify(c('confirmed'))}).checked`), false);
    await field('mode', 'fixed'); assert.equal(await ev(`document.querySelector(${JSON.stringify(c('confirmed'))}).disabled`), true);
    await field('balanceScale', '0.01'); assert.equal(await ev(`document.querySelector(${JSON.stringify(c('confirmed'))}).checked`), false);
    assert.equal(await ev(`document.querySelector(${JSON.stringify(c('confirmed'))}).disabled`), true);
    await host(380, 360); await formGeometry('settings-small'); await capture('settings-small');
    await field('url', 'https://billing-a.example.test/late-preview'); await click(c('preview'));
    await wait(() => control.pending, 'held synthetic preview'); await click('#cancel-settings'); await openSettings();
    control.release(); await delay(250);
    assert.equal(await ev(`document.querySelector(${JSON.stringify(c('confirmed'))}).disabled`), true);
    assert.equal(await ev(`document.querySelector(${JSON.stringify(c('previewResult'))}).hidden`), true);
    assert.deepEqual(service.config.readConnection(idA), a);
    checks.push('mode and unit edits clear monetary confirmation; a late preview cannot restore confirmation after closing and reopening settings');
    await host(900, 720); const idB = await buildConnection('合成密钥 B', 'b'); await preview(); await confirm(); await reloadSave();
    assert.equal((await service.getBalance({ force: true })).totalBalance, 25); assert.deepEqual(service.config.readConnection(idA), a);
    await openSettings(); await field('selection', idA); await reloadSave();
    assert.equal((await service.getBalance({ force: true })).totalBalance, 1234.5);
    await openSettings(); await field('selection', idB); await click(c('delete'));
    await wait(`!document.querySelector(${JSON.stringify(c('delete'))}).disabled && document.querySelector(${JSON.stringify(c('status'))}).textContent==='已删除连接'`, 'delete inactive B acknowledged in renderer');
    assert.equal(service.config.load().connections.some(record => record.id === idB), false);
    assert.deepEqual(service.config.readConnection(idA), a);
    await field('mode', 'fixed'); await field('selection', idA); await reloadSave();
    assert.equal((await service.getBalance({ force: true })).totalBalance, 1234.5);
    checks.push('a second named connection saves and switches independently; deleting it preserves A and fixed selection reloads A without exposing rules');
    await showBalance('balance-account-normal', '1234.50');
    service.config.save({ connectionUpdate: { id: idA, value: { balance: { mapping: { confirmed: false } } } } });
    await showBalance('balance-unconfirmed-small', '金额口径待确认', { small: true });
    service.config.save({ connectionUpdate: { id: idA, value: { balance: { adapter: 'none' } } } });
    await showBalance('balance-unsupported-small', '未提供余额接口', { small: true });
    const quota = { adapter: 'newapi', request: { url: 'https://billing-a.example.test/quota', method: 'GET', auth: { type: 'bearer', keyEnv: 'BILLING_A', header: '' }, headers: {}, envHeaders: {}, query: {}, envQuery: {}, body: null }, mapping: { confirmed: true, balanceScale: 1, usedScale: 1 } };
    service.config.save({ connectionUpdate: { id: idA, value: { balance: quota } } });
    await showBalance('balance-key-quota-normal', '35.50');
    assert.match(await ev('document.querySelector(".whale-overview-data").textContent'), /密钥/);
    service.config.save({ connectionUpdate: { id: idA, value: { balance: { request: { url: 'https://billing-a.example.test/unlimited' }, mapping: { confirmed: true } } } } });
    await showBalance('balance-unlimited-small', '密钥不限额', { small: true });
    checks.push('account, unconfirmed, unsupported, finite key quota and unlimited key quota render correct labels and stay inside the ellipse at normal and small sizes');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    fs.writeFileSync(path.join(output, 'connection-ui.json'), JSON.stringify({ ok: true, dataDir, checks, geometry, screenshots, requests: control.requests, errors }, null, 2));
    await setHost({ hostAlive: false });
  } catch (error) {
    try { await capture('connection-ui-failure'); } catch {}
    control.release?.();
    fs.writeFileSync(path.join(output, 'connection-ui.json'), JSON.stringify({ ok: false, dataDir, error: error.stack, checks, geometry, screenshots, requests: control.requests, errors }, null, 2));
    app.exit(1);
  }
}
