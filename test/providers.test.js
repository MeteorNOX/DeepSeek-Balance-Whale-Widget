/**
 * lib/providers.js —— 适配器单元测试
 *
 * 契约来源：PRD-whale-multirelay.md 第 5 节（字段映射与不限额判定）、第 6.1 节
 * （统一输出形状）、第 7 节（新增文件）、第 8 节（回归红线）；错误分级见 5.4。
 *
 * 测试遵循的接口约定（与 lib/providers.js 并行开发；若实现接口与下方注释存在出入，
 * 按真实导出调整本文件即可）：
 *
 *   import { readAccount, SCHEMES } from '../lib/providers.js'
 *
 *   readAccount(options)  —— 统一入口，options = {
 *     type: 'deepseek'|'newapi'|'sub2api',
 *     baseUrl?: string,        // newapi/sub2api 必填
 *     credential?: string,     // 已解析的 key 原文；缺省按类型取默认
 *     fetch?,                  // 可注入 fetch（测试用）
 *     now?,                    // 可注入的当前时间（毫秒），用于把相对重置时间解析为绝对时刻
 *     timeoutMs?               // 每请求超时（默认 15000）
 *   }
 *
 *   返回统一形状：{ ok, error?, total?, granted?, used?, unlimited?, currency?,
 *     windows?, provider?, label?, keyName?, expiresAt?, isAvailable? }
 *     - ok     布尔；false 时 error 为错误码（no-credential/unreachable/timeout/
 *               http-<code>/upstream-<message>/invalid-response/shape/
 *               cross-origin-redirect/too-large）
 *     - windows 每项 { kind:'session'|'daily'|'weekly'|'monthly', used, limit,
 *               usedPercent?, resetsAt? }，恒按 session→daily→weekly→monthly 归一化；
 *               limit 为 null 的周期不产生窗口
 *
 * 测试用 fetch 均为可注入的 mock，仅验证契约与字段映射，不依赖网络。
 *
 * ── 待全栈开发确认的接口假设（若与实现不符，此处为本用例的期望值）──────────
 *  ① 账户「不可用」的表示：sub2api 的 status∈{expired,quota_exhausted,disabled}
 *     或 isValid===false 时，本用例断言 `result.isAvailable === false`（沿用
 *     TokenLedger/src/balance.js 的 `isAvailable` 字段）。若实现改为用
 *     ok:false + error 表达「不可用」，请告知，我会同步调整断言。
 *  ② newapi 的 expires_at>0 保留为原始 epoch 秒数值；0/缺失视为永久。
 *  ③ readAccount 入参签名 `{ type, baseUrl, credential, fetch, now, timeoutMs }`。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readAccount, SCHEMES, createRateLimiter, learnRateLimitCap } from '../lib/providers.js'

const RELAY = 'https://relay.example.com'
const DEEPSEEK = 'https://api.deepseek.com'

/** 7 天，毫秒 —— Sub2API 的周重置时间 = weekly_window_start + 7d。 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** 构造一个最小可用 mock Response（含 addEventListener 所需的路由定位）。 */
function jsonResponse(body, { status = 200, location = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'location' ? location : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: undefined,
  }
}

/**
 * 一个按 URL 路由的 fetch，用于一次覆盖多个上游端点（newapi 的 token + status）。
 * 记录每次调用的 { url, headers } 供断言（路径末尾斜杠、Authorization 头）。
 */
function routeFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    const urlStr = String(url)
    calls.push({ url: urlStr, headers: init.headers ?? {} })
    const hit = routes.find((r) => urlStr.includes(r.match))
    if (hit) {
      return typeof hit.response === 'function' ? hit.response(urlStr, init) : hit.response
    }
    throw new Error(`unexpected url: ${urlStr}`)
  }
  fn.calls = calls
  return fn
}

/** 一个 body 通过 reader 流式返回、总大小超上限的 mock Response（测 too-large）。 */
function hugeBodyResponse(sizeBytes) {
  const chunkLen = 64 * 1024
  let remaining = sizeBytes
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (remaining <= 0) return { done: true, value: undefined }
          const n = Math.min(chunkLen, remaining)
          remaining -= n
          return { done: false, value: new Uint8Array(n) }
        },
        cancel: async () => {},
      }),
    },
    text: async () => '{}',
    json: async () => ({}),
  }
}

describe('适配器模块导出（冒烟）', () => {
  it('导出 readAccount 函数与 SCHEMES 注册表', () => {
    expect(typeof readAccount).toBe('function')
  })

  it('SCHEMES 注册 deepseek / newapi / sub2api 三类 reader', () => {
    expect(SCHEMES).toHaveProperty('deepseek')
    expect(SCHEMES).toHaveProperty('newapi')
    expect(SCHEMES).toHaveProperty('sub2api')
  })
})

describe('newapi 适配器', () => {
  it('正常 key：quota_per_unit 折算 USD，name→keyName，expires_at→expiresAt', async () => {
    // 1/perUnit = 1/1e6；total_available=3e6 → 3.000000 USD；used=1e6 → 1.0；granted=4e6 → 4.0
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { name: 'key-1', total_granted: 4000000, total_used: 1000000, total_available: 3000000, unlimited_quota: false, expires_at: 1786634961 } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 1000000, display_in_currency: true, quota_display_type: 'CNY' } }) },
    ])

    const result = await readAccount({ type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', fetch })

    expect(result.ok).toBe(true)
    expect(result.currency).toBe('USD')
    // 余额态 = 用户余额（/api/user/self）。未配置访问令牌时 total 缺省，
    // 由 UI 弹窗引导用户配置；token 使用额度字段保持不变。
    expect(result.total).toBeUndefined()
    expect(result.userTokenConfigured).toBe(false)
    expect(result.granted).toBeCloseTo(4.0, 6)
    expect(result.used).toBeCloseTo(1.0, 6)
    expect(result.keyName).toBe('key-1')
    expect(result.expiresAt).toBe(1786634961)
    expect(result.provider).toBe('newapi')
  })

  it('unlimited_quota=true 且 total_available 为负：只输出已用，绝不输出负余额', async () => {
    const fetch = routeFetch([
      // 假余额：total_available 从 0 递减，等于负的用量，是不限额 key 的典型陷阱。
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { name: 'unlimited-key', total_granted: 0, total_used: 14383915, total_available: -14383915, unlimited_quota: true } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000 } }) },
    ])

    const result = await readAccount({ type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', fetch })

    expect(result.ok).toBe(true)
    expect(result.unlimited).toBe(true)
    expect(result.total).toBeUndefined() // 不显示 total_available（负的假余额）
    expect(result.granted).toBeUndefined()
    expect(result.used).toBeCloseTo(28.76783, 6) // 已用：14383915 × (1/500000) 折算 USD
  })

  it('success:false 信封（HTTP 200 拒绝）→ 归为 upstream 错误', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: false, message: 'Invalid token' }, { status: 200 }) },
    ])

    const result = await readAccount({ type: 'newapi', baseUrl: RELAY, credential: 'sk-bad', fetch })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^upstream-/)
  })

  it('缺 quota_per_unit → 配额整数回退（不折算、currency 缺省）', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_granted: 4000000, total_used: 1000000, total_available: 3000000, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: null } }) },
    ])

    const result = await readAccount({ type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', fetch })

    expect(result.ok).toBe(true)
    expect(result.total).toBeUndefined() // 余额态无用户令牌 → 缺省
    expect(result.granted).toBe(4000000)
    expect(result.used).toBe(1000000)
    expect(result.currency).toBeUndefined()
  })

  it('请求路径末尾斜杠必须保留（api/usage/token/，而非 api/usage/token）', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_available: 1, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 1000000 } }) },
    ])

    await readAccount({ type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', fetch })

    expect(fetch.calls.some((c) => c.url === `${RELAY}/api/usage/token/`)).toBe(true)
    expect(fetch.calls.some((c) => c.url === `${RELAY}/api/usage/token`)).toBe(false)
  })

  it('API key 只通过 Authorization 头下发；status 匿名请求不带 Authorization', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_available: 1, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 1000000 } }) },
    ])

    await readAccount({ type: 'newapi', baseUrl: RELAY, credential: 'sk-secret', fetch })

    const tokenCall = fetch.calls.find((c) => c.url.includes('/api/usage/token/'))
    expect(tokenCall.headers.authorization).toBe('Bearer sk-secret')

    const statusCall = fetch.calls.find((c) => c.url.includes('/api/status'))
    expect(statusCall.headers.authorization).toBeUndefined()
  })
})

describe('sub2api 适配器', () => {
  it('配额形态：quota + rate_limits，归一化 session→daily→weekly 窗口', async () => {
    const fetch = routeFetch([
      {
        match: '/v1/usage',
        response: jsonResponse({
          isValid: true, status: 'ok', unit: 'USD',
          quota: { limit: 100, used: 30, remaining: 70 },
          rate_limits: [
            // 故意乱序，验证窗口归一化顺序为 session→daily→weekly
            { window: '1d', used: 1, limit: 5, reset_at: '2026-08-17T23:59:59.000Z' },
            { window: '7d', used: 3, limit: 20, reset_at: '2026-08-24T00:00:00.000Z' },
            { window: '5h', used: 5, limit: 10, reset_at: '2026-08-17T04:00:00.000Z' },
          ],
        }),
      },
    ])

    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })

    expect(result.ok).toBe(true)
    expect(result.currency).toBe('USD')
    expect(result.total).toBe(70)
    expect(result.granted).toBe(100)
    expect(result.used).toBe(30)
    expect(result.unlimited).toBeFalsy()

    const kinds = result.windows.map((w) => w.kind)
    expect(kinds).toEqual(['session', 'daily', 'weekly'])
    expect(result.windows[0]).toMatchObject({ kind: 'session', used: 5, limit: 10 })
    expect(result.windows[1]).toMatchObject({ kind: 'daily', used: 1, limit: 5 })
    expect(result.windows[2]).toMatchObject({ kind: 'weekly', used: 3, limit: 20 })
  })

  it('订阅形态：subscription 且 remaining=-1 → 不限额，含日/周/月周期，weekly 重置=window_start+7d', async () => {
    const fetch = routeFetch([
      {
        match: '/v1/usage',
        response: jsonResponse({
          isValid: true, status: 'ok', unit: 'USD', remaining: -1,
          subscription: {
            daily_usage_usd: 1, daily_limit_usd: 10,
            weekly_usage_usd: 2, weekly_limit_usd: 50,
            weekly_window_start: '2026-08-17T00:00:00.000Z',
            monthly_usage_usd: 3, monthly_limit_usd: 100,
          },
        }),
      },
    ])

    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })

    expect(result.ok).toBe(true)
    expect(result.unlimited).toBe(true)
    expect(result.total).toBeUndefined()

    const daily = result.windows.find((w) => w.kind === 'daily')
    const weekly = result.windows.find((w) => w.kind === 'weekly')
    const monthly = result.windows.find((w) => w.kind === 'monthly')

    expect(daily).toMatchObject({ kind: 'daily', used: 1, limit: 10 })
    expect(daily.resetsAt).toBeUndefined()
    expect(weekly).toMatchObject({ kind: 'weekly', used: 2, limit: 50 })
    // 周窗口的重置时间 = weekly_window_start + 7 天
    expect(weekly.resetsAt).toBe(new Date(Date.parse('2026-08-17T00:00:00.000Z') + WEEK_MS).toISOString())
    expect(monthly).toMatchObject({ kind: 'monthly', used: 3, limit: 100 })
    expect(monthly.resetsAt).toBeUndefined()

    const kinds = result.windows.map((w) => w.kind)
    expect(kinds).toEqual(['daily', 'weekly', 'monthly'])
  })

  it('钱包形态：balance/unit 直接展示', async () => {
    const fetch = routeFetch([
      {
        match: '/v1/usage',
        response: jsonResponse({
          balance: 4.76803348, remaining: 4.76803348, unit: 'USD',
          isValid: true, status: 'ok', planName: '钱包余额',
        }),
      },
    ])

    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })

    expect(result.ok).toBe(true)
    expect(result.currency).toBe('USD')
    expect(result.total).toBeCloseTo(4.76803348, 8)
    expect(result.unlimited).toBeFalsy()
    expect(result.windows).toBeUndefined() // 无订阅/限流窗口
  })

  it('status=quota_exhausted → 标记账户不可用', async () => {
    const fetch = routeFetch([
      {
        match: '/v1/usage',
        response: jsonResponse({
          balance: 0, remaining: 0, unit: 'USD', isValid: true,
          status: 'quota_exhausted', planName: '钱包余额',
        }),
      },
    ])

    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })
    expect(result.isAvailable).toBe(false)
  })

  it('status=expired → 标记账户不可用', async () => {
    const fetch = routeFetch([
      {
        match: '/v1/usage',
        response: jsonResponse({
          balance: 5, remaining: 5, unit: 'USD', isValid: true,
          status: 'expired', planName: '钱包余额',
        }),
      },
    ])

    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })
    expect(result.isAvailable).toBe(false)
  })

  it('isValid=false → 标记账户不可用', async () => {
    const fetch = routeFetch([
      {
        match: '/v1/usage',
        response: jsonResponse({ balance: 5, remaining: 5, unit: 'USD', isValid: false, status: 'ok' }),
      },
    ])

    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })
    expect(result.isAvailable).toBe(false)
  })
})

describe('deepseek 适配器', () => {
  it('CNY>0 优先：即使存在更大的其它币种余额，仍选 CNY', async () => {
    const fetch = routeFetch([
      {
        match: '/user/balance',
        response: jsonResponse({
          is_available: true,
          balance_infos: [
            { currency: 'USD', total_balance: 500 },
            { currency: 'CNY', total_balance: 100 },
          ],
        }),
      },
    ])

    const result = await readAccount({ type: 'deepseek', baseUrl: DEEPSEEK, credential: 'sk-official', fetch })
    expect(result.ok).toBe(true)
    expect(result.currency).toBe('CNY')
    expect(result.total).toBe(100)
  })

  it('CNY 不为正时回退到 >0 的其它币种', async () => {
    const fetch = routeFetch([
      {
        match: '/user/balance',
        response: jsonResponse({
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: 0 },
            { currency: 'USD', total_balance: 500 },
          ],
        }),
      },
    ])

    const result = await readAccount({ type: 'deepseek', baseUrl: DEEPSEEK, credential: 'sk-official', fetch })
    expect(result.currency).toBe('USD')
    expect(result.total).toBe(500)
  })

  it('所有币种皆非正时，按现有 pickBalanceInfo 规则仍选 CNY（保留负值，锁定官方老逻辑）', async () => {
    const fetch = routeFetch([
      {
        match: '/user/balance',
        response: jsonResponse({
          is_available: true,
          balance_infos: [
            { currency: 'USD', total_balance: 0 },
            { currency: 'CNY', total_balance: -1 },
          ],
        }),
      },
    ])

    const result = await readAccount({ type: 'deepseek', baseUrl: DEEPSEEK, credential: 'sk-official', fetch })
    // 现有 pickBalanceInfo：CNY>0 → 任意>0 → 任意 CNY（含负值）→ 首项。
    // 本例前两条皆不命中，故命中第三条「任意 CNY」，返回 -1。
    expect(result.total).toBe(-1)
  })
})

describe('异常与健壮性', () => {
  it('timeout：fetch 抛 AbortError → 错误码 timeout', async () => {
    const fetch = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('timeout')
  })

  it('跨 origin 重定向：302 指向不同域名 → 立即中止为 cross-origin-redirect', async () => {
    const fetch = routeFetch([
      {
        match: '/v1/usage',
        response: jsonResponse({}, { status: 302, location: 'https://collector.evil.example/steal' }),
      },
    ])
    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('cross-origin-redirect')
  })

  it('非 JSON：html 响应 → invalid-response', async () => {
    const fetch = routeFetch([
      {
        match: '/v1/usage',
        response: {
          ok: true, status: 200,
          headers: { get: () => null },
          json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
          text: async () => '<html>gateway error</html>',
          body: undefined,
        },
      },
    ])
    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid-response')
  })

  it('响应体超 256KB → too-large，不解析', async () => {
    const fetch = routeFetch([
      { match: '/v1/usage', response: hugeBodyResponse(300 * 1024) },
    ])
    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('too-large')
  })

  it('HTTP 401：提示站点需要普通 API key（http-401）', async () => {
    const fetch = routeFetch([
      { match: '/v1/usage', response: jsonResponse({}, { status: 401 }) },
    ])
    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-bad', fetch })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('http-401')
  })
})

describe('窗口归一化顺序', () => {
  it('跨 4 种来源（quota + 订阅）混合时统一排序为 session→daily→weekly→monthly', async () => {
    const fetch = routeFetch([
      {
        match: '/v1/usage',
        response: jsonResponse({
          isValid: true, status: 'ok', unit: 'USD', remaining: -1,
          rate_limits: [
            { window: '5h', used: 2, limit: 10, reset_at: '2026-08-17T03:00:00.000Z' },
            { window: '1d', used: 3, limit: 50 },
            { window: '7d', used: 4, limit: 200 },
          ],
          subscription: {
            daily_usage_usd: 3, daily_limit_usd: 50,
            weekly_usage_usd: 4, weekly_limit_usd: 200,
            weekly_window_start: '2026-08-17T00:00:00.000Z',
            monthly_usage_usd: 5, monthly_limit_usd: 1000,
          },
        }),
      },
    ])

    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })
    const kinds = result.windows.map((w) => w.kind)
    expect(kinds).toEqual(['session', 'daily', 'weekly', 'monthly'])
  })

  it('limit 为 null 的周期不产出窗口（不展示不设限周期）', async () => {
    const fetch = routeFetch([
      {
        match: '/v1/usage',
        response: jsonResponse({
          isValid: true, status: 'ok', unit: 'USD', remaining: -1,
          subscription: {
            daily_usage_usd: 1, daily_limit_usd: null,
            weekly_usage_usd: 2, weekly_limit_usd: 50,
            weekly_window_start: '2026-08-17T00:00:00.000Z',
            monthly_usage_usd: 3, monthly_limit_usd: 100,
          },
        }),
      },
    ])

    const result = await readAccount({ type: 'sub2api', baseUrl: RELAY, credential: 'key-1', fetch })
    const kinds = result.windows.map((w) => w.kind)
    expect(kinds).toEqual(['weekly', 'monthly'])
  })
})

describe('newapi 用户余额（/api/user/self + 访问令牌 + 用户 ID）', () => {
  // 契约：GET /api/user/self，Authorization: Bearer <系统访问令牌>，
  // New-Api-User: <用户ID>。data.quota = 用户余额（÷ quota_per_unit = 网站额度），
  // data.used_quota = 已使用量。实测站点：api.hohai.eu.org（2026-08-24）。
  const USER_SELF = {
    success: true,
    data: { id: 1, username: 'user', quota: 3000000, used_quota: 1000000, request_count: 10 },
  }

  it('带 userToken+userId：Bearer 令牌 + New-Api-User 头；total=用户余额（站点币种）', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { name: 'key-1', total_granted: 4000000, total_used: 1000000, total_available: 3000000, unlimited_quota: false, expires_at: 1786634961 } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY' } }) },
      { match: '/api/user/self', response: jsonResponse(USER_SELF) },
    ])

    const result = await readAccount({
      type: 'newapi', baseUrl: RELAY, credential: 'sk-abc',
      userToken: 'ak-user-token', userId: '1',
      fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.userTokenConfigured).toBe(true)
    // data.quota(3000000) ÷ quota_per_unit(500000) = 6 用户余额
    expect(result.total).toBeCloseTo(6, 6)
    // 用户余额自身币种 = 站点 quota_display_type（CNY）
    expect(result.balanceCurrency).toBe('CNY')
    // token 接口的使用额度字段不变
    expect(result.used).toBeCloseTo(2, 6)
    expect(result.granted).toBeCloseTo(8, 6)
    expect(result.keyName).toBe('key-1')

    const selfCall = fetch.calls.find((c) => c.url.includes('/api/user/self'))
    expect(selfCall.headers.authorization).toBe('Bearer ak-user-token')
    expect(selfCall.headers['New-Api-User']).toBe('1')

    const tokenCall = fetch.calls.find((c) => c.url.includes('/api/usage/token/'))
    expect(tokenCall.headers.authorization).toBe('Bearer sk-abc') // 普通 key 仍走 token 接口
  })

  it('缺 userToken：不请求 /api/user/self；userTokenConfigured=false、total 缺省', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_granted: 4000000, total_used: 1000000, total_available: 3000000, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000 } }) },
    ])

    const result = await readAccount({ type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', fetch })

    expect(result.ok).toBe(true)
    expect(result.userTokenConfigured).toBe(false)
    expect(result.total).toBeUndefined()
    expect(result.used).toBeCloseTo(2, 6)
    expect(fetch.calls.some((c) => c.url.includes('/api/user/self'))).toBe(false)
  })

  it('user/self 信封拒绝（success:false）→ ok 仍 true，userBalanceError=upstream-*，total 缺省', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_used: 1000000, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000 } }) },
      { match: '/api/user/self', response: jsonResponse({ success: false, message: '无效的访问令牌' }, { status: 200 }) },
    ])

    const result = await readAccount({
      type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', userToken: 'ak-bad', fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.total).toBeUndefined()
    expect(result.used).toBeCloseTo(2, 6)
    expect(result.userBalanceError).toMatch(/^upstream-/)
  })

  it('user/self HTTP 401 → userBalanceError=http-401，token 数据仍正常', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_used: 1000000, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000 } }) },
      { match: '/api/user/self', response: jsonResponse({}, { status: 401 }) },
    ])

    const result = await readAccount({
      type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', userToken: 'ak-bad', fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.userBalanceError).toBe('http-401')
    expect(result.used).toBeCloseTo(2, 6)
  })

  it('userToken 带 "Bearer " 前缀/空白：自动剥除，Authorization 只发单 Bearer', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_used: 1000000, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY' } }) },
      { match: '/api/user/self', response: jsonResponse(USER_SELF) },
    ])

    const result = await readAccount({
      type: 'newapi', baseUrl: RELAY, credential: 'sk-abc',
      userToken: 'Bearer  ak-user-token ', userId: '1',
      fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.total).toBeCloseTo(6, 6)
    const selfCall = fetch.calls.find((c) => c.url.includes('/api/user/self'))
    expect(selfCall.headers.authorization).toBe('Bearer ak-user-token')
    expect(selfCall.headers['New-Api-User']).toBe('1')
  })

  it('用户 unlimited_quota=true → userUnlimited=true、total 缺省（不显示假余额）', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_used: 1000000, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000 } }) },
      { match: '/api/user/self', response: jsonResponse({ success: true, data: { id: 1, quota: 9999999, used_quota: 1, unlimited_quota: true } }) },
    ])

    const result = await readAccount({
      type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', userToken: 'ak-unlimited', fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.userUnlimited).toBe(true)
    expect(result.total).toBeUndefined()
  })

  it('status 被限流拒绝 + scaleFallback：用缓存换算率换算金额（不显示天文数字）', async () => {
    // 实测 bug：/api/status 被 gate 拒掉后 scale 丢失，used 以原始配额整数
    // 展示（如 65755622.00）。有缓存换算率时必须照常换算。
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_granted: 4000000, total_used: 1000000, total_available: 3000000, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY' } }) },
      { match: '/api/user/self', response: jsonResponse(USER_SELF) },
    ])
    let n = 0
    const result = await readAccount({
      type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', userToken: 'ak-user-token',
      // token 放行、status 与 user/self 拒绝（gate 中途耗尽）
      guard: () => { n++; return n < 2 },
      scaleFallback: { scale: 1 / 500000, siteCurrency: 'CNY' },
      fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.userBalanceError).toBe('rate-limited') // user/self 仍被拒，余额缺省
    expect(result.used).toBeCloseTo(2, 6) // 1000000 × (1/500000)，不是 1000000.00
    expect(result.granted).toBeCloseTo(8, 6)
    expect(result.currency).toBe('USD')
  })

  it('status 成功且拿到换算率：结果带 statusScale 供宿主缓存', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_used: 1000000, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY' } }) },
      { match: '/api/user/self', response: jsonResponse(USER_SELF) },
    ])

    const result = await readAccount({
      type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', userToken: 'ak-user-token', fetch,
    })

    expect(result.statusScale).toEqual({ scale: 1 / 500000, siteCurrency: 'CNY' })
  })

  it('token 级 unlimited_quota=true 但用户有真实余额：total 仍给出用户余额（余额态不被已用盖掉）', async () => {
    // 实测场景（api.hohai.eu.org）：sk- key 不限额度（used=123.28），
    // 用户钱包有真实余额（quota=40.93 CNY）；余额态必须显示用户余额。
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { name: 'dsh', total_granted: 0, total_used: 61640429, total_available: -61640429, unlimited_quota: true } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY' } }) },
      { match: '/api/user/self', response: jsonResponse(USER_SELF) },
    ])

    const result = await readAccount({
      type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', userToken: 'ak-user-token', fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.unlimited).toBe(true) // token 级不限额（已用配额态的依据）
    expect(result.userUnlimited).toBeFalsy()
    expect(result.total).toBeCloseTo(6, 6) // 用户余额仍给出
    expect(result.balanceCurrency).toBe('CNY')
    expect(result.used).toBeCloseTo(123.280858, 6) // 已用口径不变
  })

  it('currencyOptions：站点币种（quota_display_type）与配额原值两个变体', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_used: 1000000, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY' } }) },
      { match: '/api/user/self', response: jsonResponse(USER_SELF) },
    ])

    const result = await readAccount({
      type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', userToken: 'ak-user-token', fetch,
    })

    expect(result.currencyOptions).toEqual([
      { key: 'site', label: 'CNY', value: 6, currency: 'CNY' },
      { key: 'raw', label: '配额原值', value: 3000000, currency: '' },
    ])
  })
})

describe('查询限流（自适应：默认 15 次 / 5 分钟 + 429 retry-after 学习）', () => {
  it('createRateLimiter 缺省上限 = 15（按实测 60/20min 折算）', () => {
    const guard = createRateLimiter()
    expect(guard.max('https://relay.example.com')).toBe(15)
  })

  it('createRateLimiter：窗口内超限拒绝，按 origin 隔离，窗口滚动后恢复', () => {
    let t = 0
    const guard = createRateLimiter({ windowMs: 300000, max: 60, now: () => t })
    for (let i = 0; i < 60; i++) expect(guard('https://relay.example.com')).toBe(true)
    expect(guard('https://relay.example.com')).toBe(false) // 第 61 次超限
    expect(guard('https://other.example.com')).toBe(true) // 不同站点互不影响
    t += 300001
    expect(guard('https://relay.example.com')).toBe(true) // 窗口滚动后恢复
  })

  it('setMax：按 origin 收紧上限立即生效；stats 报告 used/max/remaining/learned', () => {
    const guard = createRateLimiter({ windowMs: 300000, max: 15 })
    guard.setMax('https://relay.example.com', 5)
    for (let i = 0; i < 5; i++) expect(guard('https://relay.example.com')).toBe(true)
    expect(guard('https://relay.example.com')).toBe(false) // 第 6 次超限
    expect(guard.max('https://relay.example.com')).toBe(5)
    expect(guard.max('https://other.example.com')).toBe(15) // 其它 origin 不受影响
    expect(guard('https://other.example.com')).toBe(true)
    expect(guard.stats()['https://relay.example.com']).toEqual({ used: 5, max: 5, remaining: 0, learned: true })
    expect(guard.stats()['https://other.example.com']).toEqual({ used: 1, max: 15, remaining: 14, learned: false })
  })

  it('historyCount：只统计窗口内的请求（自适应学习样本来源）', () => {
    let t = 1000000
    const guard = createRateLimiter({ windowMs: 300000, max: 100, now: () => t })
    for (let i = 0; i < 10; i++) guard('https://relay.example.com')
    t += 600000
    for (let i = 0; i < 4; i++) guard('https://relay.example.com')
    expect(guard.historyCount('https://relay.example.com', 300000)).toBe(4) // 只算最近 5 分钟
    expect(guard.historyCount('https://relay.example.com', 900000)).toBe(14)
    expect(guard.historyCount('https://none.example.com', 300000)).toBe(0)
  })

  it('learnRateLimitCap：按 retry-after 窗口内的实际请求数折算 5 分钟上限（×0.8 余量）', () => {
    // 实测 hohai：20 分钟窗口内 60 次后 429 → 60 × 5/20 × 0.8 = 12 次/5 分钟
    expect(learnRateLimitCap(60, 1200000)).toEqual({ learned: true, per5min: 12 })
    expect(learnRateLimitCap(61, 1200000)).toEqual({ learned: true, per5min: 12 })
    expect(learnRateLimitCap(60, 1200000, 600000)).toEqual({ learned: true, per5min: 24 })
    // 样本不足 / 非法输入：不学习
    expect(learnRateLimitCap(4, 1200000)).toEqual({ learned: false })
    expect(learnRateLimitCap(10, 0)).toEqual({ learned: false })
    expect(learnRateLimitCap(Number.NaN, 1200000)).toEqual({ learned: false })
  })

  it('readAccount 带 guard：起点超限 → error=rate-limited，且不再发任何请求', async () => {
    let calls = 0
    const fetch = async () => { calls++; return jsonResponse({}) }
    const result = await readAccount({
      type: 'newapi', baseUrl: RELAY, credential: 'sk-abc',
      guard: () => false,
      fetch,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('rate-limited')
    expect(calls).toBe(0)
  })

  it('readAccount 带 guard：中途耗尽 → 仅 user/self 失败，token 数据仍在', async () => {
    const fetch = routeFetch([
      { match: '/api/usage/token/', response: jsonResponse({ success: true, data: { total_granted: 4000000, total_used: 1000000, total_available: 3000000, unlimited_quota: false } }) },
      { match: '/api/status', response: jsonResponse({ success: true, data: { quota_per_unit: 500000 } }) },
      { match: '/api/user/self', response: jsonResponse({ success: true, data: { quota: 3000000 } }) },
    ])
    let n = 0
    const result = await readAccount({
      type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', userToken: 'ak-1',
      guard: () => { n++; return n < 3 }, // token + status 放行，user/self 拒绝
      fetch,
    })
    expect(result.ok).toBe(true)
    expect(result.userBalanceError).toBe('rate-limited')
    expect(result.total).toBeUndefined()
    expect(result.used).toBeCloseTo(2, 6)
  })

  it('站点 429 带 retry-after：error=http-429 且 retryAfterMs 按秒换算（供负缓存时长）', async () => {
    const fetch = routeFetch([
      {
        match: '/api/usage/token/',
        response: {
          ok: false,
          status: 429,
          headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? '1200' : null) },
          json: async () => ({}),
          text: async () => '{}',
          body: undefined,
        },
      },
    ])

    const result = await readAccount({ type: 'newapi', baseUrl: RELAY, credential: 'sk-abc', fetch })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('http-429')
    expect(result.retryAfterMs).toBe(1200000) // 1200 秒 → 20 分钟
  })
})
