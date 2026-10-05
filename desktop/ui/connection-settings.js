(function (host) {
  'use strict';
  const adapters = { none: '不查询余额', auto: '自动探测（金额待确认）', billing: '兼容账单', newapi: '密钥额度', deepseek: 'DeepSeek 余额', 'custom-json': '自定义 JSON' };
  const help = {
    none: '保留 token 与任务记录，不查询余额。',
    auto: '自动探测只提供候选结果。选择具体接口并确认币种、范围和单位后再记账。',
    billing: 'URL 填账单基准目录，将追加 dashboard/billing/subscription 和 usage。额度为 USD；用量默认按美分除以 100，再分别乘下方系数。',
    newapi: 'URL 填完整额度接口。total_available / total_used 按金额读取；remain_quota / used_quota 默认除以 500000，再分别乘下方系数。此接口表示密钥额度。',
    deepseek: 'URL 填完整余额接口。原始余额乘余额系数，币种采用接口返回值。',
    'custom-json': 'URL 填完整余额接口。分别读取金额字段并乘换算系数；请确认结果是账户余额还是密钥额度。'
  };
  function objectJson(value, label) {
    let parsed;
    try { parsed = JSON.parse(value || '{}'); } catch { throw Error(label + '须为有效 JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error(label + '须为 JSON 对象');
    return parsed;
  }
  function makeRecord(id, values) {
    const advanced = objectJson(values.advanced, '高级规则');
    if (Object.keys(advanced).some(key => !['headers', 'envHeaders', 'query', 'envQuery', 'body', 'unlimitedField', 'unlimitedValue'].includes(key))) throw Error('高级规则包含未知字段');
    const scale = (key, label) => { const n = Number(values[key]); if (!Number.isFinite(n) || n <= 0) throw Error(label + '须大于零'); return n; };
    const record = { id, name: String(values.name || '').trim(), match: { providerId: String(values.providerId || '').trim(), profile: String(values.profile || '').trim() },
      baseUrl: String(values.baseUrl || '').trim(), keyEnv: String(values.keyEnv || '').trim(), balance: {
        adapter: values.adapter, request: { url: String(values.url || '').trim(), method: values.method,
          auth: { type: values.authType, keyEnv: ['bearer', 'header'].includes(values.authType) ? String(values.authKeyEnv || '').trim() : '', header: values.authType === 'header' ? String(values.authHeader || '').trim() : '' },
          headers: advanced.headers || {}, envHeaders: advanced.envHeaders || {}, query: advanced.query || {}, envQuery: advanced.envQuery || {}, body: advanced.body ?? null },
        mapping: { balanceField: String(values.balanceField || '').trim(), usedField: String(values.usedField || '').trim(),
          unlimitedField: advanced.unlimitedField || '', unlimitedValue: advanced.unlimitedValue ?? true,
          scope: values.scope, currency: String(values.currency || 'USD').trim().toUpperCase(),
          balanceScale: scale('balanceScale', '余额系数'), usedScale: scale('usedScale', '消耗系数'), confirmed: values.confirmed === true && !['none', 'auto'].includes(values.adapter) }
      } };
    if (!record.name) throw Error('请填写连接名称');
    if (!Object.hasOwn(adapters, record.balance.adapter)) throw Error('请选择余额接口');
    return record;
  }
  function newRecord(id) {
    return { id, name: '', match: { providerId: '', profile: '' }, baseUrl: '', keyEnv: '', balance: {
      adapter: 'none', request: { url: '', method: 'GET', auth: { type: 'inherit', keyEnv: '', header: '' }, headers: {}, envHeaders: {}, query: {}, envQuery: {}, body: null },
      mapping: { balanceField: 'data.balance', usedField: '', unlimitedField: '', unlimitedValue: true, scope: 'account', currency: 'USD', balanceScale: 1, usedScale: 1, confirmed: false }
    } };
  }
  function previewText(result) {
    const preview = result.preview;
    if (!preview) return result.error || (result.balanceStatus === 'unsupported' ? '未提供余额接口' : '暂未取得可预览的金额');
    const number = value => typeof value === 'number' && Number.isFinite(value) ? String(value) : '未知';
    const scope = { account: '账户余额', 'api-key-quota': '密钥额度', custom: '自定义金额' }[preview.scope] || '范围未知';
    return ['预览余额：' + number(preview.balance) + ' ' + (preview.currency || ''), '累计消耗：' + number(preview.used) + ' ' + (preview.currency || ''),
      '金额范围：' + scope, '接口：' + (adapters[preview.adapter] || '未知'), result.balanceStatus === 'unlimited' ? '密钥不限额' : '',
      '此预览不会保存规则、记账或触发预警。'].filter(Boolean).join('\n');
  }
  function init() {
    const section = document.getElementById('connection-settings');
    if (!section) return;
    const get = name => section.querySelector('[data-connection="' + name + '"]');
    const fields = ['name', 'providerId', 'profile', 'baseUrl', 'keyEnv', 'adapter', 'url', 'method', 'authType', 'authKeyEnv', 'authHeader', 'balanceField', 'usedField', 'scope', 'currency', 'balanceScale', 'usedScale', 'advanced', 'confirmed'];
    let summaries = [], loaded = null, dirty = false, serial = 0, busy = false, previewReady = false, opened = false, modeValue = 'follow', modeChanged = false;
    const status = message => { get('status').textContent = message; get('status').hidden = !message; };
    async function request(url, method = 'GET', body) {
      const response = await fetch(url, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json();
      if (data.ok === false && !url.includes('balance-preview')) throw Error(data.error || '操作未完成');
      return data;
    }
    function setBusy(value) { busy = value; get('editor').disabled = value; for (const name of ['load', 'new', 'delete', 'preview', 'previewCurrent', 'selection', 'mode']) get(name).disabled = value; }
    function resetEditor() {
      loaded = null; dirty = false; previewReady = false; get('editor').hidden = true; get('previewResult').hidden = true; get('currentResult').hidden = true;
      for (const name of fields) { const input = get(name); if (name === 'confirmed') { input.checked = false; input.disabled = true; } else input.value = ''; }
    }
    function updateHelp() {
      const adapter = get('adapter').value;
      get('adapterHelp').textContent = help[adapter] || '';
      get('mappingFields').hidden = adapter !== 'custom-json';
      get('requestFields').hidden = adapter === 'none';
      get('moneyFields').hidden = adapter === 'none';
      get('confirmation').hidden = ['none', 'auto'].includes(adapter);
      get('authHeader').closest('label').hidden = get('authType').value !== 'header';
      get('authKeyEnv').closest('label').hidden = !['bearer', 'header'].includes(get('authType').value);
      get('modeHelp').textContent = get('mode').value === 'fixed' ? '固定使用所选连接。请明确填写 API 地址，并绑定该服务的专用密钥环境变量。' : '按 Codex provider 与 profile 匹配已保存连接；无法匹配时保留未确认状态。';
      const legacy = document.getElementById('settings-form').elements.namedItem('provider');
      if (legacy) { legacy.disabled = get('mode').value === 'fixed'; legacy.closest('label').hidden = get('mode').value === 'fixed'; }
    }
    function showRecord(record) {
      loaded = record; dirty = modeChanged; previewReady = false;
      const request = record.balance.request, mapping = record.balance.mapping;
      const values = { name: record.name, providerId: record.match.providerId, profile: record.match.profile, baseUrl: record.baseUrl, keyEnv: record.keyEnv,
        adapter: record.balance.adapter, url: request.url, method: request.method, authType: request.auth.type, authKeyEnv: request.auth.keyEnv, authHeader: request.auth.header,
        balanceField: mapping.balanceField, usedField: mapping.usedField, scope: mapping.scope, currency: mapping.currency, balanceScale: mapping.balanceScale, usedScale: mapping.usedScale,
        advanced: JSON.stringify({ headers: request.headers, envHeaders: request.envHeaders, query: request.query, envQuery: request.envQuery, body: request.body, unlimitedField: mapping.unlimitedField, unlimitedValue: mapping.unlimitedValue }, null, 2) };
      for (const [name, value] of Object.entries(values)) get(name).value = value ?? '';
      get('confirmed').checked = mapping.confirmed === true && !modeChanged; get('confirmed').disabled = !mapping.confirmed || modeChanged;
      get('editor').hidden = false; get('previewResult').hidden = true; updateHelp();
    }
    function open(info) {
      serial++; opened = true; summaries = info.connections || []; resetEditor(); status('');
      get('mode').value = info.settings.connectionMode || info.connectionMode || 'follow';
      modeValue = get('mode').value; modeChanged = false;
      get('selection').replaceChildren();
      const option = (value, label) => { const item = document.createElement('option'); item.value = value; item.textContent = label; get('selection').append(item); };
      option('', '选择连接'); for (const record of summaries) option(record.id, record.name + ' · ' + (adapters[record.adapter] || record.adapter) + (record.confirmed || record.adapter === 'none' ? '' : ' · 未确认'));
      get('selection').value = info.settings.selectedConnection || info.selectedConnection || '';
      get('summary').textContent = '已有 URL、环境变量引用和规则默认隐藏。选择“载入规则”后才会展示。';
      setBusy(false); updateHelp();
    }
    function readRecord() {
      const values = Object.fromEntries(fields.map(name => [name, name === 'confirmed' ? get(name).checked : get(name).value]));
      return makeRecord(loaded.id, values);
    }
    function patch({ preview = false } = {}) {
      if (!opened) return {};
      if (busy && !preview) throw Error('请等待当前连接操作完成');
      const result = { connectionMode: get('mode').value, selectedConnection: get('selection').value };
      if (result.connectionMode === 'fixed' && !result.selectedConnection) throw Error('固定模式须选择连接');
      if (loaded && dirty) {
        const record = readRecord();
        if (result.connectionMode === 'fixed' && !record.baseUrl) throw Error('固定模式须填写该连接的 API 地址');
        if (result.connectionMode === 'follow' && !record.match.providerId) throw Error('跟随模式须填写 Codex provider ID，例如 openai');
        result.connectionUpdate = { id: loaded.id, value: record };
      } else if (modeChanged && result.selectedConnection) {
        result.connectionUpdate = { id: result.selectedConnection, value: { balance: { mapping: { confirmed: false } } } };
      }
      return result;
    }
    get('selection').addEventListener('change', () => { serial++; resetEditor(); status('规则仍隐藏；可保存选择，或载入后编辑。'); });
    get('mode').addEventListener('change', () => {
      if (get('mode').value !== modeValue) {
        modeValue = get('mode').value; modeChanged = true; serial++; previewReady = false;
        if (loaded) dirty = true;
        get('confirmed').checked = false; get('confirmed').disabled = true; get('previewResult').hidden = true; get('currentResult').hidden = true;
        status('连接方式已改变，请按新的来源重新预览并确认金额。');
      }
      updateHelp();
    });
    get('new').addEventListener('click', () => {
      serial++; const id = 'connection-' + crypto.randomUUID(); const item = document.createElement('option'); item.value = id; item.textContent = '新连接'; get('selection').append(item); get('selection').value = id;
      showRecord(newRecord(id)); dirty = true; status('填写新连接。未确认的金额只供预览，不参与记账和预警。'); get('name').focus();
    });
    get('load').addEventListener('click', async () => {
      const id = get('selection').value; if (!id) { status('请先选择连接'); return; }
      const own = ++serial; setBusy(true);
      try { const data = await request('/api/connections/' + encodeURIComponent(id)); if (own !== serial) return; showRecord(data.connection || data.record || data); status('已载入 URL 和环境变量引用；不包含真实密钥。'); }
      catch (error) { if (own === serial) status(error.message); }
      finally { if (own === serial) setBusy(false); }
    });
    get('delete').addEventListener('click', async () => {
      const id = get('selection').value; if (!id) { status('请先选择连接'); return; }
      if (!summaries.some(item => item.id === id)) { get('selection').querySelector('option[value="' + id + '"]')?.remove(); get('selection').value = ''; resetEditor(); status('已移除未保存连接'); return; }
      const own = ++serial; setBusy(true);
      try { const data = await request('/api/config', 'PUT', { connectionDelete: id }); if (own !== serial) return; open(data); status('已删除连接'); }
      catch (error) { if (own === serial) status(error.message); }
      finally { if (own === serial) setBusy(false); }
    });
    for (const name of fields) get(name).addEventListener(name === 'confirmed' ? 'change' : 'input', () => {
      dirty = true;
      if (name !== 'confirmed' && name !== 'name') { serial++; previewReady = false; get('confirmed').checked = false; get('confirmed').disabled = true; get('previewResult').hidden = true; }
      if (name === 'adapter' || name === 'authType') updateHelp();
    });
    get('preview').addEventListener('click', async () => {
      const own = ++serial;
      try {
        const draft = patch({ preview: true }); setBusy(true); status('正在预览，不会记账…');
        const data = await request('/api/balance-preview', 'POST', { patch: draft }); if (own !== serial) return;
        get('previewResult').textContent = previewText(data); get('previewResult').hidden = false;
        previewReady = data.ok !== false && !!data.preview;
        get('confirmed').disabled = !previewReady; status(previewReady ? '请核对金额、币种和范围，再勾选确认。' : data.error || '尚未取得可确认的金额');
      } catch (error) { if (own === serial) status(error.message); }
      finally { if (own === serial) setBusy(false); }
    });
    get('previewCurrent').addEventListener('click', async () => {
      const own = ++serial;
      try {
        const draft = host.WhaleSettingsDraft ? host.WhaleSettingsDraft() : patch(); setBusy(true); status('正在预览，不会记账…');
        const data = await request('/api/balance-preview', 'POST', { patch: draft }); if (own !== serial) return;
        get('currentResult').textContent = previewText(data); get('currentResult').hidden = false;
        status(data.ok === false ? data.error || '尚未取得可预览的金额' : '预览已完成；如需确认自定义金额，请载入或新建连接规则。');
      } catch (error) { if (own === serial) status(error.message); }
      finally { if (own === serial) setBusy(false); }
    });
    const dialog = document.getElementById('settings-dialog');
    dialog.addEventListener('close', () => {
      // HTML dialog queues its close event. A rapid reopen can already own a
      // fresh editor by the time that old event is delivered.
      if (dialog.open) return;
      serial++; resetEditor(); opened = false;
    });
    host.WhaleConnectionSettings = { open, patch };
  }
  if (typeof module === 'object' && module.exports) module.exports = { makeRecord, newRecord, previewText };
  else init();
})(typeof window === 'object' ? window : globalThis);
