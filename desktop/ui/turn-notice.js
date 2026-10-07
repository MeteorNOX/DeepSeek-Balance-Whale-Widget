(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleTurnNotice = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function kind(record) {
    if (record.completionKind === 'failed' || ['failed','interrupted','superseded'].includes(record.outcome)) return 'failed';
    if (record.completionKind === 'cancelled' || ['aborted', 'cancelled'].includes(record.outcome)) return 'cancelled';
    return 'success';
  }
  function shouldNotify(record, { seq = 0, id = '', firstPoll = false, startedAt = 0 } = {}) {
    if (!record?.ok || !Number.isSafeInteger(record.seq) || record.seq <= seq || !record.id || record.id === id ||
        record.turn == null || record.notify === false || record.isSubagent) return false;
    const published = record.notificationAt || record.ts;
    const at = typeof published === 'number' ? published : Date.parse(published);
    return !firstPoll || Number.isFinite(at) && at >= startedAt;
  }
  function snapshot(record, nativeCurrency = 'USD', random = Math.random) {
    const completionKind = kind(record);
    const known = record.source !== 'shared-key-interval' && record.amount !== null && record.amount !== undefined && Number.isFinite(Number(record.amount)) &&
      !['pending', 'unknown'].includes(record.costState);
    const failureKind = completionKind === 'failed' && record.failureKind === 'high-demand' ? 'high-demand' : null;
    return Object.freeze({
      id: String(record.id || ''), completionKind,
      failureKind,
      label: failureKind ? '挤不进去...' : known ? (record.source === 'configured-pricing-estimate' ? '本轮消耗（估算）:' : '本轮消耗:') : record.tokens > 0 ? '本轮用量已记录' : '本轮已结束',
      conversationRef: /^[a-f0-9]{8}$/.test(record.conversationRef || '') ? record.conversationRef : '',
      accountIntervalAmount: record.accountIntervalAmount ?? (record.source === 'shared-key-interval' ? record.amount : null),
      amount: known ? Number(record.amount) : null,
      currency: record.currency || nativeCurrency,
      costState: known ? record.costState || 'observed' : record.costState === 'pending' ? 'pending' : 'unknown',
      tokens: Number.isFinite(record.tokens) && record.tokens >= 0 ? Math.floor(record.tokens) : null,
      note: String(record.note || ''),
    });
  }
  function enabled(notice, settings, turnCostOn) {
    return notice.completionKind === 'failed' && notice.failureKind === 'high-demand' || ['success','cancelled','failed'].includes(notice.completionKind) && !!turnCostOn;
  }
  return Object.freeze({ kind, shouldNotify, snapshot, enabled });
});
