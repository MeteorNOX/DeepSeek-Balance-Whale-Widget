import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhaleService } from '../runtime/service.mjs';
import { UsageLedger } from '../runtime/ledger.mjs';
import { SessionMonitor, SessionParser } from '../runtime/session-monitor.mjs';

const usage = input => ({ model: { input_tokens: input, output_tokens: 0, cached_input_tokens: 0 } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = (id, extra = {}) => ({ id: 'main:' + id, sessionId: 'main', turnId: id, rootTurnId: id, ...extra });
const event = (type, turn, extra = {}) => ({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn, ...extra } });
const header = { type: 'session_meta', payload: { id: 'main', source: 'vscode' } };
const context = turn => ({ type: 'turn_context', payload: { model: 'model', turn_id: turn, root_turn_id: turn } });
const tokens = input => event('token_count', undefined, { info: { total_token_usage: usage(input).model, last_token_usage: usage(input).model } });
async function waitFor(predicate, message = 'condition') {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'Timed out: ' + message); await delay(20); }
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-audit-accounting-')), services = [], monitors = [];
  const resolved = path.resolve(dir), expectedParent = path.resolve(os.tmpdir()) + path.sep;
  t.after(async () => {
    for (const monitor of monitors) await monitor.stop({ timeoutMs: 25 });
    for (const service of services) await service.close({ timeoutMs: 25 });
    assert.ok(resolved.startsWith(expectedParent) && path.basename(resolved).startsWith('whale-audit-accounting-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const setting = { currency: 'USD', refreshSeconds: 60, monitorSessions: true, models: {}, ...options.setting };
  const resolvedConfig = { accountId: 'a'.repeat(24), key: 'FIXTURE-SECRET-NEVER-PERSIST', model: 'model', dashboardUrl: '', setting };
  const config = { dataDir: dir, codexHome: dir, resolve: () => resolvedConfig };
  const provider = { used: 0, calls: 0, async balance(c) { this.calls++; return { ok: true, accountId: c.accountId, currency: 'USD', totalUsed: this.used, totalBalance: 100 - this.used }; } };
  const make = extra => { const service = new WhaleService({ config, provider, ...options, ...extra }); services.push(service); return service; };
  const monitor = service => { const value = new SessionMonitor(service, { intervalMs: 20, discoverMs: 20 }); monitors.push(value); return value; };
  return { dir, config, provider, make, monitor, scope: resolvedConfig.accountId + '-USD' };
}

test('cross-midnight meter interval is retained once, and old daily summaries remain complete', t => {
  const { dir, scope } = fixture(t), ledger = new UsageLedger(dir);
  let memory = ledger.load(scope);
  ledger.load = () => structuredClone(memory);
  ledger.save = (_scope, value) => { memory = structuredClone(value); };
  let used = 0, now;
  for (let i = 0; i < 40; i++) {
    const morning = new Date(2026, 6, 1 + i, 9).getTime(); now = morning + 1000;
    ledger.observe(scope, { totalUsed: used }, morning);
    ledger.observe(scope, { totalUsed: ++used }, now);
    ledger.append(scope, { id: 'round-' + i, ts: now, cost: 1 });
  }
  const result = ledger.records(scope, now);
  assert.equal(result.all.days.length, 40); assert.equal(result.all.total, 40); assert.equal(result.all.totalComplete, true);
  assert.equal(result.all.days.at(-1).total, 1);
  const next = new Date(2026, 6, 41, 0, 0, 1).getTime();
  ledger.observe(scope, { totalUsed: used + 3 }, next);
  assert.equal(ledger.records(scope, next).today.total, 3);
  assert.equal(ledger.records(scope, next).all.total, 43);
});

test('summaries already deleted by old versions are unknown, never synthetic zero or overlapping event sums', t => {
  const { dir, scope } = fixture(t), ledger = new UsageLedger(dir);
  const now = new Date(2026, 8, 16, 10).getTime();
  ledger.observe(scope, { totalUsed: 5 }, now);
  ledger.append(scope, { id: 'legacy', ts: new Date(2026, 0, 1, 10).getTime(), cost: 7 });
  const result = ledger.records(scope, now);
  assert.equal(result.all.totalComplete, false); assert.deepEqual(result.all.missingSummaryDays, ['2026-01-01']);
  assert.equal(result.all.days.find(day => day.date === '2026-01-01').total, null);
});

test('late same-key debits update daily totals without being falsely assigned to a pending round', async t => {
  const { make, provider, scope } = fixture(t, { pendingCostMs: 30 }), service = make(), meta = round('late');
  service.beginTurn(meta); await service.turns.get(meta.id).start;
  await service.finishTurn({ ...meta, outcome: 'completed', byModel: usage(10) });
  assert.equal(service.lastTurn().costState, 'unknown'); assert.equal(service.lastTurn().amount, null);
  const seq = service.lastTurn().seq;
  provider.used = 3; await service.getBalance({ force: true });
  await waitFor(() => service.ledger.find(scope, meta)?.costState === 'unknown');
  assert.equal(service.ledger.records(scope).today.total, 3);
  assert.equal(service.lastTurn().amount, null); assert.equal(service.lastTurn().seq, seq);
});

test('late children revise one root estimate and model total idempotently without a second notice', async t => {
  const { make, scope } = fixture(t, { setting: { models: { model: { input: 1, cachedInput: 1, output: 1 } } } }), service = make();
  const main = round('parent'), child = { id: 'child:sub', sessionId: 'child', turnId: 'sub', rootTurnId: main.turnId, isSubagent: true };
  service.beginTurn(main); await service.turns.get(main.id).start;
  await service.finishTurn({ ...main, byModel: usage(1000000) });
  assert.equal(service.lastTurn().amount, 1);
  service.beginTurn(child); await service.finishTurn({ ...child, byModel: usage(1000000), notify: false });
  assert.equal(service.lastTurn().amount, 2); assert.equal(service.lastTurn().seq, 1);
  assert.equal(service.usageRecords().today.models.reduce((sum, item) => sum + item.cost, 0), 2);
  const revision = service.ledger.find(scope, main).revision;
  service.beginTurn(child); await service.finishTurn({ ...child, byModel: usage(1000000), notify: false });
  assert.equal(service.ledger.find(scope, main).revision, revision);
  assert.equal(service.lastTurn().seq, 1);
});

test('an incomplete late child invalidates an earlier full-round estimate', async t => {
  const { make } = fixture(t, { setting: { models: { model: { input: 1, cachedInput: 1, output: 1 } } } }), service = make();
  const main = round('partial-child'), child = { id: 'child:partial', sessionId: 'child', turnId: 'partial', rootTurnId: main.turnId, isSubagent: true, partial: true };
  service.beginTurn(main); await service.turns.get(main.id).start;
  await service.finishTurn({ ...main, byModel: usage(1000000) });
  service.beginTurn(child); await service.finishTurn({ ...child, byModel: usage(100), notify: false });
  assert.equal(service.lastTurn().amount, null); assert.equal(service.lastTurn().costState, 'unknown');
  assert.equal(service.lastTurn().seq, 1); assert.deepEqual(service.usageRecords().today.models, []);
});

test('a prompt retry suppresses high demand; cancellation reports neutral observed spending', async t => {
  const { make, provider, scope } = fixture(t, { noticeDelayMs: 80 }), service = make();
  const failed = round('failed'); service.beginTurn(failed); await service.turns.get(failed.id).start;
  provider.used = 1; await service.finishTurn({ ...failed, outcome: 'failed', failureKind: 'high-demand', statusNotify: true, notify: false, byModel: usage(10) });
  const retry = round('retry'); service.beginTurn(retry); await service.turns.get(retry.id).start;
  provider.used = 2; await service.finishTurn({ ...retry, outcome: 'completed', byModel: usage(10) });
  await delay(110);
  assert.equal(service.lastTurn().seq, 1); assert.equal(service.lastTurn().completionKind, 'success');
  assert.equal(service.ledger.find(scope, failed).cost, null);
  const cancelled = round('cancelled'); service.beginTurn(cancelled); await service.turns.get(cancelled.id).start;
  provider.used = 3; await service.finishTurn({ ...cancelled, outcome: 'aborted', statusNotify: true, notify: false, byModel: usage(10) });
  await waitFor(()=>service.lastTurn().seq===2);
  assert.equal(service.lastTurn().completionKind,'cancelled');assert.equal(service.lastTurn().amount,null);assert.equal(service.lastTurn().accountIntervalAmount,1); assert.equal(service.ledger.find(scope, cancelled).cost, null);
  assert.equal(service.lastTurn().amount, null);
});

test('recovery journal is a whitelist and never persists credentials or provider configuration', async t => {
  const { make, dir } = fixture(t), service = make(), meta = round('safe', { context: { key: 'UNSAFE-META-SECRET' }, error: 'PRIVATE-ERROR' });
  service.beginTurn(meta); await service.turns.get(meta.id).start; service.updateTurn({ ...meta, byModel: usage(22) });
  const raw = fs.readFileSync(path.join(dir, 'turn-journal.json'), 'utf8');
  assert.ok(!raw.includes('FIXTURE-SECRET') && !raw.includes('UNSAFE-META') && !raw.includes('PRIVATE-ERROR'));
  const saved = JSON.parse(raw).entries[0];
  assert.equal(saved.stage, 'active'); assert.equal(saved.meta.byModel.model.input_tokens, 22);
  assert.ok(!('context' in saved) && !('setting' in saved) && !('key' in saved));
});

test('a cancellation that happened while the widget was stopped is recovered without replaying a notice', async t => {
  const { make, monitor, dir, provider, scope } = fixture(t), first = make(), meta = round('offline');
  first.beginTurn(meta); await first.turns.get(meta.id).start; first.updateTurn({ ...meta, byModel: usage(100) });
  await first.close(); provider.used = 3;
  const sessions = path.join(dir, 'sessions'); fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, 'main.jsonl'), [header, event('task_started', 'offline'), context('offline'), tokens(150), event('turn_aborted', 'offline')].map(JSON.stringify).join('\n') + '\n');
  const restarted = make(), watcher = monitor(restarted); watcher.start();
  await waitFor(() => restarted.ledger.find(scope, meta));
  const recovered = restarted.ledger.find(scope, meta);
  assert.equal(recovered.outcome, 'aborted'); assert.equal(recovered.tokens, 150); assert.equal(recovered.historical, true);
  assert.equal(recovered.cost, null); assert.equal(recovered.costState, 'unknown'); assert.equal(restarted.lastTurn().seq, 0);
  assert.equal(restarted.ledger.records(scope).today.total, 3); assert.equal(restarted.journal.entries.size, 0);
});

test('a still-running restored task keeps its original meter baseline and accumulated tokens', async t => {
  const { make, monitor, dir, provider, scope } = fixture(t), first = make(), meta = round('ongoing');
  first.beginTurn(meta); await first.turns.get(meta.id).start; first.updateTurn({ ...meta, byModel: usage(100) }); await first.close();
  const sessions = path.join(dir, 'sessions'); fs.mkdirSync(sessions);
  const file = path.join(sessions, 'main.jsonl');
  fs.writeFileSync(file, [header, event('task_started', 'ongoing'), context('ongoing'), tokens(200)].map(JSON.stringify).join('\n') + '\n');
  const restarted = make(), watcher = monitor(restarted); watcher.start();
  await waitFor(() => !watcher.status().initializing && restarted.turns.get(meta.id)?.byModel?.model?.input_tokens === 200);
  provider.used = 4;
  fs.appendFileSync(file, [tokens(300), event('task_complete', 'ongoing')].map(JSON.stringify).join('\n') + '\n');
  await waitFor(() => restarted.lastTurn().seq === 1);
  const saved = restarted.ledger.find(scope, meta);
  assert.equal(saved.tokens, 300); assert.equal(saved.cost, null); assert.equal(saved.partial, false); assert.equal(saved.historical, false);
});

test('quit during an in-flight settlement is bounded and restores the pending record silently', async t => {
  const { make, provider, scope } = fixture(t), first = make(), meta = round('settling');
  first.beginTurn(meta); await first.turns.get(meta.id).start;
  const immediate = provider.balance.bind(provider); provider.balance = async () => new Promise(() => {});
  first.finishTurn({ ...meta, outcome: 'completed', byModel: usage(50) });
  await delay(5); const before = Date.now(); await first.close({ timeoutMs: 25 });
  assert.ok(Date.now() - before < 500);
  assert.equal(first.journal.list()[0].stage, 'settling');
  provider.balance = immediate; provider.used = 2;
  const restarted = make(); restarted.prepareRecovery();
  await waitFor(() => restarted.ledger.find(scope, meta));
  assert.equal(restarted.ledger.find(scope, meta).tokens, 50); assert.equal(restarted.ledger.find(scope, meta).cost, null);
  assert.equal(restarted.lastTurn().seq, 0); assert.equal(restarted.journal.entries.size, 0);
});

test('recovery closes the crash window between a pending ledger append and journal-stage update', async t => {
  const { make, scope } = fixture(t), first = make(), meta = round('atomic-window');
  first.beginTurn(meta); await first.turns.get(meta.id).start;
  await first.finishTurn({ ...meta, outcome: 'completed', byModel: usage(10) });
  const seq = first.lastTurn().seq;
  const saved = first.journal.list()[0];
  first.journal.put({ ...saved, stage: 'settling', dueAt: null });
  await first.close();
  const restarted = make(); restarted.prepareRecovery();
  await waitFor(() => restarted.ledger.find(scope, meta)?.costState === 'unknown');
  assert.equal(restarted.lastTurn().seq, seq); assert.equal(restarted.lastTurn().amount, null);
  assert.equal(restarted.journal.entries.size, 0);
});

test('parser permits neutral consumption for failed and cancelled turns', () => {
  const ends = [], parser = new SessionParser({ id: 'file', onEnd: meta => ends.push(meta) });
  for (const [id, type, extra] of [['bad', 'task_complete', { error: 'fixture' }], ['cancel', 'turn_aborted', {}]]) {
    parser.accept(header); parser.accept(event('task_started', id)); parser.accept(event(type, id, extra));
  }
  assert.deepEqual(ends.map(meta => [meta.outcome, meta.notify, meta.statusNotify]), [['failed', false, true], ['aborted', false, true]]);
});

test('unmarked terminal API error settles observed consumption without waiting for task_complete', async t => {
  const {make,provider,scope}=fixture(t),service=make(),jobs=[];
  const parser=new SessionParser({id:'main',defaultModel:'model',onStart:m=>service.beginTurn(m),onUpdate:m=>service.updateTurn(m),onEnd:m=>jobs.push(service.finishTurn(m))});
  parser.accept(header);parser.accept(event('task_started','unexpected'));
  await service.turns.get('main:unexpected').start;
  parser.accept(tokens(40));provider.used=0.25;
  parser.accept(event('stream_error','unexpected',{message:'SYNTHETIC-RETRY'}));assert.equal(jobs.length,0);
  parser.accept(event('error','unexpected',{message:'SYNTHETIC-PRIVATE-API-ERROR'}));
  await Promise.all(jobs);
  const notice=service.lastTurn();assert.equal(notice.completionKind,'failed');assert.equal(notice.failureKind,null);
  assert.equal(notice.notify,true);assert.equal(notice.amount,null);assert.equal(notice.accountIntervalAmount,0.25);assert.equal(notice.tokens,40);
  assert.equal(JSON.stringify(notice).includes('SYNTHETIC-PRIVATE'),false);
  parser.accept(event('task_complete','unexpected',{status:'failed'}));await Promise.all(jobs);
  assert.equal(service.lastTurn().seq,notice.seq);assert.equal(service.ledger.load(scope).events.filter(e=>e.id==='main:unexpected').length,1);
});

test('unexpected failure retains pending or unknown cost, tokens, and one notice after continue',async t=>{
  const {make}=fixture(t),service=make();
  for(const outcome of ['failed','interrupted','superseded']){
    const meta=round(outcome);service.beginTurn(meta);await service.turns.get(meta.id).start;
    const finish=service.finishTurn({...meta,outcome,statusNotify:true,byModel:usage(57)});
    service.beginTurn(round(outcome+'-continued'));await finish;
    const notice=service.lastTurn();assert.equal(notice.id,meta.id);assert.equal(notice.completionKind,'failed');
    assert.equal(notice.amount,null);assert.equal(notice.tokens,57);
    assert.ok(['pending','unknown'].includes(notice.costState));assert.equal(notice.notify,true);
  }
});

test('immediately starting another turn does not suppress cancellation consumption',async t=>{
  const {make,provider}=fixture(t,{noticeDelayMs:100}),service=make(),first=round('cancel-then-continue');
  service.beginTurn(first);await service.turns.get(first.id).start;provider.used=0.4;
  const finish=service.finishTurn({...first,outcome:'aborted',statusNotify:true,notify:false,byModel:usage(40)});
  service.beginTurn(round('next'));await finish;
  assert.equal(service.lastTurn().completionKind,'cancelled');assert.equal(service.lastTurn().amount,null);assert.equal(service.lastTurn().accountIntervalAmount,0.4);
});

test('high demand survives settlement and journal sanitization without saving error text', async t => {
  const { make, provider, dir, scope } = fixture(t, { noticeDelayMs: 10 }), service = make();
  const meta = round('busy', { failureKind: 'high-demand', error: 'SYNTHETIC-PRIVATE-ERROR' });
  service.beginTurn(meta); await service.turns.get(meta.id).start;
  const journal = fs.readFileSync(path.join(dir, 'turn-journal.json'), 'utf8');
  assert.ok(journal.includes('high-demand')); assert.ok(!journal.includes('SYNTHETIC-PRIVATE-ERROR'));
  provider.used = 0.25;
  await service.finishTurn({ ...meta, outcome: 'failed', statusNotify: true, notify: false, byModel: usage(10) });
  await waitFor(() => service.lastTurn().seq === 1);
  assert.equal(service.lastTurn().failureKind, 'high-demand');
  assert.equal(service.ledger.find(scope, meta).cost, null);
  assert.ok(!fs.readFileSync(service.lastFile, 'utf8').includes('SYNTHETIC-PRIVATE-ERROR'));
});

test('cancel after a terminal overload replaces its queued phrase with neutral spending',async t=>{
  const {make,provider,scope}=fixture(t,{noticeDelayMs:80}),service=make(),meta=round('late-cancel');
  service.beginTurn(meta);await service.turns.get(meta.id).start;provider.used=0.3;
  await service.finishTurn({...meta,outcome:'failed',failureKind:'high-demand',statusNotify:true,notify:false});
  await service.finishTurn({...meta,outcome:'aborted',statusCorrection:true,notify:false,statusNotify:false});
  await delay(120);
  assert.equal(service.lastTurn().seq,1);assert.equal(service.lastTurn().completionKind,'cancelled');assert.equal(service.lastTurn().failureKind,null);assert.equal(service.lastTurn().amount,null);assert.equal(service.lastTurn().accountIntervalAmount,0.3);assert.equal(service.ledger.find(scope,meta).cost,null);
  assert.equal(service.ledger.find(scope,meta).outcome,'aborted');
});


test('parallel zero-token failure never receives another conversation debit', async t => {
  const { make, provider, scope } = fixture(t), service = make();
  const a = round('A', { sessionId: 'session-A' }), b = round('B', { sessionId: 'session-B' });
  service.beginTurn(a); await service.turns.get(a.id).start;
  service.beginTurn(b); await service.turns.get(b.id).start;
  provider.used = 0.25;
  await service.finishTurn({ ...b, outcome: 'failed', statusNotify: true, byModel: usage(0) });
  const failed = service.lastTurn();
  assert.equal(failed.amount, null); assert.equal(failed.costState, 'unknown');
  assert.equal(failed.accountIntervalAmount, 0.25); assert.equal(failed.concurrent, true);
  assert.match(failed.conversationRef, /^[a-f0-9]{8}$/);
  await service.finishTurn({ ...a, byModel: usage(100) });
  assert.equal(service.ledger.records(scope).today.total, 0.25);
});

test('decimal accumulation retains repeated sub-round8 debits across reload and recharge', t => {
  const { dir, scope } = fixture(t); let ledger = new UsageLedger(dir);
  ledger.observe(scope, { totalBalance: 1 });
  for (let i = 1; i <= 20; i++) ledger.observe(scope, { totalBalance: Number((1 - i * 1e-10).toFixed(10)) });
  ledger = new UsageLedger(dir);
  assert.equal(ledger.records(scope).today.total, 2e-9);
  ledger.observe(scope, { totalBalance: 2 });
  ledger.observe(scope, { totalBalance: 1.9999999999 });
  assert.equal(ledger.records(scope).today.total, 2.1e-9);
});

test('history is anonymously selectable and legacy interval projection does not rewrite storage', t => {
  const { make, scope } = fixture(t), service = make(), old = 'b'.repeat(24) + '-CNY';
  service.ledger.observe(old, { totalUsed: 1 }); service.ledger.observe(old, { totalUsed: 3 });
  service.ledger.append(old, { id: 'legacy', ts: Date.now(), source: 'shared-key-interval', cost: 2, amount: 2, currency: 'CNY' });
  const list = service.usageScopes(); assert.equal(list.scopes[0].current, false);
  assert.equal(JSON.stringify(list).includes('FIXTURE-SECRET'), false);
  const history = service.usageRecords({ scope: old });
  assert.equal(history.today.total, 2); assert.equal(history.all.events[0].cost, null);
  assert.equal(history.all.events[0].accountIntervalAmount, 2);
  assert.equal(service.ledger.load(old).events[0].cost, 2);
  assert.throws(() => service.usageRecords({ scope: '../secret' }));
});


test('positive tiny token estimates retain precision while zero tokens remain unknown', async t => {
  const { make } = fixture(t, { setting: { models: { model: { input: 0.0001, cachedInput: 0.0001, output: 0.0001 } } } }), service = make();
  const tiny = round('tiny'); service.beginTurn(tiny); await service.turns.get(tiny.id).start;
  await service.finishTurn({ ...tiny, byModel: usage(1) });
  assert.equal(service.lastTurn().amount, 1e-10); assert.equal(service.lastTurn().costState, 'estimated');
  const zero = round('zero'); service.beginTurn(zero); await service.turns.get(zero.id).start;
  await service.finishTurn({ ...zero, byModel: usage(0), outcome: 'failed', statusNotify: true });
  assert.equal(service.lastTurn().amount, null); assert.equal(service.lastTurn().costState, 'unknown');
});
