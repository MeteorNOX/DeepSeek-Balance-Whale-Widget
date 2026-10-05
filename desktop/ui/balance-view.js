(function (host) {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function describe(payload = {}) {
    const status = payload.balanceStatus || (payload.unlimited ? 'unlimited' : finite(payload.totalBalance) ? 'finite' : '');
    const balance = status === 'finite' && finite(payload.totalBalance) ? payload.totalBalance : null;
    const observable = payload.ok !== false && payload.canObserve !== false && (status === 'finite' || status === 'unlimited');
    const label = status === 'unconfirmed' || status === 'unsupported' ? '余额查询' : status === 'unlimited' ? '密钥额度' :
      ({ account: '账户可用余额', 'api-key-quota': '密钥剩余额度', custom: '自定义余额' }[payload.balanceScope] || payload.balanceLabel || 'API 余额');
    const message = status === 'unconfirmed' ? '金额口径待确认' : status === 'unsupported' ? '未提供余额接口' : status === 'unlimited' ? '密钥不限额' : '';
    return { status, balance, label, message, canObserve: observable,
      todayUsage: observable && finite(payload.todayUsage) ? payload.todayUsage : null,
      canAlertBalance: observable && status === 'finite' && balance !== null,
      canAlertBudget: observable && finite(payload.todayUsage) && (status !== 'unlimited' || payload.counter === 'used') };
  }
  function amount(payload, format) {
    const view = describe(payload);
    return view.message || (view.balance === null ? '暂不可用' : format(view.balance, payload.currency || 'USD'));
  }
  const api = Object.freeze({ describe, amount, finite });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleBalanceView = api;
})(typeof window === 'object' ? window : globalThis);
