import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {InsightAccumulator,quotaWindows,mergeQuotaWindows,collectInsights} from '../runtime/insights-worker.mjs';
import {createInsightsService} from '../runtime/insights.mjs';

const at=Date.parse('2026-10-04T12:00:00Z');
const win=(mins,used=20,reset=at+3600000)=>({used_percent:used,window_minutes:mins,resets_at:reset/1000});
const event=(timestamp,rate_limits)=>({type:'event_msg',timestamp:new Date(timestamp).toISOString(),payload:{type:'token_count',rate_limits}});
const meta=id=>({type:'session_meta',payload:{id}});
function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-quota-regression-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const write=(name,rows,mtime=Date.now())=>{
    const file=path.join(home,name);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');fs.utimesSync(file,new Date(mtime),new Date(mtime));return file;
  };
  const auth=(mtime,account='fixture-account')=>{
    const file=path.join(home,'auth.json');
    fs.writeFileSync(file,JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:account,access_token:'synthetic-test-value'}}));
    fs.utimesSync(file,new Date(mtime),new Date(mtime));
  };
  return {home,write,auth};
}

test('quota identity excludes explicitly unrelated buckets and cautiously accepts legacy',()=>{
  for(const limit_id of ['codex_other','codex_bengalfox','',42,'CODEX']) assert.deepEqual(quotaWindows({limit_id,primary:win(300)},at,at),[]);
  assert.deepEqual(quotaWindows({limit_name:'Other quota',primary:win(300)},at,at),[]);
  assert.equal(quotaWindows({limit_id:'codex',limit_name:'Account display name',primary:win(300)},at,at)[0].source,'codex');
  assert.equal(quotaWindows({primary:win(300)},at,at)[0].source,'legacy-unscoped');
  assert.equal(quotaWindows({limit_id:null,limit_name:null,primary:win(300)},at,at).length,1);
  assert.deepEqual(quotaWindows({limit_id:'codex',primary:win(1440)},at,at),[]);
});

test('camelCase identities cannot bypass quota type filtering or conflicting aliases',()=>{
  for (const identity of [
    {limitId:'codex_review'}, {limitId:'codex_bengalfox'}, {limitName:'Review quota'},
    {limit_id:'codex',limitId:'codex_review'}, {limit_id:null,limitId:'codex_review'},
    {limit_id:'codex',limit_name:'Codex',limitName:'Other'}, {limitId:'codex',limitName:42},
  ]) assert.deepEqual(quotaWindows({...identity,primary:win(300)},at,at),[]);
  assert.equal(quotaWindows({limit_id:'codex',limitId:'codex',limit_name:'Codex',limitName:'Codex',primary:win(300)},at,at)[0].source,'codex');
});

test('all supported window spellings normalize consistently and numeric conflicts are rejected',()=>{
  const canonical=quotaWindows({limit_id:'codex',primary:win(300)},at,at);
  for(const duration of ['window_minutes','window_duration_mins','windowDurationMins','windowMinutes']) {
    assert.deepEqual(quotaWindows({limitId:'codex',primary:{usedPercent:20,[duration]:300,resetsAt:(at+3600000)/1000}},at,at),canonical);
  }
  for(const window of [
    {...win(300),usedPercent:99}, {...win(300),windowDurationMins:10080},
    {...win(300),resetsAt:at/1000}, {...win(300),windowMinutes:'300'},
    {usedPercent:'20',windowMinutes:300}, {usedPercent:NaN,windowMinutes:300},
  ]) assert.deepEqual(quotaWindows({limitId:'codex',primary:window},at,at),[]);
  assert.equal(quotaWindows({limitId:'codex',primary:{...win(300),usedPercent:20,windowMinutes:300,resetsAt:(at+3600000)/1000}},at,at).length,1);
});

test('collector reads rateLimits payloads and excludes camelCase unrelated quota',t=>{
  const f=fixture(t);
  const row=(time,rateLimits)=>({type:'event_msg',timestamp:new Date(time).toISOString(),payload:{type:'token_count',rateLimits}});
  f.write('sessions/rollout-camel.jsonl',[meta('camel'),
    row(at-1000,{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:(at+3600000)/1000}}),
    row(at,{limitId:'codex_review',primary:{usedPercent:99,windowMinutes:300,resetsAt:(at+3600000)/1000}})],at);
  const windows=collectInsights({codexHome:f.home,now:at}).windows;
  assert.equal(windows.length,1);assert.equal(windows[0].usedPercent,25);assert.equal(windows[0].source,'codex');
});

test('conflicting rate_limits and rateLimits containers are not silently preferred',()=>{
  const parser=new InsightAccumulator(at),good={limit_id:'codex',primary:win(300)};
  parser.accept({...event(at,good),payload:{type:'token_count',rate_limits:good,rateLimits:{limitId:'codex_review',primary:win(300)}}});
  assert.equal(parser.quota,null);
  parser.accept({...event(at,good),payload:{type:'token_count',rate_limits:good,rateLimits:structuredClone(good)}});
  assert.equal(parser.quota.windows.length,1);
});

test('single-file partial quota updates retain each duration and timestamp',()=>{
  const parser=new InsightAccumulator(at);
  parser.accept(event(at-1000,{limit_id:'codex',primary:win(300,20),secondary:win(10080,40)}));
  parser.accept(event(at,{limit_id:'codex',primary:win(10080,50)}));
  parser.accept(event(at+1,{limit_id:'codex_other',primary:win(300,99)}));
  assert.deepEqual(parser.quota.windows.map(w=>[w.windowDurationMins,w.usedPercent,w.observedAt]),[[300,20,at-1000],[10080,50,at]]);
});

test('same-time five-hour and weekly events are complementary in either arrival order',()=>{
  const updates=[event(at,{limit_id:'codex',primary:win(300,20)}),event(at,{limit_id:'codex',primary:win(10080,40)})];
  const a=new InsightAccumulator(at),b=new InsightAccumulator(at);
  updates.forEach(e=>a.accept(e));updates.toReversed().forEach(e=>b.accept(e));
  assert.deepEqual(a.quota,b.quota);assert.equal(a.quota.windows.length,2);
});

test('equal-time fragments merge independently of order, preserving reset and conservative conflicts',()=>{
  const a=quotaWindows({limit_id:'codex',primary:{used_percent:20,window_minutes:300}},at,at);
  const b=quotaWindows({limit_id:'codex',secondary:win(300,25)},at,at);
  assert.deepEqual(mergeQuotaWindows(a,b,at),mergeQuotaWindows(b,a,at));
  const [merged]=mergeQuotaWindows(a,b,at);
  assert.equal(merged.usedPercent,25);assert.equal(merged.resetsAt,at+3600000);assert.equal(merged.stale,false);
});

test('explicit Codex quota takes precedence over newer ambiguous legacy for the same duration',()=>{
  const a=quotaWindows({limit_id:'codex',primary:win(300,20)},at-1000,at);
  const b=quotaWindows({primary:win(300,90),secondary:win(10080,10)},at,at);
  for(const rows of [mergeQuotaWindows(a,b,at),mergeQuotaWindows(b,a,at)]) {
    assert.equal(rows[0].usedPercent,20);assert.equal(rows[0].source,'codex');
    assert.equal(rows[1].usedPercent,10);assert.equal(rows[1].source,'legacy-unscoped');
  }
});

test('collector combines distinct files and archived copies before session deduplication',t=>{
  const f=fixture(t);
  f.write('sessions/rollout-a.jsonl',[meta('same'),event(at-2000,{limit_id:'codex',primary:win(300,20)})],at);
  f.write('archived_sessions/rollout-copy.jsonl',[meta('same'),event(at-1000,{limit_id:'codex',secondary:win(10080,40)})],at-1000);
  f.write('sessions/rollout-b.jsonl',[meta('other'),event(at,{limit_id:'codex_bengalfox',primary:win(300,99)})],at+1000);
  const result=collectInsights({codexHome:f.home,now:at});
  assert.deepEqual(result.windows.map(w=>[w.windowDurationMins,w.usedPercent]),[[300,20],[10080,40]]);
  assert.equal(result.observedAt,at-1000);
});

test('collector cutoff applies to each window before source precedence',t=>{
  const f=fixture(t);
  f.write('sessions/rollout-a.jsonl',[meta('a'),
    event(at-2000,{limit_id:'codex',primary:win(300,80)}),
    event(at,{limit_id:'codex',secondary:win(10080,10)})],at);
  const result=collectInsights({codexHome:f.home,now:at,quotaAfterMs:at-1000});
  assert.deepEqual(result.windows.map(w=>w.windowDurationMins),[10080]);
});

test('new weekly data cannot freshen an expired five-hour window',()=>{
  const parser=new InsightAccumulator(at);
  parser.accept(event(at-16*60000,{limit_id:'codex',primary:win(300,30)}));
  parser.accept(event(at,{limit_id:'codex',secondary:win(10080,20)}));
  assert.equal(parser.quota.windows[0].stale,true);assert.equal(parser.quota.windows[1].stale,false);
  assert.equal(quotaWindows({limit_id:'codex',primary:win(300,20,Infinity)},at,at)[0].stale,true);
});

test('service hides pre-login windows even when a later other window is available',async t=>{
  const f=fixture(t),now=Date.now();f.auth(now-10000);
  f.write('sessions/rollout-a.jsonl',[meta('a'),event(now-20000,{limit_id:'codex',primary:win(300,80,now+3600000)}),
    event(now-1000,{limit_id:'codex',secondary:win(10080,10,now+3600000)})]);
  const service=createInsightsService({codexHome:f.home,resolve:()=>({id:'openai',accountId:'fixture',key:null,setting:{monitorSessions:true}})});
  t.after(()=>service.close());const result=await service.get();
  assert.deepEqual(result.subscription.windows.map(w=>w.windowDurationMins),[10080]);
});

test('service invalidates cached quota on same-account re-login, account and API-mode changes',async t=>{
  const f=fixture(t),now=Date.now();f.auth(now-20000);
  f.write('sessions/rollout-a.jsonl',[meta('a'),event(now-10000,{limit_id:'codex',primary:win(300,25,now+3600000)})]);
  const current={id:'openai',accountId:'fixture',key:null,setting:{monitorSessions:true}};
  const service=createInsightsService({codexHome:f.home,resolve:()=>current});t.after(()=>service.close());
  assert.equal((await service.get()).subscription.available,true);
  current.key='synthetic-api-key';assert.equal((await service.get()).subscription.available,false);
  current.key=null;assert.equal((await service.get()).subscription.available,true);
  f.auth(now-5000);assert.equal((await service.get()).subscription.available,false);
  f.auth(now-4000,'another-fixture-account');assert.equal((await service.get()).subscription.available,false);
});

test('authentication changing during a worker scan never exposes its old snapshot',async t=>{
  const f=fixture(t),now=Date.now();f.auth(now-20000);
  f.write('sessions/rollout-a.jsonl',[meta('a'),event(now-10000,{limit_id:'codex',primary:win(300,25,now+3600000)})]);
  const service=createInsightsService({codexHome:f.home,resolve:()=>({id:'openai',accountId:'fixture',key:null,setting:{monitorSessions:true}})});
  t.after(()=>service.close());const pending=service.get();f.auth(now-1000,'changed-account');
  const result=await pending;assert.equal(result.subscription.available,false);assert.deepEqual(result.subscription.windows,[]);
  assert.equal((await service.get()).subscription.available,false);
});
