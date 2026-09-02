import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Package root: lib/index.js -> package root. Keeps the bundle relocatable
// when installed as a normal DSH npm plugin (node_modules or a local link).
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// DSH home: used for the widget size/usage memory files, since node_modules may
// be read-only or cleaned on update.
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// Whale image: package-relative first, legacy absolute paths as fallback.
const IMAGE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'DSniang1.png'),
  path.join(PACKAGE_ROOT, 'assets', 'DSniang02.png'),
  'D:/TestBox/deepseek/DSniang1.png',
  'D:/TestBox/deepseek/DSniang02.png',
  'D:/TestBox/deepseek/skin/DSniang02.png',
]

// Alternate skins (奶鲸 / 糖鲸 / 睡觉): package-relative only, default skin keeps legacy fallbacks.
const SKIN_FILES = {
  naijing: [path.join(PACKAGE_ROOT, 'assets', 'DSniang-naijing.png')],
  tangjing: [path.join(PACKAGE_ROOT, 'assets', 'DSniang-tangjing.png')],
  sleep: [path.join(PACKAGE_ROOT, 'assets', 'DSniang-sleep.png')],
}

function normalizeSkin(v) {
  return v === 'naijing' || v === 'tangjing' || v === 'sleep' ? v : 'default'
}

// 有睡觉形象、会空闲自动入睡的皮肤列表（奶鲸/糖鲸）。
const SLEEPABLE_SKINS = ['naijing', 'tangjing']

// Size memory file: prefer writable DSH home locations, then legacy fallbacks.
const SIZE_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-size.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-size.json'),
  'D:/TestBox/deepseek/.dshw-size.json',
  'D:/TestBox/deepseek/skin/.dshw-size.json',
]

// Usage ledger file (小鲸鱼记账 mode): same policy as the size file.
const USAGE_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-usage.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-usage.json'),
  'D:/TestBox/deepseek/.dshw-usage.json',
  'D:/TestBox/deepseek/skin/.dshw-usage.json',
]

// Sound assets: package-relative first (ship Ya1/Ya2/D1/D2.mp3 in assets/ for
// sounds out of the box), legacy paths as fallback.
const SOUND_SETS = {
  duck: {
    press: [path.join(PACKAGE_ROOT, 'assets', 'Ya1.mp3'), 'D:/TestBox/deepseek/skin/Ya1.mp3'],
    release: [path.join(PACKAGE_ROOT, 'assets', 'Ya2.mp3'), 'D:/TestBox/deepseek/skin/Ya2.mp3'],
  },
  fx1: {
    press: [path.join(PACKAGE_ROOT, 'assets', 'D1.mp3'), 'D:/TestBox/deepseek/skin/D1.mp3'],
    release: [path.join(PACKAGE_ROOT, 'assets', 'D2.mp3'), 'D:/TestBox/deepseek/skin/D2.mp3'],
  },
  tangxiao: {
    press: [path.join(PACKAGE_ROOT, 'assets', 'T1.mp3')],
    release: [path.join(PACKAGE_ROOT, 'assets', 'T2.mp3')],
  },
  laugh: {
    press: [path.join(PACKAGE_ROOT, 'assets', 'L1.mp3')],
    release: [path.join(PACKAGE_ROOT, 'assets', 'L2.mp3')],
  },
}

function normalizeSoundSet(v) {
  return v === 'fx1' || v === 'tangxiao' || v === 'laugh' ? v : 'duck'
}
function soundSetFromUrl(url) {
  try {
    const q = String(url || '').split('?')[1] || ''
    const m = /(?:^|&)set=([^&]+)/.exec(q)
    return m ? decodeURIComponent(m[1]) : ''
  } catch (err) { return '' }
}
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 25000
const RUA_GIF_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'rua.gif'),
  'D:/TestBox/deepseek/skin/rua.gif',
  'D:/TestBox/deepseek/rua.gif',
]
// DeepSeek CNY prices per million tokens: [空闲时段价, 高峰时段价].
// 高峰时段：工作日 9:00–12:00 和 14:00–18:00（北京时间）；2026-08-23 起周末全天谷价。
// Adjust here if DeepSeek changes pricing.
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
// deepseek-v4-pro 为 flash 的 3 倍价（官方 2026-08-17 生效）；vision-exp 与 flash 同价
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}
function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}
// bucket time is an epoch second; derive the Beijing local hour to pick peak vs off-peak price.
// 2026-08-23 起（北京时间）周末（周六/周日）全天按谷价；生效时刻之前的历史
// 分桶仍按旧规则计价，所以周末判定带生效分界。
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // = 北京时间 2026-08-23 00:00
// 分桶时间可能是 epoch 秒、epoch 毫秒或 ISO 字符串；解析不出来时返回 null。
function toEpochSeconds(t) {
  if (typeof t === 'number' && isFinite(t)) return t > 1e11 ? Math.floor(t / 1000) : t
  const s = String(t == null ? '' : t).trim()
  if (s === '') return null
  const n = Number(s)
  if (isFinite(n)) return n > 1e11 ? Math.floor(n / 1000) : n
  const ms = Date.parse(s)
  return isFinite(ms) ? Math.floor(ms / 1000) : null
}
function isPeakTime(timeSec) {
  const n = toEpochSeconds(timeSec)
  if (n === null) return false
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay() // 0=周日 6=周六（bj 按 UTC 读即为北京日历日）
    if (dow === 0 || dow === 6) return false
  }
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

// 挂件缩放与音量的合法区间（与前端 MIN_SCALE / MAX_SCALE 一致）。size.json 是本机
// 未鉴权端点，越界值写进配置后会让挂件铺满或消失，这里在持久化前后都夹一次。
const HOST_MIN_SCALE = 0.6
const HOST_MAX_SCALE = 2.5
function clampScale(v) {
  const n = Number(v)
  if (!isFinite(n)) return 1
  return Math.min(HOST_MAX_SCALE, Math.max(HOST_MIN_SCALE, n))
}
function clampVol(v) {
  const n = Number(v)
  if (!isFinite(n)) return 0.9
  return Math.min(1, Math.max(0, n))
}

// 挂件与这些端点同源，不需要 CORS。曾经的 Access-Control-Allow-Origin: * 让任意
// 网页都能读到余额/今日已用，还能跨站 PUT 改配置，这里去掉。
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}


// —— 导出清单 ——
export {
  PACKAGE_ROOT,
  DSH_HOME,
  IMAGE_CANDIDATES,
  SKIN_FILES,
  normalizeSkin,
  SLEEPABLE_SKINS,
  SIZE_FILE_CANDIDATES,
  USAGE_FILE_CANDIDATES,
  SOUND_SETS,
  normalizeSoundSet,
  soundSetFromUrl,
  BALANCE_URL,
  BALANCE_TTL_MS,
  RUA_GIF_CANDIDATES,
  PEAK_HOURS,
  BASE_PRICE,
  PRO_PRICE,
  PRICING,
  priceFor,
  WEEKEND_VALLEY_FROM_SEC,
  toEpochSeconds,
  isPeakTime,
  HOST_MIN_SCALE,
  HOST_MAX_SCALE,
  clampScale,
  clampVol,
  JSON_HEADERS,
}
