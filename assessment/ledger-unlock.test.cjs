const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const os=require('node:os');
const lockfile=require('proper-lockfile');
const {pathToFileURL}=require('node:url');
test('LEDGER-UNLOCK: cleanup failure after commit must not replay a completed turn',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-turn-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'ledger.json');
  fs.writeFileSync(file,JSON.stringify({date:new Date().toISOString().slice(0,10),events:[],history:{},accounting:{version:1}}));
  const source=fs.readFileSync(path.join(__dirname,'../lib/index.js'),'utf8');
  const accounting=await import(pathToFileURL(path.join(__dirname,'../lib/accounting.mjs')).href);
  const wrapped=Object.create(fs);let failed=false;
  const lockFs=Object.create(fs);
  lockFs.rmdirSync=(...args)=>{
    if(!failed){failed=true;const error=Error('sharing violation deleting lock');error.code='EBUSY';throw error;}
    return fs.rmdirSync(...args);
  };
  const locks={lockSync:(file,options)=>lockfile.lockSync(file,{...options,fs:lockFs})};
  const aggs=new Map([['session',{turn:1,cost:3,tokens:30,lastTs:Date.now(),byModel:{A:1,B:2},byModelTokens:{A:10,B:20}}]]);
  const sandbox={fs:wrapped,path,process,console,lockfile:locks,DSH_HOME:dir,USAGE_FILE_CANDIDATES:[file],...accounting,
    ledgerIo:fn=>fn(),todayKey:()=>accounting.beijingDay(),turnAggs:aggs,subagentSessions:new Set(),lastTurnSeq:0,
    writeTurnSeq:()=>{},apiAttributeEvent:()=>{}};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('    function freshUsageLedger()'),source.indexOf('    function usageRecordsPayload()'))+
    source.slice(source.indexOf('    function finalizeTurn('),source.indexOf('    // 监听会话事件流')),sandbox);
  try{sandbox.finalizeTurn('session')}catch{}
  assert.equal(failed,true,'the injected failure must execute');
  if(fs.existsSync(file+'.lock')){const old=new Date(Date.now()-60000);fs.utimesSync(file+'.lock',old,old)}
  sandbox.finalizeTurn('session');
  const events=JSON.parse(fs.readFileSync(file)).events;
  assert.deepEqual(events.map(e=>[e.model,e.cost]),[['A',1],['B',2]]);
  assert.equal(aggs.has('session'),false);
});
