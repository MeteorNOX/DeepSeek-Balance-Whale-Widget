import test from 'node:test';
import assert from 'node:assert/strict';
import {InsightAccumulator,quotaWindows} from '../runtime/insights-worker.mjs';
import {pricingSchedule} from '../runtime/pricing-schedule.mjs';
const now=Date.parse('2026-09-28T10:00:00+08:00');

test('next transition never crosses the verified calendar boundary', () => {
  const c = { baseUrl: 'https://api.deepseek.com/v1' };
  const lastPeak = pricingSchedule(c, Date.parse('2026-12-31T17:59:59+08:00'));
  assert.equal(lastPeak.nextChangeAt, Date.parse('2026-12-31T18:00:00+08:00'));
  for (const date of ['2026-12-31T18:00:00+08:00', '2026-12-31T23:59:59+08:00']) {
    const p = pricingSchedule(c, Date.parse(date));
    assert.equal(p.phase, 'off-peak'); assert.equal(p.nextChangeAt, null); assert.match(p.note, /后续时段需更新/);
  }
  for (const date of ['2027-01-01T00:00:00+08:00', '2026-09-18T23:59:59+08:00']) {
    const p = pricingSchedule(c, Date.parse(date));
    assert.equal(p.phase, 'unknown'); assert.equal(p.nextChangeAt, null); assert.equal(p.stale, true);
  }
  assert.equal(pricingSchedule(c, NaN).phase, 'unknown');
});
test('DeepSeek only: official host, time zones, holidays and boundary',()=>{
  assert.equal(pricingSchedule({baseUrl:'https://example.org',model:'deepseek-flash'},now).visible,false);
  const c={baseUrl:'https://api.deepseek.com/v1'};
  const p=pricingSchedule(c,now);assert.equal(p.phase,'peak');assert.equal(p.nextChangeAt,Date.parse('2026-09-28T12:00:00+08:00'));
  assert.equal(pricingSchedule(c,Date.parse('2026-10-01T10:00:00+08:00')).phase,'off-peak');
  assert.equal(pricingSchedule(c,Date.parse('2026-09-28T12:00:00+08:00')).phase,'off-peak');
  assert.equal(pricingSchedule(c,Date.parse('2027-01-01T10:00:00+08:00')).phase,'unknown');
});
test('quota windows use real duration and stale reset, never invent token total',()=>{
  const r=quotaWindows({primary:{used_percent:20,window_minutes:300,resets_at:now/1000+3600},secondary:{used_percent:80,window_minutes:10080,resets_at:now/1000-1}},now,now);
  assert.equal(r[0].remainingPercent,80);assert.equal(r[1].stale,true);assert.equal(r[0].totalTokens,undefined);
  assert.deepEqual(quotaWindows({primary:{used_percent:101,window_minutes:300}},now,now),[]);
});
test('counter differences dedupe, reset uses last usage, cached/reasoning not added twice',()=>{
  const p=new InsightAccumulator(now);
  const add=(input,output,last)=>p.accept({type:'event_msg',timestamp:new Date(now).toISOString(),payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:output,cached_input_tokens:20,reasoning_output_tokens:3},last_token_usage:last}}});
  add(100,10,{input_tokens:100,output_tokens:10});add(100,10);add(130,20);add(5,2,{input_tokens:5,output_tokens:2});
  assert.equal(p.events.length,3);assert.equal(p.events.reduce((s,e)=>s+e.input_tokens+e.output_tokens,0),157);
});
test('quota-only token event is captured, inherited fork events skipped',()=>{
  const p=new InsightAccumulator(now);
  p.accept({type:'session_meta',payload:{timestamp:new Date(now).toISOString(),forked_from_id:'parent'}});
  p.accept({type:'event_msg',timestamp:new Date(now-1000).toISOString(),payload:{type:'token_count',rate_limits:{primary:{used_percent:20,window_minutes:300}}}});
  assert.equal(p.quota,null);
  p.accept({type:'event_msg',timestamp:new Date(now).toISOString(),payload:{type:'token_count',rate_limits:{primary:{used_percent:20,window_minutes:300}}}});
  assert.equal(p.quota.windows.length,1);
});
