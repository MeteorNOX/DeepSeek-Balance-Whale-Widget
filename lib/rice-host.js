import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Package root: lib/rice-host.js -> package root (same dir as lib/index.js)
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 平台侧接口
export const PLATFORM_API = 'https://platform.deepseek.com'

// 白饭图标素材 — 三态：满碗 / 半碗 / 空碗（Issue #34）
export const RICE_CANDIDATES = {
  full: [path.join(PACKAGE_ROOT, 'assets', 'rice', 'full.png')],
  half: [path.join(PACKAGE_ROOT, 'assets', 'rice', 'half.png')],
  empty: [path.join(PACKAGE_ROOT, 'assets', 'rice', 'empty.png')],
}

// 白饭档位解析：?level=full|half|empty，非法或缺省回退 full
export function riceLevelFromUrl(url) {
  try {
    const q = String(url || '').split('?')[1] || ''
    const m = /(?:^|&)level=([^&]+)/.exec(q)
    const v = m ? decodeURIComponent(m[1]) : ''
    return v === 'half' || v === 'empty' ? v : 'full'
  } catch (err) { return 'full' }
}

// 平台请求头（与官网前端一致的客户端标识）
export function platformHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'zh_CN',
    'x-client-platform': 'web',
    'x-client-version': '1.0.0',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  }
}

// 白饭图标读取（带内存缓存）
const riceBytesCache = {}
export function loadRice(level) {
  const key = level === 'half' || level === 'empty' ? level : 'full'
  if (riceBytesCache[key]) return riceBytesCache[key]
  const candidates = RICE_CANDIDATES[key] || RICE_CANDIDATES.full
  for (const p of candidates) {
    try {
      const bytes = fs.readFileSync(p)
      if (bytes && bytes.length > 0) {
        riceBytesCache[key] = bytes
        return bytes
      }
    } catch (err) {}
  }
  throw new Error('rice image not found: ' + key)
}

// —— 平台余额预警阈值（Issue #34 白饭图标档位参照）——
// 读取 DeepSeek 平台 users/current 的 balance_alert[币种]，60 秒内存缓存
let alertCache = null
export async function fetchAlertConfig(ctx) {
  const now = Date.now()
  if (alertCache && now - alertCache.at < 60000) return alertCache.payload
  let cred
  try {
    cred = await ctx.credentials.resolve('DEEPSEEK_PLATFORM_TOKEN')
  } catch (err) {
    return { ok: false, code: 'NO_TOKEN', error: '平台令牌读取失败' }
  }
  if (!cred) return { ok: false, code: 'NO_TOKEN', error: '未配置 DEEPSEEK_PLATFORM_TOKEN' }
  const token = String(cred.value).replace(/^Bearer\s+/i, '')
  let res
  try {
    res = await fetch(PLATFORM_API + '/auth-api/v0/users/current', {
      headers: platformHeaders(token),
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    return { ok: false, code: 'NET', transient: true, error: String((err && err.message) || err).slice(0, 120) }
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      alertCache = null
      return { ok: false, code: 'TOKEN_EXPIRED', error: '令牌过期，请重新获取' }
    }
    return { ok: false, code: 'HTTP', error: '平台接口 HTTP ' + res.status }
  }
  let data
  try {
    data = await res.json()
  } catch (err) {
    return { ok: false, code: 'PARSE', error: '平台接口返回异常' }
  }
  const bizData = data && data.data && data.data.biz_data
  if (!bizData || typeof bizData.currency !== 'string') {
    return { ok: false, code: 'SHAPE', error: 'users/current 返回结构异常' }
  }
  const ba = bizData.balance_alert
  const currency = bizData.currency.toUpperCase()
  // 按账户币种取 balance_alert[currency]；该币种无条目则回退任意一个可用币种
  let alert = ba && ba[currency]
  if (!alert) {
    const keys = Object.keys(ba || {})
    const first = keys.find((k) => ba[k] && typeof ba[k].enabled === 'boolean' && 'alert_bound' in ba[k])
    alert = first ? ba[first] : null
  }
  if (!alert || typeof alert.enabled !== 'boolean' || !('alert_bound' in alert)) {
    return { ok: false, code: 'SHAPE', error: 'users/current 返回结构异常' }
  }
  const bound = Number(alert.alert_bound)
  const payload = {
    ok: true,
    enabled: !!alert.enabled,
    alertBound: isFinite(bound) ? bound : null,
  }
  alertCache = { at: now, payload }
  return payload
}