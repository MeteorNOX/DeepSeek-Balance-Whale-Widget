import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { createRoleLinesStore, emptyRoleLines, ROLE_LINES_MAX_BYTES } from '../lib/role-lines.mjs'

// All plugin persistence and gallery fixtures stay inside this disposable home.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-role-lines-test-'))
const pluginHome = path.join(scratch, 'dsh-home')
const originalEnv = Object.fromEntries(['DSH_HOME', 'DSHW_ADMIN_HOSTS', 'DSHW_TRUSTED_HOSTS']
  .map((key) => [key, process.env[key]]))
const routes = new Map(), effects = []
let fence = { requestRejection: () => null }, checks = 0
const jsonFile = path.join(pluginHome, '.dshw-role-lines.json')
const rolesDir = path.join(pluginHome, 'whale-roles')
const roleIndexFile = path.join(rolesDir, 'roles.json')
const customId = 'role_test'
const noop = () => {}

function resetGallery() {
  fs.mkdirSync(rolesDir, { recursive: true })
  fs.writeFileSync(roleIndexFile, JSON.stringify({ version: 1, roles: [
    { id: 'default', name: '小鲸鱼', createdAt: 0 },
    { id: customId, name: '测试角色', format: 'png', createdAt: 1 },
  ] }))
  fs.writeFileSync(path.join(rolesDir, customId + '.png'), Buffer.from('fixture-image'))
}

async function request(routePath, method = 'GET', input, headers = {}) {
  const body = typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input)
  const req = Readable.from([Buffer.from(body)])
  req.method = method
  req.url = routePath
  req.headers = { host: 'localhost:3000', ...headers }
  const res = {
    statusCode: 200, headers: {}, body: '',
    writeHead(status, responseHeaders) { this.statusCode = status; this.headers = responseHeaders },
    end(value) { this.body = value === undefined ? '' : String(value) },
  }
  const route = routes.get(routePath)
  assert.ok(route, 'actual plugin route must be registered: ' + routePath)
  await route.handler(req, res)
  req.destroy()
  return { status: res.statusCode, headers: res.headers, data: res.body ? JSON.parse(res.body) : null }
}

function config(roles, enabled = true) {
  return { version: 1, enabled, updatedAt: 0, roles }
}

async function check(label, fn) {
  await fn()
  checks += 1
  console.log('PASS ' + label)
}

try {
  process.env.DSH_HOME = pluginHome
  process.env.DSHW_ADMIN_HOSTS = 'admin.example'
  process.env.DSHW_TRUSTED_HOSTS = 'trusted.example'
  resetGallery()
  const plugin = (await import(pathToFileURL(path.resolve('lib/index.js')).href)).default
  const ctx = {
    get(name) { return name === 'connection' ? fence : null },
    on: () => noop,
    effect(callback) { effects.push(callback()) },
    credentials: { resolve: async () => null },
    webServer: {
      register(route) { routes.set(route.path, route); return noop },
      tapIndex: () => noop,
    },
  }
  const root = { ...ctx, inject(names, callback) { callback(ctx) } }
  plugin.apply(root)

  await check('missing file returns disabled empty table without creating it', async () => {
    const result = await request('/dsh-whale/role-lines.json')
    assert.equal(result.status, 200)
    assert.deepEqual(result.data, { ok: true, ...emptyRoleLines() })
    assert.equal(fs.existsSync(jsonFile), false)
  })

  const metadata = config({
    default: { name: '默认角色', persona: { tone: 'calm' }, refs: ['a'], lines: [
      { text: '测试句子', source: 'fixture', ref: { page: 1 }, pick: 3, custom: { tags: ['x'] } },
    ] },
    [customId]: { name: '角色', persona: '测试设定', refs: [{ url: 'https://example.test' }], lines: [
      { text: '🙂'.repeat(200), source: { kind: 'test' }, ref: ['r'], pick: 0.5 },
    ] },
  })
  await check('PUT, GET and a fresh store preserve Unicode and all JSON metadata', async () => {
    const saved = await request('/dsh-whale/role-lines.json', 'PUT', metadata)
    assert.equal(saved.status, 200)
    assert.equal(saved.data.ok, true)
    assert.ok(saved.data.updatedAt > 0)
    assert.deepEqual(saved.data.roles, metadata.roles)
    assert.deepEqual((await request('/dsh-whale/role-lines.json')).data, saved.data)
    assert.deepEqual(createRoleLinesStore(jsonFile).read(), { ...metadata, updatedAt: saved.data.updatedAt })
    assert.equal(fs.readdirSync(pluginHome).some((file) => file.endsWith('.tmp')), false)
  })

  await check('invalid dictionaries, ids, limits and text cannot overwrite existing data', async () => {
    const before = fs.readFileSync(jsonFile, 'utf8')
    const invalid = [
      null,
      { ...metadata, version: 2 },
      { ...metadata, enabled: 'true' },
      { ...metadata, updatedAt: -1 },
      { ...metadata, updatedAt: 1.5 },
      { ...metadata, roles: [] },
      config({ default: [] }),
      config({ default: { lines: ['string'] } }),
      config({ default: { lines: [{ text: ' \n\t' }] } }),
      config({ default: { lines: [{ text: '🙂'.repeat(201) }] } }),
      config({ default: { lines: Array.from({ length: 501 }, () => ({ text: 'x' })) } }),
      config({ missing_role: { lines: [{ text: 'x' }] } }),
      config({ '../escape': { lines: [] } }),
      config(JSON.parse('{"__proto__":{"lines":[]}}')),
      config({ constructor: { lines: [] } }),
      config(Object.fromEntries(Array.from({ length: 201 }, (_, i) => ['role_' + i, { lines: [] }]))),
      '{invalid-json',
    ]
    for (const input of invalid) {
      const rejected = await request('/dsh-whale/role-lines.json', 'PUT', input)
      assert.equal(rejected.status, 400)
      assert.equal(rejected.data.ok, false)
      assert.equal(fs.readFileSync(jsonFile, 'utf8'), before)
    }
    assert.equal((await request('/dsh-whale/role-lines.json', 'POST', metadata)).status, 405)
  })

  await check('1 MiB request/file budgets produce 413 and retain original content', async () => {
    const before = fs.readFileSync(jsonFile, 'utf8')
    const hugeRequest = await request('/dsh-whale/role-lines.json', 'PUT', ' '.repeat(ROLE_LINES_MAX_BYTES + 1))
    assert.equal(hugeRequest.status, 413)
    assert.equal(fs.readFileSync(jsonFile, 'utf8'), before)
    assert.throws(() => createRoleLinesStore(jsonFile).write(config({
      default: { lines: [], extra: 'x'.repeat(ROLE_LINES_MAX_BYTES) },
    })), (err) => err.statusCode === 413)
    assert.equal(fs.readFileSync(jsonFile, 'utf8'), before)
  })

  await check('atomic write and rename failures retain original bytes and remove temporary files', async () => {
    const before = fs.readFileSync(jsonFile, 'utf8')
    const originalRename = fs.renameSync
    try {
      fs.renameSync = (from, to) => { if (to === jsonFile) throw new Error('simulated rename failure'); return originalRename(from, to) }
      assert.equal((await request('/dsh-whale/role-lines.json', 'PUT', metadata)).status, 500)
      assert.equal(fs.readFileSync(jsonFile, 'utf8'), before)
      assert.equal(fs.readdirSync(pluginHome).some((file) => file.endsWith('.tmp')), false)
    } finally { fs.renameSync = originalRename }
    const originalWrite = fs.writeFileSync
    try {
      fs.writeFileSync = (file, ...args) => { if (String(file).endsWith('.tmp')) throw new Error('simulated write failure'); return originalWrite(file, ...args) }
      assert.equal((await request('/dsh-whale/role-lines.json', 'PUT', metadata)).status, 500)
      assert.equal(fs.readFileSync(jsonFile, 'utf8'), before)
    } finally { fs.writeFileSync = originalWrite }
  })

  await check('empty/disabled documents persist and bad disk data is reported without being overwritten', async () => {
    for (const document of [emptyRoleLines(), config({ default: { lines: [] } }, false)]) {
      assert.equal((await request('/dsh-whale/role-lines.json', 'PUT', document)).status, 200)
      const loaded = (await request('/dsh-whale/role-lines.json')).data
      assert.equal(loaded.enabled, false)
      assert.deepEqual(loaded.roles, document.roles)
    }
    for (const invalidFile of ['{bad-json', JSON.stringify({ version: 2 }), ' '.repeat(ROLE_LINES_MAX_BYTES + 1)]) {
      fs.writeFileSync(jsonFile, invalidFile)
      const loaded = await request('/dsh-whale/role-lines.json')
      assert.notEqual(loaded.status, 200)
      assert.equal(loaded.data.ok, false)
      assert.ok(loaded.data.error)
      assert.deepEqual(createRoleLinesStore(jsonFile).read(), emptyRoleLines())
      assert.equal(fs.readFileSync(jsonFile, 'utf8'), invalidFile)
    }
    await request('/dsh-whale/role-lines.json', 'PUT', metadata)
    const before = fs.readFileSync(jsonFile, 'utf8')
    const originalRead = fs.readFileSync
    try {
      fs.readFileSync = (file, ...args) => {
        if (file === jsonFile) {
          const error = new Error('simulated permission failure')
          error.code = 'EACCES'
          throw error
        }
        return originalRead(file, ...args)
      }
      const loaded = await request('/dsh-whale/role-lines.json')
      assert.equal(loaded.status, 500)
      assert.equal(loaded.data.ok, false)
      assert.match(loaded.data.error, /permission failure/)
    } finally { fs.readFileSync = originalRead }
    assert.equal(fs.readFileSync(jsonFile, 'utf8'), before)
  })

  await check('common trust fence rejects forged Host, cross-site, mismatched Origin, auth failure and exceptions', async () => {
    const before = fs.readFileSync(jsonFile, 'utf8')
    for (const headers of [{ host: '' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'http://evil.example' }]) {
      assert.equal((await request('/dsh-whale/role-lines.json', 'PUT', metadata, headers)).status, 403)
    }
    fence = { requestRejection: () => 401 }
    assert.equal((await request('/dsh-whale/role-lines.json')).status, 401)
    fence = { requestRejection: () => { throw new Error('fixture fence failure') } }
    assert.equal((await request('/dsh-whale/role-lines.json')).status, 403)
    fence = null
    assert.equal((await request('/dsh-whale/role-lines.json', 'GET', undefined, { host: '127.0.0.1.evil.example' })).status, 403)
    assert.equal((await request('/dsh-whale/role-lines.json')).status, 200)
    fence = { requestRejection: () => null }
    assert.equal(fs.readFileSync(jsonFile, 'utf8'), before)
  })

  await check('remote reads remain supported but remote PUT is denied even for an administrator host', async () => {
    const before = fs.readFileSync(jsonFile, 'utf8')
    for (const host of ['remote.example', 'admin.example']) {
      assert.equal((await request('/dsh-whale/role-lines.json', 'GET', undefined, { host })).status, 200)
      assert.equal((await request('/dsh-whale/role-lines.json', 'PUT', metadata, { host })).status, 403)
    }
    assert.equal(fs.readFileSync(jsonFile, 'utf8'), before)
  })

  await check('pool cleanup failures abort role deletion and retain the gallery identity', async () => {
    const before = fs.readFileSync(jsonFile, 'utf8')
    const originalRename = fs.renameSync
    try {
      fs.renameSync = (from, to) => { if (to === jsonFile) throw new Error('simulated cleanup failure'); return originalRename(from, to) }
      const deleted = await request('/dsh-whale/role-delete.json', 'POST', { id: customId })
      assert.notEqual(deleted.status, 200)
      assert.match(deleted.data.error, /cleanup failure/)
      assert.ok(JSON.parse(fs.readFileSync(roleIndexFile)).roles.some((role) => role.id === customId))
      assert.equal(fs.readFileSync(jsonFile, 'utf8'), before)
      assert.equal(fs.existsSync(path.join(rolesDir, customId + '.png')), true)
    } finally { fs.renameSync = originalRename }
    fs.writeFileSync(jsonFile, '{bad-json')
    assert.notEqual((await request('/dsh-whale/role-delete.json', 'POST', { id: customId })).status, 200)
    assert.ok(JSON.parse(fs.readFileSync(roleIndexFile)).roles.some((role) => role.id === customId))
    await request('/dsh-whale/role-lines.json', 'PUT', metadata)
  })

  await check('gallery index failure restores the previous role pools', async () => {
    const before = fs.readFileSync(jsonFile, 'utf8')
    const originalWrite = fs.writeFileSync
    try {
      fs.writeFileSync = (file, ...args) => { if (file === roleIndexFile) throw new Error('simulated index failure'); return originalWrite(file, ...args) }
      const deleted = await request('/dsh-whale/role-delete.json', 'POST', { id: customId })
      assert.notEqual(deleted.status, 200)
      assert.match(deleted.data.error, /index save failed/)
      assert.equal(fs.readFileSync(jsonFile, 'utf8'), before)
      assert.ok(JSON.parse(fs.readFileSync(roleIndexFile)).roles.some((role) => role.id === customId))
    } finally { fs.writeFileSync = originalWrite }
  })

  await check('successful gallery deletion removes only that pool and allows the next save', async () => {
    assert.equal((await request('/dsh-whale/role-delete.json', 'POST', { id: 'default' })).status, 400)
    assert.equal((await request('/dsh-whale/role-delete.json', 'POST', { id: customId })).status, 200)
    const saved = (await request('/dsh-whale/role-lines.json')).data
    assert.equal(Object.hasOwn(saved.roles, customId), false)
    assert.deepEqual(saved.roles.default, metadata.roles.default)
    assert.equal(fs.existsSync(path.join(rolesDir, customId + '.png')), false)
    const { ok, ...document } = saved
    assert.equal(ok, true)
    assert.equal((await request('/dsh-whale/role-lines.json', 'PUT', document)).status, 200)
  })

  console.log('PASS all ' + checks + ' backend groups (actual registered routes, isolated DSH_HOME)')
} finally {
  for (const dispose of effects.reverse()) dispose?.()
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(scratch, { recursive: true, force: true })
}
