import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageLedger } from '../runtime/ledger.mjs';
import { WhaleService } from '../runtime/service.mjs';
import { DEFAULT_CONFIG } from '../runtime/config.mjs';
const scope = 'a'.repeat(24) + '-USD', meter = 'b'.repeat(64);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-account-notices-'));
  const current = {accountId:'a'.repeat(24),key:'synthetic-test-key',model:'model',dashboardUrl:'',setting:structuredClone(DEFAULT_CONFIG)};
  const config = { dataDir:dir, codexHome:dir, resolve:()=>structuredClone(current) };
  const provider = { used:0, calls:0, failure:null, async balance(c) {
    this.calls++; if(this.failure)throw this.failure;
    return {ok:true,accountId:c.accountId,currency:c.setting.currency,totalUsed:this.used,totalBalance:100-this.used};
  } };
  const services=[]; const service=()=>{const s=new WhaleService({config,provider});services.push(s);return s;};
  t.after(async()=>{for(const s of services)await s.close();const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('whale-account-notices-'));fs.rmSync(resolved,{recursive:true,force:true});});
  return {dir,current,config,provider,service,ledger:new UsageLedger(dir)};
}
const sample=(used,extra={})=>({ok:true,totalUsed:used,meterKey:meter,...extra});

test('first observation initializes a notice baseline without reporting existing ledger history',t=>{
  const {ledger}=fixture(t);const old=ledger.load(scope);old.date='2026-10-04';old.observed=40;old.lastObservation={used:50,balance:50,at:1,meterKey:meter};ledger.save(scope,old);
  ledger.observe(scope,sample(60),1000);assert.equal(ledger.accountNotice(scope,meter),null);
  ledger.observe(scope,sample(60.25),2000);const notice=ledger.accountNotice(scope,meter);
  assert.equal(notice.amount,0.25);assert.equal(notice.intervalStart,1000);
  assert.equal(JSON.stringify(notice).includes('a'.repeat(24)),false);assert.equal(JSON.stringify(notice).includes('synthetic-test-key'),false);
});

test('GET is durable and unacknowledged, new debits after GET survive old batch ACK',t=>{
  const {dir,ledger}=fixture(t);ledger.observe(scope,sample(0),1000);ledger.observe(scope,sample(0.25),2000);
  const first=ledger.accountNotice(scope,meter);assert.deepEqual(ledger.accountNotice(scope,meter),first);
  ledger.observe(scope,sample(0.6),3000);assert.deepEqual(ledger.accountNotice(scope,meter),first);
  const restart=new UsageLedger(dir);assert.deepEqual(restart.accountNotice(scope,meter),first);
  assert.deepEqual(restart.acknowledgeNotices(scope,meter,[first.id]),[first.id]);
  assert.deepEqual(restart.acknowledgeNotices(scope,meter,[first.id]),[first.id]);
  const second=restart.accountNotice(scope,meter);assert.notEqual(second.id,first.id);assert.equal(second.amount,0.35);
  restart.acknowledgeNotices(scope,meter,[first.id]);assert.deepEqual(restart.accountNotice(scope,meter),second);
});

test('exact aggregate survives midnight and restart, then reports delayed debit once',t=>{
  const {dir,ledger}=fixture(t);const before=new Date(2026,9,4,23,59,59).getTime(),after=before+2000;
  ledger.observe(scope,sample(0),before);ledger.observe(scope,sample(1e-10),before+1);
  const restart=new UsageLedger(dir);restart.observe(scope,sample(3e-10),after);
  const notice=restart.accountNotice(scope,meter);assert.equal(notice.amount,3e-10);assert.equal(notice.observedAt,after);
  restart.acknowledgeNotices(scope,meter,[notice.id]);restart.observe(scope,sample(3e-10),after+1000);assert.equal(restart.accountNotice(scope,meter),null);
  restart.observe(scope,sample(0.5),after+2000);assert.equal(restart.accountNotice(scope,meter).amount,0.4999999997);
});

test('disabled UI has constant-size pending aggregate, not one record per sample',t=>{
  const {ledger}=fixture(t);let memory=ledger.load(scope);ledger.load=()=>structuredClone(memory);ledger.save=(_scope,data)=>memory=structuredClone(data);
  ledger.observe(scope,sample(0));for(let i=1;i<=5000;i++)ledger.observe(scope,sample(i/100));
  assert.equal(memory.accountNotices.issued,null);assert.ok(JSON.stringify(memory.accountNotices).length<500);
  const notice=ledger.accountNotice(scope,meter);assert.equal(notice.amount,50);assert.equal(memory.events.length,0);
});

test('currency and meter mode switches cannot cross-notify or accept foreign acknowledgments',t=>{
  const {ledger}=fixture(t);ledger.observe(scope,sample(0));ledger.observe(scope,sample(1));const old=ledger.accountNotice(scope,meter);
  const other='a'.repeat(24)+'-CNY';ledger.observe(other,sample(0));assert.throws(()=>ledger.acknowledgeNotices(other,meter,[old.id]),/当前账户/);
  const newMeter='c'.repeat(64);assert.equal(ledger.accountNotice(scope,newMeter),null);assert.throws(()=>ledger.acknowledgeNotices(scope,newMeter,[old.id]));
  ledger.observe(scope,sample(1,{meterKey:newMeter}));assert.equal(ledger.accountNotice(scope,newMeter),null);
  ledger.observe(scope,{ok:true,totalBalance:80,meterKey:newMeter});ledger.observe(scope,{ok:true,totalBalance:79.75,meterKey:newMeter});
  assert.equal(ledger.accountNotice(scope,newMeter).amount,0.25);assert.throws(()=>ledger.acknowledgeNotices(scope,newMeter,[old.id]));
});

test('failed observation and failed ACK writes retry without losing or repeating amounts',t=>{
  const {ledger}=fixture(t);ledger.observe(scope,sample(0));const save=ledger.save.bind(ledger);let fail=true;
  ledger.save=(...args)=>{if(fail)throw Error('synthetic disk failure');return save(...args);};
  assert.throws(()=>ledger.observe(scope,sample(0.3)));assert.equal(ledger.load(scope).lastObservation.used,0);
  fail=false;ledger.observe(scope,sample(0.3));const first=ledger.accountNotice(scope,meter);assert.equal(first.amount,0.3);
  fail=true;assert.throws(()=>ledger.acknowledgeNotices(scope,meter,[first.id]));assert.equal(ledger.accountNotice(scope,meter).id,first.id);
  fail=false;ledger.acknowledgeNotices(scope,meter,[first.id]);ledger.observe(scope,sample(0.3));assert.equal(ledger.accountNotice(scope,meter),null);
});

test('parallel failure produces an account notification while the failed turn stays unattributed',async t=>{
  const {service,provider}=fixture(t),s=service();await s.getBalance({force:true});
  const a={id:'a:t',sessionId:'a',turnId:'t'},b={id:'b:t',sessionId:'b',turnId:'t'};
  s.beginTurn(a);await s.turns.get(a.id).start;s.beginTurn(b);await s.turns.get(b.id).start;
  provider.used=0.25;await s.finishTurn({...b,outcome:'failed',statusNotify:true,byModel:{}});
  assert.equal(s.lastTurn().amount,null);const result=s.accountNotices(),notice=result.notices[0];
  assert.equal(notice.amount,0.25);assert.equal(notice.concurrent,true);assert.equal(notice.concurrentCount,2);assert.equal(result.scope,notice.scope);
  await s.finishTurn({...a,outcome:'completed',byModel:{}});assert.equal(s.accountNotices().notices[0].id,notice.id);
  s.ackAccountNotices([notice.id]);assert.deepEqual(s.accountNotices().notices,[]);assert.equal(s.usageRecords().today.total,0.25);
});

test('cached and failed balance queries never duplicate; delayed refresh reports later debit',async t=>{
  const {service,provider}=fixture(t),s=service();await s.getBalance({force:true});provider.used=0.4;await s.getBalance({force:true});
  const first=s.accountNotices().notices[0];s.ackAccountNotices([first.id]);await s.getBalance();assert.deepEqual(s.accountNotices().notices,[]);
  provider.failure=Object.assign(Error('transient'),{transient:true});provider.used=0.8;assert.equal((await s.getBalance({force:true})).stale,true);assert.deepEqual(s.accountNotices().notices,[]);
  provider.failure=null;await s.getBalance({force:true});assert.equal(s.accountNotices().notices[0].amount,0.4);
});

test('service filters and rejects prior-account/context notices before any new balance sample',async t=>{
  const {service,provider,current}=fixture(t),s=service();await s.getBalance({force:true});provider.used=1;await s.getBalance({force:true});const notice=s.accountNotices().notices[0];
  current.accountId='d'.repeat(24);assert.deepEqual(s.accountNotices().notices,[]);assert.throws(()=>s.ackAccountNotices([notice.id]));
  current.accountId='a'.repeat(24);current.setting.balanceScale=2;assert.deepEqual(s.accountNotices().notices,[]);assert.throws(()=>s.ackAccountNotices([notice.id]));
});

test('stale, unavailable and failed raw samples preserve pending notices without consumption',t=>{
  const {ledger}=fixture(t);ledger.observe(scope,sample(0));ledger.observe(scope,sample(0.2));const notice=ledger.accountNotice(scope,meter);
  ledger.observe(scope,sample(1,{stale:true}));ledger.observe(scope,sample(1,{ok:false}));ledger.observe(scope,{ok:true,totalBalance:null,totalUsed:null,meterKey:meter});
  assert.equal(ledger.load(scope).lastObservation.used,0.2);assert.deepEqual(ledger.accountNotice(scope,meter),notice);
});


test('all previously acknowledged batch IDs remain idempotent without an unbounded receipt list',t=>{
  const {ledger}=fixture(t);ledger.observe(scope,sample(0));const ids=[];
  for(let n=1;n<=4;n++){ledger.observe(scope,sample(n));const notice=ledger.accountNotice(scope,meter);ids.push(notice.id);ledger.acknowledgeNotices(scope,meter,[notice.id]);}
  assert.deepEqual(ledger.acknowledgeNotices(scope,meter,ids),ids);assert.equal(ledger.accountNotice(scope,meter),null);
  assert.ok(JSON.stringify(ledger.load(scope).accountNotices).length<500);
});

test('service restores actual provider currency and durable issued notice across restart',async t=>{
  const {service,current,provider}=fixture(t);current.setting.currency='CNY';
  provider.balance=async c=>({ok:true,accountId:c.accountId,currency:'USD',totalUsed:provider.used,totalBalance:100-provider.used});
  const first=service();await first.getBalance({force:true});provider.used=0.7;await first.getBalance({force:true});const notice=first.accountNotices().notices[0];assert.equal(notice.currency,'USD');
  await first.close();const restarted=service();assert.deepEqual(restarted.accountNotices().notices,[notice]);
  restarted.ackAccountNotices([notice.id]);assert.deepEqual(restarted.accountNotices().notices,[]);
});

test('out-of-order balance responses cannot manufacture or duplicate account debit notices',async t=>{
  const {service,current,provider}=fixture(t),s=service();await s.getBalance({force:true});
  const requests=[];provider.balance=c=>new Promise(resolve=>requests.push({resolve,c}));
  const older=s.getBalance({force:true,context:structuredClone(current)});
  current.setting.models={demo:{input:1,cachedInput:1,output:1}};
  const newer=s.getBalance({force:true});
  const reply=(index,used)=>requests[index].resolve({ok:true,accountId:current.accountId,currency:'USD',totalUsed:used,totalBalance:100-used});
  reply(1,0.6);await newer;reply(0,0.3);await older;
  const notice=s.accountNotices().notices[0];assert.equal(notice.amount,0.6);s.ackAccountNotices([notice.id]);
  const unchanged=s.getBalance({force:true});reply(2,0.6);await unchanged;assert.deepEqual(s.accountNotices().notices,[]);
});


test('failed issuance persistence exposes no transient ID and leaves the aggregate retryable',t=>{
  const {ledger}=fixture(t);ledger.observe(scope,sample(0));ledger.observe(scope,sample(0.125));
  const save=ledger.save.bind(ledger);ledger.save=()=>{throw Error('synthetic issuance write failure');};
  assert.throws(()=>ledger.accountNotice(scope,meter));assert.equal(ledger.load(scope).accountNotices.issued,null);
  ledger.save=save;const notice=ledger.accountNotice(scope,meter);assert.equal(notice.amount,0.125);
  assert.deepEqual(ledger.accountNotice(scope,meter),notice);
});
