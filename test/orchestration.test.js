/**
 * lib/index.js —— 服务端编排集成测试（mock ctx，不依赖真实 DSH）
 *
 * 契约来源：PRD-whale-multirelay.md 第 6.1（架构契约）、6.4（载荷协议）、8（回归红线）。
 * 通过 mock ctx 调用 apply()，直接请求 /dsh-whale/balance.json 与 /dsh-whale/size.json。
 *
 * 验证：
 *   1. 无 providers 配置时顶层字段与 0.2.9 一致（回归红线，新字段仅追加）
 *   2. 多账户并行编排 + displayProvider 别名（余额态/已用态）
 *   3. 中转站失败隔离（不影响官方余额与其它账户）
 *   4. 不限额 newapi：不出现负假余额，只输出已用
 *   5. size.json PUT 保留 providers 并持久化 displayProvider
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-orch-'))
// DSH_HOME 在 lib/index.js 模块顶层读取，必须在首次 import 前设置
process.env.DSH_HOME = TMP

const OFFICIAL_BALANCE = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '123.45', granted_balance: '100', topped_up_balance: '50' }],
}
const NEWAPI_TOKEN_LIMITED = {
  success: true,
  data: { name: 'key-1', total_granted: 4000000, total_used: 1000000, total_available: 3000000, unlimited_quota: false, expires_at: 1786634961 },
}
const NEWAPI_TOKEN_UNLIMITED = {
  success: true,
  data: { name: 'unlimited-key', total_granted: 0, total_used: 14383915, total_available: -14383915, unlimited_quota: true },
}
const NEWAPI_STATUS = { success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY' } }
const NEWAPI_USER_SELF = {
  success: true,
  data: { id: 1, username: 'user', quota: 3000000, used_quota: 1000000, request_count: 10 },
}

const SIZE_FILE = path.join(TMP, '.dshw-size.json')
const USAGE_FILE = path.join(TMP, '.dshw-usage.json')

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const k = String(name).toLowerCase()
        return k in extraHeaders ? extraHeaders[k] : null
      },
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: undefined,
  }
}

let failSub = false
let failSubNet = false
let failSub429 = false
let statusFail = false
let unlimitedNewapi = false
let userTokenOn = false
let v1Calls = 0
let userSelfCalls = 0
let setCalls = []

/** 路由 mock：官方余额 + newapi（token/status/user/self）+ sub2api（可注入故障）。 */
async function fakeFetch(url) {
  const u = String(url)
  if (u.includes('api.deepseek.com/user/balance')) return jsonResponse(OFFICIAL_BALANCE)
  if (u.includes('/api/user/self')) {
    userSelfCalls++
    return jsonResponse(NEWAPI_USER_SELF)
  }
  if (u.includes('/api/usage/token/')) return jsonResponse(unlimitedNewapi ? NEWAPI_TOKEN_UNLIMITED : NEWAPI_TOKEN_LIMITED)
  if (u.includes('/api/status')) {
    if (statusFail) throw new Error('status down')
    return jsonResponse(NEWAPI_STATUS)
  }
  if (u.includes('/v1/usage')) {
    v1Calls++
    if (failSubNet) throw new Error('network down')
    if (failSub429) return jsonResponse({ success: false, message: 'too many requests' }, 429, { 'retry-after': '1200' })
    if (failSub) return jsonResponse({ error: 'boom' }, 500)
    return jsonResponse({ isValid: true, status: 'ok', unit: 'USD', balance: 4.5, remaining: 4.5 })
  }
  throw new Error('unexpected url ' + u)
}

/** 构造 mock ctx 并调用 apply()，返回按 path 索引的 route handler。 */
async function startPlugin() {
  const handlers = {}
  const ctx = {
    webServer: {
      register: (opts) => {
        handlers[opts.path] = opts.handler
        return () => {}
      },
      tapIndex: () => () => {},
    },
    credentials: {
      resolve: async (name) => {
        if (name === 'DEEPSEEK_API_KEY') return { value: 'sk-official-test' }
        if (name === 'NEWAPI_API_KEY') return { value: 'sk-newapi-test' }
        if (name === 'SUB2API_API_KEY') return { value: 'sub2api-key-test' }
        if (name === 'NEWAPI_USER_TOKEN') return userTokenOn ? { value: 'ak-test-token' } : undefined
        if (name === 'NEWAPI_USER_ID') return userTokenOn ? { value: '1' } : undefined
        return undefined
      },
      set: async (name, value) => {
        setCalls.push({ name, value })
      },
    },
    on: () => () => {},
    effect: () => {},
  }
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'lib', 'index.js')).href)
  mod.apply(ctx)
  return handlers
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function pathToFileURL(p) {
  return new URL('file:///' + p.replace(/\\/g, '/'))
}

function request(handler, method = 'GET', body) {
  return new Promise((resolve) => {
    let out = ''
    const res = {
      writeHead: (code) => {
        res.statusCode = code
      },
      end: (d) => {
        out += d
        resolve({ statusCode: res.statusCode, body: out })
      },
    }
    const req = {
      method,
      url: '',
      on: (ev, cb) => {
        if (ev === 'data' && body) cb(Buffer.from(body))
        if (ev === 'end') cb()
      },
    }
    handler(req, res)
  })
}

function writeSize(extra) {
  fs.writeFileSync(
    SIZE_FILE,
    JSON.stringify({
      scale: 1.5,
      providers: [
        { type: 'deepseek' },
        { type: 'newapi', baseUrl: 'https://relay.example.com' },
        { type: 'sub2api', baseUrl: 'https://sub.example.com' },
      ],
      ...extra,
    }),
  )
}

beforeEach(() => {
  failSub = false
  failSubNet = false
  failSub429 = false
  statusFail = false
  unlimitedNewapi = false
  userTokenOn = false
  v1Calls = 0
  userSelfCalls = 0
  setCalls = []
  for (const f of [SIZE_FILE, USAGE_FILE]) {
    try {
      fs.unlinkSync(f)
    } catch (err) {}
  }
  globalThis.fetch = fakeFetch
})

describe('服务端编排（mock ctx）', () => {
  it('无 providers 配置：顶层字段与 0.2.9 一致，新字段仅追加（回归红线）', async () => {
    const handlers = await startPlugin()
    const res = await request(handlers['/dsh-whale/balance.json'])
    expect(res.statusCode).toBe(200)
    const p = JSON.parse(res.body)

    // 0.2.9 顶层字段值逐一一致
    expect(p.ok).toBe(true)
    expect(p.totalBalance).toBe(123.45)
    expect(p.currency).toBe('CNY')
    expect(p.todayUsage).toBe(0)
    expect(p.usageMode).toBe('ledger')
    expect(p.isPeak).toBe(false)
    expect(typeof p.updatedAt).toBe('string')

    // 新字段仅追加：键集 = 0.2.9 键集 + 新键
    const keys = Object.keys(p).sort()
    expect(keys).toEqual(
      ['accounts', 'currency', 'currencyOptions', 'displayCurrency', 'displayProvider', 'isPeak', 'ok', 'providers', 'rateLimit', 'todayUsage', 'totalBalance', 'updatedAt', 'usageMode'].sort(),
    )
    expect(p.displayProvider).toBe('deepseek')
    expect(p.displayCurrency).toBe('auto')
    expect(p.rateLimit).toEqual({
      windowMs: 300000,
      mode: 'adaptive',
      origins: {},
      perCycleCalls: 0,
      recommendedRefreshMs: null,
    })
    expect(p.providers).toEqual([
      { accountId: 'deepseek', type: 'deepseek', label: 'DeepSeek 官方', ok: true, isAvailable: true, unlimited: false },
    ])
    expect(p.accounts.length).toBe(1)
    expect(p.accounts[0].accountId).toBe('deepseek')
  })

  it('多账户：并行读取 + 顶层别名到 displayProvider（余额态 = 用户余额）', async () => {
    userTokenOn = true
    writeSize({ displayProvider: 'newapi' })
    const handlers = await startPlugin()
    const res = await request(handlers['/dsh-whale/balance.json'])
    const p = JSON.parse(res.body)

    expect(p.ok).toBe(true)
    expect(p.accounts.length).toBe(3)
    expect(p.providers.length).toBe(3)
    expect(p.displayProvider).toBe('newapi')
    // 顶层别名到 newapi 用户余额：user/self quota(3000000) ÷ 500000 = 6
    expect(p.totalBalance).toBe(6)
    // 余额态 auto 币种 = 用户余额币种（站点 quota_display_type = CNY）
    expect(p.currency).toBe('CNY')
    expect(p.todayUsage).toBe(2)
    expect(p.usageMode).toBe('relay')

    const deepseek = p.accounts.find((a) => a.accountId === 'deepseek')
    const newapi = p.accounts.find((a) => a.accountId === 'newapi')
    const sub2api = p.accounts.find((a) => a.accountId === 'sub2api')
    expect(deepseek.ok).toBe(true)
    expect(newapi).toMatchObject({ ok: true, balance: 6, used: 2, granted: 8, currency: 'USD', keyName: 'key-1', userTokenConfigured: true, balanceCurrency: 'CNY' })
    expect(newapi.currencyOptions).toEqual([
      { key: 'site', label: 'CNY', value: 6, currency: 'CNY' },
      { key: 'raw', label: '配额原值', value: 3000000, currency: '' },
    ])
    expect(sub2api).toMatchObject({ ok: true, balance: 4.5, currency: 'USD' })
    // 本周期 4 次中转查询（newapi token+status+user/self，sub2api usage）
    // → 推荐间隔 = 4 × 5min ÷ 15 = 80 秒
    expect(p.rateLimit.perCycleCalls).toBe(4)
    expect(p.rateLimit.recommendedRefreshMs).toBe(80000)
    // 自适应限流状态：每 origin 的已用/上限/剩余/是否已学习
    expect(p.rateLimit.origins['https://relay.example.com']).toEqual({ used: 3, max: 15, remaining: 12, learned: false })
    expect(p.rateLimit.origins['https://sub.example.com']).toEqual({ used: 1, max: 15, remaining: 14, learned: false })
  })

  it('newapi 未配置访问令牌：balance 缺省 + userTokenConfigured=false（前端引导去设置弹窗）', async () => {
    writeSize({ displayProvider: 'newapi' })
    const handlers = await startPlugin()
    const res = await request(handlers['/dsh-whale/balance.json'])
    const p = JSON.parse(res.body)

    const newapi = p.accounts.find((a) => a.accountId === 'newapi')
    expect(newapi.ok).toBe(true)
    expect(newapi.userTokenConfigured).toBe(false)
    expect(newapi.balance).toBeUndefined()
    expect(newapi.used).toBeCloseTo(2, 6) // token 已用仍可读
    expect(newapi.currencyOptions).toEqual([])
    // 未配置访问令牌：余额卡回退到 token 级已用额度（顶层 totalBalance 同样回退）
    expect(p.totalBalance).toBe(2)
    expect(p.todayUsage).toBe(2)
    expect(userSelfCalls).toBe(0) // 未配置令牌 → 不请求 user/self
  })

  it('「已用配额」独立模式已移除：历史 :usage 配置归一化为余额态，未配置令牌回退已用', async () => {
    writeSize({ displayProvider: 'newapi:usage' })
    const handlers = await startPlugin()
    const res = await request(handlers['/dsh-whale/balance.json'])
    const p = JSON.parse(res.body)

    // 遗留 ':usage' 归一化为余额态：displayProvider 不带后缀
    expect(p.displayProvider).toBe('newapi')
    // 未配置访问令牌 → 余额卡回退到 token 级已用（2）
    expect(p.totalBalance).toBe(2)
    expect(p.todayUsage).toBe(2)
  })

  it('中转站失败隔离：sub2api 500 不影响官方余额与其它账户', async () => {
    failSub = true
    writeSize({ displayProvider: 'deepseek' })
    const handlers = await startPlugin()
    const res = await request(handlers['/dsh-whale/balance.json'])
    const p = JSON.parse(res.body)

    expect(p.ok).toBe(true)
    expect(p.totalBalance).toBe(123.45)
    const sub2api = p.accounts.find((a) => a.accountId === 'sub2api')
    expect(sub2api.ok).toBe(false)
    expect(sub2api.error).toBe('http-500')
    expect(sub2api.message).toBe('HTTP 500')
    expect(p.accounts.find((a) => a.accountId === 'newapi').ok).toBe(true)
  })

  it('展示失败账户时：顶层 ok=false 带错误码，其余账户数据仍在', async () => {
    failSub = true
    writeSize({ displayProvider: 'sub2api' })
    const handlers = await startPlugin()
    const res = await request(handlers['/dsh-whale/balance.json'])
    const p = JSON.parse(res.body)

    expect(p.ok).toBe(false)
    expect(p.code).toBe('http-500')
    expect(p.error).toBe('HTTP 500')
    expect(p.accounts.length).toBe(3)
    expect(p.accounts.find((a) => a.accountId === 'deepseek').ok).toBe(true)
  })

  it('不限额 newapi：balance 为 undefined（不显示负假余额），used 折算 USD', async () => {
    unlimitedNewapi = true
    writeSize({ displayProvider: 'newapi' })
    const handlers = await startPlugin()
    const res = await request(handlers['/dsh-whale/balance.json'])
    const p = JSON.parse(res.body)

    const newapi = p.accounts.find((a) => a.accountId === 'newapi')
    expect(newapi.ok).toBe(true)
    expect(newapi.unlimited).toBe(true)
    expect(newapi.balance).toBeUndefined()
    expect(newapi.used).toBeCloseTo(28.76783, 6) // 14383915 × (1/500000)
    // 余额态顶层：无用户余额时回退到 token 级已用（不限额度 → 同样显示已用）
    expect(p.totalBalance).toBeCloseTo(28.76783, 6)
    expect(p.todayUsage).toBeCloseTo(28.76783, 6)
  })

  it('同类型多账户：accountId 追加 -1/-2 后缀', async () => {
    fs.writeFileSync(
      SIZE_FILE,
      JSON.stringify({
        scale: 1.5,
        providers: [
          { type: 'deepseek' },
          { type: 'newapi', baseUrl: 'https://a.example.com' },
          { type: 'newapi', baseUrl: 'https://b.example.com' },
        ],
      }),
    )
    const handlers = await startPlugin()
    const res = await request(handlers['/dsh-whale/balance.json'])
    const p = JSON.parse(res.body)

    const ids = p.accounts.map((a) => a.accountId)
    expect(ids).toEqual(['deepseek', 'newapi', 'newapi-1'])
  })

  it('size.json PUT 保留 providers 并持久化 displayProvider', async () => {
    writeSize({ displayProvider: 'deepseek' })
    const handlers = await startPlugin()
    const put = await request(
      handlers['/dsh-whale/size.json'],
      'PUT',
      JSON.stringify({ scale: 1.6, displayProvider: 'newapi:usage' }),
    )
    expect(JSON.parse(put.body).ok).toBe(true)

    const after = JSON.parse(fs.readFileSync(SIZE_FILE, 'utf8'))
    expect(after.displayProvider).toBe('newapi:usage')
    expect(after.providers.length).toBe(3) // 用户手配的 providers 未被清掉
    expect(after.scale).toBe(1.6)

    const get = await request(handlers['/dsh-whale/size.json'])
    const got = JSON.parse(get.body)
    expect(got.displayProvider).toBe('newapi:usage')
    expect(got.providers).toEqual(after.providers)
  })

  it('设置弹窗：POST /dsh-whale/user-token.json 写入凭据服务，下次读取立即生效', async () => {
    writeSize({ displayProvider: 'newapi' })
    const handlers = await startPlugin()

    const post = await request(
      handlers['/dsh-whale/user-token.json'],
      'POST',
      // 粘贴值带 Bearer 前缀与首尾空白：路由应剥除后再存
      JSON.stringify({ accountId: 'newapi', userId: ' 1 ', token: 'Bearer  ak-secret-token ' }),
    )
    expect(JSON.parse(post.body).ok).toBe(true)
    expect(setCalls).toContainEqual({ name: 'NEWAPI_USER_ID', value: '1' })
    expect(setCalls).toContainEqual({ name: 'NEWAPI_USER_TOKEN', value: 'ak-secret-token' })

    // 保存后（用户已配置令牌）：余额读取切换到 /api/user/self 用户余额
    userTokenOn = true
    const res = await request(handlers['/dsh-whale/balance.json'])
    const p = JSON.parse(res.body)
    expect(p.totalBalance).toBe(6)
    expect(p.accounts.find((a) => a.accountId === 'newapi').userTokenConfigured).toBe(true)
  })

  it('设置弹窗：POST /dsh-whale/platform-token.json 写入 DEEPSEEK_PLATFORM_TOKEN', async () => {
    writeSize({})
    const handlers = await startPlugin()

    const post = await request(
      handlers['/dsh-whale/platform-token.json'],
      'POST',
      JSON.stringify({ token: 'Bearer eyJtest-platform-token' }),
    )
    expect(JSON.parse(post.body).ok).toBe(true)
    expect(setCalls).toContainEqual({ name: 'DEEPSEEK_PLATFORM_TOKEN', value: 'Bearer eyJtest-platform-token' })

    const bad = await request(handlers['/dsh-whale/platform-token.json'], 'POST', JSON.stringify({}))
    expect(bad.statusCode).toBe(400)
  })

  it('设置弹窗：非 newapi 账户 / 缺字段 → 400 且不触碰凭据服务', async () => {
    writeSize({})
    const handlers = await startPlugin()

    const bad1 = await request(
      handlers['/dsh-whale/user-token.json'],
      'POST',
      JSON.stringify({ accountId: 'deepseek', userId: '1', token: 'x' }),
    )
    expect(bad1.statusCode).toBe(400)
    expect(setCalls.length).toBe(0)

    const bad2 = await request(
      handlers['/dsh-whale/user-token.json'],
      'POST',
      JSON.stringify({ accountId: 'newapi' }),
    )
    expect(bad2.statusCode).toBe(400)
    expect(setCalls.length).toBe(0)
  })

  it('瞬时故障负缓存：窗口内重复读取不再触碰上游', async () => {
    failSubNet = true
    writeSize({ displayProvider: 'sub2api' })
    const handlers = await startPlugin()

    const r1 = await request(handlers['/dsh-whale/balance.json'])
    const p1 = JSON.parse(r1.body)
    expect(p1.ok).toBe(false)
    expect(v1Calls).toBe(1)

    const r2 = await request(handlers['/dsh-whale/balance.json'])
    const p2 = JSON.parse(r2.body)
    expect(p2.ok).toBe(false)
    expect(p2.error).toBe(p1.error)
    expect(v1Calls).toBe(1) // 第二次走负缓存，未再请求上游
  })

  it('站点 429：按 retry-after 负缓存，且带 retryAfterMs 供后续策略使用', async () => {
    failSub429 = true
    writeSize({ displayProvider: 'sub2api' })
    const handlers = await startPlugin()

    const r1 = await request(handlers['/dsh-whale/balance.json'])
    const p1 = JSON.parse(r1.body)
    expect(p1.ok).toBe(false)
    expect(p1.code).toBe('http-429')
    const sub1 = p1.accounts.find((a) => a.accountId === 'sub2api')
    expect(sub1.retryAfterMs).toBe(1200000) // retry-after: 1200 秒 → 20 分钟

    const r2 = await request(handlers['/dsh-whale/balance.json'])
    const p2 = JSON.parse(r2.body)
    expect(p2.ok).toBe(false)
    expect(v1Calls).toBe(1) // retry-after 20 分钟内的重复读取不再触碰上游
  })

  it('换算率缓存：/api/status 失败时用上次成功的 quota_per_unit 兜底换算（不显示原始整数）', async () => {
    writeSize({ displayProvider: 'deepseek' })
    const handlers = await startPlugin()

    // 第一次读取：status 正常 → 换算率入缓存，payload 入 25s 缓存
    const r1 = await request(handlers['/dsh-whale/balance.json'])
    const p1 = JSON.parse(r1.body)
    expect(p1.accounts.find((a) => a.accountId === 'newapi').used).toBeCloseTo(2, 6)

    // 让 /api/status 失败，并通过 usageMode 变化失效余额缓存，强制重新读上游
    statusFail = true
    const put = await request(
      handlers['/dsh-whale/size.json'],
      'PUT',
      JSON.stringify({ scale: 1.5, usageMode: 'token' }),
    )
    expect(JSON.parse(put.body).ok).toBe(true)

    const r2 = await request(handlers['/dsh-whale/balance.json'])
    const p2 = JSON.parse(r2.body)
    const newapi2 = p2.accounts.find((a) => a.accountId === 'newapi')
    // status 失败 → 用缓存换算率：仍是 2.0 金额，而不是 1000000 原始整数
    expect(newapi2.used).toBeCloseTo(2, 6)
    expect(newapi2.currency).toBe('USD')
  })

  it('货币偏好：displayCurrency=USD → 仅切换币种符号，金额数值不变', async () => {
    userTokenOn = true
    writeSize({ displayProvider: 'newapi', displayCurrency: 'USD' })
    const handlers = await startPlugin()
    const res = await request(handlers['/dsh-whale/balance.json'])
    const p = JSON.parse(res.body)

    expect(p.displayCurrency).toBe('USD')
    expect(p.totalBalance).toBe(6) // 金额不变（用户余额），符号改为 $
    expect(p.currency).toBe('USD')
  })

  it('货币偏好：历史值 raw 按 auto 处理（不再别名到配额原值）', async () => {
    userTokenOn = true
    writeSize({ displayProvider: 'newapi', displayCurrency: 'raw' })
    const handlers = await startPlugin()
    const res = await request(handlers['/dsh-whale/balance.json'])
    const p = JSON.parse(res.body)

    expect(p.totalBalance).toBe(6)
    expect(p.currency).toBe('CNY') // auto → 用户余额币种（站点 CNY）
  })

  it('货币偏好：displayCurrency=CNY（官方账户）→ 仅切换币种符号，金额不变', async () => {
    // 官方 balance_infos 只有 CNY 一项，显式选择 CNY 与 auto 同值；验证符号别名路径生效
    writeSize({ displayProvider: 'deepseek', displayCurrency: 'CNY' })
    const handlers = await startPlugin()
    const res = await request(handlers['/dsh-whale/balance.json'])
    const p = JSON.parse(res.body)
    expect(p.totalBalance).toBe(123.45)
    expect(p.currency).toBe('CNY')
    expect(p.displayCurrency).toBe('CNY')
  })
})
