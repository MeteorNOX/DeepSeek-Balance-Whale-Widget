import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERSION } from '../runtime/paths.mjs';
import { validateReleaseMetadata,verifyReleaseMetadata } from '../scripts/release-metadata.mjs';

const record=()=>({name:'api-balance-whale',version:VERSION});
const fixture=()=>({plugin:record(),packageMetadata:record(),lock:{...record(),packages:{'':record()}},runtimeVersion:VERSION});
test('public release metadata, runtime and skill identify the same 0.4.1 candidate',()=>{
  assert.equal(VERSION,'0.4.1');assert.equal(verifyReleaseMetadata(),VERSION);
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.name,'api-balance-whale');assert.equal(pkg.codexBuild,'provider-connections-20261005');
  const skill=fs.readFileSync(new URL('../skills/api-balance-whale/SKILL.md',import.meta.url),'utf8');
  assert.ok(skill.includes('# API 余额小鲸鱼 v'+VERSION));
});
test('changing only a manifest or lockfile version fails the package preflight',()=>{
  for(const edit of [x=>x.plugin.version='0.3.0',x=>x.packageMetadata.version='0.3.0',
    x=>x.lock.version='0.3.0',x=>x.lock.packages[''].version='0.3.0',x=>x.plugin.name='another-plugin']) {
    const data=fixture();edit(data);assert.throws(()=>validateReleaseMetadata(data),/metadata mismatch/);
  }
  assert.equal(validateReleaseMetadata(fixture()),VERSION);
});
test('both installers validate package metadata before changing the machine',()=>{
  const win=fs.readFileSync(new URL('../scripts/install-package.ps1',import.meta.url),'utf8');
  const mac=fs.readFileSync(new URL('../scripts/install-macos.mjs',import.meta.url),'utf8');
  assert.ok(win.indexOf('scripts\\check-package.mjs')<win.indexOf('$null = New-Item'));
  assert.ok(mac.indexOf("'check-package.mjs'")<mac.indexOf('const rollbackReceipt = backupMacInstall'));
  assert.ok(mac.includes('version: VERSION'));
  const rollback=fs.readFileSync(new URL('../scripts/rollback-package.ps1',import.meta.url),'utf8');
  assert.ok(rollback.includes('$priorManifest.version -cne $saved.previousVersion'));
  assert.ok(!rollback.includes("'"+VERSION+"'"));
});
