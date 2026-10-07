import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script=fs.readFileSync(new URL('../desktop/ui/account-notices.js',import.meta.url),'utf8');
const box={};vm.runInNewContext(script,box);
const create=box.WhaleAccountNotices.create;
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){
 const store=new Map(),shown=[],acks=[];let enabled=true,scope='a',id='notice-1',failure=false;
 const storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
 const options={storage,enabled:()=>enabled,fetchImpl:async(url,opts)=>{
  if(opts?.method==='POST'){acks.push(JSON.parse(opts.body).ids[0]);return {ok:!failure,json:async()=>({ok:!failure})};}
  return {ok:true,json:async()=>({ok:true,scope,notices:[{id,scope,amount:0.25,currency:'USD'}]})};
 },enqueue:(n,h)=>{shown.push({n,h});return true;}};
 const client=create(options);return {client,options,shown,acks,store,setEnabled:v=>enabled=v,setScope:v=>scope=v,setFailure:v=>failure=v,setId:v=>id=v};
}
test('GET queues once and ACK only happens after actual visual commit',async()=>{
 const h=setup();await h.client.poll();await h.client.poll();assert.equal(h.shown.length,1);assert.equal(h.acks.length,0);
 h.shown[0].h.shown();await tick();assert.deepEqual(h.acks,['notice-1']);await h.client.poll();assert.equal(h.shown.length,1);
});
test('lost acknowledgement and restart retry confirmation without repeating visible money',async()=>{
 const h=setup();h.setFailure(true);await h.client.poll();h.shown[0].h.shown();await tick();
 const restarted=create(h.options);h.setFailure(false);await restarted.poll();assert.equal(h.shown.length,1);assert.ok(h.acks.length>=2);
 h.setId('notice-2');await restarted.poll();assert.equal(h.shown.length,2);
});
test('discarded render is retried and never acknowledges unseen consumption',async()=>{
 const h=setup();await h.client.poll();h.shown[0].h.discarded();assert.equal(h.acks.length,0);await h.client.poll();assert.equal(h.shown.length,2);
});
test('disabled/hidden mode does not poll or consume, stale scope queues become invalid',async()=>{
 const h=setup();h.setEnabled(false);await h.client.poll();assert.equal(h.shown.length,0);
 h.setEnabled(true);await h.client.poll();const a=h.shown[0];assert.equal(a.h.valid(),true);
 h.setScope('b');h.setId('notice-b');await h.client.poll();assert.equal(a.h.valid(),false);assert.equal(h.shown[1].h.valid(),true);
 h.client.invalidate();assert.equal(h.shown[1].h.valid(),false);assert.equal(h.acks.length,0);
});
test('a delayed GET or JSON parse cannot restore a scope invalidated by an account change',async()=>{
 for(const phase of ['fetch','json']){
  let release;const gate=new Promise(r=>release=r);const enqueued=[];
  const client=create({enabled:()=>true,storage:{getItem:()=>null,setItem(){}},enqueue:n=>enqueued.push(n),fetchImpl:async()=>{
   if(phase==='fetch')await gate;
   return {ok:true,json:async()=>{if(phase==='json')await gate;return {ok:true,scope:'old',notices:[{scope:'old',id:'old-id',currency:'USD',amount:5}]};}};
  }});
  const job=client.poll();await Promise.resolve();client.invalidate();release();await job;assert.equal(enqueued.length,0,phase);
 }
});
