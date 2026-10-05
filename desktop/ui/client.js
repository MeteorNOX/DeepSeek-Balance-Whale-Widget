(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let toastTimer;
  const privateFields = ['baseUrl', 'keyEnv', 'profile', 'projectDir', 'dashboardUrl', 'balancePath', 'balanceField', 'usedField'];
  const resetFields = new Set();
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000); }
  window.whaleToast = toast;
  async function api(url, method = 'GET', body) {
    const response = await fetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    const result = await response.json();
    if (result.ok === false) throw new Error(result.error || '操作未完成');
    return result;
  }
  const form = $('settings-form');
  const element = name => form.elements.namedItem(name);
  for (const key of privateFields) {
    const input = element(key), reset = document.createElement('button');
    input.autocomplete = 'off'; input.spellcheck = false;
    reset.type = 'button'; reset.className = 'private-reset'; reset.textContent = '恢复默认';
    reset.dataset.resetField = key;
    reset.setAttribute('aria-label', '恢复' + input.closest('label').firstChild.textContent.trim() + '默认值');
    reset.addEventListener('click', () => {
      resetFields.add(key); input.value = ''; input.placeholder = '保存后恢复默认'; input.focus();
    });
    input.addEventListener('input', () => { if (input.value.trim()) resetFields.delete(key); });
    input.insertAdjacentElement('afterend', reset);
  }
  async function openSettings() {
    try {
      const info = await api('/api/config'), settings = info.settings;
      resetFields.clear();
      for (const key of ['provider', 'currency', 'balanceScale', 'billingUsageDivisor', 'quotaPerUnit']) element(key).value = settings[key] ?? '';
      for (const key of privateFields) {
        element(key).value = '';
        element(key).placeholder = info.configured?.[key] ? '已配置（内容隐藏）；留空保持不变' : '留空保持默认；填写新值可修改';
      }
      element('monitorSessions').checked = settings.monitorSessions;
      for (const key of ['priceModel', 'priceInput', 'priceCached', 'priceOutput', 'priceWrite']) element(key).value = '';
      element('removePrice').checked = false;
      window.WhaleConnectionSettings?.open(info);
      $('settings-error').hidden = true; $('settings-dialog').showModal();
    } catch (error) { toast(error.message); }
  }
  window.addEventListener('whale-open-settings', openSettings);
  for (const id of ['close-settings', 'cancel-settings']) $(id).addEventListener('click', () => $('settings-dialog').close());
  function collectSettings() {
      const settings = {};
      for (const key of ['provider', 'currency']) settings[key] = element(key).value.trim();
      for (const key of privateFields) {
        const value = element(key).value.trim();
        if (value) settings[key] = value;
        else if (resetFields.has(key)) settings[key] = key === 'balanceField' ? 'data.balance' : '';
      }
      for (const key of ['balanceScale', 'billingUsageDivisor', 'quotaPerUnit']) settings[key] = Number(element(key).value);
      settings.monitorSessions = element('monitorSessions').checked;
      const fields = ['priceInput', 'priceCached', 'priceOutput'];
      const hasPrice = [...fields, 'priceWrite'].some(key => element(key).value !== '');
      const model = element('priceModel').value.trim();
      if (element('removePrice').checked) {
        if (!model || hasPrice) throw new Error('删除价格时请只填写模型名称，不填写价格');
        settings.pricingUpdate = { model, prices: null };
      } else if (hasPrice) {
        if (!model || fields.some(key => element(key).value === '')) throw new Error('请完整填写模型名称、输入、缓存命中和输出价格');
        const prices = { input: Number(element('priceInput').value), cachedInput: Number(element('priceCached').value), output: Number(element('priceOutput').value) };
        if (element('priceWrite').value !== '') prices.cacheWrite = Number(element('priceWrite').value);
        settings.pricingUpdate = { model, prices };
      } else if (model) throw new Error('请填写完整价格，或选择删除该模型价格');
      const connectionPatch = window.WhaleConnectionSettings?.patch() || {};
      if (connectionPatch.connectionMode === 'fixed' || connectionPatch.connectionUpdate) {
        for (const key of ['provider', 'currency', 'baseUrl', 'keyEnv', 'dashboardUrl', 'balancePath', 'balanceField', 'usedField', 'balanceScale', 'billingUsageDivisor', 'quotaPerUnit']) delete settings[key];
      }
      return Object.assign(settings, connectionPatch);
  }
  window.WhaleSettingsDraft = collectSettings;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await api('/api/config', 'PUT', collectSettings()); location.reload();
    } catch (error) { $('settings-error').hidden = false; $('settings-error').textContent = error.message; }
  });
})();
