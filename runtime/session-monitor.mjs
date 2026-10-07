import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Worker } from 'node:worker_threads';
import { failureKind } from './failure-kind.mjs';

const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const normalize = value => Object.fromEntries(fields.map(key => [key, Math.max(0, Number(value?.[key]) || 0)]));
const zero = () => normalize({});
const relevant = /"(?:session_meta|token_count|turn_context|task_started|task_complete|turn_started|turn_completed|turn_aborted|task_aborted|error|stream_error)"/;
const timestamp = value => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);

export class SessionParser {
  constructor({ id, defaultModel = '', onStart = () => {}, onEnd = () => {}, onUpdate = () => {}, recoverIds = [] }) {
    this.id = id; this.model = ['__proto__', 'prototype', 'constructor'].includes(defaultModel) ? '' : defaultModel;
    this.onStart = onStart; this.onEnd = onEnd; this.onUpdate = onUpdate;
    this.total = null; this.active = null; this.priming = false;
    this.identity = null; this.skipHistory = 0; this.completed = new Set();
    this.recentEnds = new Map();
    this.recoverIds = new Set(recoverIds); this.recoverySeen = new Set();
  }
  identify(meta) {
    // Only the first header identifies this file; session_id may be inherited.
    if (this.identity || !meta || !(meta.id || meta.session_id)) return;
    this.id = String(meta.id || meta.session_id);
    this.identity = { sessionId: this.id, parentThreadId: meta.parent_thread_id || meta.source?.subagent?.thread_spawn?.parent_thread_id || null,
      isSubagent: meta.thread_source === 'subagent' || !!meta.source?.subagent,
      createdAt: timestamp(meta.timestamp), forked: !!meta.forked_from_id };
    this.skipHistory = Number.isSafeInteger(meta.subagent_history_start_ordinal) ? Math.max(0, meta.subagent_history_start_ordinal) : 0;
  }
  prime(lines) {
    this.priming = true;
    for (const line of lines) this.accept(line);
    this.priming = false;
    if (this.active) {
      if (!this.active.recoverable) { this.active.byModel = {}; this.active.partial = true; }
      this.onStart({ ...this.active });
    }
  }
  accept(line) {
    if (this.skipHistory > 0) { this.skipHistory--; return; }
    if (typeof line === 'string' && !relevant.test(line)) return;
    let d;
    try { d = typeof line === 'string' ? JSON.parse(line) : line; } catch { return; }
    const p = d.payload || {};
    if (d.type === 'session_meta') { this.identify(p); return; }
    if (d.type === 'turn_context') {
      if (typeof p.model === 'string' && !['__proto__', 'prototype', 'constructor'].includes(p.model)) this.model = p.model;
      if (this.active && (!p.turn_id || p.turn_id === this.active.turnId)) {
        this.active.rootTurnId = p.root_turn_id || this.active.turnId;
        if (!this.priming) this.onUpdate({ ...this.active });
      }
      return;
    }
    if (d.type !== 'event_msg') return;
    const turnId = p.turn_id || p.turnId;
    if (['error', 'stream_error'].includes(p.type)) {
      // stream_error can be a reconnect diagnostic. A turn-level error is
      // terminal unless it explicitly says it will retry; it often has no
      // following task_complete record after an API/transport failure.
      if (!this.active || turnId && turnId !== this.active.turnId) return;
      this.active.failureKind = failureKind(p);
      if (!this.priming) this.onUpdate({ ...this.active });
      if (p.will_retry === false || p.fatal === true || p.type === 'error' && p.will_retry !== true) this.end(timestamp(d.timestamp) || Date.now(), 'failed');
      return;
    }
    if (['task_started', 'turn_started'].includes(p.type)) {
      if (typeof turnId !== 'string' || !turnId || this.completed.has(turnId) || this.active?.turnId === turnId) return;
      const startedAt = timestamp(p.started_at);
      // Old forks can rewrite outer timestamps, but preserve original start seconds.
      if (this.identity?.forked && Number.isFinite(startedAt) && startedAt + 1000 < this.identity.createdAt) return;
      if (this.active) this.end(timestamp(d.timestamp) || Date.now(), 'superseded');
      this.active = { id: this.id + ':' + turnId, sessionId: this.id, turnId, rootTurnId: p.root_turn_id || turnId,
        isSubagent: this.identity?.isSubagent || false, parentThreadId: this.identity?.parentThreadId || null,
        byModel: {}, startedAt: startedAt || timestamp(d.timestamp) || Date.now(), ts: timestamp(d.timestamp) || Date.now(), partial: false };
      this.active.recoverable = this.recoverIds.has(this.active.id);
      if (this.active.recoverable) this.recoverySeen.add(this.active.id);
      if (!this.priming) this.onStart({ ...this.active });
      return;
    }
    if (p.type === 'token_count' && p.info?.total_token_usage) {
      const next = normalize(p.info.total_token_usage);
      let delta = zero();
      if (this.total) {
        const reset = next.input_tokens < this.total.input_tokens || next.output_tokens < this.total.output_tokens;
        delta = reset ? normalize(p.info.last_token_usage) : Object.fromEntries(fields.map(k => [k, Math.max(0, next[k] - this.total[k])]));
      } else if (this.active && (!this.priming || this.active.recoverable)) delta = normalize(p.info.last_token_usage || next);
      this.total = next;
      if (this.active && (!this.priming || this.active.recoverable) && delta.input_tokens + delta.output_tokens > 0) {
        const model = this.model || '未知模型';
        const counts = Object.hasOwn(this.active.byModel, model) ? this.active.byModel[model] : (this.active.byModel[model] = zero());
        for (const k of fields) counts[k] += delta[k];
        this.active.ts = timestamp(d.timestamp) || Date.now();
        if (!this.priming) this.onUpdate({ ...this.active });
      }
      return;
    }
    if (['task_complete', 'turn_completed', 'turn_aborted', 'task_aborted'].includes(p.type)) {
      const previous = this.recentEnds.get(turnId);
      if (/aborted$/.test(p.type) && previous?.outcome === 'failed') {
        const corrected = { ...previous, outcome: 'aborted', failureKind: null, notify: false, statusNotify: true, statusCorrection: true };
        this.recentEnds.set(turnId, corrected);
        if (!this.priming && !previous.historical) this.onEnd(corrected);
        return;
      }
      if (!this.active || !turnId || turnId !== this.active.turnId) return;
      const outcome = /aborted$/.test(p.type) || ['aborted','cancelled','canceled'].includes(p.status) ? 'aborted' :
        ['interrupted','incomplete'].includes(p.status) ? 'interrupted' : p.error || ['failed','error'].includes(p.status) ? 'failed' : 'completed';
      this.active.failureKind = outcome === 'failed' ? (p.error ? failureKind(p.error) : failureKind(p) || this.active.failureKind) : null;
      this.end(timestamp(d.timestamp) || Date.now(), outcome);
    }
  }
  end(ts, outcome) {
    if (!this.active) return;
    const completed = { ...this.active, ts, outcome, historical: this.priming,
      notify: !this.priming && outcome === 'completed' && !this.active.isSubagent,
      failureKind: outcome === 'failed' && this.active.failureKind === 'high-demand' ? 'high-demand' : null,
      statusNotify: !this.priming && ['aborted','failed','interrupted','superseded'].includes(outcome) && !this.active.isSubagent };
    this.active = null; this.completed.add(completed.turnId);
    this.recentEnds.set(completed.turnId, completed);
    if (this.recentEnds.size > 128) this.recentEnds.delete(this.recentEnds.keys().next().value);
    if (this.completed.size > 8192) this.completed.delete(this.completed.values().next().value);
    if (!this.priming || completed.recoverable) this.onEnd(completed);
  }
}

function sessionFiles(root, recoverIds = []) {
  const files = [];
  function walk(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { const stat = fs.statSync(file); files.push({ file, mtime: stat.mtimeMs, size: stat.size }); } catch {}
      }
    }
  }
  walk(root);
  const sorted = files.sort((a, b) => b.mtime - a.mtime), sessions = recoverIds.map(id => id.slice(0, id.lastIndexOf(':'))).filter(Boolean);
  return sorted.filter((item, index) => index < 64 || sessions.some(id => path.basename(item.file).includes(id)));
}

// Synchronous scanning is confined to the worker or isolated replay tests.
export class SessionReader {
  constructor({ root, defaultModel = '', onStart = () => {}, onEnd = () => {}, onUpdate = () => {}, discoverMs = 3000, recoverIds = [] }) {
    Object.assign(this, { root, defaultModel, onStart, onEnd, onUpdate, discoverMs, recoverIds });
    this.files = new Map(); this.lastDiscovery = 0; this.error = '';
  }
  add(info, initial) {
    const parser = new SessionParser({ id: path.basename(info.file, '.jsonl'), defaultModel: this.defaultModel,
      onStart: this.onStart, onEnd: this.onEnd, onUpdate: this.onUpdate, recoverIds: this.recoverIds });
    const fd = fs.openSync(info.file, 'r');
    try {
      const head = Buffer.alloc(Math.min(info.size, 1024 * 1024));
      fs.readSync(fd, head, 0, head.length, 0);
      const newline = head.indexOf(10);
      if (newline < 0) return;
      const metadata = JSON.parse(head.subarray(0, newline).toString('utf8').replace(/^\uFEFF/, ''));
      if (metadata.type !== 'session_meta') return;
      parser.identify(metadata.payload);
      const state = { parser, offset: newline + 1, pending: '', skipLine: false, decoder: new StringDecoder('utf8') };
      if (initial || info.mtime < Date.now() - 30000) {
        // Long Ultra turns can start well before the last megabyte. Bootstrap
        // the lifecycle in bounded chunks on the worker, without replaying any
        // completions. The UI and native follower never wait for this scan.
        parser.priming = true;
        while (state.offset < info.size) {
          const previous = state.offset;
          this.readNew(info.file, state, info.size);
          if (state.offset <= previous) break; // Concurrent truncation cannot trap the worker.
        }
        parser.prime([]);
      }
      this.files.set(info.file, state);
    } finally { fs.closeSync(fd); }
  }
  tick(initial = false) {
    this.error = '';
    if (initial || Date.now() - this.lastDiscovery > this.discoverMs) {
      const listed = sessionFiles(this.root, this.recoverIds);
      for (const info of listed) if (!this.files.has(info.file)) {
        try { this.add(info, initial); } catch { this.error = '部分会话记录暂不可读'; }
      }
      const keep = new Set(listed.map(x => x.file));
      for (const [file, state] of this.files) if (!keep.has(file) && !state.parser.active) this.files.delete(file);
      this.lastDiscovery = Date.now();
    }
    for (const [file, state] of this.files) {
      try { this.readNew(file, state); } catch { this.error = '部分会话记录暂不可读'; }
    }
  }
  readNew(file, state, through = Infinity) {
    const size = Math.min(fs.statSync(file).size, through);
    if (size < state.offset) { this.files.delete(file); this.lastDiscovery = 0; return; }
    if (size === state.offset) return;
    const count = Math.min(size - state.offset, 4 * 1024 * 1024);
    const fd = fs.openSync(file, 'r'); let buf;
    try { buf = Buffer.alloc(count); fs.readSync(fd, buf, 0, count, state.offset); } finally { fs.closeSync(fd); }
    state.offset += count; state.more = state.offset < size;
    const lines = (state.pending + state.decoder.write(buf)).split('\n'); state.pending = lines.pop() || '';
    for (const line of lines) {
      if (state.skipLine) { state.skipLine = false; state.parser.accept(''); continue; }
      state.parser.accept(line);
    }
    if (state.pending.length > 8 * 1024 * 1024) { state.pending = ''; state.skipLine = true; }
  }
  status() { return { watching: this.files.size, error: this.error, catchingUp: [...this.files.values()].some(s => s.more),
    recoverySeen: [...new Set([...this.files.values()].flatMap(s => [...s.parser.recoverySeen]))] }; }
}

export class SessionMonitor {
  constructor(service, { intervalMs = 750, discoverMs = 3000 } = {}) {
    Object.assign(this, { service, intervalMs, discoverMs });
    this.pending = new Set(); this.snapshot = { watching: 0, error: '', initializing: true }; this.stopped = false;
  }
  start() {
    if (this.worker) return;
    let c;
    try { c = this.service.config.resolve(); }
    catch { c = { model: '', setting: { monitorSessions: false } }; }
    this.worker = new Worker(new URL('./session-worker.mjs', import.meta.url), { workerData: {
      root: path.join(this.service.config.codexHome, 'sessions'), defaultModel: c.model,
      intervalMs: this.intervalMs, discoverMs: this.discoverMs, enabled: c.setting.monitorSessions,
      recoverIds: this.service.prepareRecovery?.() || [],
    } });
    this.worker.on('message', message => {
      if (this.stopped) return;
      if (message.status) this.snapshot = { ...message.status, initializing: false };
      for (const item of message.events || []) {
        if (item.type === 'start') this.service.beginTurn(item.meta);
        else if (item.type === 'update') this.service.updateTurn?.(item.meta);
        else this.dispatch(item.meta);
      }
      if (message.recoveryComplete) this.service.finishMissingRecovery?.(message.status?.recoverySeen || []);
    });
    this.worker.on('error', () => { this.snapshot.error = '会话监测线程异常；余额查询仍可使用'; });
    this.worker.on('exit', code => { if (!this.stopped && code) this.snapshot.error = '会话监测线程退出'; });
    this.worker.unref();
    this.timer = setInterval(() => {
      try { const current = this.service.config.resolve(); this.worker.postMessage({ enabled: current.setting.monitorSessions, defaultModel: current.model }); } catch {}
    }, 3000); this.timer.unref();
  }
  async stop({ timeoutMs = 1200 } = {}) {
    this.stopped = true; clearInterval(this.timer); await this.worker?.terminate();
    if (!this.pending.size) return;
    let timer;
    await Promise.race([Promise.allSettled([...this.pending]), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timer);
  }
  dispatch(meta) {
    const p = this.service.finishTurn(meta).catch(() => { this.snapshot.error = '一条会话用量记录未能写入'; }).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
  status() { return { ...this.snapshot, activeTurns: [...this.service.turns.values()].filter(x => !x.isSubagent).length,
    recovery: { pending: this.service.journal?.entries.size || 0, error: this.service.journal?.error || this.service.recoveryError || '' }, worker: true }; }
}

