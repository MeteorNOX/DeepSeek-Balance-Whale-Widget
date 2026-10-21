import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// Exercise the host's actual lifecycle functions without spawning a desktop window.
const source = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const stateStart = source.indexOf('    const windowState = ')
assert.notEqual(stateStart, -1)
const stateSource = source.slice(stateStart, source.indexOf('    ;(() =>', stateStart))
const names = ['standaloneAlive', 'powershellPath', 'windowArchitectureSupported', 'windowSupported',
  'webOrigin', 'windowPageUrl', 'windowStatus', 'launchStandaloneWindow', 'closeStandaloneWindow']
const functions = names.map(name => {
  const match = source.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n    \\}'))
  assert.ok(match, name + ' must be present')
  return match[0]
}).join('\n')
const startupStart = source.indexOf('    // 独立窗口是"常驻开关"')
const startupEnd = source.indexOf('    disposers.push(registerRoute({', startupStart)
assert.ok(startupStart > 0 && startupEnd > startupStart)
const startupSource = source.slice(startupStart, startupEnd)

function fixture() {
  let now = 100000
  let sequence = 0
  const timers = new Map()
  const children = []
  const kills = []
  let cleanup
  const sandbox = {
    process: { platform: 'win32', arch: 'x64', pid: 42, env: { PROCESSOR_ARCHITECTURE: 'AMD64' } },
    Date: class extends Date { static now() { return now } },
    URL, path,
    fs: { existsSync: () => true, mkdirSync() {}, readFileSync: () => JSON.stringify(sandbox.command) },
    ctx: { webServer: { host: '127.0.0.1', port: 19387 }, effect(fn) { cleanup = fn() } },
    WINDOW_SCRIPT: 'fixture/whale-window.ps1', WINDOW_TITLE: 'Whale fixture',
    WINDOW_CMD_FILE: 'fixture/command.json', WINDOW_STATE_FILE: 'fixture/state.json',
    WINDOW_PROFILE_DIR: 'fixture/profile', WINDOW_LOG_FILE: 'fixture/window.log',
    readWindowStateFile: () => sandbox.heartbeat,
    writeWindowConfig() {}, writeWindowCmd(cmd) { sandbox.command = cmd }, mintBrowserSessionCookie: () => 'fixture=session',
    command: {},
    heartbeat: null,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { at: now + delay, fn }); return id },
    clearTimeout(id) { timers.delete(id) },
    spawn() {
      const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, exitCode: null, signalCode: null })
      children.push(child)
      return child
    },
    killProcessTree(child) { kills.push(child) },
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(stateSource + '\n' + functions, context)
  const run = code => vm.runInContext(code, context)
  const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve() }
  return {
    sandbox, children, kills, run,
    open() { run('windowState.enabled = true'); return context.launchStandaloneWindow() },
    close: () => context.closeStandaloneWindow(),
    armStartup() { run('windowState.enabled = true'); run(startupSource) },
    dispose: () => cleanup(),
    exit(child) { child.exitCode = 0; child.emit('close', 0) },
    async advance(milliseconds) {
      const target = now + milliseconds
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at
        timers.delete(next[0])
        next[1].fn()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

{
  const f = fixture()
  f.armStartup()
  f.dispose()
  await f.advance(2000)
  assert.equal(f.children.length, 0, 'unloading cancels delayed startup')
  assert.equal((await f.open()).error, 'WINDOW_OPEN_CANCELLED')
}
{
  const old = fixture()
  old.armStartup()
  await old.open()
  const heartbeat = { alive: true, ts: 100000, page: 'ready' }
  old.sandbox.heartbeat = heartbeat
  old.dispose()
  const restored = fixture()
  restored.sandbox.heartbeat = heartbeat
  restored.sandbox.command = old.sandbox.command
  restored.armStartup()
  await restored.advance(1500)
  assert.equal(restored.children.length, 0, 'reload waits for the old closing window')
  heartbeat.alive = false
  old.exit(old.children[0])
  await restored.advance(50)
  assert.equal(restored.children.length, 1, 'reload restores after the previous instance exits')
}
{
  const f = fixture()
  assert.equal((await f.open()).ok, true)
  const old = f.children[0]
  f.sandbox.heartbeat = { alive: true, ts: 100000, page: 'ready' }
  f.close()
  let settled = false
  const reopen = f.open().then(result => { settled = true; return result })
  await f.advance(500)
  assert.equal(settled, false, 'reopen waits for the previous process')
  assert.equal(f.children.length, 1)
  f.exit(old)
  await f.advance(50)
  assert.equal((await reopen).ok, true)
  assert.equal(f.children.length, 2, 'stale heartbeat cannot suppress a requested reopen')
  assert.equal(f.run('windowState.enabled'), true, 'old exit preserves the new open request')
  assert.equal(f.run('windowState.child.pid'), f.children[1].pid)
}
for (const action of ['close', 'dispose']) {
  const f = fixture()
  f.armStartup()
  await f.open()
  f.close()
  const reopen = f.open()
  f[action]()
  f.exit(f.children[0])
  await f.advance(50)
  assert.equal((await reopen).error, 'WINDOW_OPEN_CANCELLED', action + ' cancels a pending reopen')
  assert.equal(f.children.length, 1)
}
{
  const f = fixture()
  await f.open()
  f.sandbox.heartbeat = { alive: true, ts: 100000, page: 'ready' }
  f.exit(f.children[0])
  assert.equal(f.run('standaloneAlive()'), false, 'exited child invalidates its last heartbeat')
  assert.equal((await f.open()).ok, true)
  assert.equal(f.children.length, 2, 'unexpected exit permits immediate reopen')
}
{
  const f = fixture()
  await f.open()
  f.close()
  const reopen = f.open()
  await f.advance(8000)
  assert.equal(f.kills.length, 1, 'unresponsive child is terminated once')
  assert.equal((await reopen).error, 'WINDOW_CLOSE_TIMEOUT')
  assert.equal((await f.open()).error, 'WINDOW_CLOSE_TIMEOUT')
  assert.equal(f.children.length, 1, 'timeout cannot create an overlapping window')
  f.exit(f.children[0])
  assert.equal((await f.open()).ok, true, 'reopen resumes after the timed-out child actually exits')
  assert.equal(f.children.length, 2)
}
{
  const f = fixture()
  f.sandbox.heartbeat = { alive: true, ts: 100000, page: 'ready' }
  assert.equal((await f.open()).already, true)
  f.close()
  const reopen = f.open()
  await f.advance(100)
  assert.equal(f.children.length, 0, 'reloaded host waits for the previously tracked window')
  f.sandbox.heartbeat.alive = false
  await f.advance(50)
  assert.equal((await reopen).ok, true)
  assert.equal(f.children.length, 1)
}
{
  const f = fixture()
  for (const [host, expected] of [
    ['::1', 'http://[::1]:19387'], ['[::1]', 'http://[::1]:19387'],
    ['localhost', 'http://localhost:19387'], ['0.0.0.0', 'http://127.0.0.1:19387'],
    ['::', 'http://127.0.0.1:19387'],
  ]) {
    f.sandbox.ctx.webServer.host = host
    assert.equal(f.run('webOrigin()'), expected)
  }
  f.sandbox.process.env.DSH_WEB_URL = 'https://localhost:443/'
  assert.equal(f.run('webOrigin()'), 'https://localhost:443')
}
{
  const f = fixture()
  assert.equal(f.run('windowSupported()'), true)
  f.sandbox.process.arch = 'ia32'
  assert.equal(f.run('windowSupported()'), false)
  f.sandbox.process.arch = 'x64'
  f.sandbox.process.env.PROCESSOR_ARCHITEW6432 = 'ARM64'
  assert.equal(f.run('windowSupported()'), false, 'x64 process on ARM64 does not select a native ARM64 PowerShell with x64 loader')
  delete f.sandbox.process.env.PROCESSOR_ARCHITEW6432
  f.sandbox.process.platform = 'linux'
  assert.equal(f.run('windowSupported()'), false)
}
console.log('PASS: standalone startup/disposal, serialized reopen, close timeout, IPv6 and architecture selection')
