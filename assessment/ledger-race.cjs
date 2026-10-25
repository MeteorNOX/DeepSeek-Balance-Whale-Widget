const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {spawn, spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const sourcePath = path.resolve(__dirname, '../lib/index.js');
if (process.argv[2] === 'worker') {
  const [dir, id] = process.argv.slice(3);
  const ledger = path.join(dir, 'ledger.json');
  let first = true;
  const wrapped = Object.create(fs);
  wrapped.readFileSync = (...args) => {
    const result = fs.readFileSync(...args);
    if (first && !process.env.SKIP_BARRIER && args[0] === ledger) {
      first = false;
      fs.writeFileSync(path.join(dir, 'ready-' + id), '');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(path.join(dir, 'release'))) {
        if (Date.now() > deadline) throw Error('barrier timeout');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    return result;
  };
  const source = fs.readFileSync(sourcePath, 'utf8');
  const helpers = source.slice(source.indexOf('    function freshUsageLedger()'), source.indexOf('    function usageRecordsPayload()'));
  const dateKey = ts => new Date(ts).toISOString().slice(0,10);
  const sandbox = {fs:wrapped,path,process,console,USAGE_FILE_CANDIDATES:[ledger],DSH_HOME:dir,
    lockfile:require('proper-lockfile'),ledgerIo:fn=>fn(),todayKey:()=>dateKey(Date.now()),beijingDay:dateKey,
    dayOffset:(day,n)=>dateKey(Date.parse(day)+n*86400000),preciseMoney:x=>x};
  vm.createContext(sandbox);
  vm.runInContext(helpers + '\nappendUsageEvent({ts:Date.now(),model:' + JSON.stringify(id) + ',cost:1,tokens:10})',sandbox);
} else {
  (async()=>{
    const dir=fs.mkdtempSync('/tmp/whale-ledger-race-');
    fs.writeFileSync(path.join(dir,'ledger.json'),JSON.stringify({date:new Date().toISOString().slice(0,10),events:[],history:{},accounting:{version:1}}));
    for (const id of ['sequential-A','sequential-B']) {
      const result = spawnSync(process.execPath,[__filename,'worker',dir,id],{env:{...process.env,SKIP_BARRIER:'1'},stdio:'inherit'});
      assert.equal(result.status,0);
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'ledger.json'))).events.length,2);
    console.log('LEDGER-SEQUENTIAL-01: PASS, both events retained');
    fs.writeFileSync(path.join(dir,'ledger.json'),JSON.stringify({date:new Date().toISOString().slice(0,10),events:[],history:{},accounting:{version:1},customSetting:'preserve'}));
    const children=['A','B'].map(id=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[__filename,'worker',dir,id],{stdio:'inherit'});
      child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('worker exit '+code)));
    }));
    const deadline=Date.now()+10000;
    while(!['A','B'].some(id=>fs.existsSync(path.join(dir,'ready-'+id)))) {
      if(Date.now()>deadline)throw Error('read barrier timeout');
      await new Promise(r=>setTimeout(r,10));
    }
    // A transaction lock may correctly serialize the second reader. Release the
    // first after a bounded overlap window instead of requiring both to read.
    await new Promise(r=>setTimeout(r,200));
    fs.writeFileSync(path.join(dir,'release'),'');
    await Promise.all(children);
    const saved=JSON.parse(fs.readFileSync(path.join(dir,'ledger.json')));
    assert.equal(saved.customSetting,'preserve');
    const events=saved.events;
    console.log('LEDGER-RACE-01: 2 successful writers; retained events:',events.map(e=>e.model));
    assert.equal(events.length,2,'two completed usage events must both survive concurrent writes');
  })().catch(e=>{console.error(e);process.exitCode=1});
}
