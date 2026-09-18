// Regression test for the model-settings menu payload: uses a COPY of the real
// ~/.dsh registry/roles files, so the "settings menu is empty / builtin missing"
// class of bug is caught against the user's actual data shape.
//
// Usage: node tools/models-payload.test.mjs
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-payload-test-'))
process.env.DSH_HOME = HOME
fs.mkdirSync(path.join(HOME, 'whale-roles'), { recursive: true })

// seed with the real registry if present, else a representative fixture
const realRegistry = path.join(os.homedir(), '.dsh', '.dshw-api.json')
if (fs.existsSync(realRegistry)) {
  fs.copyFileSync(realRegistry, path.join(HOME, '.dshw-api.json'))
} else {
  fs.writeFileSync(path.join(HOME, '.dshw-api.json'), JSON.stringify({
    version: 1, models: [], usage: {},
    accounts: [{ id: 'deepseek_api_key', name: '默认账号', keyRef: 'DEEPSEEK_API_KEY' }],
    activeAccount: 'deepseek_api_key',
  }, null, 2))
}
const realRoles = path.join(os.homedir(), '.dsh', 'whale-roles', 'roles.json')
if (fs.existsSync(realRoles)) fs.copyFileSync(realRoles, path.join(HOME, 'whale-roles', 'roles.json'))

const mod = await import(new URL('file:///' + path.join(PKG_ROOT, 'lib', 'index.js').replace(/\\/g, '/')))
const routes = new Map()
const ctx = {
  get: () => undefined,
  effect: () => () => {},
  on: () => {},
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  webServer: { register: (r) => { routes.set(r.path, r); return () => {} }, tapIndex: () => () => {} },
  credentials: { async resolve() { return undefined }, async set() {}, async unset() {} },
  connection: { requestRejection: () => undefined },
}
mod.default.apply(ctx)

function call(routePath, method, body) {
  const route = routes.get(routePath)
  if (!route) throw new Error('route not registered: ' + routePath)
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = routePath
    req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
    req.destroy = () => {}
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
      req.emit('end')
    })
    const res = {
      statusCode: 200,
      writeHead(c) { this.statusCode = c },
      end(t) { try { resolve({ status: this.statusCode, body: JSON.parse(t) }) } catch (e) { reject(e) } },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

let pass = 0, fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')) }
}

console.log('\n[1] /dsh-whale/api-models.json 必须返回可用的内置条目（设置菜单靠它渲染）')
const r = await call('/dsh-whale/api-models.json', 'GET')
check('HTTP 200 且 ok', r.status === 200 && r.body.ok === true, { status: r.status, ok: r.body.ok })
check('返回了 models 数组', Array.isArray(r.body.models), typeof r.body.models)
const builtin = (r.body.models || []).find((m) => m.id === 'deepseek')
check('内置 DeepSeek 条目存在', !!builtin, (r.body.models || []).map((m) => m.id))
check('内置条目标了 builtin=true', builtin && builtin.builtin === true, builtin && builtin.builtin)
check('内置条目带 canAdjustBalance（前端据此显示账号/校正入口）', builtin && builtin.canAdjustBalance === true, builtin && builtin.canAdjustBalance)
check('内置条目带 accounts 列表', builtin && Array.isArray(builtin.accounts), builtin && typeof builtin.accounts)
check('内置条目有 accountId / accountName', builtin && !!builtin.accountId && !!builtin.accountName, builtin && { id: builtin.accountId, name: builtin.accountName })
check('内置条目有 keyRef', builtin && typeof builtin.keyRef === 'string' && builtin.keyRef.length > 0, builtin && builtin.keyRef)
check('顶层 accounts 也下发了', Array.isArray(r.body.accounts), typeof r.body.accounts)
check('模板列表非空（新增模型下拉需要）', Array.isArray(r.body.templates) && r.body.templates.length > 10, r.body.templates && r.body.templates.length)
check('每条模板都带 balance 描述字段', (r.body.templates || []).every((t) => 'balance' in t || t.kind), '模板缺字段')

console.log('\n[2] roles.json 与 appearance 路由（配色入口）')
const rr = await call('/dsh-whale/roles.json', 'GET')
check('roles GET ok', rr.body.ok === true && Array.isArray(rr.body.roles), rr.body && rr.body.ok)
check('roles payload 含 appearance', !!rr.body.appearance, rr.body.appearance)
const ar = await call('/dsh-whale/appearance.json', 'GET')
check('appearance GET ok', ar.body.ok === true, ar.body)
check('appearance 返回 palette', !!ar.body.palette && /^#[0-9a-f]{6}$/.test(ar.body.palette.ui), ar.body.palette)

console.log('\n[3] 用真实 registry 跑一遍不能崩')
check('内置条目错误字段是字符串或 null', builtin && (builtin.error === null || typeof builtin.error === 'string'), builtin && builtin.error)
check('models 里没有 null 条目', (r.body.models || []).every((m) => m && typeof m === 'object'), '有 null')

fs.rmSync(HOME, { recursive: true, force: true })
console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
