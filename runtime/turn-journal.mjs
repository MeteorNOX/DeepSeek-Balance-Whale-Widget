import path from 'node:path';
import { readJson, writeJson } from './paths.mjs';

const countFields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' ? value.slice(0, 500) : '';

export function safeUsage(value) {
  const result = {};
  for (const [model, counts] of Object.entries(value || {})) {
    if (!model || model.length > 150 || ['__proto__', 'prototype', 'constructor'].includes(model)) continue;
    result[model] = Object.fromEntries(countFields.map(key => [key, Math.max(0, finite(counts?.[key]) || 0)]));
  }
  return result;
}

export function safeSample(value) {
  if (!value || !value.ok) return null;
  return { ok: true, accountId: text(value.accountId), currency: text(value.currency),
    totalBalance: finite(value.totalBalance), totalUsed: finite(value.totalUsed),
    ...(typeof value.canObserve === 'boolean' ? { canObserve: value.canObserve } : {}),
    ...(/^[a-f0-9]{64}$/.test(value.meterId || '') ? { meterId: value.meterId } : {}),
    ...(['used', 'balance'].includes(value.counter) ? { counter: value.counter } : {}),
    ...(['finite', 'unlimited', 'unconfirmed', 'unsupported'].includes(value.balanceStatus) ? { balanceStatus: value.balanceStatus } : {}),
    stale: value.stale === true, updatedAt: text(value.updatedAt) };
}

export function safeTurn(meta) {
  return { id: text(meta.id), sessionId: text(meta.sessionId), turnId: text(meta.turnId),
    rootTurnId: text(meta.rootTurnId || meta.turnId), parentThreadId: text(meta.parentThreadId),
    isSubagent: meta.isSubagent === true, partial: meta.partial === true, historical: meta.historical === true,
    startedAt: finite(meta.startedAt), ts: finite(meta.ts), byModel: safeUsage(meta.byModel),
    outcome: ['completed', 'failed', 'aborted', 'superseded', 'interrupted'].includes(meta.outcome) ? meta.outcome : null,
    failureKind: meta.failureKind === 'high-demand' ? 'high-demand' : null,
    notify: meta.notify !== false, statusNotify: meta.statusNotify === true };
}

function safePrices(models) {
  const result = {};
  for (const [model, prices] of Object.entries(models || {})) {
    if (!model || model.length > 150 || ['__proto__', 'prototype', 'constructor'].includes(model)) continue;
    const entry = {};
    for (const key of ['input', 'cachedInput', 'output', 'cacheWrite']) if (finite(prices?.[key]) !== null && prices[key] >= 0) entry[key] = prices[key];
    if (['input', 'cachedInput', 'output'].every(key => key in entry)) result[model] = entry;
  }
  return result;
}

function cleanEntry(entry) {
  if (!entry || !/^[a-f0-9]{24}$/.test(entry.accountId || '') || !/^[A-Z]{3}$/.test(entry.currency || '')) return null;
  const meta = safeTurn(entry.meta || {});
  if (!meta.id || !['active', 'settling', 'pending-cost'].includes(entry.stage)) return null;
  return { stage: entry.stage, accountId: entry.accountId, currency: entry.currency,
    pricing: safePrices(entry.pricing), meta, start: safeSample(entry.start),
    concurrent: entry.concurrent === true, dueAt: finite(entry.dueAt), scope: text(entry.scope) };
}

// Explicit fields only: config, provider URLs, environment and credentials never enter this file.
export class TurnJournal {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'turn-journal.json'); this.entries = new Map(); this.error = '';
    try {
      const value = readJson(this.file, { version: 1, entries: [] });
      if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('unsupported journal');
      for (const item of value.entries) { const entry = cleanEntry(item); if (entry) this.entries.set(entry.meta.id, entry); }
    } catch { this.error = '待记账恢复文件损坏或不可读；已保留原文件，请从备份恢复。'; }
  }
  list() { return structuredClone([...this.entries.values()]); }
  save() {
    if (this.error) return false;
    try { writeJson(this.file, { version: 1, entries: [...this.entries.values()] }); return true; }
    catch { this.error = '待记账恢复文件未能保存；请检查磁盘空间和目录权限。'; return false; }
  }
  put(value) { const entry = cleanEntry(value); if (!entry || this.error) return false; this.entries.set(entry.meta.id, entry); return this.save(); }
  remove(id) { if (this.error || !this.entries.delete(id)) return; this.save(); }
}
