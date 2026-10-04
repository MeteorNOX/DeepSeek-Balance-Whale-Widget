import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDispatcher } from '../runtime/dispatcher.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-commit-'));
  const service = { config: { resolve: () => ({ setting: {} }) }, usageScopes: () => ({ok:true,scopes:[]}),
    usageRecords: ({scope}) => ({ok:true,requestedScope:scope}), close: async () => {} };
  const server = createDispatcher({dataDir:dir,service,monitor:false,autoRefresh:false});
  t.after(async()=>{await server.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(dir).startsWith('whale-commit-'));fs.rmSync(dir,{recursive:true,force:true});});
  return async (url, method='GET', body) => {const r=await server.dispatch(url,{method,body});return {status:r.status,data:JSON.parse(r.body.toString())};};
}
test('independent preference writes merge at commit instead of erasing unrelated saved fields', async t=>{
 const request=setup(t);
 assert.equal((await request('/dsh-whale/size.json','PUT',{scale:1.7,sound:false,vol:0.6,turnCostOn:false})).status,200);
 assert.equal((await request('/dsh-whale/size.json','PUT',{vol:0.2})).status,200);
 const saved=(await request('/dsh-whale/size.json')).data;
 assert.equal(saved.scale,1.7);assert.equal(saved.vol,0.2);assert.equal(saved.sound,false);assert.equal(saved.turnCostOn,false);
});
test('stale bubble editor cannot resurrect deleted modules and conflict keeps newest configuration',async t=>{
 const request=setup(t),initial=(await request('/dsh-whale/bubble.json')).data;
 const first=await request('/dsh-whale/bubble.json','POST',{v:1,items:[],lib:[{id:'old-module',type:'text'}],expectedRevision:initial.revision});
 assert.equal(first.status,200);
 const second=await request('/dsh-whale/bubble.json','POST',{v:1,items:[],lib:[],expectedRevision:first.data.revision});
 assert.equal(second.status,200);
 const stale=await request('/dsh-whale/bubble.json','POST',{v:1,items:[],lib:[{id:'old-module',type:'text'}],expectedRevision:first.data.revision});
 assert.equal(stale.status,409);assert.equal(stale.data.ok,false);
 const saved=(await request('/dsh-whale/bubble.json')).data;
 assert.deepEqual(saved.config.lib,[]);assert.equal(saved.revision,second.data.revision);
});
test('historical account selection reaches service and scopes have a read-only endpoint',async t=>{
 const request=setup(t);
 assert.deepEqual((await request('/api/usage-scopes')).data,{ok:true,scopes:[]});
 assert.equal((await request('/dsh-whale/usage-records.json?scope=synthetic-scope')).data.requestedScope,'synthetic-scope');
 assert.notEqual((await request('/api/usage-scopes','POST')).status,200);
});
