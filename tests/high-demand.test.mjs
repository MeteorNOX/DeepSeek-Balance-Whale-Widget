import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionParser } from '../runtime/session-monitor.mjs';
import { failureKind } from '../runtime/failure-kind.mjs';
const busy = "We're currently experiencing high demand, which may cause temporary errors.";
const event = (type, id, extra = {}) => ({ type: 'event_msg', timestamp: '2026-09-28T00:00:00Z', payload: { type, turn_id: id, ...extra } });

test('only the requested overload phrase matches and error fields are bounded', () => {
  assert.equal(failureKind({ error: { message: busy } }), 'high-demand');
  for (const text of ['HTTP 429 quota exhausted', 'timeout', 'high demand', 'permission denied']) assert.equal(failureKind(text), null);
  assert.equal(failureKind({ user_text: busy }), null);
  const cycle = {}; cycle.error = cycle; assert.equal(failureKind(cycle), null);
});

test('retry diagnostics, cancellations, other turns, success and history cannot emit a busy failure', () => {
  const ends = [], p = new SessionParser({ id: 'synthetic', onEnd: v => ends.push(v) });
  p.accept(event('task_started', 'one'));
  p.accept(event('stream_error', 'one', { error: busy, will_retry: true }));
  assert.equal(ends.length, 0);
  p.accept(event('task_complete', 'wrong', { error: busy })); assert.equal(ends.length, 0);
  p.accept(event('task_complete', 'one')); assert.equal(ends[0].outcome, 'completed'); assert.equal(ends[0].failureKind, null);
  p.accept(event('task_started', 'two'));
  p.accept(event('error', 'two', { message: busy, will_retry: true }));
  p.accept(event('turn_aborted', 'two', { error: busy }));
  assert.equal(ends[1].outcome, 'aborted'); assert.equal(ends[1].statusNotify, true); assert.equal(ends[1].failureKind,null);
  p.accept(event('task_started', 'three'));
  p.accept(event('error', 'three', { message: busy, will_retry: true }));
  p.accept(event('task_complete', 'three', { error: 'network failed' }));
  assert.equal(ends[2].statusNotify, true); assert.equal(ends[2].failureKind, null);
  p.prime([event('task_started', 'history'), event('task_complete', 'history', { error: busy })]);
  assert.equal(ends.length, 3);
});

test('terminal structured errors and failed completion retain only the safe category', () => {
  const ends = [], p = new SessionParser({ id: 'synthetic', onEnd: v => ends.push(v) });
  for (const type of ['task_complete', 'error']) {
    p.accept(event('task_started', type));
    p.accept(JSON.stringify(event(type, type, { error: { message: busy }, will_retry: false })));
  }
  assert.equal(ends.length, 2);
  for (const record of ends) {
    assert.equal(record.statusNotify, true); assert.equal(record.failureKind, 'high-demand');
    assert.ok(!JSON.stringify(record).includes(busy)); assert.equal(record.notify, false);
  }
});

test('a cancellation following a terminal overload corrects the pending failure outcome', () => {
  const ends=[],p=new SessionParser({id:'late-cancel',onEnd:v=>ends.push(v)});
  p.accept(event('task_started','one'));
  p.accept(event('error','one',{message:busy,will_retry:false}));
  p.accept(event('turn_aborted','one',{error:busy}));
  assert.equal(ends.length,2);assert.equal(ends[1].outcome,'aborted');
  assert.equal(ends[1].statusCorrection,true);assert.equal(ends[1].statusNotify,true);assert.equal(ends[1].failureKind,null);
});

test('1000 repeated and out-of-order terminal records produce one classified outcome per turn', () => {
  const ends = [], p = new SessionParser({ id: 'stress', onEnd: v => ends.push(v) });
  for (let i = 0; i < 1000; i++) {
    const id = String(i);
    p.accept(event('task_started', id));
    p.accept(event('stream_error', id, { message: busy, will_retry: true }));
    const done = event('task_complete', id, { error: busy });
    p.accept(done); p.accept(done); p.accept(event('task_started', id));
  }
  assert.equal(ends.length, 1000); assert.equal(ends.filter(x => x.statusNotify).length, 1000);
  assert.equal(p.active, null);
});
