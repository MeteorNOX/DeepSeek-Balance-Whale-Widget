/**
 * probe-rate-limit.mjs —— 站点 429 限流阈值探测
 *
 * 目的：实测「连续读接口多少次后会触发 429」，用于校准挂件的
 * rateLimitMax（默认 20 次/5 分钟）。
 *
 * 用法（在仓库根目录执行）：
 *   node probe-rate-limit.mjs
 *   node probe-rate-limit.mjs --mode token      # 只打 /api/usage/token/
 *   node probe-rate-limit.mjs --mode self       # 只打 /api/user/self
 *   node probe-rate-limit.mjs --mode status     # 只打 /api/status（匿名）
 *   node probe-rate-limit.mjs --mode mixed      # 默认：轮流打 token→status→self（最接近挂件行为）
 *   node probe-rate-limit.mjs --base https://api.hohai.eu.org --max 300 --delay 20
 *
 * 可选参数：
 *   --base <url>   站点地址（默认 https://api.hohai.eu.org）
 *   --mode <m>     mixed | token | status | self（默认 mixed）
 *   --max <n>      最多请求次数（默认 300，防跑飞）
 *   --delay <ms>   每次请求间隔毫秒（默认 20）
 *   --key <name>   token 模式使用的 sk- 凭据名（默认 HOHAI_API_KEY，备选 NEWAPI_API_KEY）
 *   --user-token-name <name>   self 模式访问令牌凭据名（默认 NEWAPI_USER_TOKEN）
 *   --user-id-name <name>      self 模式用户 ID 凭据名（默认 NEWAPI_USER_ID）
 *   --list     只做预检：列出将使用的端点与凭据配置状态（不发任何请求）
 *   --help         显示本说明
 *
 * 安全：凭据从 DSH 凭据服务文件（$DSH_HOME/.credentials.yaml 或
 *   ~/.dsh/.credentials.yaml，或环境变量）读取，仅用于 Authorization 头，
 *   任何密钥值都不会打印到屏幕或写入结果文件。
 *
 * 输出：进度行 + 触发 429 的序号/retry-after + 汇总 JSON，
 *   并写入 probe-rate-limit.result.json（无凭据内容）。
 */

import fs from 'node:fs'
import path from 'node:path'

const ARGS = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--help' || a === '-h') {
    console.log('用法: node probe-rate-limit.mjs [--base <url>] [--mode mixed|token|status|self] [--max <n>] [--delay <ms>] [--key <name>] [--user-token-name <name>] [--user-id-name <name>]')
    process.exit(0)
  }
  if (a.startsWith('--')) {
    const next = process.argv[i + 1]
    if (next === undefined || next.startsWith('--')) ARGS[a.slice(2)] = true
    else { ARGS[a.slice(2)] = next; i++ }
  }
}

const BASE = String(ARGS.base || 'https://api.hohai.eu.org').replace(/\/+$/, '')
const MODE = ARGS.mode || 'mixed'
const MAX = Math.max(1, Math.min(10000, Number(ARGS.max) || 300))
const DELAY_MS = Math.max(0, Number(ARGS.delay) || 20)
const KEY_NAME = ARGS.key || 'HOHAI_API_KEY'
const USER_TOKEN_NAME = ARGS['user-token-name'] || 'NEWAPI_USER_TOKEN'
const USER_ID_NAME = ARGS['user-id-name'] || 'NEWAPI_USER_ID'

/** 从 DSH 凭据服务读取一个凭据引用的值（env 优先，其次文件）。不打印。 */
function readCredential(name) {
  if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name]
  const files = []
  // 与 dsh-credentials-local 的分层一致：$DSH_HOME/.credentials.yaml 优先，
  // 其次 ~/.dsh/.credentials.yaml
  if (process.env.DSH_HOME) files.push(path.join(process.env.DSH_HOME, '.credentials.yaml'))
  if (process.env.USERPROFILE) files.push(path.join(process.env.USERPROFILE, '.dsh', '.credentials.yaml'))
  for (const f of files) {
    try {
      const text = fs.readFileSync(f, 'utf8')
      const m = text.match(new RegExp('^\\s*' + name + '\\s*:\\s*["\']?([^"\'\\s#]+)', 'm'))
      if (m && m[1]) return m[1]
    } catch { /* 下一个候选 */ }
  }
  return undefined
}

const API_KEY = readCredential(KEY_NAME) || readCredential('NEWAPI_API_KEY')
const USER_TOKEN = readCredential(USER_TOKEN_NAME)
const USER_ID = readCredential(USER_ID_NAME)

/** 按模式列出要轮询的端点（含请求头）。mixed 依次轮询各端点。 */
function buildEndpoints() {
  const eps = []
  const pushToken = () => {
    if (!API_KEY) return false
    eps.push({
      name: 'usage/token',
      url: `${BASE}/api/usage/token/`,
      headers: { authorization: `Bearer ${API_KEY}`, accept: 'application/json' },
    })
    return true
  }
  const pushStatus = () => {
    eps.push({ name: 'status', url: `${BASE}/api/status`, headers: { accept: 'application/json' } })
    return true
  }
  const pushSelf = () => {
    if (!USER_TOKEN) return false
    eps.push({
      name: 'user/self',
      url: `${BASE}/api/user/self`,
      headers: {
        authorization: `Bearer ${USER_TOKEN}`,
        accept: 'application/json',
        ...(USER_ID ? { 'New-Api-User': USER_ID } : {}),
      },
    })
    return true
  }
  if (MODE === 'token') { pushToken(); return eps }
  if (MODE === 'status') { pushStatus(); return eps }
  if (MODE === 'self') { pushSelf(); return eps }
  // mixed：与挂件行为一致，轮流 token → status → self（缺凭据的自动跳过）
  pushToken()
  pushStatus()
  pushSelf()
  return eps
}

const ENDPOINTS = buildEndpoints()
if (ARGS.list) {
  console.log(JSON.stringify({
    base: BASE,
    mode: MODE,
    max: MAX,
    delayMs: DELAY_MS,
    credentialStatus: {
      [KEY_NAME]: API_KEY ? `已找到(长度 ${API_KEY.length})` : '未找到',
      NEWAPI_API_KEY: API_KEY ? '—' : (readCredential('NEWAPI_API_KEY') ? `已找到(长度 ${readCredential('NEWAPI_API_KEY').length})` : '未找到'),
      [USER_TOKEN_NAME]: USER_TOKEN ? `已找到(长度 ${USER_TOKEN.length})` : '未找到',
      [USER_ID_NAME]: USER_ID ? `已找到(长度 ${USER_ID.length})` : '未找到',
    },
    endpoints: ENDPOINTS.map((e) => e.name),
  }, null, 2))
  process.exit(0)
}
if (ENDPOINTS.length === 0) {
  console.error('未找到可用凭据/端点。请确认凭据服务中已配置相关凭据。')
  process.exit(2)
}
console.log(`[probe] base=${BASE} mode=${MODE} max=${MAX} delay=${DELAY_MS}ms`)
console.log(`[probe] 轮询端点: ${ENDPOINTS.map((e) => e.name).join(' → ')}`)
console.log('[probe] 开始连续请求，遇到 429 / 401 / 403 立即停止…')

const counts = {} // status -> n
const byEndpoint = {} // name -> { status -> n }
let stopped = false
let stopReason = ''
let totalSent = 0
const t0 = Date.now()

function record(name, status) {
  counts[status] = (counts[status] || 0) + 1
  byEndpoint[name] = byEndpoint[name] || {}
  byEndpoint[name][status] = (byEndpoint[name][status] || 0) + 1
}

for (let i = 0; i < MAX && !stopped; i++) {
  const ep = ENDPOINTS[i % ENDPOINTS.length]
  totalSent++
  try {
    const res = await fetch(ep.url, { headers: ep.headers, signal: AbortSignal.timeout(15000) })
    const status = res.status
    record(ep.name, status)
    if (status === 429 || status === 401 || status === 403) {
      let bodyNote = ''
      try {
        const t = (await res.text()).slice(0, 120)
        if (t) bodyNote = ' | body: ' + t
      } catch { /* body 读取失败无妨 */ }
      const retryAfter = typeof res.headers?.get === 'function' ? (res.headers.get('retry-after') ?? '无') : '无'
      console.log(`[${status}] 第 ${totalSent} 次请求触发（端点 ${ep.name}）retry-after=${retryAfter}${bodyNote}`)
      stopReason = status
      stopped = true
      break
    }
    if ((i + 1) % 10 === 0) console.log(`… ${totalSent} 次完成，最近状态 ${status}`)
  } catch (e) {
    record(ep.name, 'network')
    const msg = String(e && e.message ? e.message : e).slice(0, 80)
    console.log(`[network] 第 ${totalSent} 次请求网络错误（${ep.name}）: ${msg}`)
    if (String(e && e.name) === 'TimeoutError') {
      // 超时不是限流；继续但提示
    }
  }
  if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS))
}

const seconds = Number(((Date.now() - t0) / 1000).toFixed(1))
const summary = {
  base: BASE,
  mode: MODE,
  max: MAX,
  totalSent,
  stopped,
  stopReason: stopReason || `未触发（达到上限 ${MAX}）`,
  seconds,
  counts,
  byEndpoint,
}
console.log('')
console.log('=== 汇总 ===')
console.log(JSON.stringify(summary, null, 2))

const outFile = 'probe-rate-limit.result.json'
try {
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf8')
  console.log(`结果已写入 ${outFile}`)
} catch { /* 写盘失败仅提示 */ }
