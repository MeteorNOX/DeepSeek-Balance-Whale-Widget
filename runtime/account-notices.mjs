import { createHash, randomUUID } from 'node:crypto';
import { decimalAdd } from './money-precision.mjs';

export const accountNoticeScope = (scope, meterKey) => createHash('sha256').update(scope + ':' + (meterKey || '')).digest('hex');
const positive = value => Number(value) > 0;

// Lives inside the ledger: debit observation and its outbox are committed by
// one atomic write. The queue is one immutable issued batch plus one aggregate.
export function observeAccountDebit(ledger, { delta, meterKey, mode, at, intervalStart, concurrentCount = 0 }) {
  let state = ledger.accountNotices;
  if (!state || state.version !== 1 || state.meterKey !== meterKey || state.mode !== mode) {
    // Upgrading an existing ledger must not present its historical balance gap
    // as newly observed spending. A different meter also needs a fresh baseline.
    ledger.accountNotices = { version: 1, meterKey, mode, epoch: randomUUID(), sequence: 0, acknowledgedSequence: 0, pending: null, issued: null };
    return;
  }
  if (!positive(delta)) return;
  const count = Number.isSafeInteger(concurrentCount) && concurrentCount >= 0 ? concurrentCount : 0;
  const pending = state.pending;
  state.pending = { amountExact: decimalAdd(pending?.amountExact || '0', delta),
    intervalStart: pending?.intervalStart ?? intervalStart ?? at, observedAt: at,
    concurrentCount: Math.max(pending?.concurrentCount || 0, count) };
}

export function issueAccountNotice(ledger, scope, meterKey) {
  const state = ledger.accountNotices;
  if (!state || state.meterKey !== meterKey) return { notice: null, changed: false };
  let changed = false;
  if (!state.issued && state.pending && positive(state.pending.amountExact)) {
    state.sequence++;
    state.issued = { ...state.pending, id: 'account-' + state.epoch + ':' + state.sequence };
    state.pending = null; changed = true;
  }
  const issued = state.issued;
  return { changed, notice: issued ? { id: issued.id, scope: accountNoticeScope(scope, meterKey),
    amount: Number(issued.amountExact), currency: scope.slice(-3),
    intervalStart: issued.intervalStart, observedAt: issued.observedAt,
    concurrent: issued.concurrentCount > 1, concurrentCount: issued.concurrentCount } : null };
}

export function acknowledgeAccountNotices(ledger, meterKey, ids) {
  if (!Array.isArray(ids) || ids.length > 32 || ids.some(id => typeof id !== 'string' || !/^account-[a-f0-9-]{36}:[1-9][0-9]{0,14}$/.test(id))) throw new Error('账户消费通知确认格式无效');
  const state = ledger.accountNotices;
  const belongs = id => {
    const index = id.lastIndexOf(':'), epoch = id.slice(8, index), sequence = Number(id.slice(index + 1));
    return state && state.meterKey === meterKey && epoch === state.epoch &&
      (sequence <= state.acknowledgedSequence || id === state.issued?.id);
  };
  if (ids.some(id => !belongs(id))) throw new Error('账户消费通知不属于当前账户，或计量上下文已变更');
  let changed = false;
  if (state?.issued && ids.includes(state.issued.id)) {
    state.acknowledgedSequence = state.sequence; state.issued = null; changed = true;
  }
  return { changed, acknowledged: [...new Set(ids)] };
}
