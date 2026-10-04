import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { SessionParser, SessionReader, SessionMonitor } from '../runtime/session-monitor.mjs';
import { WhaleService } from '../runtime/service.mjs';
import { ConfigStore } from '../runtime/config.mjs';
import { UsageLedger } from '../runtime/ledger.mjs';

const event = (type, turn, extra = {}) => ({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn, ...extra } });
const header = (id, extra = {}) => ({ type: 'session_meta', payload: { id, session_id: id, source: 'vscode', ...extra } });
const context = (turn, root = turn) => ({ type: 'turn_context', payload: { turn_id: turn, root_turn_id: root, model: 'model' } });
const usage = (input, output = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: 0 });
const tokens = input => event('token_count', undefined, { info: { total_token_usage: usage(input), last_token_usage: usage(input) } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-round-'));
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(dir).startsWith('whale-round-')); fs.rmSync(dir, { recursive: true }); });
  return dir;
}
function fixture(t) {
  const dir = temporary(t);
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model_provider="test"\nmodel="model"\n[model_providers.test]\nbase_url="https://example.invalid/v1"\nexperimental_bearer_token="TEST-ONLY-NOT-A-KEY"\n');
  const config = new ConfigStore({ dataDir: path.join(dir, 'data'), codexHome: dir, env: {} });
  const provider = { used: 0, calls: 0, async balance(c) { this.calls++; return { ok: true, accountId: c.accountId, totalBalance: 20 - this.used, totalUsed: this.used, currency: 'USD' }; } };
  return { dir, config, provider, service: new WhaleService({ config, provider }) };
}

test('only the matching successful main turn can request a completion notification', () => {
  const ends = [], p = new SessionParser({ id: 'file', onEnd: e => ends.push(e) });
  p.accept(header('main')); p.accept(event('task_started', 'A')); p.accept(event('task_complete', 'unrelated'));
  assert.equal(ends.length, 0); assert.equal(p.active.turnId, 'A');
  p.accept(event('task_complete', 'A')); p.accept(event('task_complete', 'A'));
  p.accept(event('task_started', 'A')); p.accept(event('task_complete', 'A'));
  assert.equal(ends.length, 1); assert.equal(ends[0].id, 'main:A'); assert.equal(ends[0].notify, true);
  p.accept(event('task_started', 'B')); p.accept(event('task_complete', 'B', { error: 'fixture' }));
  p.accept(event('task_started', 'C')); p.accept(event('turn_aborted', 'C'));
  p.accept(event('task_started', 'D')); p.accept(event('task_started', 'E')); p.accept(event('task_complete', 'D'));
  assert.deepEqual(ends.slice(1).map(e => [e.outcome, e.notify]), [['failed', false], ['aborted', false], ['superseded', false]]);
  assert.equal(p.active.turnId, 'E');
});

test('fork identity and inherited history cannot be replaced by parent metadata', () => {
  const starts = [], ends = [], p = new SessionParser({ id: 'filename', defaultModel: 'model', onStart: e => starts.push(e), onEnd: e => ends.push(e) });
  p.accept(header('child', { session_id: 'main', thread_source: 'subagent', parent_thread_id: 'main', subagent_history_start_ordinal: 4 }));
  p.accept(header('main')); p.accept(event('task_started', 'old')); p.accept(tokens(10000)); p.accept(event('task_complete', 'old'));
  p.accept(event('task_started', 'child-turn')); p.accept(context('child-turn', 'main-turn')); p.accept(tokens(30)); p.accept(event('task_complete', 'child-turn'));
  assert.equal(starts.length, 1); assert.equal(ends.length, 1); assert.equal(ends[0].sessionId, 'child');
  assert.equal(ends[0].rootTurnId, 'main-turn'); assert.equal(ends[0].notify, false); assert.equal(ends[0].byModel.model.input_tokens, 30);
});

test('newly discovered fork files skip copied records while retaining fresh child usage', t => {
  const root = temporary(t), starts = [], ends = [];
  const copied = [header('main'), event('task_started', 'old'), context('old'), event('task_complete', 'old')];
  const lines = [header('child', { thread_source: 'subagent', parent_thread_id: 'main', subagent_history_start_ordinal: copied.length }), ...copied,
    event('task_started', 'fresh'), context('fresh', 'root'), tokens(12), event('task_complete', 'fresh')];
  fs.writeFileSync(path.join(root, 'fork.jsonl'), lines.map(JSON.stringify).join('\n') + '\n');
  const reader = new SessionReader({ root, onStart: e => starts.push(e), onEnd: e => ends.push(e) }); reader.tick();
  assert.equal(starts.length, 1); assert.equal(ends.length, 1); assert.equal(ends[0].notify, false); assert.equal(ends[0].byModel.model.input_tokens, 12);
  const afterRestart = [];
  new SessionReader({ root, onEnd: e => afterRestart.push(e) }).tick(true);
  assert.equal(afterRestart.length, 0);
});

test('subagent completions keep usage but never publish overlapping interval fees', async t => {
  const { service, provider, config } = fixture(t);
  const main = { id: 'main:M', sessionId: 'main', turnId: 'M', rootTurnId: 'M', partial: false };
  service.beginTurn(main); await service.turns.get(main.id).start;
  for (const turnId of ['child-A', 'child-B']) {
    const child = { id: 'child:' + turnId, sessionId: 'child', turnId, rootTurnId: 'M', isSubagent: true, partial: false };
    service.beginTurn(child); await service.finishTurn({ ...child, byModel: { model: usage(25) }, outcome: 'completed', notify: false });
  }
  assert.equal(provider.calls, 1); assert.equal(service.lastTurn().seq, 0);
  provider.used = 3.5;
  await service.finishTurn({ ...main, byModel: { model: usage(100) }, outcome: 'completed', notify: true });
  const notice = service.lastTurn(); assert.equal(notice.seq, 1); assert.equal(notice.amount, null); assert.equal(notice.costState, 'unknown'); assert.equal(notice.accountIntervalAmount, 3.5); assert.equal(notice.tokens, 150);
  assert.equal(notice.childTurns, 2); assert.equal(notice.concurrent, false);
  const records = service.ledger.records(service.scope(config.resolve(), 'USD'));
  assert.equal(records.today.total, 3.5); assert.equal(records.all.events.filter(e => e.isSubagent).length, 2);
  const restarted = new WhaleService({ config, provider }); restarted.beginTurn(main); await restarted.finishTurn({ ...main, byModel: {} });
  assert.equal(restarted.lastTurn().seq, 1);
});

test('bootstrap recovers an ongoing Ultra turn whose start is outside the last megabyte', t => {
  const root = temporary(t), starts = [], ends = [];
  const content = [header('main'), event('task_started', 'long-running'), context('long-running'),
    { type: 'response_item', payload: { text: 'x'.repeat(1300000) } }, tokens(300)];
  fs.writeFileSync(path.join(root, 'long.jsonl'), content.map(JSON.stringify).join('\n') + '\n');
  const reader = new SessionReader({ root, onStart: e => starts.push(e), onEnd: e => ends.push(e) }); reader.tick(true);
  assert.equal(starts.length, 1); assert.equal(starts[0].turnId, 'long-running'); assert.equal(starts[0].partial, true);
  assert.equal(ends.length, 0);
  fs.appendFileSync(path.join(root, 'long.jsonl'), [tokens(325), event('task_complete', 'long-running')].map(JSON.stringify).join('\n') + '\n');
  reader.tick(); assert.equal(ends.length, 1); assert.equal(ends[0].notify, true); assert.equal(ends[0].byModel.model.input_tokens, 25);
});

test('configured estimates include child tokens exactly once in both notice and model totals', async t => {
  const { service, provider, config } = fixture(t);
  config.save({ models: { model: { input: 1, cachedInput: 1, output: 1 } } });
  const main = { id: 'main:round', sessionId: 'main', turnId: 'round', rootTurnId: 'round', partial: false };
  service.beginTurn(main); await service.turns.get(main.id).start;
  const child = { id: 'child:turn', sessionId: 'child', turnId: 'turn', rootTurnId: 'round', isSubagent: true, partial: false };
  service.beginTurn(child); await service.finishTurn({ ...child, byModel: { model: usage(1000000) } });
  assert.equal(service.lastTurn().seq, 0);
  await service.finishTurn({ ...main, byModel: { model: usage(1000000) } });
  assert.equal(service.lastTurn().amount, 2); assert.equal(service.lastTurn().tokens, 2000000);
  assert.equal(service.usageRecords().today.models.reduce((n, e) => n + e.cost, 0), 2);
  assert.equal(provider.calls, 2);
});

test('failed and cancelled main turns preserve observed spend without a success notice', async t => {
  const { service, provider } = fixture(t);
  for (const outcome of ['failed', 'aborted', 'superseded']) {
    const meta = { id: outcome, turnId: outcome, partial: false };
    service.beginTurn(meta); await service.turns.get(meta.id).start; provider.used++;
    await service.finishTurn({ ...meta, outcome, notify: false, byModel: { model: usage(10) } });
  }
  assert.equal(service.lastTurn().seq, 0); assert.equal(service.usageRecords().today.total, 3);
});

test('stable identity also deduplicates a record written by the previous filename-based monitor', t => {
  const ledger = new UsageLedger(temporary(t)), scope = 'a'.repeat(24) + '-USD';
  assert.equal(ledger.append(scope, { id: 'rollout-2026-09-16-main:turn', ts: Date.now() }), true);
  assert.equal(ledger.append(scope, { id: 'main:turn', sessionId: 'main', turnId: 'turn', ts: Date.now() }), false);
  assert.equal(ledger.append(scope, { id: 'other:turn', sessionId: 'other', turnId: 'turn', ts: Date.now() }), true);
});

test('worker starts asynchronously and reports matching main completion after child records', async t => {
  const { service, dir } = fixture(t), sessions = path.join(dir, 'sessions'); fs.mkdirSync(sessions);
  const monitor = new SessionMonitor(service, { intervalMs: 20, discoverMs: 20 });
  t.after(() => monitor.stop()); monitor.start();
  assert.equal(monitor.status().initializing, true);
  const waitFor = async predicate => { const end = Date.now() + 5000; while (!predicate()) { assert.ok(Date.now() < end, JSON.stringify(monitor.status())); await new Promise(r => setTimeout(r, 15)); } };
  await waitFor(() => !monitor.status().initializing);
  const main = [header('main'), event('task_started', 'round'), context('round'), tokens(100)];
  fs.writeFileSync(path.join(sessions, 'main.jsonl'), main.map(JSON.stringify).join('\n') + '\n');
  await waitFor(() => service.turns.has('main:round'));
  const child = [header('child', { thread_source: 'subagent' }), event('task_started', 'sub'), context('sub', 'round'), tokens(25), event('task_complete', 'sub')];
  fs.writeFileSync(path.join(sessions, 'child.jsonl'), child.map(JSON.stringify).join('\n') + '\n');
  await waitFor(() => service.usageRecords().all.events.some(e => e.isSubagent));
  assert.equal(service.lastTurn().seq, 0);
  fs.appendFileSync(path.join(sessions, 'main.jsonl'), JSON.stringify(event('task_complete', 'round')) + '\n');
  await waitFor(() => service.lastTurn().seq === 1);
  assert.equal(service.lastTurn().tokens, 125); assert.equal(monitor.status().worker, true);
  await monitor.stop();
});

test('actual frontend polling suppresses startup replay, duplicates, children and overlapping requests', async () => {
  const source = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8');
  const begin = source.indexOf("    var LAST_TURN_URL = "), end = source.indexOf('    setInterval(pollLastTurn, 1000);', begin);
  assert.ok(begin > 0 && end > begin);
  const stored = new Map(); let fetches = 0, sounds = 0, bubbles = 0, release;
  const pending = [], sandbox = { state: {}, Date, Number, isFinite,
    usageSet: {taskEnd:{on:false}}, soundOn: false, soundVol: 0,
    window: { dispatchEvent() {} }, CustomEvent: class { constructor(type, options) { this.type=type;this.detail=options.detail; } },
    localStorage: { getItem: key => stored.get(key), setItem: (k, v) => stored.set(k, v) },
    fetch: () => { fetches++; return new Promise(resolve => pending.push(resolve)); },
    playTaskEndSound: () => sounds++, showCostBubble: () => bubbles++ };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL('../desktop/ui/turn-notice.js', import.meta.url), 'utf8'), sandbox);
  vm.runInContext(source.slice(begin, end), sandbox);
  const respond = async data => { release = pending.shift(); assert.ok(release); release({ json: async () => data }); await tick(); };
  const notice = (seq, id, extra = {}) => ({ ok: true, seq, id, turn: id, ts: Date.now() + 10, amount: 1, outcome: 'completed', notify: true, ...extra });
  sandbox.pollLastTurn(); sandbox.pollLastTurn(); assert.equal(fetches, 1);
  await respond(notice(5, 'old', { ts: Date.now() - 10000 })); assert.equal(sounds, 0);
  for (const data of [notice(6, 'new'), notice(7, 'new'), notice(8, 'failed', { notify: false }), notice(9, 'child', { isSubagent: true }), notice(10, 'next')]) {
    sandbox.pollLastTurn(); await respond(data);
  }
  assert.equal(sounds, 2); assert.equal(bubbles, 2); assert.equal(stored.get('dshw-last-turn-id'), 'next');
  for (const data of [notice(11, 'failed-notice', { outcome: 'failed', completionKind: 'failed', amount: null, costState: 'pending' }),
    notice(12, 'cancelled-notice', { outcome: 'aborted', completionKind: 'cancelled', amount: null, costState: 'unknown' }),
    notice(12, 'cancelled-notice', { outcome: 'aborted', completionKind: 'cancelled', amount: 2, costState: 'observed' })]) {
    sandbox.pollLastTurn(); await respond(data);
  }
  assert.equal(sounds, 2); assert.equal(bubbles, 4);
  sandbox.pollLastTurn(); await respond(notice(13, 'busy', { outcome: 'failed', completionKind: 'failed', failureKind: 'high-demand' }));
  assert.equal(sounds, 2); assert.equal(bubbles, 5);
});
