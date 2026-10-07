import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(root, 'scripts/marketplace-helper.mjs');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const releaseVersion = json(path.join(root,'.codex-plugin/plugin.json')).version;
const previousVersion = '0.3.0+codex.previous';
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const setup = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const env = { ...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(dir, 'local'), CODEX_HOME: path.join(home, '.codex'), WHALE_HOME: path.join(dir, 'data') };
  return { dir, home, env, market: path.join(home, '.agents/plugins/marketplace.json') };
};
test('personal marketplace helper preserves unrelated metadata and restores only its own entry', t => {
  const s = setup(t), receipt = path.join(s.dir, 'receipt.json');
  const unrelated = { name: 'another-plugin', source: { source: 'local', path: './plugins/another-plugin' }, custom: ['keep'] };
  const before = { name: 'custom_personal', interface: { displayName: 'Keep This' }, extra: 8, plugins: [unrelated] };
  write(s.market, before);
  let result = spawnSync(process.execPath, [helper, 'install', receipt], { env: s.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const installed = json(s.market); assert.deepEqual(installed.plugins[0], unrelated); assert.equal(installed.extra, 8); assert.equal(installed.interface.displayName, 'Keep This');
  installed.plugins.push({ name: 'added-after-install' }); write(s.market, installed);
  result = spawnSync(process.execPath, [helper, 'restore', receipt], { env: s.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(s.market).plugins, [unrelated, { name: 'added-after-install' }]);
});
test('marketplace rollback refuses a changed whale entry without modifying the file', t => {
  const s = setup(t), receipt = path.join(s.dir, 'receipt.json');
  let result = spawnSync(process.execPath, [helper, 'install', receipt], { env: s.env, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const changed = json(s.market); changed.plugins[0].category = 'Changed'; write(s.market, changed);
  const before = fs.readFileSync(s.market, 'utf8');
  result = spawnSync(process.execPath, [helper, 'restore', receipt], { env: s.env, encoding: 'utf8' }); assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(s.market, 'utf8'), before);
});

for (const scenario of ['fresh', 'upgrade', 'failed-registration', 'fresh-newer-pointer']) {
  test(`isolated Windows package ${scenario} restores code and retains current user data`, { skip: process.platform !== 'win32' }, t => {
    const s = setup(t), source = path.join(s.dir, 'source'), target = path.join(s.home, 'plugins/api-balance-whale');
    for (const name of ['install-package.ps1','rollback-package.ps1','package-common.ps1','marketplace-helper.mjs']) write(path.join(source, 'scripts', name), fs.readFileSync(path.join(root, 'scripts', name), 'utf8'));
    write(path.join(source, '.codex-plugin/plugin.json'), { name: 'api-balance-whale', version: releaseVersion });
    write(path.join(source, 'scripts/install-desktop.mjs'), 'process.stdout.write("mock desktop dependency ready\\n");');
    write(path.join(source, 'scripts/check-package.mjs'), 'process.stdout.write("mock package dependency check\\n");');
    write(path.join(source, 'scripts/verify-runtime.mjs'), 'process.stdout.write("mock runtime check\\n");');
    write(path.join(source, 'scripts/install-follow.ps1'), 'param([string]$DataDir)\n$null=New-Item -ItemType Directory -Path $DataDir -Force\n[IO.File]::WriteAllText((Join-Path $DataDir "mock-follow"),"ready")\n');
    write(path.join(source, 'scripts/uninstall-follow.ps1'), 'param([string]$DataDir)\n');
    const unrelated = { name: 'keep-other', source: { source: 'local', path: './plugins/keep-other' }, category: 'Productivity' };
    const plugins = [unrelated];
    const pointerFile = path.join(s.env.WHALE_HOME, 'package-installation.json');
    const previousPointer = { receipt: path.join(s.dir, 'older-backup', 'installation.json'), version: previousVersion };
    if (scenario === 'upgrade') {
      write(pointerFile, previousPointer);
      write(path.join(target, '.codex-plugin/plugin.json'), { name: 'api-balance-whale', version: previousVersion });
      write(path.join(target, 'old-file.txt'), 'old-source');
      plugins.push({ name: 'api-balance-whale', source: { source: 'local', path: './plugins/api-balance-whale' }, custom: 'restore-this' });
    }
    write(s.market, { name: 'personal', interface: { displayName: 'Keep' }, plugins });
    write(path.join(s.env.WHALE_HOME, 'ledger.json'), { amount: 1 });
    const cli = path.join(s.dir, 'mock-codex.cmd');
    write(cli, '@echo off\r\nnode "%~dp0mock-cli.mjs" %*\r\n');
    write(path.join(s.dir, 'mock-cli.mjs'), `import fs from 'node:fs';import path from 'node:path';const a=process.argv.slice(2);if(a.includes('--help'))process.exit(0);if(a[1]==='remove'&&process.env.WHALE_TEST_HELPER){const helper=path.resolve(process.env.WHALE_TEST_HELPER);if(helper!==path.join(import.meta.dirname,'source','scripts','marketplace-helper.mjs'))throw Error('Unsafe fixture helper');fs.unlinkSync(helper);}if(a[1]==='add'&&process.env.WHALE_TEST_FAIL==='1')process.exit(9);if(a[1]==='list'){const m=JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE,'plugins/api-balance-whale/.codex-plugin/plugin.json')));console.log(JSON.stringify({installed:[{pluginId:'api-balance-whale@personal',version:m.version,installed:true,enabled:true}]}));}else console.log('{}');`);
    const wrapper = path.join(s.dir, 'invoke.ps1');
    write(wrapper, `param([string]$Action,[string]$Source,[string]$Cli,[string]$Receipt)\nfunction Get-ScheduledTask { param($TaskName,$ErrorAction) return $null }\nif($Action -eq 'install'){& (Join-Path $Source 'scripts/install-package.ps1') -Source $Source -CodexCli $Cli}else{& (Join-Path $Source 'scripts/rollback-package.ps1') -Receipt $Receipt}\n`);
    const shell = path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const base = ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper];
    const env = { ...s.env, WHALE_TEST_FAIL: scenario === 'failed-registration' ? '1' : '0' };
    let result = spawnSync(shell, [...base,'-Action','install','-Source',source,'-Cli',cli], { env, encoding: 'utf8', timeout: 30000 });
    if (scenario === 'failed-registration') assert.notEqual(result.status, 0); else assert.equal(result.status, 0, result.stdout + result.stderr);
    const backups = path.join(s.env.LOCALAPPDATA, 'CodexWhale/backups');
    assert.ok(fs.existsSync(backups), result.stdout + result.stderr);
    const receipt = path.join(backups, fs.readdirSync(backups)[0], 'installation.json');
    assert.equal(json(receipt).version,releaseVersion);
    assert.equal(json(path.join(target,'.codex-plugin/plugin.json')).version,releaseVersion);
    assert.equal(json(s.market).plugins[0].name, unrelated.name);
    write(path.join(s.env.WHALE_HOME, 'ledger.json'), { amount: 2 });
    const newerPointer = { receipt: path.join(s.dir, 'newer-backup', 'installation.json'), version: '0.5.0' };
    if (scenario === 'fresh-newer-pointer') write(pointerFile, newerPointer);
    const removedHelper = path.join(source, 'scripts/marketplace-helper.mjs');
    result = spawnSync(shell, [...base,'-Action','rollback','-Source',source,'-Receipt',receipt], { env: { ...s.env, WHALE_TEST_HELPER: removedHelper }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(json(path.join(s.env.WHALE_HOME,'ledger.json')), { amount: 2 });
    if (scenario === 'upgrade') assert.deepEqual(json(pointerFile), previousPointer);
    else if (scenario === 'fresh-newer-pointer') assert.deepEqual(json(pointerFile), newerPointer);
    else assert.equal(fs.existsSync(pointerFile), false);
    if (scenario !== 'failed-registration') assert.equal(fs.existsSync(removedHelper), false, 'fixture removes invoking helper while rollback is running');
    assert.deepEqual(json(s.market).plugins, plugins);
    if(scenario === 'upgrade') { assert.equal(json(path.join(target,'.codex-plugin/plugin.json')).version,previousVersion); assert.equal(fs.readFileSync(path.join(target,'old-file.txt'),'utf8'),'old-source'); }
    else assert.equal(fs.existsSync(target), false);
  });
}
