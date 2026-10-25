const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const os=require('node:os');
const lockfile=require('proper-lockfile');
const {pathToFileURL}=require('node:url');
test('LEDGER-TURN-RETRY: a failed multi-model turn is retried without missing or duplicate charges',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-turn-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'ledger.json');
  fs.writeFileSync(file,JSON.stringify({date:new Date().toISOString().slice(0,10),events:[],history:{},accounting:{version:1}}));
  const source=fs.readFileSync(path.join(__dirname,'../lib/index.js'),'utf8');
  const accounting=await import(pathToFileURL(path.join(__dirname,'../lib/accounting.mjs')).href);
  const wrapped=Object.create(fs);let failed=false;
  wrapped.writeFileSync=(...args)=>{
    if(!failed&&String(args[0]).includes('ledger.json.tmp-')&&JSON.parse(args[1]).events.some(e=>e.model==='B')){
      failed=true;const error=Error('one injected write failure');error.code='EIO';throw error;
    }
    return fs.writeFileSync(...args);
  };
  const aggs=new Map([['session',{turn:1,cost:3,tokens:30,lastTs:Date.now(),byModel:{A:1,B:2},byModelTokens:{A:10,B:20}}]]);
  const sandbox={fs:wrapped,path,process,console,lockfile,DSH_HOME:dir,USAGE_FILE_CANDIDATES:[file],...accounting,
    ledgerIo:fn=>fn(),todayKey:()=>accounting.beijingDay(),turnAggs:aggs,subagentSessions:new Set(),lastTurnSeq:0,
    writeTurnSeq:()=>{},apiAttributeEvent:()=>{}};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('    function freshUsageLedger()'),source.indexOf('    function usageRecordsPayload()'))+
    source.slice(source.indexOf('    function finalizeTurn('),source.indexOf('    // 监听会话事件流')),sandbox);
  try{sandbox.finalizeTurn('session')}catch{}
  assert.equal(failed,true,'the injected failure must execute');
  sandbox.finalizeTurn('session');
  const events=JSON.parse(fs.readFileSync(file)).events;
  assert.deepEqual(events.map(e=>[e.model,e.cost]),[['A',1],['B',2]]);
  assert.equal(aggs.has('session'),false);
});
