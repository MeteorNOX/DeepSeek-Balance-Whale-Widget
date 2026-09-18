// DeepSeek 多账号（v0.3.3）离线回归测试
//
// 不启动 DSH、不联网、不碰真实配置：用假 ctx 加载真实插件文件，直接调用
// `/dsh-whale/api-models.json` 的真实处理器，覆盖账号增删改查、切换、校验与防呆。
//
// 用法（仓库根目录）：
//   node tools/account-switch.test.mjs
//
// 说明：凭据服务用内存 Map 假装，DSH_HOME 指向临时目录，因此不会改写
// ~/.dsh/.dshw-api.json，也不会把你的 key 写进 .credentials.yaml。

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(PKG_ROOT, 'lib', 'index.js')
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-acct-test-'))
process.env.DSH_HOME = HOME

const mod = await import(new URL('file:///' + PLUGIN.replace(/\\/g, '/')))
const routes = new Map()
const creds = new Map()

const ctx = {
  get: () => undefined,
  effect: () => () => {},
  on: () => {},
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  webServer: {
    register: (route) => { routes.set(route.path, route); return () => {} },
    tapIndex: () => () => {},
  },
  credentials: {
    async resolve(ref) {
      const v = creds.get(String(ref))
      return v ? { value: v, source: 'test' } : undefined
    },
    async set(ref, value) { creds.set(String(ref), String(value)) },
    async unset(ref) { creds.delete(String(ref)) },
  },
  connection: { requestRejection: () => undefined },
}

mod.default.apply(ctx)

function fakeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = '/dsh-whale/api-models.json'
  req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
  req.destroy = () => {}
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

function call(method, body) {
  const route = routes.get('/dsh-whale/api-models.json')
  if (!route) throw new Error('route /dsh-whale/api-models.json 未注册')
  return new Promise((resolve, reject) => {
    const req = fakeReq(method, body)
    const res = {
      statusCode: 200,
      writeHead(code) { this.statusCode = code },
      end(text) {
        try { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }) }
        catch (e) { reject(e) }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')) }
}
const builtin = (payload) => payload.models.find((m) => m.id === 'deepseek')
const registryPath = path.join(HOME, '.dshw-api.json')

console.log('\n[1] 初始状态：未配置任何 key')
let r = await call('GET')
check('GET ok', r.status === 200 && r.body.ok === true, r.body)
check('内置条目存在', !!builtin(r.body))
check('默认账号（legacy）', builtin(r.body).accountName === '默认账号', builtin(r.body).accountName)
check('默认凭据名 DEEPSEEK_API_KEY', builtin(r.body).keyRef === 'DEEPSEEK_API_KEY', builtin(r.body).keyRef)
check('没有 key 时报未配置', !!builtin(r.body).error, builtin(r.body).error)
check('accounts 下发 1 条', r.body.accounts.length === 1, r.body.accounts)

console.log('\n[2] 新增「同事A」账号（别人给的 key 走新凭据名）')
r = await call('POST', { action: 'save-account', account: { name: '同事A', keyRef: 'DEEPSEEK_KEY_A', keyValue: 'sk-aaaa' } })
check('save-account 成功', r.body.ok === true, r.body)
check('返回新账号 id', r.body.id === 'deepseek_key_a', r.body.id)
check('密钥写入凭据服务', creds.get('DEEPSEEK_KEY_A') === 'sk-aaaa', [...creds.keys()])
check('accounts 变 2 条', r.body.accounts.length === 2, r.body.accounts)

console.log('\n[3] 切到「同事A」')
r = await call('POST', { action: 'set-account', accountId: 'deepseek_key_a' })
check('set-account 成功', r.body.ok === true, r.body)
check('当前账号=同事A', builtin(r.body).accountName === '同事A', builtin(r.body).accountName)
check('内置 keyRef=新凭据名', builtin(r.body).keyRef === 'DEEPSEEK_KEY_A', builtin(r.body).keyRef)
check('active 标记唯一', r.body.accounts.filter((a) => a.active).length === 1, r.body.accounts)

const reg1 = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
check('注册表落盘 activeAccount', reg1.activeAccount === 'deepseek_key_a', reg1.activeAccount)
check('注册表含 2 个账号', reg1.accounts.length === 2, reg1.accounts)
check('注册表不含密钥明文', !JSON.stringify(reg1).includes('sk-aaaa'), 'LEAK!')

console.log('\n[4] 校验：坏凭据名 / 重名 / 空名')
r = await call('POST', { action: 'save-account', account: { name: 'x', keyRef: '2bad-name' } })
check('拒绝非法凭据名', r.body.ok === false && /凭据名/.test(r.body.error), r.body)
r = await call('POST', { action: 'save-account', account: { name: 'x', keyRef: 'DEEPSEEK_KEY_A' } })
check('拒绝重复凭据名', r.body.ok === false && /已存在/.test(r.body.error), r.body)
r = await call('POST', { action: 'save-account', account: { name: '', keyRef: 'DEEPSEEK_KEY_Z' } })
check('拒绝空账号名', r.body.ok === false && /名称/.test(r.body.error), r.body)

console.log('\n[5] 改名')
r = await call('POST', { action: 'save-account', account: { id: 'deepseek_key_a', name: '同事A（备用）', keyRef: 'DEEPSEEK_KEY_A' } })
check('改名成功', r.body.ok === true, r.body)
check('名字已更新', builtin(r.body).accountName === '同事A（备用）', builtin(r.body).accountName)

console.log('\n[6] 删除保护')
r = await call('POST', { action: 'delete-account', id: 'nope' })
check('删除不存在的账号被拒', r.body.ok === false, r.body)

console.log('\n[7] 回切默认账号 + 删除同事A')
r = await call('POST', { action: 'set-account', accountId: 'deepseek_api_key' })
check('回切默认账号', builtin(r.body).accountName === '默认账号', builtin(r.body).accountName)
r = await call('POST', { action: 'delete-account', id: 'deepseek_key_a' })
check('删除成功', r.body.ok === true, r.body)
check('凭据被保留（不误删密钥）', creds.get('DEEPSEEK_KEY_A') === 'sk-aaaa', [...creds.keys()])
check('剩 1 个账号', r.body.accounts.length === 1, r.body.accounts)
r = await call('POST', { action: 'delete-account', id: 'deepseek_api_key' })
check('最后一个账号不可删', r.body.ok === false && /至少保留/.test(r.body.error), r.body)

console.log('\n[8] 旧的隐式默认账号会被实体化')
creds.set('DEEPSEEK_API_KEY', 'sk-own')
fs.rmSync(registryPath, { force: true })
r = await call('GET')
check('无注册表时回退 legacy 账号', builtin(r.body).accountName === '默认账号', builtin(r.body).accountName)
r = await call('POST', { action: 'save-account', account: { name: '同事B', keyRef: 'DEEPSEEK_KEY_B', keyValue: 'sk-bbbb' } })
check('legacy 账号被实体化', r.body.accounts.length === 2, r.body.accounts)
check('legacy 账号仍在列表', r.body.accounts.some((a) => a.keyRef === 'DEEPSEEK_API_KEY'), r.body.accounts)

console.log('\n[9] 异常输入不炸路由')
r = await call('POST', { action: 'set-account' })
check('缺 accountId 被拒', r.body.ok === false, r.body)
r = await call('POST', { action: 'delete-account' })
check('缺 id 被拒', r.body.ok === false, r.body)
r = await call('POST', { action: 'save-account', account: { name: 'a'.repeat(200), keyRef: 'K'.repeat(10), keyValue: 'x' } })
check('超长名称被截断且不报错', r.body.ok === true, r.body)

console.log('\n[10] 关键防呆：切到「没有 key 的账号」时绝不能拿自己的 key 冒充')
creds.clear()
creds.set('DEEPSEEK_API_KEY', 'sk-own-key')
fs.rmSync(registryPath, { force: true })
r = await call('POST', { action: 'save-account', account: { name: '同事C', keyRef: 'DEEPSEEK_KEY_C' } })
check('建号成功（不带 key）', r.body.ok === true, r.body)
r = await call('POST', { action: 'set-account', accountId: 'deepseek_key_c' })
check('切到同事C', builtin(r.body).accountId === 'deepseek_key_c', builtin(r.body).accountId)
check('自带未配置错误，不回落自己的 key', /未配置 DEEPSEEK_KEY_C/.test(String(builtin(r.body).error)), builtin(r.body).error)
check('余额为空（没有显示自己的余额）', builtin(r.body).balance === null, builtin(r.body).balance)

console.log('\n[11] 默认账号仍兼容旧写法（DEEPSEEK_API_KEY 就是它自己的 ref）')
r = await call('POST', { action: 'set-account', accountId: 'deepseek_api_key' })
check('回默认账号', builtin(r.body).keyRef === 'DEEPSEEK_API_KEY', builtin(r.body).keyRef)
check('默认账号读到了 key（hasKey=true）', builtin(r.body).hasKey === true, builtin(r.body).hasKey)
check('不再报「未配置」', !/未配置/.test(String(builtin(r.body).error)), builtin(r.body).error)

fs.rmSync(HOME, { recursive: true, force: true })
console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
