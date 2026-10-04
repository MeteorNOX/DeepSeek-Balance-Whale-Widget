import fs from 'node:fs';
import { observeAccountDebit, issueAccountNotice, acknowledgeAccountNotices } from './account-notices.mjs';
import { decimalAdd, decimalSum } from './money-precision.mjs';
import path from 'node:path';
import { readJson, writeJson, dayKey } from './paths.mjs';

const initialLedger = () => ({ version: 1, date: '', observed: 0, firstObservation: null, lastObservation: null, history: {}, events: [] });

export class UsageLedger {
  constructor(dataDir) { this.dataDir = dataDir; }
  file(scope) {
    if (!/^[a-f0-9]{24}-[A-Z]{3}$/.test(scope)) throw new Error('记账账户标识无效');
    return path.join(this.dataDir, 'ledgers', scope + '.json');
  }
  scopes() {
    try { return fs.readdirSync(path.join(this.dataDir, 'ledgers')).filter(name => /^[a-f0-9]{24}-[A-Z]{3}\.json$/.test(name)).map(name => name.slice(0, -5)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  load(scope) { return readJson(this.file(scope), initialLedger()); }
  save(scope, ledger) { writeJson(this.file(scope), ledger); }
  rollover(led, now) {
    const today = dayKey(now);
    if (led.date !== today) {
      if (led.date) led.history[led.date] = { total: led.observed, since: led.firstObservation };
      // Keep the last meter reading across midnight. The interval spanning
      // midnight belongs to its observation date; it is not a per-request bill.
      led.date = today; led.observed = 0; led.observedExact = '0'; led.firstObservation = null;
    }
    return led;
  }
  observe(scope, sample, now = Date.now()) {
    if (sample.stale || sample.ok === false) return this.load(scope);
    const led = this.rollover(this.load(scope), now);
    const balance = Number.isFinite(sample.totalBalance) ? sample.totalBalance : null;
    const used = Number.isFinite(sample.totalUsed) ? sample.totalUsed : null;
    if (balance === null && used === null) return this.load(scope);
    const last = led.lastObservation;
    let delta = '0';
    const meterKey = typeof sample.meterKey === 'string' && /^[a-f0-9]{64}$/.test(sample.meterKey) ? sample.meterKey : null;
    // A newer reading can legitimately reset to zero. Ordering is handled by
    // the service, while a changed adapter/scale starts a new meter baseline.
    if (last && (!meterKey || !last.meterKey || last.meterKey === meterKey)) {
      if (used !== null && last.used !== null && used >= last.used) delta = decimalAdd(used, last.used, true);
      else if (used === null && last.used === null && balance !== null && last.balance !== null) delta = last.balance >= balance ? decimalAdd(last.balance, balance, true) : '0';
    }
    observeAccountDebit(led, { delta, meterKey, mode: used !== null ? 'used' : balance !== null ? 'balance' : 'unavailable',
      at: now, intervalStart: last?.at ?? now, concurrentCount: sample.concurrentCount });
    led.observedExact = decimalAdd(Number(led.observedExact) === led.observed ? led.observedExact : led.observed, delta);
    led.observed = Number(led.observedExact);
    led.firstObservation ||= now;
    led.lastObservation = { balance, used, at: now, ...(meterKey ? { meterKey } : {}) };
    this.save(scope, led); return led;
  }
  accountNotice(scope, meterKey) {
    const led = this.load(scope), result = issueAccountNotice(led, scope, meterKey);
    if (result.changed) this.save(scope, led);
    return result.notice;
  }
  acknowledgeNotices(scope, meterKey, ids) {
    const led = this.load(scope), result = acknowledgeAccountNotices(led, meterKey, ids);
    if (result.changed) this.save(scope, led);
    return result.acknowledged;
  }
  append(scope, event) {
    const led = this.load(scope);
    if (led.events.some(e => this.sameEvent(e, event))) return false;
    led.events.push({ ...event, day: dayKey(event.ts) });
    led.events = led.events.slice(-8000);
    this.save(scope, led); return true;
  }
  sameEvent(existing, event) {
    return existing.id === event.id || !!(event.sessionId && event.turnId &&
      existing.id?.endsWith(event.sessionId + ':' + event.turnId));
  }
  find(scope, event) { return this.load(scope).events.find(e => this.sameEvent(e, event)) || null; }
  revise(scope, id, patch) {
    const led = this.load(scope), index = led.events.findIndex(e => e.id === id);
    if (index < 0) return null;
    const before = led.events[index];
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(before[key]) === JSON.stringify(value))) return before;
    const next = { ...before, ...patch, id: before.id, ts: before.ts, day: before.day, revision: (before.revision || 0) + 1 };
    led.events[index] = next; this.save(scope, led); return next;
  }
  records(scope, now = Date.now()) {
    const led = this.rollover(this.load(scope), now);
    const today = dayKey(now);
    const modelsFor = day => {
      const models = new Map();
      for (const e of led.events) {
        if (e.day !== day || e.source !== 'configured-pricing-estimate') continue;
        models.set(e.model, decimalAdd(models.get(e.model) || 0, e.cost || 0));
      }
      return [...models].map(([model, cost]) => ({ model: model + '（估算）', cost: Number(cost) })).sort((a, b) => b.cost - a.cost);
    };
    const totalDay = day => day === today ? led.observed : Object.hasOwn(led.history, day) ? Number(led.history[day].total || 0) : null;
    const days7 = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const date = dayKey(d), total = totalDay(date);
      days7.push({ date, total, totalState: total === null ? 'unknown' : 'observed', models: modelsFor(date) });
    }
    const days = [...new Set([today, ...Object.keys(led.history), ...led.events.map(e => e.day)])].sort().reverse();
    const missingSummaryDays = days.filter(date => totalDay(date) === null);
    return { ok: true, today: { total: led.observed, models: modelsFor(today), since: led.firstObservation }, days7,
      total7: decimalSum(days7.map(d => d.total || 0)),
      total7Complete: days7.every(d => d.total !== null),
      all: { days: days.map(date => ({ date, total: totalDay(date), totalState: totalDay(date) === null ? 'unknown' : 'observed', models: modelsFor(date) })),
        total: decimalSum(days.map(day => totalDay(day) || 0)), totalComplete: missingSummaryDays.length === 0,
        missingSummaryDays, events: led.events.slice(-500).reverse().map(normalizeTurnCost), storedEventCount: led.events.length, detailLimit: 500 },
      usageSource: 'observed-api-debits', note: '每日合计来自同密钥累计消耗或余额差值；停机或跨午夜的观测间隔归入再次观测日，不能拆成精确逐请求账单。日汇总长期保留，明细最多保留 8000 条、页面提供最近 500 条。旧版已删除的日汇总显示未知，不冒充零消费；模型金额为配置价格估算。' };
  }
}

export function usageDefaults() {
  return {
    taskEnd: { on: false, sel: '' },
    alert: { on: true, below: 5, msg: '余额已低于 {currency}{below}', lines: [
      { type: 'text', text: '老大～你的 API 余额', size: 5, bold: true },
      { type: 'text', text: '已经不足 {currency}{below} 啦', size: 6, bold: true, rgb: 'rouge' },
      { type: 'image', imgId: 'bimg_yue_money', size: 6, imgScale: 0.3 },
      { type: 'link', text: '打开当前 API 账单', url: '/provider-dashboard', size: 2, color: '#ffffff', bgRgb: 'indigo' },
    ], autoClose: false, ttlSec: 6 },
    budget: { on: true, amount: 10, msg: '今日已观测用量达到 {currency}{amount}', lines: [
      { type: 'text', text: '今天已观测用量超过', size: 6, bold: true },
      { type: 'text', text: '{currency}{amount}', size: 7, bold: true, rgb: 'rouge' },
    ], autoClose: false, ttlSec: 6 },
  };
}

// Compatibility is a read projection: original history and daily totals remain intact.
export function normalizeTurnCost(event) {
  if (event?.source !== 'shared-key-interval') return event;
  return { ...event, accountIntervalAmount: event.accountIntervalAmount ?? event.amount ?? event.cost ?? null,
    accountIntervalCurrency: event.accountIntervalCurrency || event.currency,
    amount: null, cost: null, costState: 'unknown', source: 'token-only', label: '本轮费用未知:',
    note: '旧记录金额仅为同密钥账户期间扣费，无法归属本轮。' };
}
