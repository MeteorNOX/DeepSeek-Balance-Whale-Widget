const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawn, spawnSync} = require('node:child_process');
const lockfile = require('proper-lockfile');
const source = fs.readFileSync(path.join(__dirname, '../lib/index.js'), 'utf8');
const accountingUrl = require('node:url').pathToFileURL(path.join(__dirname, '../lib/accounting.mjs')).href;
function segment(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
async function load(dir, extraFs = fs) {
  const accounting = await import(accountingUrl);
  const sandbox = {fs:extraFs,path,process,console,lockfile,DSH_HOME:dir,USAGE_FILE_CANDIDATES:[path.join(dir,'ledger.json')],
    ...accounting,todayKey:()=>accounting.beijingDay(),readUsageSettings:()=>({}),API_BUILTIN_ID:'deepseek',
    ledgerIo:fn=>fn()};
  vm.createContext(sandbox);
  vm.runInContext(segment('    function freshUsageLedger()', '    function usageRecordsPayload()') +
    segment('    function writeUsageSettings(', '    // ===== Codex 本地会话统计') +
    segment('    function recordLedgerUsage(', '    function normalizeUsageMode()'), sandbox);
  return sandbox;
}
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-txn-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'ledger.json'),JSON.stringify({date:new Date().toISOString().slice(0,10),events:[],history:{},accounting:{version:1},custom:'keep'}));
  return dir;
}
if(process.argv[2]==='worker') {
  (async()=>{
    const [dir,kind]=process.argv.slice(3);
    if(kind==='hold') {lockfile.lockSync(path.join(dir,'ledger.json'),{realpath:false,stale:30000});fs.writeFileSync(path.join(dir,'held'),'');setInterval(()=>{},1000);return;}
    const wrapped=Object.create(fs);let first=true;
    wrapped.readFileSync=(...args)=>{
      const data=fs.readFileSync(...args);
      if(first&&args[0]===path.join(dir,'ledger.json')) {
        first=false;fs.writeFileSync(path.join(dir,'ready-'+kind),'');
        const deadline=Date.now()+10000;
        while(!fs.existsSync(path.join(dir,'release'))) {if(Date.now()>deadline)throw Error('barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}
      }
      return data;
    };
    const api=await load(dir,wrapped);
    if(kind==='settings')api.writeUsageSettings({budget:{on:true,amount:17}});
    else if(kind==='balance')api.recordLedgerUsage(10,'CNY','test',Date.now());
    else api.appendUsageEvent({ts:Date.now(),model:kind,cost:0.123456,tokens:7});
  })().catch(e=>{console.error(e.message);process.exitCode=1});
} else {
  async function waitFile(file) {const deadline=Date.now()+10000;while(!fs.existsSync(file)){if(Date.now()>deadline)throw Error('worker timeout');await new Promise(r=>setTimeout(r,10));}}
  for(const kind of ['settings','balance']) test('LEDGER-MIXED-'+kind+': another writer cannot erase an appended event',async t=>{
    const dir=fixture(t);
    const workers=['event',kind].map(k=>spawn(process.execPath,[__filename,'worker',dir,k],{stdio:['ignore','pipe','pipe']}));
    const completed=workers.map(c=>new Promise((resolve,reject)=>{let err='';c.stderr.on('data',x=>err+=x);c.on('error',reject);c.on('exit',n=>n===0?resolve():reject(Error(err)));}));
    const deadline=Date.now()+10000;
    while(!['event',kind].some(k=>fs.existsSync(path.join(dir,'ready-'+k)))) {
      if(Date.now()>deadline)throw Error('read barrier timeout');
      await new Promise(r=>setTimeout(r,10));
    }
    // Either writer can acquire the transaction first; do not require both reads.
    await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(dir,'release'),'');
    await Promise.all(completed);
    const result=JSON.parse(fs.readFileSync(path.join(dir,'ledger.json')));
    assert.equal(result.custom,'keep');assert.equal(result.events.length,1);
    if(kind==='settings')assert.equal(result.settings?.budget?.amount,17);
    else assert.ok(result.accounting.books&&Object.keys(result.accounting.books).length>0);
  });
  test('LEDGER-STALE: recover a crashed owner without changing ledger format',async t=>{
    const dir=fixture(t), ledger=path.join(dir,'ledger.json');
    const child=spawn(process.execPath,[__filename,'worker',dir,'hold'],{stdio:'ignore'});
    await waitFile(path.join(dir,'held'));child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));
    const old=new Date(Date.now()-60000);fs.utimesSync(ledger+'.lock',old,old);
    const api=await load(dir);api.appendUsageEvent({ts:Date.now(),model:'after-crash',cost:1,tokens:1});
    assert.equal(JSON.parse(fs.readFileSync(ledger)).events.length,1);
    assert.equal(fs.existsSync(ledger+'.lock'),false,'stale lock is recovered and released');
  });
  test('LEDGER-LIVE-LOCK: fail visibly without overwriting a live transaction',async t=>{
    const dir=fixture(t),ledger=path.join(dir,'ledger.json'),before=fs.readFileSync(ledger,'utf8');
    fs.writeFileSync(path.join(dir,'release'),'');
    const release=lockfile.lockSync(ledger,{realpath:false,stale:30000});
    try {
      const result=spawnSync(process.execPath,[__filename,'worker',dir,'event'],{encoding:'utf8',timeout:8000});
      assert.equal(result.error,undefined,'contention must finish within bounded wait');
      assert.notEqual(result.status,0,'live lock must not be ignored');
      assert.equal(fs.readFileSync(ledger,'utf8'),before);
    } finally { release(); }
    const api=await load(dir);api.appendUsageEvent({ts:Date.now(),model:'after-release',cost:1,tokens:1});
    assert.equal(JSON.parse(fs.readFileSync(ledger)).events.length,1);
  });
  test('LEDGER-EXCEPTION: release the lock after a failed save',async t=>{
    const dir=fixture(t), wrapped=Object.create(fs);wrapped.writeFileSync=()=>{const e=Error('test disk failure');e.code='EIO';throw e};
    const api=await load(dir,wrapped);try{api.appendUsageEvent({model:'fail',cost:1})}catch{}
    assert.equal(fs.existsSync(path.join(dir,'ledger.json.lock')),false);
    const retry=await load(dir);retry.appendUsageEvent({ts:Date.now(),model:'retry',cost:1,tokens:1});
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'ledger.json'))).events[0].model,'retry');
  });
}
