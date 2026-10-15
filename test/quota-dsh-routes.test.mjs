// 额度链路测试：用假 ctx（webServer / credentials / settings / llm）+ 假 fetch 直接跑宿主插件本体，
// 走真实的 /dsh-whale/api-models.json 路由，断言自定义厂商额度模块的行为。
//
// 覆盖两层：
//   ① 模板层：Command Code GOAT 的 5h / 周 / 月三窗口、used+cap 现算、副请求、Base URL 归一化
//   ② 绑定层（v0.4.0 Provider ID 绑定）：从 DSH 配置发现路由 → 只绑 Provider ID 就能取到凭据名与地址
//
// 运行：node test/quota-dsh-routes.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const HOME = path.join(HERE, '.dsh-home')
process.env.DSH_HOME = HOME

fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })

const KEY = 'user_testkey_1234567890'
const NOW = Date.now()
const r2 = (v) => (v === null || v === undefined ? v : Math.round(Number(v) * 100) / 100)
let pass = 0
function check(name, fn) { fn(); pass++; console.log('ok   ' + name) }

// —— 假响应：字段形状照 commandcode-usage 仓库核实过的官方契约 ——
const CREDITS = {
  credits: { monthlyCredits: 62.5, freeCredits: 0, purchasedCredits: 0, planId: 'individual-goat', belowThreshold: false, creditThreshold: 5 },
  windowLimits: {
    fiveHour: { used: 1.5, cap: 14, exceeded: false, resetAt: NOW + 2 * 3600e3 },
    weekly: { used: 4, cap: 35, exceeded: false, resetAt: NOW + 6 * 86400e3 },
  },
}
const USAGE = { totalCredits: 7.5, totalCount: 18087, successRate: 100 }
const SUBS = { data: { planId: 'individual-goat', status: 'active', currentPeriodStart: '2026-09-18T00:00:00.000Z', currentPeriodEnd: '2026-09-25T17:08:00.000Z' } }
const OPENCODE = { usage: { rolling: { percent: 12.5, resetsAt: NOW + 3600e3 }, weekly: { percent: 40, resetsAt: NOW + 86400e3 }, monthly: { percent: 60, resetsAt: NOW + 86400e3 } } }

const calls = []
const state = {
  keys: { COMMAND_CODE_API_KEY: KEY },
  failUsage: false,
  credits: null,
  services: {}, // 形如 { settings: {...}, llm: {...} }
}
const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
const errRes = (status) => ({ ok: false, status, json: async () => ({}), text: async () => '' })

globalThis.fetch = async (url, opts) => {
  const u = String(url)
  calls.push({ url: u, auth: String(((opts || {}).headers || {}).Authorization || '') })
  const pathOf = u.replace(/^https?:\/\/[^/]+/, '')
  if (/opencode\.ai\/zen\/go\/v1\/usage/.test(u)) return jsonRes(OPENCODE)
  if (state.failUsage && /\/alpha\/usage\/summary/.test(pathOf)) return errRes(500)
  if (/\/alpha\/billing\/credits/.test(pathOf)) return jsonRes(state.credits || CREDITS)
  if (/\/alpha\/usage\/summary/.test(pathOf)) return jsonRes(USAGE)
  if (/\/alpha\/billing\/subscriptions/.test(pathOf)) return jsonRes(SUBS)
  return errRes(404)
}

// 假 settings 服务：describe() 给"已解析的命名空间配置"，get(ns) 给单个命名空间
const SETTINGS_VALUE = {
  providers: {
    'commandcode-goat': {
      displayName: 'commandCode goat',
      apiKeyEnv: 'COMMANDCODE_GOAT_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://api.commandcode.ai/provider/v1',
      models: [{ id: 'deepseek/deepseek-v4.1-flash' }, { id: 'glm-5.2' }],
      apiKey: 'should-never-reach-the-browser',
    },
    'my-cc-proxy': {
      displayName: '我的中转',
      apiKeyEnv: 'MY_CC_KEY',
      baseURL: 'https://proxy.example.com/cc/provider/v1',
      models: [{ id: 'deepseek/deepseek-v4.1-flash' }],
    },
    openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1' },
  },
}
const settingsService = {
  describe: () => [{ ns: 'llm-pi-ai', value: SETTINGS_VALUE }],
  get: (ns) => (ns === 'llm-pi-ai' ? SETTINGS_VALUE : undefined),
}
const llmService = {
  listConfigurableProviders: () => [
    { provider: 'commandcode-goat', displayName: 'commandCode goat', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'commandcode-goat'], declared: true },
    { provider: 'my-cc-proxy', displayName: '我的中转', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my-cc-proxy'], declared: true },
    // 内置 catalog 路由：llm 目录里全都会列出来，但 settings 里并不存在 → 不该进候选列表
    { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], declared: false },
    { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], declared: false },
  ],
}

function setRegistry(models) {
  fs.writeFileSync(path.join(HOME, '.dshw-api.json'), JSON.stringify({ version: 1, models, usage: {} }))
}

// —— 假 root：只实现 apply() 真正用到的那几个服务 ——
// 插件已按上游形态改成 apply(root) + root.inject([...], cb)：这里同步把 cb 跑起来。
const routes = new Map()
const ctx = {
  get: (name) => (name === 'connection' ? ctx.connection
    : name === 'webServer' ? ctx.webServer
      : name === 'credentials' ? ctx.credentials
        : state.services[name]),
  inject: (names, cb) => { cb(ctx); return () => {} },
  connection: { requestRejection: () => false },
  credentials: {
    resolve: async (ref) => (state.keys[String(ref)] ? { value: state.keys[String(ref)], source: 'file' } : undefined),
    describe: async (ref) => (state.keys[String(ref)]
      ? { configured: true, source: 'file', writable: true }
      : { configured: false, writable: true }),
    set: async () => {}, unset: async () => {},
  },
  webServer: {
    register: (route) => { routes.set(route.path, route); return () => {} },
    tapIndex: () => () => {},
  },
  on: () => () => {},
  effect: (fn) => { try { return fn() } catch (err) { return () => {} } },
}

const mod = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'index.js')).href)
mod.default.apply(ctx)
assert.ok(routes.has('/dsh-whale/api-models.json'), 'api-models 路由已注册')
const API_ROUTE = routes.get('/dsh-whale/api-models.json')
const mkRes = () => ({ statusCode: 0, body: '', writeHead(c) { this.statusCode = c }, end(b) { this.body = b || '' } })

async function payload() {
  const res = mkRes()
  // v761 起插件自带回环/同源校验：假请求必须带一个回环 Host，否则会被 403（与真实浏览器一致）
  await API_ROUTE.handler({ method: 'GET', headers: { host: '127.0.0.1:19387' }, url: '/dsh-whale/api-models.json' }, res)
  assert.equal(res.statusCode, 200, 'HTTP 200（body: ' + String(res.body).slice(0, 300) + '）')
  return JSON.parse(res.body)
}
async function post(body) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { host: '127.0.0.1:19387' } // 写请求必须来自回环（v761 起）
  req.url = '/dsh-whale/api-models.json'
  const res = mkRes()
  const done = API_ROUTE.handler(req, res)
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  await done
  return { status: res.statusCode, body: JSON.parse(res.body) }
}
const winOf = (plan) => Object.fromEntries((plan.windows || []).map((w) => [w.key, w]))
const entryOf = (p, id) => p.models.find((m) => m.id === id)
const pathsOf = (list) => list.map((c) => c.url.replace(/^https?:\/\/[^/]+/, '')).sort()

const GOAT_MODEL = { id: 'cc-goat', name: 'Command Code GOAT', provider: 'commandcode_goat', currency: 'USD', keyRef: 'COMMAND_CODE_API_KEY' }
const BOUND_MODEL = { id: 'cc-bound', name: 'Command Code（跟随路由）', provider: 'commandcode_goat', currency: 'USD', dshRoute: 'commandcode-goat' }

// ============================ ① 模板层 ============================
setRegistry([GOAT_MODEL])
calls.length = 0
let p = await payload()
let e = entryOf(p, 'cc-goat')
assert.ok(e.plan && e.plan.ok, 'plan.ok: ' + JSON.stringify(e.plan))
let w = winOf(e.plan)
check('5h 窗口 = used/cap', () => assert.equal(r2(w.rolling.usedPct), r2((1.5 / 14) * 100)))
check('周窗口 = used/cap', () => assert.equal(r2(w.weekly.usedPct), r2((4 / 35) * 100)))
check('月窗口 = 已用 /(已用 + 套餐剩余)', () => assert.equal(r2(w.monthly.usedPct), r2((7.5 / (7.5 + 62.5)) * 100)))
check('月窗口重置时间取自订阅接口', () => assert.equal(w.monthly.resetAt, SUBS.data.currentPeriodEnd))
check('weeklyUsedPct 回填（供单窗口链路）', () => assert.equal(r2(e.plan.weeklyUsedPct), r2((4 / 35) * 100)))
check('3 个端点各请求一次（主 + 2 副）', () => {
  assert.deepEqual(pathsOf(calls), ['/alpha/billing/credits', '/alpha/billing/subscriptions', '/alpha/usage/summary'])
})
check('统一带 Bearer 鉴权头', () => assert.ok(calls.length === 3 && calls.every((c) => c.auth === 'Bearer ' + KEY)))
check('模板下发：needsBaseUrl + 3 窗口（前端多窗口选择器依赖它）', () => {
  const t = p.templates.find((x) => x.id === 'commandcode_goat')
  assert.ok(t, '模板已下发')
  assert.equal(t.needsBaseUrl, true)
  assert.equal(t.quota.json.windows.length, 3)
  assert.equal(t.kind, 'quota')
})

// 空闲 5h 窗口（resetAt=0）：不渲染重置时间，也不编百分比
state.credits = { ...CREDITS, windowLimits: { ...CREDITS.windowLimits, fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 } } }
e = entryOf(await payload(), 'cc-goat')
w = winOf(e.plan)
check('resetAt=0 视为「没有运行中的窗口」', () => {
  assert.equal(w.rolling.usedPct, 0)
  assert.equal(w.rolling.resetAt, null) // 前端 apiPlanResetMs(null) → 显示 '--'
})
state.credits = null

// 副请求失败：月度百分比缺失（不编造），5h/周 照常
state.failUsage = true
e = entryOf(await payload(), 'cc-goat')
w = winOf(e.plan)
check('副请求失败：不编造月度百分比，主窗口不受影响', () => {
  assert.equal(e.plan.ok, true)
  assert.ok(w.rolling && w.weekly, '5h/周 仍在')
  assert.equal(w.monthly.usedPct, null)
  assert.equal(w.monthly.resetAt, SUBS.data.currentPeriodEnd)
})
state.failUsage = false

// 显式 Base URL 覆盖默认域名。注意：自定义地址属于"用户可填字段"，按 v761（安全修复 S1）必须先在本机
// 面板里确认过（model.allowCustomHost），否则一律拒绝把凭据发出去。
setRegistry([{ ...GOAT_MODEL, baseUrl: 'https://proxy.example.com' }])
calls.length = 0
e = entryOf(await payload(), 'cc-goat')
check('自定义 Base URL 未本机确认 → 拒绝带凭据请求（S1）', () => {
  assert.equal(calls.length, 0, '不该发出任何请求：' + calls.map((c) => c.url).join(','))
  assert.equal(e.plan.ok, false)
  assert.equal(e.plan.code, 'DEST_NOT_ALLOWED')
})

setRegistry([{ ...GOAT_MODEL, baseUrl: 'https://proxy.example.com', allowCustomHost: true }])
calls.length = 0
await payload()
check('本机确认后：显式 Base URL 覆盖默认域名', () => {
  assert.ok(calls.length === 3, '三个请求都发到自定义 base')
  assert.ok(calls.every((c) => c.url.startsWith('https://proxy.example.com/alpha/')), calls.map((c) => c.url).join(','))
})

// 「测试连通性」：probeUrl 的 {base} 用模板默认域名
setRegistry([GOAT_MODEL])
calls.length = 0
const probe = await post({ action: 'probe', id: 'cc-goat' })
check('测试连通性走 probeUrl（Base URL 留空 → 模板默认）', () => {
  assert.equal(probe.body.ok, true, JSON.stringify(probe.body))
  assert.deepEqual(calls.map((c) => c.url), ['https://api.commandcode.ai/alpha/usage/summary'])
  assert.equal(calls[0].auth, 'Bearer ' + KEY)
})

// 回归：OpenCode Go 的 percent 多窗口路径不受影响
setRegistry([{ id: 'oc-go', name: 'OpenCode Go', provider: 'opencode_go', currency: 'USD', keyRef: 'OPENCODE_GO_API_KEY' }])
state.keys = { OPENCODE_GO_API_KEY: KEY }
w = winOf(entryOf(await payload(), 'oc-go').plan)
check('OpenCode Go 多窗口回归', () => {
  assert.equal(w.rolling.usedPct, 12.5)
  assert.equal(w.weekly.usedPct, 40)
  assert.equal(w.monthly.usedPct, 60)
})

// ============================ ② Provider ID 绑定层 ============================
state.keys = { COMMANDCODE_GOAT_API_KEY: KEY }
state.services = { settings: settingsService, llm: llmService }
setRegistry([BOUND_MODEL])
calls.length = 0
p = await payload()

check('从 DSH 配置发现 provider 路由（id / 显示名 / 地址 / 凭据名 / 建议模板）', () => {
  assert.ok(Array.isArray(p.dshRoutes), 'dshRoutes 已下发')
  const r = p.dshRoutes.find((x) => x.route === 'commandcode-goat')
  assert.ok(r, '发现 commandcode-goat：' + JSON.stringify(p.dshRoutes.map((x) => x.route)))
  assert.equal(r.displayName, 'commandCode goat')
  assert.equal(r.baseUrl, 'https://api.commandcode.ai/provider/v1')
  assert.equal(r.apiKeyEnv, 'COMMANDCODE_GOAT_API_KEY')
  assert.equal(r.suggestedTemplate, 'commandcode_goat')
  assert.deepEqual(r.modelIds, ['deepseek/deepseek-v4.1-flash', 'glm-5.2'])
  assert.deepEqual(r.credential, { configured: true, source: 'file', writable: true })
})

check('内置 catalog 路由（settings 里没有的）不进候选列表', () => {
  const names = p.dshRoutes.map((x) => x.route)
  assert.equal(names.indexOf('openai'), -1, 'openai 不该出现：' + JSON.stringify(names))
  assert.equal(names.indexOf('anthropic'), -1, 'anthropic 不该出现：' + JSON.stringify(names))
  // settings 里真的存在的（含只有 apiKeyEnv/baseURL 的）要在
  assert.ok(names.indexOf('commandcode-goat') >= 0 && names.indexOf('my-cc-proxy') >= 0 && names.indexOf('openrouter') >= 0, JSON.stringify(names))
  assert.deepEqual(names, names.slice().sort(), '按 id 排序，便于下拉里找')
})

check('路由清单只带"名字"，不下发字面 apiKey', () => {
  assert.equal(JSON.stringify(p.dshRoutes).indexOf('should-never-reach-the-browser'), -1)
  const r = p.dshRoutes.find((x) => x.route === 'commandcode-goat')
  assert.equal(r.hasLiteralKey, true) // 只标记"有内联密钥"，不带值
})

check('只绑 Provider ID（凭据名/地址留空）→ 凭据名与地址都跟随路由', () => {
  const b = entryOf(p, 'cc-bound')
  assert.equal(b.dshRoute, 'commandcode-goat')
  assert.equal(b.routeFound, true)
  assert.equal(b.effectiveKeyRef, 'COMMANDCODE_GOAT_API_KEY')
  assert.equal(b.effectiveBaseUrl, 'https://api.commandcode.ai')
  assert.ok(b.plan && b.plan.ok, '额度读取成功：' + JSON.stringify(b.plan && b.plan.error))
  assert.deepEqual(pathsOf(calls), ['/alpha/billing/credits', '/alpha/billing/subscriptions', '/alpha/usage/summary'])
  assert.ok(calls.every((c) => c.auth === 'Bearer ' + KEY), '用的是路由里的 apiKeyEnv 解析出的 key')
})

check('绑定的 baseURL 带 /provider/v1 → 归一化到主机根路径', () => {
  assert.ok(calls.every((c) => c.url.startsWith('https://api.commandcode.ai/alpha/')), calls.map((c) => c.url).join(','))
})

// 代理场景：/provider/v1 挂在自建网关子路径下 → 只去掉尾段，保留子路径。
// 自建网关属于"非内置端点"：该模型必须在本机确认过（allowCustomHost）才允许带凭据；
// 官方 api.commandcode.ai 写在模板的 quota.baseDefault 里，属于可信端点，不需要这一步。
setRegistry([{ ...BOUND_MODEL, dshRoute: 'my-cc-proxy', allowCustomHost: true }])
state.keys = { MY_CC_KEY: KEY }
calls.length = 0
p = await payload()
check('自建网关子路径不被吃掉（proxy.example.com/cc）', () => {
  const b = entryOf(p, 'cc-bound')
  assert.equal(b.effectiveBaseUrl, 'https://proxy.example.com/cc')
  assert.ok(calls.every((c) => c.url.startsWith('https://proxy.example.com/cc/alpha/')), calls.map((c) => c.url).join(','))
  assert.ok(calls.every((c) => c.auth === 'Bearer ' + KEY))
})

// 路由被删/改名：降级到模板默认，不能因此查不到额度
setRegistry([{ ...BOUND_MODEL, dshRoute: 'route-that-gone' }])
state.keys = { COMMAND_CODE_API_KEY: KEY }
calls.length = 0
p = await payload()
check('绑定的路由已不存在 → 回退模板默认（凭据名/地址）', () => {
  const b = entryOf(p, 'cc-bound')
  assert.equal(b.routeFound, false)
  assert.equal(b.effectiveKeyRef, 'COMMAND_CODE_API_KEY')
  assert.equal(b.effectiveBaseUrl, 'https://api.commandcode.ai')
  assert.ok(b.plan && b.plan.ok)
})

// 保存语义：绑定路由时，"模板默认凭据名"视为未填（= 跟随路由）
const regPath = path.join(HOME, '.dshw-api.json')
setRegistry([])
let saved = await post({ model: { name: 'CC 跟随', provider: 'commandcode_goat', currency: 'USD', keyRef: 'COMMAND_CODE_API_KEY', dshRoute: 'commandcode-goat' } })
check('保存：绑定 + 模板默认凭据名 → 存空串（跟随路由）', () => {
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const m = JSON.parse(fs.readFileSync(regPath, 'utf8')).models[0]
  assert.equal(m.dshRoute, 'commandcode-goat')
  assert.ok(!m.keyRef, 'keyRef 存空：' + JSON.stringify(m.keyRef))
})
saved = await post({ model: { id: JSON.parse(fs.readFileSync(regPath, 'utf8')).models[0].id, name: 'CC 覆盖', provider: 'commandcode_goat', currency: 'USD', keyRef: 'MY_OWN_REF', dshRoute: 'commandcode-goat' } })
check('保存：用户显式填了别的凭据名 → 保留（显式优先）', () => {
  const m = JSON.parse(fs.readFileSync(regPath, 'utf8')).models[0]
  assert.equal(m.keyRef, 'MY_OWN_REF')
})

// 回归：真实踩到的坑 —— 模型先在面板里建好（凭据名被填成模板默认值），dshRoute 是**事后手写**
// 进注册表的。此时模板默认名必须让位给路由的 apiKeyEnv，否则报「未配置 COMMAND_CODE_API_KEY」。
setRegistry([{
  id: 'api_manual_1', createdAt: Date.now(), name: 'ASD', dshRoute: 'commandcode-goat',
  provider: 'commandcode_goat', currency: 'USD', keyRef: 'COMMAND_CODE_API_KEY', baseUrl: '',
  balance: { auth: 'Bearer {key}' },
}])
state.keys = { COMMANDCODE_GOAT_API_KEY: KEY }
calls.length = 0
p = await payload()
e = entryOf(p, 'api_manual_1')
check('手写 dshRoute + 模板默认凭据名 → 让位给路由的 apiKeyEnv', () => {
  assert.equal(e.effectiveKeyRef, 'COMMANDCODE_GOAT_API_KEY', '实际生效的凭据名')
  assert.equal(e.keyRefFallback, false)
  assert.equal(e.hasKey, true)
  assert.ok(e.plan && e.plan.ok, '额度读取成功：' + JSON.stringify(e.plan && e.plan.error))
  assert.ok(calls.length && calls.every((c) => c.auth === 'Bearer ' + KEY))
  assert.ok(calls.every((c) => c.url.startsWith('https://api.commandcode.ai/alpha/')), calls.map((c) => c.url).join(','))
})

// 候选名兜底：没绑路由、也没按模板默认名配置时，按 keyRefCandidates 再试几个常见命名
setRegistry([{ id: 'api_manual_2', name: '未绑定', provider: 'commandcode_goat', currency: 'USD', keyRef: 'COMMAND_CODE_API_KEY' }])
state.keys = { CMD_API_KEY: KEY }
calls.length = 0
p = await payload()
e = entryOf(p, 'api_manual_2')
check('主凭据名取不到 → 按候选名兜底（并报出实际命中的名字）', () => {
  assert.equal(e.effectiveKeyRef, 'CMD_API_KEY')
  assert.equal(e.keyRefFallback, true)
  assert.equal(e.hasKey, true)
  assert.ok(e.plan && e.plan.ok, '额度读取成功：' + JSON.stringify(e.plan && e.plan.error))
  assert.ok(calls.every((c) => c.auth === 'Bearer ' + KEY))
})

// 候选名也取不到时，错误信息要报出"实际在找的那个名字"
state.keys = {}
p = await payload()
e = entryOf(p, 'api_manual_2')
check('完全取不到时错误信息点名主凭据名', () => {
  assert.equal(e.hasKey, false)
  assert.equal(e.plan.ok, false)
  assert.equal(e.plan.code, 'NO_KEY')
  assert.equal(e.plan.error, '未配置 COMMAND_CODE_API_KEY')
})

// YAML 降级：没有 settings / llm 服务时，扫 $DSH_HOME/settings.yaml
state.services = {}
fs.writeFileSync(path.join(HOME, 'settings.yaml'), [
  '# 假配置：形状与 DSH 的 llm-pi-ai providers 段一致',
  'llm-pi-ai:',
  '  providers:',
  '    commandcode-goat:',
  '      displayName: commandCode goat',
  '      apiKeyEnv: COMMANDCODE_GOAT_API_KEY',
  '      api: openai-completions',
  '      baseURL: https://api.commandcode.ai/provider/v1',
  '      models:',
  '        - id: deepseek/deepseek-v4.1-flash',
  '    some-other-gateway:',
  '      apiKeyEnv: OTHER_KEY',
  '      baseURL: https://gw.example.com/v1',
  '',
].join('\n'))
setRegistry([BOUND_MODEL])
state.keys = { COMMANDCODE_GOAT_API_KEY: KEY }
p = await payload()
check('settings 服务缺失时降级扫 settings.yaml', () => {
  const r = p.dshRoutes.find((x) => x.route === 'commandcode-goat')
  assert.ok(r, '从 YAML 发现路由：' + JSON.stringify(p.dshRoutes.map((x) => x.route)))
  assert.equal(r.apiKeyEnv, 'COMMANDCODE_GOAT_API_KEY')
  assert.equal(r.baseUrl, 'https://api.commandcode.ai/provider/v1')
  assert.equal(r.suggestedTemplate, 'commandcode_goat')
  assert.ok(p.dshRoutes.some((x) => x.route === 'some-other-gateway'), '同一段里的其它路由也能识别')
  // 容器键（providers / llm-pi-ai / models）不能被当成路由
  assert.deepEqual(p.dshRoutes.map((x) => x.route).sort(), ['commandcode-goat', 'some-other-gateway'])
  const b = entryOf(p, 'cc-bound')
  assert.equal(b.effectiveKeyRef, 'COMMANDCODE_GOAT_API_KEY')
  assert.ok(b.plan && b.plan.ok)
})

// 可选：用一份**真实的** settings.yaml 验证 YAML 扫描器（DSH 写出来的可能是流式 YAML，
// 与手写的块式不同）。用法：DSHW_REAL_SETTINGS=<路径> node test/quota-dsh-routes.test.mjs
if (process.env.DSHW_REAL_SETTINGS) {
  const real = process.env.DSHW_REAL_SETTINGS
  fs.copyFileSync(real, path.join(HOME, 'settings.yaml'))
  state.services = {}
  setRegistry([BOUND_MODEL])
  state.keys = { COMMANDCODE_GOAT_API_KEY: KEY }
  p = await payload()
  const r = p.dshRoutes.find((x) => x.route === 'commandcode-goat')
  check('真实 settings.yaml（' + path.basename(real) + '）：扫描器识别正确', () => {
    assert.ok(r, '未从真实配置里发现路由；发现的是：' + JSON.stringify(p.dshRoutes.map((x) => x.route)))
    assert.equal(r.apiKeyEnv, 'COMMANDCODE_GOAT_API_KEY')
    assert.equal(r.baseUrl, 'https://api.commandcode.ai/provider/v1')
    assert.equal(r.suggestedTemplate, 'commandcode_goat')
    // YAML 降级只取路由 id / 地址 / 凭据名（模型清单要真解析 YAML，只有 settings 服务那条路有）
    assert.ok(Array.isArray(r.modelIds))
    assert.equal(p.dshRoutes.some((x) => x.route === 'providers' || x.route === 'llm-pi-ai' || x.route === 'models'), false, '容器键被误判成路由：' + JSON.stringify(p.dshRoutes.map((x) => x.route)))
    const b = entryOf(p, 'cc-bound')
    assert.equal(b.effectiveKeyRef, 'COMMANDCODE_GOAT_API_KEY')
    assert.equal(b.effectiveBaseUrl, 'https://api.commandcode.ai')
    assert.ok(b.plan && b.plan.ok, '额度读取成功')
  })
  console.log('     （真实配置里发现的路由：' + p.dshRoutes.map((x) => x.route + '→' + (x.suggestedTemplate || '无建议模板')).join('、') + '）')
}

// 可选：用**真实 settings.yaml 解析出来的 providers 段**验证 settings 服务那条生产路径。
// 用法（先用 js-yaml 把真实配置里的 llm-pi-ai.providers 导成 JSON）：
//   DSHW_REAL_PROVIDERS=<providers.json> node test/quota-dsh-routes.test.mjs
if (process.env.DSHW_REAL_PROVIDERS) {
  const raw = JSON.parse(fs.readFileSync(process.env.DSHW_REAL_PROVIDERS, 'utf8'))
  const providers = raw.providers && typeof raw.providers === 'object' ? raw.providers : raw
  state.services = {
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers } }], get: (ns) => (ns === 'llm-pi-ai' ? { providers } : undefined) },
    llm: { listConfigurableProviders: () => Object.keys(providers).map((id) => ({ provider: id, displayName: providers[id].displayName || id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id], declared: true })) },
  }
  setRegistry([BOUND_MODEL])
  state.keys = { COMMANDCODE_GOAT_API_KEY: KEY }
  calls.length = 0
  p = await payload()
  const r = p.dshRoutes.find((x) => x.route === 'commandcode-goat')
  check('真实配置（settings 服务路径）：路由 + 绑定 + 读额度全通', () => {
    assert.ok(r, '未发现 commandcode-goat：' + JSON.stringify(p.dshRoutes.map((x) => x.route)))
    assert.equal(r.displayName, 'commandCode goat')
    assert.equal(r.apiKeyEnv, 'COMMANDCODE_GOAT_API_KEY')
    assert.equal(r.baseUrl, 'https://api.commandcode.ai/provider/v1')
    assert.equal(r.suggestedTemplate, 'commandcode_goat')
    assert.ok(r.modelIds.indexOf('deepseek/deepseek-v4.1-flash') >= 0, '模型清单来自真实配置：' + r.modelIds.length + ' 个')
    const b = entryOf(p, 'cc-bound')
    assert.equal(b.effectiveKeyRef, 'COMMANDCODE_GOAT_API_KEY')
    assert.equal(b.effectiveBaseUrl, 'https://api.commandcode.ai')
    assert.ok(b.plan && b.plan.ok, '额度读取成功：' + JSON.stringify(b.plan && b.plan.error))
    assert.deepEqual(pathsOf(calls), ['/alpha/billing/credits', '/alpha/billing/subscriptions', '/alpha/usage/summary'])
  })
  console.log('     （真实配置：' + p.dshRoutes.length + ' 条路由、' + r.modelIds.length + ' 个模型）')
}

console.log('\n' + pass + ' checks passed')
