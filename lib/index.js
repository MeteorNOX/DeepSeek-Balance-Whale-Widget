import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as TP from './tokenplan-usage.js'

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

// 阿里 Token Plan 用量估算的数据源：
//  1) dsh-usage 插件维护的逐日逐模型账本（首选，跨重启、含子代理流量）
//  2) 挂件自己的实时账本（事件流累加，账本缺失/未落盘时兜底）
// 周窗口锚点：配置 qwenWindowAnchor 优先，否则退到「账本里第一个有量的一天」。
const DSH_USAGE_LEDGER_CANDIDATES = [
  path.join(DSH_HOME, 'dsh-usage', 'usage-ledger.json'),
  path.join(DSH_HOME, 'profiles', 'web', 'dsh-usage', 'usage-ledger.json'),
]
const QWEN_LEDGER_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-qwen.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-qwen.json'),
]
// 读盘+汇总的缓存时长：账本本身由 dsh-usage 每步落盘，30s 足够新
const QWEN_TTL_MS = 30000
// 触顶 / 限流信号的存活时长统一由 tokenplan-usage.js 管（QUOTA_HIT_TTL_MS、
// RATE_LIMIT_TTL_MS），这里不再自带一份，免得两处阈值各说各话

const DISPLAY_KEYS = ['ds', 'qwen']
// 只认两种显示态；老配置里的 'rotate'（轮换）按用户要求取消，归一成 'ds'
function normalizeDisplay(v) {
  return DISPLAY_KEYS.indexOf(v) !== -1 ? v : 'ds'
}

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
function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
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

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

const WIDGET_JS = `(function () {
if (window.__dshWhaleWidget) return
window.__dshWhaleWidget = true

var MIN_SCALE = 0.6
var MAX_SCALE = 2.5
var STEP = 0.1
var CLICK_SQ = 9
var REFRESH_MS = 60000
var CHANGE_MS = 900
var ANIM_MS = 700
var BUBBLE_MS = 5000
var FETCH_TIMEOUT_MS = 25000
var BALANCE_URL = '/dsh-whale/balance.json'
var QWEN_URL = '/dsh-whale/qwen.json'
var QWEN_REFRESH_MS = 30000
var SIZE_URL = '/dsh-whale/size.json'
var IMG_URL = '/dsh-whale/image.png?v=2'
var GIF_URL = '/dsh-whale/rua.gif'

var css = [
  '.dshwv-root{position:fixed;right:0;bottom:0;--dshw-scale:1;--dshw-base:clamp(122px,calc(min(250px,min(100vw,100vh) * 0.28) * var(--dshw-scale)),625px);width:var(--dshw-base);height:var(--dshw-base);pointer-events:none;user-select:none;-webkit-user-select:none;z-index:9999;font-family:inherit;transition:left .16s ease,top .16s ease,transform .3s ease}',
  '.dshwv-root.dshwv-left{transform:scaleX(-1)}',
  '.dshwv-root.dshwv-dragging{cursor:grabbing;transition:none}',
  '.dshwv-body{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:50% 100%;transition:transform .22s cubic-bezier(.34,1.56,.64,1)}',
  '.dshwv-img{position:absolute;right:0;bottom:0;width:59.45%;height:59.45%;display:block;pointer-events:none;-webkit-user-drag:none;user-select:none}',
  '.dshwv-bubble{position:absolute;left:0;top:0;width:100%;aspect-ratio:1026/700;pointer-events:none;z-index:1;--dshw-u:calc(var(--dshw-base) / 1026)}',
  '.dshwv-bubble svg{display:block;width:100%;height:100%;pointer-events:none;transform:scale(var(--dshw-bgrow,1));transform-origin:43.1% 92.3%;transition:transform .3s ease}',
  '.dshwv-bubble svg path,.dshwv-bubble svg ellipse{pointer-events:none;cursor:pointer}',
  '.dshwv-bubble.dshwv-bubble-open svg path,.dshwv-bubble.dshwv-bubble-open svg ellipse{pointer-events:visiblePainted}',
  '.dshwv-bubble .dshwv-bshape,.dshwv-bubble .dshwv-b1,.dshwv-bubble .dshwv-b2{opacity:0;transform:scale(.7);transform-box:fill-box;transform-origin:50% 50%;transition:opacity .2s ease,transform .2s ease}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-bshape,.dshwv-bubble.dshwv-bubble-open .dshwv-b1,.dshwv-bubble.dshwv-bubble-open .dshwv-b2{opacity:1;transform:none}',
  '.dshwv-gif{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%) translate(var(--dshw-tx,0px),var(--dshw-ty,0px));max-width:calc(var(--dshw-u) * 540 * var(--dshw-bgrow,1));max-height:calc(var(--dshw-u) * 400 * var(--dshw-bgrow,1));display:none;opacity:0;transition:opacity .2s ease;pointer-events:none;-webkit-user-drag:none;user-select:none;object-fit:contain}',
  '.dshwv-root.dshwv-left .dshwv-gif{transform:translate(-50%,-50%) translate(var(--dshw-tx,0px),var(--dshw-ty,0px)) scaleX(-1)}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-gif{opacity:1}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-b2{transition-delay:0s}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-b1{transition-delay:.13s}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-bshape{transition-delay:.26s}',
  '.dshwv-bubble .dshwv-bshape{transition-delay:.1s}',
  '.dshwv-bubble .dshwv-b1{transition-delay:.2s}',
  '.dshwv-bubble .dshwv-b2{transition-delay:.3s}',
  '.dshwv-alertdot{position:absolute;right:3%;top:3%;width:calc(var(--dshw-base) * 0.062);height:calc(var(--dshw-base) * 0.062);border-radius:50%;background:#e0433f;box-shadow:0 0 0 calc(var(--dshw-base) * 0.012) rgba(224,67,63,.28);opacity:0;transition:opacity .2s ease;pointer-events:none;z-index:3}',
  '.dshwv-root.dshwv-alert-over .dshwv-alertdot{opacity:1}',
  '.dshwv-text{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%) translate(var(--dshw-tx,0px),var(--dshw-ty,0px)) scale(var(--dshw-ts,1));text-align:center;color:#536ba9;line-height:1.15;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .16s ease,transform .3s ease}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-text{opacity:1;transition:opacity .16s ease .36s,transform .3s ease}',
  '.dshwv-root.dshwv-left .dshwv-text{transform:translate(-50%,-50%) translate(var(--dshw-tx,0px),var(--dshw-ty,0px)) scaleX(-1) scale(var(--dshw-ts,1))}',
  '.dshwv-label{font-size:calc(var(--dshw-u) * 66);font-weight:600;letter-spacing:.06em}',
  '.dshwv-amount{font-size:calc(var(--dshw-u) * 128);font-weight:800;line-height:1.05}',
  '.dshwv-period{font-size:calc(var(--dshw-u) * 104);font-weight:800;line-height:1.05}',
  '.dshwv-wrap{white-space:normal;max-width:calc(var(--dshw-u) * 480 * var(--dshw-bgrow,1));line-height:1.2}',
  '.dshwv-hint{font-size:calc(var(--dshw-u) * 44 * var(--dshw-hfit,1));color:#9fb0d9;letter-spacing:.02em;margin-top:calc(var(--dshw-u) * 7);min-height:calc(var(--dshw-u) * 52 * var(--dshw-hfit,1));line-height:1.15}',
  '.dshwv-acct{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}',
  '.dshwv-acct-item{display:flex;align-items:center;gap:6px;width:100%;border:1px solid rgba(32,49,112,.28);border-radius:7px;padding:3px 6px;background:#fff;color:#203170;font-size:11px;line-height:1.3;cursor:pointer;font-family:inherit;text-align:left}',
  '.dshwv-acct-item:hover{background:#eef2fb}',
  '.dshwv-acct-on{border-color:#203170;background:#e6ecfa;box-shadow:inset 0 0 0 1px #203170}',
  '.dshwv-acct-dot{width:7px;height:7px;border-radius:50%;background:rgba(32,49,112,.22);flex:0 0 auto;font-style:normal}',
  '.dshwv-acct-on .dshwv-acct-dot{background:#203170}',
  '.dshwv-acct-name{flex:0 0 auto;font-weight:600}',
  '.dshwv-acct-nums{flex:1;min-width:0;text-align:right;color:#536ba9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dshwv-menu-row-top{align-items:flex-start}',
  '.dshwv-menu-btn{position:absolute;top:calc(40.55% + 4px);right:4px;width:26px;height:26px;border:none;border-radius:6px;background:rgba(32,49,112,.85);cursor:pointer;pointer-events:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:0;z-index:2;opacity:0;transition:opacity .15s ease}',
  '.dshwv-menu-btn.dshwv-menu-btn-visible{opacity:1}',
  '.dshwv-menu-btn span{display:block;width:14px;height:2px;background:#fff;border-radius:1px}',
  '.dshwv-menu-btn:hover{background:#203170}',
  '.dshwv-menu{position:fixed;min-width:222px;background:rgba(255,255,255,.92);border:1px solid rgba(32,49,112,.35);border-radius:10px;padding:10px 12px;opacity:0;transform:scale(.92) translateY(-4px);transform-origin:top right;transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);pointer-events:none;z-index:10000;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:light}',
  '.dshwv-menu.dshwv-menu-open{opacity:1;transform:scale(1) translateY(0);pointer-events:auto}',
  '.dshwv-menu-row{display:flex;align-items:center;gap:8px;margin:5px 0;color:#203170;font-size:12px;white-space:nowrap}',
  '.dshwv-range{flex:1;min-width:0;accent-color:#203170}',
  '.dshwv-number{width:44px;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:2px 4px;font-size:12px;color:#203170;background:#fff;box-sizing:border-box}',
  '.dshwv-number:disabled{opacity:.4;background:rgba(32,49,112,.06);cursor:not-allowed}',
  '.dshwv-sound{flex:1;border:1px solid rgba(32,49,112,.4);border-radius:6px;background:rgba(32,49,112,.08);color:#203170;font-size:12px;padding:3px 0;cursor:pointer}',
  '.dshwv-sound:hover{background:rgba(32,49,112,.16)}',
  '.dshwv-check{width:16px;height:16px;accent-color:#203170;cursor:pointer;flex:0 0 auto}',
  '.dshwv-menu-sep{height:1px;background:rgba(32,49,112,.25);margin:6px 0}',
  '.dshwv-volpct{width:44px;text-align:right;color:#203170;font-size:12px}'
].join('\\n')

var styleEl = document.createElement('style')
styleEl.textContent = css
document.head.appendChild(styleEl)

var root = document.createElement('div')
root.className = 'dshwv-root'

var img = document.createElement('img')
img.className = 'dshwv-img'
img.src = IMG_URL
img.alt = 'DeepSeek 余额'
img.draggable = false

var menuBtn = document.createElement('button')
menuBtn.type = 'button'
menuBtn.className = 'dshwv-menu-btn'
menuBtn.title = '菜单'
menuBtn.innerHTML = '<span></span><span></span><span></span>'
menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu() })

var menuBox = document.createElement('div')
menuBox.className = 'dshwv-menu'
function menuLabel(text) {
  var s = document.createElement('span')
  s.textContent = text
  return s
}
function menuRow() {
  var r = document.createElement('div')
  r.className = 'dshwv-menu-row'
  return r
}
var scaleInput = document.createElement('input')
scaleInput.type = 'range'
scaleInput.min = String(MIN_SCALE)
scaleInput.max = String(MAX_SCALE)
scaleInput.step = '0.1'
scaleInput.className = 'dshwv-range'
scaleInput.value = '1.5'
var scaleNumber = document.createElement('input')
scaleNumber.type = 'number'
scaleNumber.min = '1'
scaleNumber.max = '20'
scaleNumber.step = '1'
scaleNumber.className = 'dshwv-number'
scaleNumber.value = '10'
scaleInput.addEventListener('pointerdown', function () { root.style.transition = 'none' })
scaleInput.addEventListener('input', function () { setScale(scaleInput.value) })
scaleInput.addEventListener('change', function () { root.style.transition = '' })
scaleNumber.addEventListener('focus', function () { root.style.transition = 'none' })
scaleNumber.addEventListener('blur', function () { root.style.transition = '' })
scaleNumber.addEventListener('input', function () {
  var v = Math.round(Number(scaleNumber.value))
  var s = MIN_SCALE + Math.max(0, Math.min(20, v) - 1) * (MAX_SCALE - MIN_SCALE) / 19
  setScale(s)
})
scaleNumber.addEventListener('change', function () {
  var v = Math.round(Number(scaleNumber.value))
  var s = MIN_SCALE + Math.max(0, Math.min(20, v) - 1) * (MAX_SCALE - MIN_SCALE) / 19
  setScale(s)
  root.style.transition = ''
})
var soundSelect = document.createElement('select')
soundSelect.className = 'dshwv-sound'
function soundOpt(value, label) {
  var o = document.createElement('option')
  o.value = value
  o.textContent = label
  return o
}
soundSelect.appendChild(soundOpt('duck', '小黄鸭'))
soundSelect.appendChild(soundOpt('fx1', '音效1'))
soundSelect.addEventListener('change', function () { setSoundSet(soundSelect.value) })
var usageSelect = document.createElement('select')
usageSelect.className = 'dshwv-sound'
usageSelect.appendChild(soundOpt('ledger', '小鲸鱼记账 (推荐)'))
usageSelect.appendChild(soundOpt('token', '实时·令牌 (用法：去问dsh)'))
usageSelect.addEventListener('change', function () { setUsageMode(usageSelect.value) })
// 显示对象：DeepSeek 余额 / 阿里 Qwen·Token Plan / 轮换
// —— 账户列表：每行「当前值 + 累计值」，点哪行气泡就显示哪行（替代原来的轮换）——
var acctBox = document.createElement('div')
acctBox.className = 'dshwv-acct'
var acctRows = {}
function acctRow(key, name) {
  var r = document.createElement('button')
  r.type = 'button'
  r.className = 'dshwv-acct-item'
  r.setAttribute('data-acct', key)
  var dot = document.createElement('i')
  dot.className = 'dshwv-acct-dot'
  var nm = document.createElement('span')
  nm.className = 'dshwv-acct-name'
  nm.textContent = name
  var nums = document.createElement('span')
  nums.className = 'dshwv-acct-nums'
  nums.textContent = '—'
  r.appendChild(dot)
  r.appendChild(nm)
  r.appendChild(nums)
  r.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation()
    setDisplay(key)
  })
  acctBox.appendChild(r)
  acctRows[key] = { row: r, nums: nums }
}
acctRow('ds', 'DeepSeek')
acctRow('qwen', 'Token Plan')
function syncAcctList() {
  var dsn = acctRows.ds ? acctRows.ds.nums : null
  if (dsn) {
    if (state.status === 'error') dsn.textContent = '获取失败'
    else if (state.balance === null) dsn.textContent = '…'
    else {
      dsn.textContent = fmt(state.balance, state.currency) +
        (state.todayUsage !== null && state.todayUsage !== undefined ? ' · 今 ' + fmt(state.todayUsage, state.currency) : '')
    }
  }
  var qn = acctRows.qwen ? acctRows.qwen.nums : null
  if (qn) {
    var p = qwenData
    if (!p) qn.textContent = qwenMessage || '…'
    else if (!p.ok) qn.textContent = '暂无记录'
    else qn.textContent = fmtCr(p.used) + '/' + fmtCr(p.cap) + ' · 累计 ' + fmtCr(p.usedAllTime) + ' Cr'
  }
  for (var k in acctRows) {
    if (acctRows.hasOwnProperty(k)) {
      acctRows[k].row.className = 'dshwv-acct-item' + (display === k ? ' dshwv-acct-on' : '')
    }
  }
}
var qwenWarnInput = document.createElement('input')
qwenWarnInput.type = 'number'
qwenWarnInput.min = '5'
qwenWarnInput.max = '100'
qwenWarnInput.step = '5'
qwenWarnInput.className = 'dshwv-number'
qwenWarnInput.value = '70'
qwenWarnInput.title = '套餐周额度用到该百分比时自动冒泡告警'
qwenWarnInput.addEventListener('input', function () { setQwenWarn(qwenWarnInput.value) })
qwenWarnInput.addEventListener('change', function () { setQwenWarn(qwenWarnInput.value) })
var peakSelect = document.createElement('select')
peakSelect.className = 'dshwv-sound'
peakSelect.appendChild(soundOpt('default', '默认'))
peakSelect.appendChild(soundOpt('liangwen', '梁文峰谷'))
peakSelect.appendChild(soundOpt('qiangqiang', '!?强强?!'))
peakSelect.addEventListener('change', function () { setPeakMode(peakSelect.value) })
var bubbleToggle = document.createElement('input')
bubbleToggle.type = 'checkbox'
bubbleToggle.className = 'dshwv-check'
bubbleToggle.checked = true
bubbleToggle.title = '开启/关闭思考气泡'
bubbleToggle.addEventListener('change', function () { setBubbleOn(bubbleToggle.checked) })
var turnCostToggle = document.createElement('input')
turnCostToggle.type = 'checkbox'
turnCostToggle.className = 'dshwv-check'
turnCostToggle.checked = true
turnCostToggle.title = '每轮对话结束后自动显示本轮消耗金额'
turnCostToggle.addEventListener('change', function () { setTurnCostOn(turnCostToggle.checked) })
var turnCostCloseInput = document.createElement('input')
turnCostCloseInput.type = 'number'
turnCostCloseInput.min = '0'
turnCostCloseInput.step = '1'
turnCostCloseInput.className = 'dshwv-number'
turnCostCloseInput.value = '5'
turnCostCloseInput.disabled = false // 跟随「每轮消耗提示」开关
turnCostCloseInput.title = '填 0 表示不自动关闭，需手动点击关闭'
turnCostCloseInput.addEventListener('input', function () { setTurnCostClose(turnCostCloseInput.value) })
turnCostCloseInput.addEventListener('change', function () { setTurnCostClose(turnCostCloseInput.value) })
var scrollGapToggle = document.createElement('input')
scrollGapToggle.type = 'checkbox'
scrollGapToggle.className = 'dshwv-check'
scrollGapToggle.checked = false
scrollGapToggle.title = '开启后挂件右侧按设定像素避开滚动条；关闭则贴边（盖住滚动条）'
scrollGapToggle.addEventListener('change', function () { setScrollGapOn(scrollGapToggle.checked) })
var scrollGapInput = document.createElement('input')
scrollGapInput.type = 'number'
scrollGapInput.min = '0'
scrollGapInput.step = '1'
scrollGapInput.className = 'dshwv-number'
scrollGapInput.value = '17'
scrollGapInput.disabled = true // 默认避让关 → 宽度不可修改，勾选后启用
scrollGapInput.title = '避让滚动条的像素宽度，填 0 表示贴边'
scrollGapInput.addEventListener('input', function () { setScrollGapPx(scrollGapInput.value) })
scrollGapInput.addEventListener('change', function () { setScrollGapPx(scrollGapInput.value) })
var row1 = menuRow()
row1.appendChild(menuLabel('大小'))
row1.appendChild(scaleInput)
row1.appendChild(scaleNumber)
var row2 = menuRow()
row2.appendChild(menuLabel('音效'))
row2.appendChild(soundSelect)
var volInput = document.createElement('input')
volInput.type = 'range'
volInput.min = '0'
volInput.max = '1'
volInput.step = '0.05'
volInput.className = 'dshwv-range'
volInput.value = '0.9'
var volPct = document.createElement('span')
volPct.className = 'dshwv-volpct'
volPct.textContent = '90%'
volInput.addEventListener('input', function () { setVol(volInput.value) })
var row3 = menuRow()
row3.appendChild(menuLabel('音量'))
row3.appendChild(volInput)
row3.appendChild(volPct)
var row4 = menuRow()
row4.appendChild(menuLabel('用量'))
row4.appendChild(usageSelect)
var rowDs = menuRow()
rowDs.className = 'dshwv-menu-row dshwv-menu-row-top'
rowDs.appendChild(menuLabel('显示'))
rowDs.appendChild(acctBox)
var rowTp = menuRow()
rowTp.appendChild(menuLabel('套餐告警'))
rowTp.appendChild(qwenWarnInput)
rowTp.appendChild(menuLabel('%'))
var row5 = menuRow()
row5.appendChild(menuLabel('峰谷'))
row5.appendChild(peakSelect)
var row6 = menuRow()
row6.appendChild(menuLabel('气泡'))
row6.appendChild(bubbleToggle)
var menuSep1 = document.createElement('div')
menuSep1.className = 'dshwv-menu-sep'
var row7 = menuRow()
row7.appendChild(menuLabel('每轮消耗提示'))
row7.appendChild(turnCostToggle)
row7.appendChild(menuLabel('自动关闭'))
row7.appendChild(turnCostCloseInput)
row7.appendChild(menuLabel('秒'))
var row9 = menuRow()
row9.appendChild(menuLabel('避让滚动条'))
row9.appendChild(scrollGapToggle)
row9.appendChild(menuLabel('宽度'))
row9.appendChild(scrollGapInput)
row9.appendChild(menuLabel('px'))
menuBox.appendChild(row1)
menuBox.appendChild(row2)
menuBox.appendChild(row3)
menuBox.appendChild(row4)
menuBox.appendChild(rowDs)
menuBox.appendChild(rowTp)
menuBox.appendChild(row5)
menuBox.appendChild(row6)
menuBox.appendChild(row7)
menuBox.appendChild(menuSep1)
menuBox.appendChild(row9)

var textBox = document.createElement('div')
textBox.className = 'dshwv-text'
var labelEl = document.createElement('div')
labelEl.className = 'dshwv-label'
labelEl.textContent = 'DeepSeek 余额'
var amountEl = document.createElement('div')
amountEl.className = 'dshwv-amount'
var hintEl = document.createElement('div')
hintEl.className = 'dshwv-hint'
textBox.appendChild(labelEl)
textBox.appendChild(amountEl)
textBox.appendChild(hintEl)

var bubbleBox = document.createElement('div')
bubbleBox.className = 'dshwv-bubble'
bubbleBox.innerHTML = '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
  '<path class="dshwv-bshape" fill="#FFFFFF" stroke="#203170" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' +
  '<ellipse class="dshwv-b1" cx="352" cy="561" rx="37.5" ry="26" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
  '<ellipse class="dshwv-b2" cx="442" cy="646" rx="24.5" ry="18" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
  '</svg>'
var gifEl = document.createElement('img')
gifEl.className = 'dshwv-gif'
gifEl.src = GIF_URL
gifEl.alt = ''
gifEl.draggable = false
bubbleBox.appendChild(gifEl)
var gifFailed = false
gifEl.onerror = function () { gifFailed = true }
bubbleBox.appendChild(textBox)
bubbleBox.addEventListener('click', function (e) {
  e.stopPropagation()
  if (!bubbleShown) return
  if (qwenAlertActive) {
    // 额度告警泡泡：点击即确认关闭
    hideQwenAlert()
    return
  }
  if (costBubbleActive) {
    // 消耗金额泡泡：点击关闭（确认）
    hideCostBubble()
    return
  }
  if (bubbleRandomActive) {
    // 再次点击：关闭
    hideBubble()
  } else {
    // 首次点击：切到随机台词段，并重置自动关闭计时——
    // 保证第二段台词有完整停留时间（否则第 4 秒点击只看到 0.5 秒）
    bubbleRandomActive = true
    // Qwen 显示模式下先看套餐详情，再点一次才轮到随机台词
    bubbleRandomLines = displayActive() === 'qwen' ? qwenDetailLines() : pickRandomLines()
    swapBubbleContent(function () { applyBubbleLines(bubbleRandomLines) })
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
  }
})

var body = document.createElement('div')
body.className = 'dshwv-body'
body.appendChild(img)
body.appendChild(bubbleBox)
root.appendChild(body)
root.appendChild(menuBtn)
var alertDot = document.createElement('div')
alertDot.className = 'dshwv-alertdot' // 没回到安全线之前一直挂着的小红点
root.appendChild(alertDot)
document.body.appendChild(root)
document.body.appendChild(menuBox)

// Position model: the widget is ALWAYS expressed in left/top px (so edge snaps
// animate smoothly via the CSS transition on both sides — switching to
// right/auto cannot transition and flashes). The anchor info (h/v + offsets)
// lives in state and is used by settle() to recompute coordinates on window
// resize and size changes, keeping the widget glued to its anchored edge.
var state = {
  scale: 1.5,
  h: 'right',
  hOff: 0,
  v: 'bottom',
  vOff: 0,
  left: 0,
  top: 0,
  balance: null,
  currency: null,
  todayUsage: null,
  isPeak: false,
  status: 'loading',
  message: ''
}
var busy = false
var settleTimer = null
var animDelayTimer = null
var drag = null
var shown = null
var animId = null
var bubbleShown = false
var bubbleTimer = null
var bubbleRandomActive = false
var bubbleRandomLines = null
// —— 显示对象（DeepSeek 余额 / 阿里 Qwen 套餐用量）与 Token Plan 状态 ——
var display = 'ds' // 'ds' = 余额，'qwen' = 套餐用量；由菜单账户列表点选
var qwenData = null // 最近一次成功的 /dsh-whale/qwen.json
var qwenMessage = '' // 拉取失败原因（不影响余额显示）
var shownCr = null // Credits 数字滚动当前值
var qwenAlertActive = false // 额度告警泡泡显示中（锁住余额/用量渲染）
var qwenAlertTimer = null
var qwenBusy = false
var qwenWarnPct = 70
function bubbleLocked() {
  return costBubbleActive || qwenAlertActive
}
var BUBBLE_STYLE_CLASS = { A: 'dshwv-label', B: 'dshwv-amount', P: 'dshwv-period', C: 'dshwv-hint' }
function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function singleCenter(style, text, color, wrap) { return [null, { t: text, s: style, c: color || '', w: !!wrap }, null] }
function buildGroup1() {
  var peak = !!state.isPeak
  var offText = '空闲时段'
  var peakText = '高峰时段'
  if (peakMode === 'liangwen') {
    offText = '梁文谷'
    peakText = '梁文峰'
  } else if (peakMode === 'qiangqiang') {
    offText = '!?谷谷?!'
    peakText = '!?峰峰?!'
  }
  return [
    { t: '当前时间段为:', s: 'A', c: '' },
    { t: peak ? peakText : offText, s: 'P', c: peak ? '#e0433f' : '#2fa24c' },
    { t: '今日已用 ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' },
  ]
}
// 随机台词：Token Plan 组（无数据时退回峰谷组，不空转）
function qwenRandomLines() {
  var p = qwenData
  if (!p || !p.ok) return buildGroup1()
  var warn = (p.alert && p.alert.warnPct) || qwenWarnPct || 70
  var tone
  var cs = capState(p)
  if (cs === 'hit' || p.pct >= 100) tone = pickOne(['本周 Credits 顶到天花板了，等服务恢复', '触顶了…等重置，或者买个用量包'])
  else if (cs === 'throttle') tone = pickOne(['刚才那下被限流了（每分钟 token 打满），缓一分钟就好', '并发太高啦，这周还剩 ' + fmtCr(p.remaining) + ' Cr，歇会儿再发~'])
  else if (cs === 'suspect') tone = pickOne(['网关说额度不足，可账上估算还剩 ' + fmtCr(p.remaining) + ' Cr…去控制台对下', '报额度不足但估算只用了 ' + p.pct + '%，我倾向信估算'])
  else if (p.pct >= 90) tone = pickOne(['只剩 ' + fmtCr(p.remaining) + ' Cr 了，省着点花', '再烧就要触顶了，大活建议排谷期'])
  else if (p.pct >= warn) tone = pickOne(['周额度已经吃掉 ' + p.pct + '%，注意节奏', '剩 ' + fmtCr(p.remaining) + ' Cr · ' + fmtReset(p.resetInMs)])
  else tone = pickOne(['这周才吃了 ' + fmtCr(p.used) + ' Cr，随便造~', '套餐就是要用满才回本呀', 'Qwen 干活，DeepSeek 的钱省下来了', '主力 ' + ((p.byModel && p.byModel[0] && p.byModel[0].model) || 'qwen') + '，今天 ' + fmtCr(p.today.credits) + ' Cr'])
  return [
    { t: 'Token Plan 第 ' + p.dayIndex + '/7 天', s: 'A', c: '' },
    { t: fmtCr(p.used) + ' Cr', s: 'B', c: qwenColor(p, warn) || '#536ba9' },
    { t: tone + '（估算）', s: 'C', c: '' },
  ]
}
var RANDOM_GROUPS = [
  { w: 45, lines: buildGroup1 },
  { w: 22, lines: qwenRandomLines },
  { w: 7, lines: function () { return singleCenter('B', pickOne(['好模型... ↓', '好女孩...↓'])) } },
  { w: 7, lines: function () { return singleCenter('A', pickOne(['不知道用户有什么用，先赶走吧~', '我...我...我也要挣钱吗？', '我去吃饭啦，测完叫我', '压力一只蓝色大肥鱼？！', 'DeepSleep...', '坏了...用户彻底怒了！']), '', true) } },
  { w: 10, lines: function () { return { gif: true } } },
  { w: 3, lines: function () { return singleCenter('A', pickOne(['你目录里的dsh是什么...大烧货吗...?', '恭喜你实现token自由！token全跑了！', '真当我是便宜货啊...']), '', true) } },
  { w: 1, lines: function () { return singleCenter('B', '哦鲸鲸... ') } },
]
function pickRandomLines() {
  var total = 0
  for (var i = 0; i < RANDOM_GROUPS.length; i++) total += RANDOM_GROUPS[i].w
  var r = Math.random() * total
  for (var i = 0; i < RANDOM_GROUPS.length; i++) {
    r -= RANDOM_GROUPS[i].w
    if (r < 0) return RANDOM_GROUPS[i].lines()
  }
  return RANDOM_GROUPS[RANDOM_GROUPS.length - 1].lines()
}
// —— 自适应气泡 v2：先长泡泡，再缩「估算」那行，最后才动主行字号 ——
//    白色泡泡是 SVG 里那个椭圆（viewBox 1026×700：中心 454,247、半轴 373/232、描边 18），
//    尾巴尖在 442,646 —— 也就是鲸鱼嘴上那个连接点。
//    v1 只有一条通道：整块文字按 --dshw-fit 缩到 0.62，缩不动就把提示行折行。问题是
//      · 三行共用一个系数，最长的「…（估算）」把 128 号字的金额行一起拖糊；
//      · 提示行缩到 0.62 依旧顶出椭圆（它本来就最长），于是「依旧有超出」。
//    v2 拆成四条独立通道，按「先看泡泡、再看字体」的顺序取代价最小解：
//      ① --dshw-bgrow：只放大 SVG（transform-origin 钉在尾巴尖）→ 泡泡变大、鲸鱼不动、
//         字还是那么大；文字块靠 --dshw-tx/--dshw-ty 跟着挪到新中心。上限还受屏幕
//         剩余空间约束：贴顶/贴左（镜像时贴右）时长不出去就自动收敛。
//      ② --dshw-hfit：带「估算」的提示行单独缩，最小 0.5 —— 缩它不牵连主行。
//      ③ --dshw-ts：三行整体缩放，下限 0.7（保底，一般走不到这一步）。
//      ④ 折行：前三条都用满才让提示行折成两行。
//    判定按「矩形塞进椭圆」：每行用自己离椭圆中心的垂直距离换算可用宽度，
//    贴中心的金额行本来就比最下面那行长得多，不该再被一刀切成 513u。
var BUB = { cx: 454, cy: 247, rx: 373, ry: 232, ax: 442, ay: 646, tx: 454, ty: 266, pad: 30, vpad: 18, ink: 0.7, wt: 0.66 }
var FIT_GMAX = 1.45  // 泡泡最多放大 45%（再大就顶到椭圆边/盖住鲸鱼）
var FIT_KMIN = 0.7   // 整块缩放下限
var FIT_HMIN = 0.5   // 提示行可以再狠一档
var fitRaf = 0
var fitAuthored = [false, false, false] // applyBubbleLines 里标了 wrap 的行：按设计就该折行
function scheduleFit() {
  if (fitRaf) return
  fitRaf = requestAnimationFrame(function () { fitRaf = 0; fitBubbleText() })
}
function fitResetVars() {
  bubbleBox.style.setProperty('--dshw-bgrow', '1')
  bubbleBox.style.setProperty('--dshw-ts', '1')
  bubbleBox.style.setProperty('--dshw-hfit', '1')
  bubbleBox.style.setProperty('--dshw-tx', '0px')
  bubbleBox.style.setProperty('--dshw-ty', '0px')
  hintEl.style.maxWidth = ''
}
function fitClearAuthored() {
  // 手写三行的路径（余额/成本/告警泡泡）不走 applyBubbleLines，得清掉台词折行标记
  fitAuthored[0] = false
  fitAuthored[1] = false
  fitAuthored[2] = false
}
function fitBubbleText() {
  if (!root || !textBox || !bubbleBox) return
  var r = root.getBoundingClientRect()
  if (!r || r.width <= 0) return
  var u = r.width / 1026
  var els = [labelEl, amountEl, hintEl]
  fitResetVars()
  for (var q = 0; q < 3; q++) { // 量之前先撤掉「上一次折行」，否则量到的是折后宽度
    if (!fitAuthored[q] && els[q].className.indexOf('dshv-wrap') !== -1) {
      els[q].className = els[q].className.replace(' dshwv-wrap', '')
    }
  }
  var rows = []
  var prevBottom = -1
  for (var i = 0; i < 3; i++) {
    var el = els[i]
    if (el.style.display === 'none' || !el.textContent) continue
    var w = Math.max(el.scrollWidth || 0, el.offsetWidth || 0)
    var h = el.offsetHeight || 0
    if (w <= 0 || h <= 0) return // 没有排版信息（jsdom / 尚未插入）→ 保持 1:1，别乱猜
    rows.push({ i: i, w: w, h: h, gap: prevBottom < 0 ? 0 : Math.max(0, (el.offsetTop || 0) - prevBottom) })
    prevBottom = (el.offsetTop || 0) + h
  }
  if (!rows.length) return
  var vp = viewport()
  var mirror = root.classList.contains('dshwv-left')
  var roomOut = Math.max(0, (mirror ? vp.w - r.right : r.left) || 0) // 泡泡「外沿」那侧的余量
  var roomIn = Math.max(0, (mirror ? r.left : vp.w - r.right) || 0)
  var roomUp = Math.max(0, r.top || 0)
  var spanL = BUB.ax - (BUB.cx - BUB.rx) // 442-81  = 361  左边缘到尾巴尖
  var spanR = (BUB.cx + BUB.rx) - BUB.ax // 827-442 = 385  右边缘到尾巴尖
  var spanU = BUB.ay - (BUB.cy - BUB.ry) // 646-15  = 631  上边缘到尾巴尖
  var gCap = Math.max(1, Math.min(FIT_GMAX,
    (BUB.ax + roomOut / u) / spanL,
    (1026 - BUB.ax + roomIn / u) / spanR,
    (BUB.ay + roomUp / u) / spanU))
  // 放大 g 倍之后椭圆的几何：ai/bi = 描边内沿半轴，cy/py = 椭圆心 / 文字块心
  function geo(g) {
    return {
      ai: (BUB.rx - 9) * g * u,
      bi: (BUB.ry - 9) * g * u,
      cy: (BUB.ay + (BUB.cy - BUB.ay) * g) * u,
      py: (BUB.ay + (BUB.ty - BUB.ay) * g) * u
    }
  }
  // 一行能不能塞进椭圆：纵向只看「墨」（行盒比字形高），横向按该行最远边所在高度的椭圆截面宽
  function fits(g, ts, hf, wrap) {
    var G = geo(g)
    var pad = BUB.pad * u
    var bh = G.bi - BUB.vpad * u
    if (G.ai - pad < 40 * u || bh < 40 * u) return false
    var box = 2 * G.ai * BUB.wt // 折行盒（root px）：按椭圆下半部的典型收窄
    var total = 0
    var j
    for (j = 0; j < rows.length; j++) {
      var r0 = rows[j]
      var f0 = r0.i === 2 ? hf : 1
      var n0 = r0.i === 2 && wrap ? Math.max(1, Math.ceil((r0.w * f0 * ts) / box)) : 1
      total += r0.h * f0 * n0 + (j ? r0.gap : 0)
    }
    var y = 0
    for (j = 0; j < rows.length; j++) {
      var rw = rows[j]
      var hint = rw.i === 2
      var f = hint ? hf : 1
      var nl = hint && wrap ? Math.max(1, Math.ceil((rw.w * f * ts) / box)) : 1
      var hh = rw.h * f * nl
      var center = G.py + (y + hh / 2 - total / 2) * ts
      var ymax = Math.abs(center - G.cy) + (hh * ts * BUB.ink) / 2
      if (ymax >= bh) return false
      var t = 1 - (ymax / G.bi) * (ymax / G.bi)
      var lim = G.ai * Math.sqrt(t < 0 ? 0 : t) - pad
      var halfW = hint && wrap ? box / 2 : (rw.w * f * ts) / 2
      if (halfW > lim) return false
      y += hh + rw.gap
    }
    return true
  }
  var best = null
  if (fits(1, 1, 1, false)) {
    best = { g: 1, ts: 1, hf: 1, wrap: false }
  } else {
    var GN = 8, HN = 6, KN = 6
    for (var wi = 0; wi < 2; wi++) {
      for (var gi = 0; gi < GN; gi++) {
        var g = 1 + (gCap - 1) * gi / (GN - 1)
        for (var hi = 0; hi < HN; hi++) {
          var hf = 1 - (1 - FIT_HMIN) * hi / (HN - 1)
          for (var ki = 0; ki < KN; ki++) {
            var ts = 1 - (1 - FIT_KMIN) * ki / (KN - 1)
            if (!fits(g, ts, hf, wi === 1)) continue
            // 代价：缩主行 > 缩提示行 > 折行 > 长泡泡（用户：没必要在字体上死磕）
            var score = (1 - ts) * 11 + (1 - hf) * 5.5 + (wi === 1 ? 18 : 0) + (g - 1) * 1.4
            if (!best || score < best.score - 1e-6) best = { g: g, ts: ts, hf: hf, wrap: wi === 1, score: score }
            break // 同一 (g,hf) 下整块缩得越少越好，第一个命中即最优
          }
        }
      }
    }
  }
  var b = best || { g: gCap, ts: FIT_KMIN, hf: FIT_HMIN, wrap: true }
  bubbleBox.style.setProperty('--dshw-bgrow', String(Math.round(b.g * 1000) / 1000))
  bubbleBox.style.setProperty('--dshw-ts', String(Math.round(b.ts * 1000) / 1000))
  bubbleBox.style.setProperty('--dshw-hfit', String(Math.round(b.hf * 1000) / 1000))
  bubbleBox.style.setProperty('--dshw-tx', (Math.round((b.g - 1) * (BUB.cx - BUB.ax) * u * 100) / 100) + 'px')
  bubbleBox.style.setProperty('--dshw-ty', (Math.round((b.g - 1) * (BUB.ty - BUB.ay) * u * 100) / 100) + 'px')
  if (b.wrap && hintEl.textContent && hintEl.style.display !== 'none' && !fitAuthored[2]) {
    hintEl.className = 'dshwv-hint dshwv-wrap'
    // 折行盒必须写在行上：CSS 里的 500u×grow 只是初值，真正的可用宽度随
    // 该行所在高度的椭圆截面收窄，并且要除掉整块缩放 ts 才落到「本地像素」
    var boxPx = 2 * geo(b.g).ai * BUB.wt
    hintEl.style.maxWidth = Math.floor(boxPx / b.ts) + 'px'
  }
}
function applyBubbleLines(lines) {
  if (lines && lines.gif) {
    // gif 台词组：只显示 gif，隐藏三行文字（display 必须显式覆盖 CSS 的 none）
    if (gifFailed) {
      // gif 加载失败/路由缺失：降级为文字台词，避免空白白色气泡
      lines = singleCenter('A', pickOne(['gif 加载失败了...', '今天没有动图给你看~', '呜呜 动图不见了...']), '', true)
    } else {
      if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
      gifEl.style.display = 'block'
      gifEl.style.opacity = ''
      labelEl.style.display = 'none'
      amountEl.style.display = 'none'
      hintEl.style.display = 'none'
      return
    }
  }
  if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
  gifEl.style.display = 'none'
  gifEl.style.opacity = ''
  var els = [labelEl, amountEl, hintEl]
  for (var i = 0; i < 3; i++) {
    var el = els[i]
    var ln = lines && lines[i]
    if (ln) {
      fitAuthored[i] = !!ln.w // 台词自己要求折行的行不参与「靠放大解决」的计算
      el.style.display = ''
      el.className = (BUBBLE_STYLE_CLASS[ln.s] || 'dshwv-label') + (ln.w ? ' dshwv-wrap' : '')
      el.textContent = ln.t
      el.style.color = ln.c || ''
    } else {
      fitAuthored[i] = false
      el.style.display = 'none'
      el.textContent = ''
      el.style.color = ''
    }
  }
  scheduleFit()
}
var bubbleSwapTimer = null
var hintFadeTimer = null
var gifFadeTimer = null
var lastHintText = null
function setHint(text) {
  // 首次/恢复（lastHintText===null）时直接写文本，不做淡出淡入——否则
  // 气泡打开或按压重开时会先淡出再淡入，造成「消失一下又出现」。
  // 只有气泡打开期间的内容变化（加载中→今日已用）才走动画。
  if (text === lastHintText) return
  var first = lastHintText === null
  lastHintText = text
  if (first || !bubbleShown) {
    hintEl.textContent = text
    scheduleFit()
    return
  }
  hintEl.style.transition = 'opacity .18s ease'
  hintEl.style.opacity = '0'
  hintFadeTimer = setTimeout(function () {
    hintFadeTimer = null
    hintEl.textContent = text
    hintEl.style.opacity = '1'
    scheduleFit()
    setTimeout(function () {
      hintEl.style.transition = ''
      hintEl.style.opacity = ''
    }, 220)
  }, 190)
}
function swapBubbleContent(applyFn) {
  if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null }
  textBox.style.transition = 'opacity .18s ease'
  textBox.style.opacity = '0'
  bubbleSwapTimer = setTimeout(function () {
    bubbleSwapTimer = null
    applyFn()
    textBox.style.opacity = '1'
    setTimeout(function () {
      textBox.style.transition = ''
      textBox.style.opacity = ''
    }, 220)
  }, 190)
}
function restoreBubbleLines() {
  scheduleFit()
  if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null }
  if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null }
  if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
  lastHintText = null
  textBox.style.transition = ''
  textBox.style.opacity = ''
  gifEl.style.display = 'none'
  gifEl.style.opacity = ''
  labelEl.style.display = ''
  labelEl.className = 'dshwv-label'
  labelEl.textContent = defaultLabel()
  labelEl.style.color = ''
  amountEl.style.display = ''
  amountEl.className = 'dshwv-amount'
  amountEl.style.color = ''
  hintEl.style.display = ''
  hintEl.className = 'dshwv-hint'
  hintEl.style.color = ''
  fitClearAuthored()
  render()
}
function showBubble() {
  if (!bubbleOn) return
  // 消耗金额/额度告警泡泡显示期间，余额变动不再弹出普通泡泡
  if (bubbleLocked()) return
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
  if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
  bubbleShown = true
  bubbleRandomActive = false
  restoreBubbleLines()
  bubbleBox.classList.add('dshwv-bubble-open')
  // 默认展示当前内容；点击气泡切到随机台词段；总时长 5 秒自动关闭
  bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
}
function hideBubble() {
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
  if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null }
  if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null }
  textBox.style.transition = ''
  textBox.style.opacity = ''
  hintEl.style.transition = ''
  hintEl.style.opacity = ''
  bubbleRandomActive = false
  bubbleRandomLines = null
  bubbleShown = false
  // 只销毁 gif 显示；三行文字保持现状让气泡自然淡出——不能在关闭瞬间
  // 恢复成余额内容（否则随机台词界面会闪现余额）。文字恢复交给下次
  // showBubble() 的 restoreBubbleLines()（那时气泡隐藏，恢复过程不可见）。
  bubbleBox.classList.remove('dshwv-bubble-open')
  // gif 靠 CSS opacity 过渡淡出；display:none 会跳过过渡，须等淡出完成再隐藏
  gifFadeTimer = setTimeout(function () {
    gifFadeTimer = null
    gifEl.style.display = 'none'
  }, 240)
}

// —— 每轮对话消耗金额泡泡 ——
var costBubbleTimer = null
function showCostBubble(amount, credits) {
  if (!bubbleOn || !turnCostOn) return
  if (costBubbleTimer) { clearTimeout(costBubbleTimer); costBubbleTimer = null }
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
  if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
  // 取消进行中的余额数字滚动与延迟计时器，避免竞态覆盖成本金额
  if (animId) { cancelAnimationFrame(animId); animId = null }
  if (animDelayTimer) { clearTimeout(animDelayTimer); animDelayTimer = null }
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }
  costBubbleActive = true
  bubbleRandomActive = false
  bubbleShown = true
  lastHintText = null
  // 样式：第一行 A（标签），第二行 B（红色金额），提示行 C 给口径
  gifEl.style.display = 'none'
  gifEl.style.opacity = ''
  labelEl.style.display = ''
  labelEl.className = 'dshwv-label'
  labelEl.textContent = credits !== undefined && credits !== null ? '上一轮套餐消耗:' : '上一轮对话消耗:'
  labelEl.style.color = ''
  amountEl.style.display = ''
  amountEl.className = 'dshwv-amount'
  if (credits !== undefined && credits !== null) {
    // Token Plan 轮次：显示估算 Credits（不是钱，是套餐额度）
    amountEl.textContent = '≈ ' + fmtCr(credits) + ' Cr'
  } else {
    amountEl.textContent = '¥ ' + (isFinite(amount) ? Number(amount).toFixed(2) : '--')
  }
  amountEl.style.color = '#e0433f'
  hintEl.style.display = ''
  hintEl.className = 'dshwv-hint'
  hintEl.textContent = credits !== undefined && credits !== null ? '估算 · 实际以控制台为准' : ''
  hintEl.style.color = ''
  fitClearAuthored()
  textBox.style.transition = ''
  textBox.style.opacity = ''
  bubbleBox.classList.add('dshwv-bubble-open')
  scheduleFit()
  if (turnCostCloseMs > 0) {
    costBubbleTimer = setTimeout(hideCostBubble, turnCostCloseMs)
  }
}
function hideCostBubble() {
  if (costBubbleTimer) { clearTimeout(costBubbleTimer); costBubbleTimer = null }
  costBubbleActive = false
  hideBubble()
}
// —— 周额度告警：原来「一周一报 + 8 秒自动消失」基本没有存在感 ——
//    现在三条：① 告警泡泡不自动关，点了才算确认；② 确认之后按级别到点再提醒，
//    级别升档立即再弹；③ 只要还没回到安全线，鲸鱼右上角小红点一直挂着。
var ALERT_RANK = { warn: 1, high: 2, exhausted: 3 }
var ALERT_REPEAT_MS = { warn: 3600000, high: 1800000, exhausted: 900000 }
var qwenAlertAckAt = 0
var qwenAlertAckRank = 0
var qwenAlertShownRank = 0
function setAlertDot(on) {
  if (!root) return
  if (on) { if (!root.classList.contains('dshwv-alert-over')) root.classList.add('dshwv-alert-over') }
  else if (root.classList.contains('dshwv-alert-over')) root.classList.remove('dshwv-alert-over')
}
function showQwenAlert(p) {
  if (!bubbleOn || !p || !p.alert) return
  if (costBubbleActive) return
  if (qwenAlertTimer) { clearTimeout(qwenAlertTimer); qwenAlertTimer = null }
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
  if (animId) { cancelAnimationFrame(animId); animId = null }
  qwenAlertActive = true
  qwenAlertShownRank = ALERT_RANK[(p.alert && p.alert.level) || 'warn'] || 1
  qwenAlertAckAt = 0
  qwenAlertAckRank = 0
  setAlertDot(true)
  bubbleRandomActive = false
  bubbleShown = true
  lastHintText = null
  gifEl.style.display = 'none'
  gifEl.style.opacity = ''
  labelEl.style.display = ''
  labelEl.className = 'dshwv-label'
  labelEl.textContent = p.alert.label || '套餐额度告警'
  labelEl.style.color = '#e0433f'
  amountEl.style.display = ''
  amountEl.className = 'dshwv-amount'
  amountEl.textContent = p.pct + '%'
  amountEl.style.color = '#e0433f'
  hintEl.style.display = ''
  hintEl.className = 'dshwv-hint'
  hintEl.textContent = fmtCr(p.used) + '/' + fmtCr(p.cap) + ' · 剩 ' + fmtCr(p.remaining)
  hintEl.style.color = ''
  fitClearAuthored()
  textBox.style.transition = ''
  textBox.style.opacity = ''
  bubbleBox.classList.add('dshwv-bubble-open')
  scheduleFit()
  // 不排自关定时器：告警必须被人点掉
}
function hideQwenAlert() {
  if (qwenAlertTimer) { clearTimeout(qwenAlertTimer); qwenAlertTimer = null }
  qwenAlertActive = false
  qwenAlertAckAt = Date.now() // 只是这段时间别再弹泡泡，红点继续挂着
  qwenAlertAckRank = qwenAlertShownRank
  hideBubble()
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }
function viewport() {
  return {
    w: window.innerWidth || document.documentElement.clientWidth || 1280,
    h: window.innerHeight || document.documentElement.clientHeight || 800
  }
}
function rightGap() {
  // 开关关闭：贴边（不避让滚动条）
  if (!scrollGapOn) return 0
  // 开启：用用户填写的像素；填 0 也贴边
  return scrollGapPx > 0 ? scrollGapPx : 0
}
function fmt(balance, currency) {
  var num = Number(balance)
  var fixed = isFinite(num) ? num.toFixed(2) : '--'
  return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency
}
// —— 阿里 Token Plan（Qwen 套餐）展示辅助 ——
function fmtCr(v) {
  var n = Number(v)
  if (!isFinite(n)) return '--'
  var sign = n < 0 ? '-' : ''
  var a = Math.abs(n)
  if (a >= 10000) return sign + (a / 1000).toFixed(1) + 'k'
  if (a >= 100) return sign + String(Math.round(a))
  return sign + (Math.round(a * 10) / 10)
}
function fmtReset(ms) {
  var n = Number(ms)
  if (!isFinite(n) || n <= 0) return '即将重置'
  var d = Math.floor(n / 86400000)
  var h = Math.floor((n % 86400000) / 3600000)
  if (d > 0) return d + '天' + h + 'h后重置'
  if (h > 0) return h + 'h后重置'
  return Math.max(1, Math.floor(n / 60000)) + '分钟后重置'
}
// 额度信号三态：hit 真触顶 / suspect 报错说额度不足但估算还剩很多 / throttle 限流中。
// 过期与合理性把关都在服务端（TP.summarize），这里只负责把三者分开口吻说话：
// 限流绝不能写成「已触顶 · 暂停」——那本周明明还剩几千 Credits。
function capState(p) {
  if (!p) return ''
  if (p.quotaHitAt || p.pct >= 100) return 'hit'
  if (p.quotaHitSuspectAt) return 'suspect'
  if (p.rateLimitedAt) return 'throttle'
  return ''
}
function qwenColor(p, warnPct) {
  if (!p || !isFinite(p.pct)) return ''
  var warn = warnPct || (p.alert && p.alert.warnPct) || 70
  var cs = capState(p)
  if (cs === 'hit' || p.pct >= 100) return '#e0433f'
  if (p.pct >= 90) return '#e0433f' // 快用完了该红就红，别被一条限流信号压成橙色
  if (cs === 'suspect' || cs === 'throttle') return '#e07a1f'
  if (p.pct >= warn) return '#e07a1f'
  return ''
}
function displayActive() {
  return display === 'qwen' ? 'qwen' : 'ds'
}
function defaultLabel() {
  return displayActive() === 'qwen' ? 'Token Plan 本周' : 'DeepSeek 余额'
}
var QWEN_BLOCKS = '▁▂▃▄▅▆▇█'
function qwenBars(p) {
  if (!p || !p.series || !p.series.length) return ''
  var max = 1
  for (var i = 0; i < p.series.length; i++) if (p.series[i].credits > max) max = p.series[i].credits
  var s = ''
  for (i = 0; i < p.series.length; i++) {
    var ratio = p.series[i].credits / max
    s += QWEN_BLOCKS.charAt(Math.min(7, Math.floor(ratio * 7.99)))
  }
  return s
}
// 详情三行：窗口进度 + 百分比 + 今日/主力模型
function qwenDetailLines() {
  var p = qwenData
  if (!p || !p.ok) return singleCenter('A', '还没有套餐用量记录（等 Qwen 跑一轮再来戳我）', '', true)
  var top = p.byModel && p.byModel.length ? p.byModel[0].model : '-'
  // 三行按各自字号控制长度：金额行是 128 号字，最多放 ~8 字符
  return [
    { t: '第 ' + p.dayIndex + '/7 天 ' + qwenBars(p), s: 'A', c: '' },
    { t: fmtCr(p.used) + ' Cr', s: 'B', c: qwenColor(p) || '#536ba9' },
    { t: '今日 ' + fmtCr(p.today.credits) + ' · ' + top, s: 'C', c: '' },
  ]
}
function animateAmount(from, to, currency, duration) {
  // 消耗金额泡泡/额度告警泡泡显示期间，余额数字滚动不触碰金额行
  if (bubbleLocked()) return
  // Qwen 显示模式下金额行归 Credits，余额滚动先只更新缓存值
  if (displayActive() !== 'ds') { shown = to; return }
  if (animId) cancelAnimationFrame(animId)
  if (from === null || !isFinite(from)) from = to
  if (from === to) {
    shown = to
    amountEl.textContent = fmt(to, currency)
    return
  }
  var startTime = null
  function step(ts) {
    // 帧级保护：成本泡泡出现后立即停止滚动，避免后续帧把余额写进金额行
    if (bubbleLocked()) {
      animId = null
      return
    }
    if (startTime === null) startTime = ts
    var t = Math.min(1, (ts - startTime) / duration)
    var eased = 1 - Math.pow(1 - t, 3)
    var val = from + (to - from) * eased
    amountEl.textContent = fmt(val, currency)
    if (t < 1) {
      animId = requestAnimationFrame(step)
    } else {
      animId = null
      shown = to
      amountEl.textContent = fmt(to, currency)
    }
  }
  animId = requestAnimationFrame(step)
}
function render() {
  syncAcctList()
  // 消耗金额/额度告警泡泡显示期间，余额渲染不覆盖其内容（金额行/标题行/提示行）
  if (bubbleLocked()) return
  if (displayActive() === 'qwen') { renderQwen(); return }
  var amount, hint
  if (state.status === 'error') {
    amount = shown !== null ? fmt(shown, state.currency) : '--'
    hint = state.message ? state.message.slice(0, 14) : '获取失败 · 点击重试'
  } else if (state.balance === null) {
    amount = shown !== null ? fmt(shown, state.currency) : '…'
    hint = '加载中…'
  } else {
    amount = shown !== null ? fmt(shown, state.currency) : fmt(state.balance, state.currency)
    hint = '今日已用 ' + (state.todayUsage !== null && state.todayUsage !== undefined ? fmt(state.todayUsage, state.currency) : '--')
  }
  amountEl.style.color = ''
  amountEl.textContent = amount
  if (bubbleRandomActive && bubbleRandomLines) {
    applyBubbleLines(bubbleRandomLines)
  } else {
    setHint(hint)
  }
  scheduleFit()
}
// Qwen·Token Plan 显示模式：金额行给本周 Credits，提示行给占比/剩余/重置
function renderQwen() {
  var p = qwenData
  var amount, hint, color
  if (!p) {
    amount = shownCr !== null ? fmtCr(shownCr) + ' Cr' : '…'
    hint = qwenMessage || '套餐用量加载中…'
    color = ''
  } else if (!p.ok) {
    amount = shownCr !== null ? fmtCr(shownCr) + ' Cr' : '--'
    hint = '暂无套餐用量记录'
    color = ''
  } else {
    amount = fmtCr(p.used) + ' Cr'
    hint = '剩 ' + fmtCr(p.remaining) + ' · ' + fmtReset(p.resetInMs)
    color = qwenColor(p)
    var cs = capState(p)
    if (cs === 'hit') hint = '已触顶 · 暂停'
    else if (cs === 'suspect') hint = '额度存疑 · 估算剩 ' + fmtCr(p.remaining)
    else if (cs === 'throttle') hint = '限流中 · 剩 ' + fmtCr(p.remaining)
  }
  amountEl.style.color = color
  amountEl.textContent = amount
  if (bubbleRandomActive && bubbleRandomLines) {
    applyBubbleLines(bubbleRandomLines)
  } else {
    setHint(hint)
  }
  scheduleFit()
}
// —— 阿里 Token Plan 用量：与余额各自独立拉取，互不拖累 ——
function applyQwenData(data) {
  if (!data || typeof data !== 'object') return
  if (data.ok) {
    qwenData = data
    qwenMessage = ''
    // 数字滚动：只在 Qwen 显示态下动画金额行
    if (displayActive() === 'qwen' && !qwenAlertActive && !costBubbleActive) {
      shownCr = Number(data.used)
    }
    var lvl = data.alert && data.alert.level
    var over = !!lvl && lvl !== 'ok'
    setAlertDot(over)
    if (over && !qwenAlertActive && !costBubbleActive) {
      var rank = ALERT_RANK[lvl] || 1
      var quiet = qwenAlertAckAt > 0 && qwenAlertAckRank >= rank &&
        (Date.now() - qwenAlertAckAt) < (ALERT_REPEAT_MS[lvl] || 3600000)
      if (!quiet) showQwenAlert(data)
    }
  } else {
    qwenData = data.ok === false ? data : null
    qwenMessage = String(data.error || '用量读取失败')
    setAlertDot(false) // 读不到数就不留来路不明的红点
  }
  render()
}
function fetchQwen(manual) {
  if (qwenBusy) return
  qwenBusy = true
  var ctrl = null
  var timer = null
  try {
    ctrl = new AbortController()
    timer = setTimeout(function () { try { ctrl.abort() } catch (err) {} }, FETCH_TIMEOUT_MS)
  } catch (err) {}
  fetch(QWEN_URL + (manual ? '?r=1' : ''), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
    .then(function (r) { return r.json() })
    .then(applyQwenData)
    .catch(function () {
      qwenMessage = '用量读取失败'
      render()
    })
    .finally(function () {
      qwenBusy = false
      if (timer) clearTimeout(timer)
    })
}
function setDisplay(v) {
  display = v === 'qwen' ? 'qwen' : 'ds'
  syncAcctList()
  // 切回余额时把余额数字补写回金额行，避免留着 Credits 数
  if (displayActive() === 'ds' && shown !== null) {
    amountEl.style.color = ''
    amountEl.textContent = fmt(shown, state.currency)
  }
  saveConfig()
  fetchQwen(true)
  render()
}
function express() {
  root.style.right = 'auto'
  root.style.bottom = 'auto'
  root.style.left = state.left + 'px'
  root.style.top = state.top + 'px'
  root.classList.toggle('dshwv-left', state.h === 'left')
}
function settle() {
  var vp = viewport()
  var w = root.offsetWidth || root.getBoundingClientRect().width || 0
  var h = root.offsetHeight || root.getBoundingClientRect().height || 0
  if (drag && drag.active) {
    // mid-drag resize: keep the pointer-follow position, just clamp into view
    state.left = clamp(state.left, 0, Math.max(0, vp.w - w - rightGap()))
    state.top = clamp(state.top, 0, Math.max(0, vp.h - h))
    express()
    return
  }
  if (state.h === 'right') {
    state.left = Math.max(0, vp.w - w - state.hOff - rightGap())
  } else if (state.h === 'left') {
    state.left = state.hOff
  } else {
    state.left = clamp(state.left, 0, Math.max(0, vp.w - w - rightGap()))
  }  if (state.v === 'bottom') {
    state.top = Math.max(0, vp.h - h - state.vOff)
  } else if (state.v === 'top') {
    state.top = state.vOff
  } else {
    state.top = clamp(state.top, 0, Math.max(0, vp.h - h))
  }
  scheduleFit() // 位置/尺寸变了，泡泡能长多大也变了（靠边时得收敛）
  express()
}
function refresh(manual) {
  if (busy) return
  busy = true
  if (animDelayTimer) { clearTimeout(animDelayTimer); animDelayTimer = null }
  if (manual || state.balance === null) { state.status = 'loading'; render() }
  var ctrl = null
  var timer = null
  try {
    ctrl = new AbortController()
    timer = setTimeout(function () { try { ctrl.abort() } catch (err) {} }, FETCH_TIMEOUT_MS)
  } catch (err) {}
  fetch(BALANCE_URL, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
    .then(function (r) { return r.json() })
    .then(function (data) {
      if (data && data.ok) {
        var nb = Number(data.totalBalance)
        var nc = String(data.currency || 'CNY')
        var changed = state.balance !== null && (nb !== state.balance || nc !== state.currency)
        var currencyChanged = state.currency !== null && nc !== state.currency
        state.balance = nb
        state.currency = nc
        state.message = ''
        state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null
        state.isPeak = !!data.isPeak
        if (changed && !currencyChanged) {
          if (!manual && displayActive() === 'ds') {
            showBubble()
            state.status = 'changing'
            // balance-change bubble: wait 0.3s after it floats out, then roll the number
            if (animDelayTimer) clearTimeout(animDelayTimer)
            animDelayTimer = setTimeout(function () {
              animDelayTimer = null
              animateAmount(shown, nb, nc, ANIM_MS)
            }, 300)
            if (settleTimer) clearTimeout(settleTimer)
            settleTimer = setTimeout(function () {
              settleTimer = null
              if (state.status === 'changing') { state.status = 'ok'; render() }
            }, CHANGE_MS + 300)
          } else {
            animateAmount(shown, nb, nc, ANIM_MS)
            state.status = 'ok'
            render()
          }
        } else {
          if (animId === null) shown = nb
          state.status = 'ok'
          render()
        }
      } else {
        state.status = 'error'
        state.message = (data && data.error) ? String(data.error) : '获取失败'
        render()
      }
    })
    .catch(function () {
      state.status = 'error'
      state.message = '获取失败'
      render()
    })
    .finally(function () {
      busy = false
      if (timer) clearTimeout(timer)
    })
}
var soundOn = true
var soundVol = 0.9
var soundSet = 'duck'
var usageMode = 'ledger'
var peakMode = 'default'
var bubbleOn = true
var turnCostOn = true
var turnCostCloseMs = 5000
var costBubbleActive = false
var scrollGapOn = false
var scrollGapPx = 17
function saveConfig() {
  try {
    fetch(SIZE_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scale: state.scale, sound: soundOn, vol: soundVol, soundSet: soundSet, usageMode: usageMode, peakMode: peakMode, bubbleOn: bubbleOn, turnCostOn: turnCostOn, turnCostCloseMs: turnCostCloseMs, scrollGapOn: scrollGapOn, scrollGapPx: scrollGapPx, display: display, qwenWarnPct: qwenWarnPct }) })
    // 锚点位置记忆：记录相对边框的离边距离，窗口 resize 后保持（localStorage）。
    // v:2 = 净距离格式（剥离避让距离），v:1 旧格式含避让距离，恢复时废弃旧格式。
    var vp = viewport()
    var w = root.offsetWidth || root.getBoundingClientRect().width || 0
    var h = root.offsetHeight || root.getBoundingClientRect().height || 0
    var leftDist = state.left
    var rightDist = vp.w - state.left - w
    var topDist = state.top
    var bottomDist = vp.h - state.top - h
    var hAnchor = leftDist <= rightDist ? 'left' : 'right'
    var hDistRaw = Math.round(Math.min(leftDist, rightDist))
    var hDist = hAnchor === 'right' && scrollGapOn ? Math.max(0, hDistRaw - rightGap()) : hDistRaw
    localStorage.setItem('dshw-pos', JSON.stringify({
      v: 2,
      hAnchor: hAnchor,
      hDist: hDist,
      vAnchor: topDist <= bottomDist ? 'top' : 'bottom',
      vDist: Math.round(Math.min(topDist, bottomDist))
    }))
  } catch (err) {}
}
function setUsageMode(v) {
  usageMode = v === 'token' ? 'token' : 'ledger'
  usageSelect.value = usageMode
  saveConfig()
  refresh(false)
}
function setQwenWarn(v) {
  var n = Number(v)
  if (!isFinite(n) || n <= 0) n = 70
  qwenWarnPct = Math.round(clamp(n, 5, 100))
  saveConfig()
  // 阈值一变，服务端立刻重算级别（可能马上弹告警）
  fetchQwen(true)
}
function setPeakMode(v) {
  peakMode = v === 'liangwen' || v === 'qiangqiang' ? v : 'default'
  peakSelect.value = peakMode
  saveConfig()
}
function setBubbleOn(v) {
  bubbleOn = !!v
  bubbleToggle.checked = bubbleOn
  saveConfig()
  // 必须走 hideCostBubble：残留的 costBubbleActive 会让 render()/showBubble() 永久早退
  if (!bubbleOn) hideCostBubble()
}
function setTurnCostOn(v) {
  turnCostOn = !!v
  turnCostToggle.checked = turnCostOn
  turnCostCloseInput.disabled = !turnCostOn
  saveConfig()
  if (!turnCostOn) hideCostBubble()
}
function setTurnCostClose(v) {
  if (!turnCostOn) return
  var n = Math.max(0, Math.round(Number(v) || 0))
  turnCostCloseMs = n * 1000
  turnCostCloseInput.value = String(n)
  saveConfig()
}
function setScrollGapOn(v) {
  scrollGapOn = !!v
  scrollGapToggle.checked = scrollGapOn
  scrollGapInput.disabled = !scrollGapOn
  saveConfig()
  settle()
}
function setScrollGapPx(v) {
  if (!scrollGapOn) return
  var n = Math.max(0, Math.round(Number(v) || 0))
  scrollGapPx = n
  scrollGapInput.value = String(n)
  saveConfig()
  settle()
}
function scaleToDisplay(s) {
  return Math.round((s - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / 19)) + 1
}
function setScale(v) {
  var next = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(v))) * 10) / 10
  // 缩放测量需要 left/top 立即到位：临时禁用过渡（滚轮/数字框路径没有
  // 滑块 pointerdown 的 transition:none，否则 r2 测的是过渡起点导致错锚点）
  var prevTrans = root.style.transition
  root.style.transition = 'none'
  var rect = root.getBoundingClientRect()
  // fixed point: the whale's corner — bottom-right when unflipped, bottom-left
  // when flipped. Growing extends the widget up-left / up-right from that
  // corner; shrinking pulls it back toward the corner. The whale always hugs
  // its corner while scaling.
  var fx = state.h === 'left' ? rect.left : rect.right
  var fy = rect.bottom
  state.scale = next
  root.style.setProperty('--dshw-scale', String(next))
  scaleInput.value = String(next)
  scaleNumber.value = String(scaleToDisplay(next))
  saveConfig()
  // keep the corner fixed while resizing; the position correction applies
  // instantly because the caller disables the transition for the whole drag
  var r2 = root.getBoundingClientRect()
  var vp = viewport()
  if (state.h === 'left') {
    state.left = Math.min(Math.max(fx, 0), Math.max(0, vp.w - r2.width))
  } else {
    state.left = Math.min(Math.max(fx - r2.width, 0), Math.max(0, vp.w - r2.width))
  }
  state.top = Math.min(Math.max(fy - r2.height, 0), Math.max(0, vp.h - r2.height))
  express()
  scheduleFit()
  // 恢复过渡必须延迟到下一帧：本帧 left/top 已在 none 下设置并提交，
  // 立即恢复会让浏览器对「刚改过的 left/top」重新评估并播放过渡动画
  // （翻转时叠加 transform .3s 更明显，表现为抽搐）。
  requestAnimationFrame(function () {
    root.style.transition = prevTrans
  })
}
function setVol(v) {
  var next = Math.round(Math.min(1, Math.max(0, Number(v))) * 100) / 100
  soundVol = next
  soundOn = next > 0
  volInput.value = String(next)
  volPct.textContent = Math.round(next * 100) + '%'
  try {
    if (pressAudio) pressAudio.volume = next
    if (releaseAudio) releaseAudio.volume = next
  } catch (err) {}
  saveConfig()
}
function setSoundSet(v) {
  soundSet = v === 'fx1' ? 'fx1' : 'duck'
  soundSelect.value = soundSet
  applySoundSet()
  saveConfig()
}
var SQUISH = 'scaleY(0.88) scaleX(1.05)'
var pressAudio = null
var releaseAudio = null
var pressing = false
var pressEnded = false
var releasePlayed = false
var releaseTimer = null
function applySoundSet() {
  try {
    pressAudio = new Audio('/dsh-whale/sound/press.mp3?set=' + soundSet)
    pressAudio.preload = 'auto'
    pressAudio.volume = soundVol
    releaseAudio = new Audio('/dsh-whale/sound/release.mp3?set=' + soundSet)
    releaseAudio.preload = 'auto'
    releaseAudio.volume = soundVol
  } catch (err) {}
}
function playPress() {
  if (!pressAudio || !soundOn) return
  try {
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null }
    if (releaseAudio) {
      releaseAudio.pause()
      releaseAudio.currentTime = 0
    }
    pressEnded = false
    releasePlayed = false
    pressAudio.onended = function () {
      pressEnded = true
      // fallback (duration unknown): click → Ya2 right after Ya1 ends
      if (!pressing && !releasePlayed) playRelease()
      // hold: still pressed → wait for pressUp()
    }
    pressAudio.currentTime = 0
    var p = pressAudio.play()
    if (p && typeof p.catch === 'function') p.catch(function () {})
  } catch (err) {}
}
function playRelease() {
  if (releasePlayed || !releaseAudio || !soundOn) return
  releasePlayed = true
  try {
    releaseAudio.currentTime = 0
    var p = releaseAudio.play()
    if (p && typeof p.catch === 'function') p.catch(function () {})
  } catch (err) {}
}
function pressDown() {
  body.style.transform = SQUISH
  pressing = true
  playPress()
}
function pressUp() {
  body.style.transform = 'scaleY(1) scaleX(1)'
  pressing = false
  if (pressEnded) {
    // hold (or released after Ya1 finished) → Ya2 now
    playRelease()
    return
  }
  // click: start Ya2 in the last 100ms of Ya1's playback
  var durKnown = false
  var remainMs = 0
  try {
    var dur = pressAudio ? pressAudio.duration : 0
    if (isFinite(dur) && dur > 0) {
      durKnown = true
      remainMs = (dur - pressAudio.currentTime) * 1000
    }
  } catch (err) {}
  if (durKnown) {
    releaseTimer = setTimeout(function () {
      releaseTimer = null
      playRelease()
    }, Math.max(0, remainMs - 100))
  }
  // duration unknown → pressAudio.onended fallback plays Ya2 after Ya1 ends
}
var menuOpen = false
function toggleMenu() {
  menuOpen = !menuOpen
  if (menuOpen) positionMenu()
  menuBox.classList.toggle('dshwv-menu-open', menuOpen)
  if (menuOpen) menuBtn.classList.add('dshwv-menu-btn-visible')
}
function closeMenu() {
  menuOpen = false
  menuBox.classList.remove('dshwv-menu-open')
  root.style.transition = ''
  snapCheck()
}
function snapCheck() {
  var rect = root.getBoundingClientRect()
  var vp = viewport()
  var w = rect.width, h = rect.height
  var left = rect.left, top = rect.top
  var centerX = left + w / 2
  var centerY = top + h / 2
  var moved = false
  if (centerX < vp.w / 4) {
    state.h = 'left'
    state.hOff = 0
    left = 0
    moved = true
  } else if (centerX > vp.w * 3 / 4) {
    state.h = 'right'
    state.hOff = 0
    left = vp.w - w - rightGap()
    moved = true
  } else {
    state.h = null
    state.hOff = left
  }
  if (centerY < vp.h / 4) {
    state.v = 'top'
    state.vOff = 0
    top = 0
    moved = true
  } else {
    state.v = 'bottom'
    state.vOff = Math.max(0, vp.h - top - h)
  }
  if (moved) {
    state.left = left
    state.top = top
    settle()
  }
}
function positionMenu() {
  try {
    var r = root.getBoundingClientRect()
    var b = menuBtn.getBoundingClientRect()
    var vp = viewport()
    var onLeft = r.left + r.width / 2 < vp.w / 2
    // the menu appears ABOVE the button, anchored to its side:
    // right side → menu bottom-right aligns with the button's top-right;
    // left side → menu bottom-left aligns with the button's top-left
    if (onLeft) {
      menuBox.style.left = b.left + 'px'
      menuBox.style.right = 'auto'
      menuBox.style.transformOrigin = 'bottom left'
    } else {
      menuBox.style.right = (vp.w - b.right) + 'px'
      menuBox.style.left = 'auto'
      menuBox.style.transformOrigin = 'bottom right'
    }
    menuBox.style.bottom = (vp.h - b.top) + 'px'
    menuBox.style.top = 'auto'
  } catch (err) {}
}

var hitCanvas = null
var hitReady = false
function setupHitTest() {
  try {
    hitCanvas = document.createElement('canvas')
    hitCanvas.width = 610
    hitCanvas.height = 610
    var probe = new Image()
    probe.onload = function () {
      try {
        // 拉伸到 610×610 与 isWhaleHit 的坐标映射对齐；不指定尺寸会按原图大小绘制，
        // 回退到非 610×610 素材（如 DSniang02.png）时命中区域会错位
        hitCanvas.getContext('2d').drawImage(probe, 0, 0, 610, 610)
        hitReady = true
      } catch (err) {}
    }
    probe.onerror = function () {}
    probe.src = IMG_URL
  } catch (err) {}
}
function isWhaleHit(e) {
  if (!hitCanvas || !hitReady) return true
  try {
    var r = img.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return false
    var lx = (e.clientX - r.left) / r.width * 610
    var ly = (e.clientY - r.top) / r.height * 610
    if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false
    if (state.h === 'left') lx = 610 - lx
    var data = hitCanvas.getContext('2d').getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data
    return data[3] > 10
  } catch (err) {
    return true
  }
}
function onDocPointerDown(e) {
  if (e.target && e.target.closest) {
    if (e.target.closest('.dshwv-bubble') || e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-menu-btn')) return
  }
  if (menuOpen) {
    closeMenu()
    return
  }
  if (e.button !== 0 && e.pointerType === 'mouse') return
  if (!isWhaleHit(e)) return
  try { e.preventDefault(); e.stopPropagation() } catch (err) {}
  var vp = viewport()
  var rect = root.getBoundingClientRect()
  drag = { active: true, startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, w: rect.width, h: rect.height, moved: false, vp: vp }
  root.classList.add('dshwv-dragging')
  pressDown()
  setWidgetCursor('grabbing')
  document.addEventListener('pointermove', onDocPointerMove, true)
  document.addEventListener('pointerup', onDocPointerUp, true)
  document.addEventListener('pointercancel', onDocPointerCancel, true)
}
function onDocPointerMove(e) {
  if (!drag || !drag.active) return
  var dx = e.clientX - drag.startX
  var dy = e.clientY - drag.startY
  if (dx * dx + dy * dy >= CLICK_SQ) drag.moved = true
  // Keep the pre-drag flip orientation while dragging (state.h/v stay as they
  // were); on release endDrag() recomputes the anchors and settle() flips the
  // class with a smooth transition instead of reverting instantly.
  state.left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w))
  state.top = clamp(drag.origTop + dy, 0, Math.max(0, drag.vp.h - drag.h))
  express()
}
function onDocPointerUp(e) {
  // 拦截鲸鱼区域内的 pointerup：防止下方元素（如文件行）监听 pointerup 穿透误触发
  try { if (isWhaleHit(e)) { e.preventDefault(); e.stopPropagation() } } catch (err) {}
  endDrag(e, true)
}
function onDocPointerCancel(e) { endDrag(e, false) }
function onDocClickStopper(e) {
  // 只在鲸鱼命中区域拦截 click（保持透明区 pass-through）。
  // 持久注册（不随 endDrag 移除）——click 在 pointerup 之后派发，
  // 若在 endDrag 移除会导致 click 穿透到下方元素（如误打开文件）。
  if (!isWhaleHit(e)) return
  try { e.preventDefault(); e.stopPropagation() } catch (err) {}
}
document.addEventListener('pointerdown', onDocPointerDown, true)
document.addEventListener('click', onDocClickStopper, true)

var widgetCursor = ''
function setWidgetCursor(v) {
  if (v !== widgetCursor) {
    widgetCursor = v
    try { document.body.style.cursor = v } catch (err) {}
  }
}
function onDocPointerMoveCursor(e) {
  if (drag && drag.active) { setWidgetCursor('grabbing'); return }
  var el = null
  try { el = document.elementFromPoint(e.clientX, e.clientY) } catch (err) {}
  if (el && el.closest && (el.closest('.dshwv-bubble') || el.closest('.dshwv-menu') || el.closest('.dshwv-menu-btn'))) {
    setWidgetCursor('')
    menuBtn.classList.add('dshwv-menu-btn-visible')
    return
  }
  var over = isWhaleHit(e)
  setWidgetCursor(over ? 'grab' : '')
  menuBtn.classList.toggle('dshwv-menu-btn-visible', over || menuOpen)
}
document.addEventListener('pointermove', onDocPointerMoveCursor, true)

function endDrag(e, clickAllowed) {
  if (!drag || !drag.active) return
  drag.active = false
  document.removeEventListener('pointermove', onDocPointerMove, true)
  document.removeEventListener('pointerup', onDocPointerUp, true)
  document.removeEventListener('pointercancel', onDocPointerCancel, true)
  pressUp()
  root.classList.remove('dshwv-dragging')
  setWidgetCursor(isWhaleHit(e) ? 'grab' : '')
  if (clickAllowed && !drag.moved) {
    if (qwenAlertActive) hideQwenAlert()
    else if (costBubbleActive) hideCostBubble()
    else showBubble()
    refresh(true); fetchQwen(true); return
  }
  var dx = e.clientX - drag.startX
  var dy = e.clientY - drag.startY
  var left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w))
  var top = clamp(drag.origTop + dy, 0, Math.max(0, drag.vp.h - drag.h))
  var centerX = left + drag.w / 2
  var centerY = top + drag.h / 2
  if (centerX < drag.vp.w / 4) {
    state.h = 'left'
    state.hOff = 0
  } else if (centerX > drag.vp.w * 3 / 4) {
    state.h = 'right'
    state.hOff = 0
  } else {
    state.h = null
    state.hOff = left
  }
  if (centerY < drag.vp.h / 4) {
    state.v = 'top'
    state.vOff = 0
  } else if (centerY > drag.vp.h * 3 / 4) {
    state.v = 'bottom'
    state.vOff = 0
  } else {
    state.v = null
    state.vOff = top
  }
  state.left = left
  state.top = top
  settle()
  // 拖拽结束立即保存锚点位置（否则刷新/关闭后位置回退到上次改菜单时）
  saveConfig()
}
// 窗口尺寸变化时：自由位置的鲸鱼按相对边框锚点重算（保持离边距离，窗口恢复原状即回原位）；
// 贴边吸附的鲸鱼走 settle()（保持贴边）
function applyAnchorPos() {
  try {
    var a = JSON.parse(localStorage.getItem('dshw-pos') || 'null')
    if (!a || a.v !== 2 || (a.hAnchor !== 'left' && a.hAnchor !== 'right') || typeof a.hDist !== 'number' ||
        (a.vAnchor !== 'top' && a.vAnchor !== 'bottom') || typeof a.vDist !== 'number') return false
    var vp = viewport()
    var w = root.offsetWidth || root.getBoundingClientRect().width || 0
    var h = root.offsetHeight || root.getBoundingClientRect().height || 0
    // 与加载恢复一致：锚点存净距离，右锚点按当前避让开关叠加
    var effectiveRightDist = a.hAnchor === 'right' ? a.hDist + (scrollGapOn ? rightGap() : 0) : a.hDist
    var l = a.hAnchor === 'left' ? a.hDist : vp.w - effectiveRightDist - w
    var t = a.vAnchor === 'top' ? a.vDist : vp.h - a.vDist - h
    state.left = clamp(l, 0, Math.max(0, vp.w - w))
    state.top = clamp(t, 0, Math.max(0, vp.h - h))
    state.h = a.hAnchor
    state.hOff = 0
    state.v = a.vAnchor
    state.vOff = 0
    express()
    return true
  } catch (err) { return false }
}
window.addEventListener('resize', function () {
  scheduleFit()
  if (state.h === null && state.v === null && applyAnchorPos()) return
  settle()
})

var rect0 = root.getBoundingClientRect()
state.left = rect0.left
state.top = rect0.top
express()
render()
applySoundSet()
setupHitTest()
fetch(SIZE_URL, { cache: 'no-store' })
  .then(function (r) { return r.json() })
  .then(function (d) {
    if (d && typeof d.scale === 'number' && d.scale >= MIN_SCALE - 0.1 && d.scale <= MAX_SCALE + 0.1) {
      state.scale = d.scale
      root.style.setProperty('--dshw-scale', String(d.scale))
      scaleInput.value = String(d.scale)
      scaleNumber.value = String(scaleToDisplay(d.scale))
      settle()
    }
    if (d && typeof d.vol === 'number') {
      soundVol = d.vol
      soundOn = soundVol > 0
      volInput.value = String(soundVol)
      volPct.textContent = Math.round(soundVol * 100) + '%'
      try {
        if (pressAudio) pressAudio.volume = soundVol
        if (releaseAudio) releaseAudio.volume = soundVol
      } catch (err) {}
    }
    if (d && typeof d.soundSet === 'string') {
      soundSet = d.soundSet === 'fx1' ? 'fx1' : 'duck'
      soundSelect.value = soundSet
      applySoundSet()
    }
    if (d && typeof d.usageMode === 'string') {
      usageMode = d.usageMode === 'token' ? 'token' : 'ledger'
      usageSelect.value = usageMode
    }
    if (d && typeof d.peakMode === 'string') {
      peakMode = d.peakMode === 'liangwen' || d.peakMode === 'qiangqiang' ? d.peakMode : 'default'
      peakSelect.value = peakMode
    }
    if (d && typeof d.bubbleOn === 'boolean') {
      bubbleOn = d.bubbleOn
      bubbleToggle.checked = bubbleOn
    }
    if (d && typeof d.turnCostOn === 'boolean') {
      turnCostOn = d.turnCostOn
      turnCostToggle.checked = turnCostOn
      turnCostCloseInput.disabled = !turnCostOn
    }
    if (d && typeof d.turnCostCloseMs === 'number') {
      turnCostCloseMs = d.turnCostCloseMs > 0 ? d.turnCostCloseMs : 0
      turnCostCloseInput.value = String(Math.round(turnCostCloseMs / 1000))
    }
    if (d && typeof d.scrollGapOn === 'boolean') {
      scrollGapOn = d.scrollGapOn
      scrollGapToggle.checked = scrollGapOn
      scrollGapInput.disabled = !scrollGapOn
    }
    if (d && typeof d.scrollGapPx === 'number') {
      scrollGapPx = d.scrollGapPx > 0 ? Math.round(d.scrollGapPx) : 0
      scrollGapInput.value = String(scrollGapPx)
    }
    if (d && (d.display === 'ds' || d.display === 'qwen')) {
      // 旧版本存过 'rotate'（轮换）：已按用户要求去掉，宿主会归一成 'ds'
      display = d.display
    }
    syncAcctList()
    if (d && typeof d.qwenWarnPct === 'number' && d.qwenWarnPct > 0) {
      qwenWarnPct = Math.round(clamp(d.qwenWarnPct, 5, 100))
      qwenWarnInput.value = String(qwenWarnPct)
    }
    // 相对边框恢复（localStorage 锚点）：窗口变化后保持离边距离。
    // 仅认 v:2 净距离格式；旧格式（含避让距离）废弃，挂件保持默认右下角吸附。
    // 恢复时还原吸附状态（hAnchor/vAnchor → state.h/v），避免挂件变自由位置
    // 导致避让调节不实时（settle 自由分支只 clamp 不重算位置）。
    try {
      var a = JSON.parse(localStorage.getItem('dshw-pos') || 'null')
      if (a && a.v === 2 && (a.hAnchor === 'left' || a.hAnchor === 'right') && typeof a.hDist === 'number' &&
          (a.vAnchor === 'top' || a.vAnchor === 'bottom') && typeof a.vDist === 'number') {
        var vpA = viewport()
        var wA = root.offsetWidth || root.getBoundingClientRect().width || 0
        var hA = root.offsetHeight || root.getBoundingClientRect().height || 0
        // 锚点存的是净距离：右锚点按当前避让开关叠加避让距离
        var effectiveRightDist = a.hAnchor === 'right' ? a.hDist + (scrollGapOn ? rightGap() : 0) : a.hDist
        var lA = a.hAnchor === 'left' ? a.hDist : vpA.w - effectiveRightDist - wA
        var tA = a.vAnchor === 'top' ? a.vDist : vpA.h - a.vDist - hA
        state.left = clamp(lA, 0, Math.max(0, vpA.w - wA))
        state.top = clamp(tA, 0, Math.max(0, vpA.h - hA))
        // 按锚点还原吸附状态（贴边锚点 → 吸附；自由位锚点 → 自由）
        state.h = a.hAnchor
        state.hOff = 0
        state.v = a.vAnchor
        state.vOff = 0
        settle()
      }
    } catch (err) {}
    refresh(false)
  })
  .catch(function () { refresh(false) })
setInterval(function () { refresh(false) }, REFRESH_MS)
// 套餐用量单独节奏：账本 30s 内不会变很多次，省点本地 IO
setInterval(function () { fetchQwen(false) }, QWEN_REFRESH_MS)

// —— 每轮对话消耗检测：轮询 last-turn.json，出现新 seq 时弹消耗金额泡泡 ——
var LAST_TURN_URL = '/dsh-whale/last-turn.json'
var lastCostSeq = 0
var lastCostAligned = false
function pollLastTurn() {
  try {
    fetch(LAST_TURN_URL, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (!d || !d.ok || typeof d.seq !== 'number') return
        if (!lastCostAligned) {
          // 首次拿到数据：只对齐 seq，不弹旧轮次
          lastCostSeq = d.seq
          lastCostAligned = true
          return
        }
        if (d.seq > lastCostSeq) {
          lastCostSeq = d.seq
          if (d.credits !== null && d.credits !== undefined) {
            // Token Plan 轮次：弹估算 Credits（口径与面板一致）
            showCostBubble(null, Number(d.credits))
          } else if (d.turn !== null && d.amount !== null) {
            showCostBubble(Number(d.amount), null)
          }
        }
      })
      .catch(function () {})
  } catch (err) {}
}
setInterval(pollLastTurn, 1000)
// 首帧就拉一次套餐用量（不等 30s），Qwen 显示态与轮换态都能立刻有数
fetchQwen(false)
})()`


const name = 'whale-balance-widget'
const inject = ['webServer', 'credentials']

function apply(ctx) {
    let imageBytes = null
    let balanceCache = null
    let balanceInFlight = null
    let gifBytes = null
    // 每轮对话消耗统计：按 (session.id, turn) 分桶聚合，完成后写入 lastTurn。
    // 用 Map 分桶避免主会话与子代理（spawn/fork）并行时串账。
    let turnAggs = new Map() // sessionId -> { turn, cost, credits, calls, tokens, lastTs }
    let lastTurn = null // { turn, amount, credits, provider, tokens, ts }
    let lastTurnSeq = 0
    // —— 阿里 Token Plan（provider 路由 tokenplan）用量检测 ——
    // 路由归属：harness 在每次请求前 append('request/context', {provider, model})，
    // 用它区分 tokenplan 与 bailian 上的同名 qwen 模型，避免串账。
    const sessionRoute = new Map() // sessionId -> { provider, model }
    const qwenSeen = new Set() // 已计入的 sessionId:turn:step，防重启回放重复计
    let qwenLedger = null // {days:{date:{...}}, alert, quotaHitAt, rateLimitedAt}
    let qwenDirty = false
    let qwenFlushTimer = null
    let qwenCache = null
    let qwenInFlight = null
    const disposers = []

    function finalizeTurn(sessionId) {
      const agg = turnAggs.get(sessionId)
      if (agg && (agg.cost > 0 || agg.credits > 0)) {
        lastTurn = {
          turn: agg.turn,
          amount: agg.cost > 0 ? agg.cost : null,
          credits: agg.credits > 0 ? agg.credits : null,
          provider: agg.provider || '',
          tokens: agg.tokens,
          ts: agg.lastTs,
        }
        lastTurnSeq++
      }
      turnAggs.delete(sessionId)
    }
    // Token Plan 失败信号：调用被阻断时 harness 会把 LlmFailure 写进 turn/end。
    // 关键是别把两种完全不同的事混成一种显示：
    //   1) 只认走套餐路由的会话（别的 provider 报 quota/403 与本周额度无关）
    //   2) 百炼免费额度耗尽（free quota）与套餐无关 → 忽略
    //   3) 429 / Throttling / #token-limit 是每分钟 TPM 限流，按分钟重置，
    //      不是周额度用尽 → 只标 rateLimitedAt（实测：一次 429 就让 66.5%
    //      的用量长期显示成「已触顶 · 暂停」，就是这个混淆造成的）
    //   4) 剩下的才当触顶候选，最终由 TP.summarize 按估算用量二次把关
    function noteQuotaHit(sessionId, reason) {
      try {
        const route = sessionRoute.get(sessionId)
        if (!route || route.provider !== qwenConfig().provider) return
        const err = reason && reason.error
        if (!err || typeof err !== 'object') return
        const kind = TP.classifyFailure(err)
        if (kind !== 'cap' && kind !== 'throttle') return
        const led = readQwenLedger()
        const stamp = String(err.code || err.status || '').slice(0, 40)
        const now = Date.now()
        if (kind === 'throttle') {
          led.rateLimitedAt = now
          led.rateLimitCode = stamp
        } else {
          led.quotaHitAt = now
          led.quotaHitCode = stamp
          led.quotaHitKind = 'cap' // 账本升级用：没有这个字段的旧触顶标记一律作废
          led.quotaHitPct = Number(computeQwenBase().pct) || 0 // 记下来自哪档用量，便于回看
        }
        markQwenDirty()
      } catch (err) {}
    }
    // 监听会话事件流：assistant/message 携带每步真实 usage，按 (session,turn) 聚合；
    // turn/end 时结算该会话本轮并写入 lastTurn
    function handleSessionEvent(sessionId, event) {
      try {
        const type = event && event.type
        const d = event && event.data
        if (!d || typeof d !== 'object') return
        if (type === 'request/context' || type === 'model/selection') {
          if (typeof d.provider === 'string' || typeof d.model === 'string') {
            sessionRoute.set(sessionId, {
              provider: String(d.provider || ''),
              model: String(d.model || ''),
              at: Date.now(),
            })
          }
          return
        }
        if (type === 'turn/end') {
          if (d.reason && d.reason.kind === 'error') noteQuotaHit(sessionId, d.reason)
          finalizeTurn(sessionId)
          return
        }
        if (type !== 'assistant/message') return
        const turn = Number(d.turn)
        const usage = d.usage
        if (!usage || typeof usage !== 'object' || !isFinite(turn)) return
        const step = Number(d.step)
        const route = sessionRoute.get(sessionId)
        const messageModel = d.message && d.message.source ? d.message.source.model : ''
        const model = messageModel || (route ? route.model : '')
        const provider = route ? route.provider : ''
        const cfg = qwenConfig()
        const onTokenPlan = cfg.enabled && TP.isTokenPlanCall(cfg, provider, model)
        // 去重：同一 (session,turn,step) 只计一次（重启回放/重复投递防护）
        let fresh = true
        if (isFinite(step)) {
          const key = sessionId + ':' + turn + ':' + step
          fresh = !qwenSeen.has(key)
          if (fresh) {
            qwenSeen.add(key)
            if (qwenSeen.size > 20000) qwenSeen.clear()
          }
        }
        let agg = turnAggs.get(sessionId)
        if (!agg || agg.turn !== turn) {
          if (agg) finalizeTurn(sessionId)
          agg = { turn, cost: 0, credits: 0, tokens: 0, lastTs: Date.now(), provider: provider || '' }
          turnAggs.set(sessionId, agg)
        }
        if (!agg.provider && provider) agg.provider = provider
        const input = Number(usage.inputTokens) || 0
        const cache = Number(usage.cacheReadTokens) || 0
        const output = Number(usage.outputTokens) || 0
        const reasoning = Number(usage.reasoningTokens) || 0
        agg.tokens += input + cache + output + reasoning
        if (onTokenPlan) {
          // 套餐轮次：按 Credits 估算，不套 DeepSeek 峰谷价目（那是另一套钱）
          if (fresh) {
            const est = TP.estimateUsage(model, usage, cfg.calib)
            agg.credits += est.credits
            accumulateQwenUsage(model, est)
          }
        } else {
          // 定价换算（CNY/百万 token；缓存命中=输入价，其余按各自档位）
          const p = priceFor(model)
          const off = isPeakTime(Math.floor(Date.now() / 1000)) ? 1 : 0
          agg.cost += (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + ((output + reasoning) / 1e6) * p.out[off]
        }
        agg.lastTs = Date.now()
      } catch (err) {}
    }

    // 监听所有会话的追加事件；按会话 id 分桶，turn/end 时结算该会话本轮
    disposers.push(ctx.on('session/event', (session, event) => {
      const sid = session && session.id ? session.id : 'default'
      handleSessionEvent(sid, event)
    }))
    // 会话销毁时清理残留聚合，避免内存泄漏
    disposers.push(ctx.on('session/disposed', (session) => {
      if (session && session.id) {
        turnAggs.delete(session.id)
        sessionRoute.delete(session.id)
      }
    }))

    // —— 阿里 Token Plan 用量估算（本地账本，0 网络 0 key）————
    let qwenCfgCache = { at: 0, cfg: null }
    function qwenConfig() {
      const now = Date.now()
      if (qwenCfgCache.cfg && now - qwenCfgCache.at < 5000) return qwenCfgCache.cfg
      const cfg = TP.normalizeConfig(readSizeConfig() || {})
      qwenCfgCache = { at: now, cfg }
      return cfg
    }
    function invalidateQwenConfig() {
      qwenCfgCache = { at: 0, cfg: null }
      qwenCache = null
    }
    function readJsonFile(p) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (err) {
        return null
      }
    }
    function readQwenLedger() {
      if (qwenLedger) return qwenLedger
      let led = null
      for (const p of QWEN_LEDGER_CANDIDATES) {
        const parsed = readJsonFile(p)
        if (parsed && parsed.days && typeof parsed.days === 'object') {
          led = parsed
          break
        }
      }
      if (!led) led = { version: 1, days: {} }
      if (typeof led.days !== 'object' || led.days === null) led.days = {}
      // 账本升级：0.2.11 之前的 quotaHitAt 会把 429 限流也记成触顶，那条脏标记
      // 能存活 6h，升级后依旧会顶着「已触顶 · 暂停」。新记录一律带 quotaHitKind，
      // 见到没带 kind 的旧触顶标记就当未知处理掉 —— 宁可不报也不误报。
      if (led.quotaHitAt && !led.quotaHitKind) {
        led.quotaHitAt = null
        led.quotaHitCode = null
        qwenLedger = led
        markQwenDirty() // 立刻安排落盘，别下次启动又读回同一条脏标记
        return led
      }
      qwenLedger = led
      return led
    }
    function markQwenDirty() {
      qwenDirty = true
      // 账本一变，汇总缓存立即失效（面板下次拉取就能看到最新数）
      qwenCache = null
      if (!qwenFlushTimer) {
        qwenFlushTimer = setTimeout(() => {
          qwenFlushTimer = null
          flushQwenLedger()
        }, 2000)
        if (qwenFlushTimer.unref) qwenFlushTimer.unref()
      }
    }
    function flushQwenLedger() {
      if (!qwenDirty || !qwenLedger) return
      const body = JSON.stringify(qwenLedger)
      for (const p of QWEN_LEDGER_CANDIDATES) {
        try {
          fs.writeFileSync(p, body, 'utf8')
          qwenDirty = false
          return
        } catch (err) {}
      }
    }
    // 实时账本：事件流每步累加（dsh-usage 账本没启用/没落盘时的兜底来源）
    function accumulateQwenUsage(model, est) {
      if (!est || !(est.credits > 0)) return
      const led = readQwenLedger()
      const key = TP.localDayKey(Date.now())
      const day = led.days[key] || { credits: 0, payg: 0, tokens: 0, calls: 0, models: {}, unknown: {} }
      day.credits += est.credits
      day.payg += est.payg
      day.tokens += est.tokens
      day.calls += est.calls
      const slot = day.models[model] || { credits: 0, tokens: 0, calls: 0 }
      slot.credits += est.credits
      slot.tokens += est.tokens
      slot.calls += est.calls
      day.models[model] = slot
      if (!est.known) day.unknown[model] = true
      led.days[key] = day
      // 只留最近 40 天（够用 7 天窗口 + 一周前的回看）
      const keys = Object.keys(led.days).sort()
      while (keys.length > 40) delete led.days[keys.shift()]
      markQwenDirty()
    }
    // dsh-usage 逐日逐模型账本（provider=tokenplan）
    function readUsageLedgerDays(provider) {
      for (const p of DSH_USAGE_LEDGER_CANDIDATES) {
        const parsed = readJsonFile(p)
        if (parsed && parsed.days && typeof parsed.days === 'object') return TP.parseLedger(parsed, provider)
      }
      return {}
    }
    function computeQwenBase() {
      const cfg = qwenConfig()
      const now = Date.now()
      if (qwenCache && now - qwenCache.at < QWEN_TTL_MS) return qwenCache.payload
      const led = readQwenLedger()
      // 过期信号先清掉再汇总。原来的顺序是「先汇总、后清标记」，那份
      // 带着过期 quotaHitAt 的 payload 又被写回 qwenCache（markQwenDirty
      // 置空缓存紧接着又被下一行覆盖），等于把已判定过期的告警再显示 30s。
      let ledStale = false
      if (led.quotaHitAt && now - led.quotaHitAt > TP.QUOTA_HIT_TTL_MS) {
        led.quotaHitAt = null
        led.quotaHitCode = null
        led.quotaHitKind = null
        ledStale = true
      }
      if (led.rateLimitedAt && now - led.rateLimitedAt > TP.RATE_LIMIT_TTL_MS) {
        led.rateLimitedAt = null
        led.rateLimitCode = null
        ledStale = true
      }
      if (ledStale) markQwenDirty()
      const ledgerDays = readUsageLedgerDays(cfg.provider)
      // 窗口锚点：配置 qwenWindowAnchor 优先；没配置则由 summarize() 退到「账本首个有量日」
      const anchor = cfg.windowAnchor
      const payload = TP.summarize({
        ledgerDays,
        selfDays: led.days,
        cfg: Object.assign({}, cfg, { windowAnchor: anchor }),
        nowMs: now,
        quotaHitAt: led.quotaHitAt,
        rateLimitedAt: led.rateLimitedAt,
      })
      payload.ledgerSource = Object.keys(ledgerDays).length ? 'dsh-usage' : 'none'
      payload.quotaHitCode = String(led.quotaHitCode || '')
      payload.rateLimitCode = String(led.rateLimitCode || '')

      qwenCache = { at: now, payload }
      return payload
    }
    function getQwenPayload() {
      const base = computeQwenBase()
      // 「是否冒泡」每次请求现算，绝不写进缓存对象（否则缓存期内人人中招）
      const led = readQwenLedger()
      const now = Date.now()
      const announce = TP.shouldAnnounce(led.alert, base.alert.level, base.windowStart, now)
      const payload = Object.assign({}, base, { alert: Object.assign({}, base.alert, { shouldAnnounce: announce }) })
      if (announce) {
        led.alert = TP.markAnnounced(led.alert, base.alert.level, base.windowStart, now)
        markQwenDirty() // 顺带丢掉汇总缓存
      }
      return payload
    }

    function loadGif() {
      if (gifBytes) return gifBytes
      for (const p of RUA_GIF_CANDIDATES) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) {
            gifBytes = bytes
            return bytes
          }
        } catch (err) {}
      }
      throw new Error('rua gif not found')
    }

    function loadImage() {
      if (imageBytes) return imageBytes
      for (const p of IMAGE_CANDIDATES) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) {
            imageBytes = bytes
            return bytes
          }
        } catch (err) {}
      }
      throw new Error('whale image not found')
    }

    function pickBalanceInfo(infos) {
      if (!Array.isArray(infos) || infos.length === 0) return null
      const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
      return (
        infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
        infos.find((x) => num(x) > 0) ||
        infos.find((x) => x && x.currency === 'CNY') ||
        infos[0]
      )
    }

    async function fetchBalance() {
      let cred
      try {
        cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
      } catch (err) {
        return { ok: false, code: 'NO_KEY', error: '凭据读取失败: ' + String((err && err.message) || err).slice(0, 160) }
      }
      if (!cred) {
        return { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY' }
      }
      let lastErr = null
      for (let attempt = 0; attempt < 2; attempt++) {
        let res
        try {
          res = await fetch(BALANCE_URL, {
            headers: { Authorization: 'Bearer ' + cred.value },
            signal: AbortSignal.timeout(20000),
          })
        } catch (err) {
          lastErr = err
          if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
          continue
        }
        if (!res.ok) {
          lastErr = new Error('HTTP ' + res.status)
          if (res.status < 500) break
          if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
          continue
        }
        let data
        try {
          data = await res.json()
        } catch (err) {
          return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
        }
        const info = pickBalanceInfo(data && data.balance_infos)
        if (!info || info.total_balance === undefined) {
          return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
        }
        return {
          ok: true,
          totalBalance: Number(info.total_balance),
          currency: String(info.currency || 'CNY'),
          updatedAt: new Date().toISOString(),
        }
      }
      const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
      return {
        ok: false,
        code: 'HTTP',
        transient: transient,
        error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
      }
    }

    async function fetchUsage() {
      let cred
      try {
        cred = await ctx.credentials.resolve('DEEPSEEK_PLATFORM_TOKEN')
      } catch (err) {
        return { error: 'platform cred resolve failed' }
      }
      if (!cred) return { error: 'no platform token' }
      const token = String(cred.value).replace(/^Bearer\s+/i, '')
      try {
        const now = new Date()
        const tz = -now.getTimezoneOffset() * 60
        const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
        const end = start + 86400
        const url = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=' + start + '&end=' + end + '&tz=' + tz
        const res = await fetch(url, {
          headers: { Authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) return { error: 'http ' + res.status }
        const data = await res.json()
        const u = computeTodayUsage(data)
        if (u && isFinite(u.amount)) return { amount: u.amount, tokens: u.tokens }
        return { error: 'no usage' }
      } catch (err) {
        return { error: String((err && err.message) || err) }
      }
    }

    function computeTodayUsage(data) {
      // data.data.biz_data.series[]: [{model, buckets:[{time, usage:{RESPONSE_TOKEN, PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN}}]}]
      let d = data
      if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
      else if (d && d.data && Array.isArray(d.data.series)) d = d.data
      const series = Array.isArray(d.series) ? d.series : null
      if (!series || series.length === 0) return null
      let cost = 0
      let tokens = 0
      let found = false
      for (const s of series) {
        if (!s || typeof s !== 'object') continue
        const p = priceFor(s.model)
        const buckets = Array.isArray(s.buckets) ? s.buckets : []
        for (const b of buckets) {
          const u = b && b.usage
          if (!u || typeof u !== 'object') continue
          const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0
          const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0
          const out = Number(u.RESPONSE_TOKEN) || 0
          if (hit + miss + out === 0) continue
          found = true
          tokens += hit + miss + out
          const pi = isPeakTime(b.time) ? 1 : 0
          cost += (hit / 1e6) * p.hit[pi] + (miss / 1e6) * p.miss[pi] + (out / 1e6) * p.out[pi]
        }
      }
      return found ? { amount: cost, tokens: tokens } : null
    }

    function todayKey() {
      const d = new Date()
      const p = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }
    function readUsageLedger() {
      for (const p of USAGE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') return parsed
        } catch (err) {}
      }
      return { date: todayKey(), lastBalance: null, todayUsage: 0, history: {} }
    }
    function writeUsageLedger(led) {
      const body = JSON.stringify(led)
      for (const p of USAGE_FILE_CANDIDATES) {
        try {
          fs.writeFileSync(p, body, 'utf8')
          return true
        } catch (err) {}
      }
      return false
    }
    // 记账模式：每次观测到余额后，用余额正差值累计当天用量（跨天自动归零并归档）。
    // 币种感知：观测币种与上次不同时只重置基准、不记差值——数值跳变来自币种
    // 切换而非真实消费（[0] 选币时代 CNY/USD 随机切换曾记出巨额假账，见 #13）。
    function recordLedgerUsage(currentBalance, currency) {
      const t = todayKey()
      let led = readUsageLedger()
      const cur = String(currency || '')
      const currencyChanged =
        typeof led.lastCurrency === 'string' && led.lastCurrency !== '' &&
        cur !== '' && led.lastCurrency !== cur
      if (led.date !== t) {
        if (led.date && typeof led.todayUsage === 'number') {
          led.history = led.history || {}
          led.history[led.date] = led.todayUsage
        }
        led.date = t
        led.lastBalance = currentBalance
        led.lastCurrency = cur
        led.todayUsage = 0
      } else if (currencyChanged) {
        // 币种切换：只换基准，不把差值记成消费
        led.lastBalance = currentBalance
        led.lastCurrency = cur
      } else {
        const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
        if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
          led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
        }
        led.lastBalance = currentBalance
        led.lastCurrency = cur
      }
      const keys = Object.keys(led.history || {}).sort()
      while (keys.length > 30) {
        delete led.history[keys.shift()]
      }
      writeUsageLedger(led)
      return led
    }
    function normalizeUsageMode(m) {
      return m === 'token' ? 'token' : 'ledger'
    }

    async function getBalancePayload() {
      const payload = await fetchBalance()
      if (!payload.ok) return payload
      // 无论哪种模式，都先把余额观测记入账本（自动累积「鲸鱼记账」数据）
      const led = recordLedgerUsage(Number(payload.totalBalance), payload.currency)
      const cfg = readSizeConfig() || {}
      const mode = normalizeUsageMode(cfg.usageMode)
      const full = { ...payload }
      full.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
      if (mode === 'ledger') {
        full.todayUsage = led.todayUsage
        full.usageMode = 'ledger'
        return full
      }
      // token：尝试平台令牌实时计算
      let cred = null
      try {
        cred = await ctx.credentials.resolve('DEEPSEEK_PLATFORM_TOKEN')
      } catch (err) {}
      if (cred) {
        const u = await fetchUsage()
        if (u && u.amount !== undefined) {
          full.todayUsage = u.amount
          full.usageMode = 'token'
          return full
        }
      }
      // 无令牌或令牌失败：回落记账模式
      full.todayUsage = led.todayUsage
      full.usageMode = 'ledger'
      return full
    }

    function getBalance() {
      const now = Date.now()
      if (balanceCache && now - balanceCache.at < BALANCE_TTL_MS) {
        return Promise.resolve(balanceCache.payload)
      }
      if (balanceInFlight) return balanceInFlight
      balanceInFlight = getBalancePayload()
        .then((payload) => {
          if (payload.ok) {
            balanceCache = { at: now, payload }
            return payload
          }
          if (payload.transient && balanceCache) {
            // transient network/API blip: keep serving the last known balance
            return { ...balanceCache.payload, stale: true, error: payload.error }
          }
          if (!payload.transient) console.error('[whale-balance]', payload.code, payload.error)
          return payload
        })
        .catch((err) => ({
          ok: false,
          code: 'ERROR',
          error: '余额服务异常: ' + String((err && err.message) || err).slice(0, 200),
        }))
        .finally(() => {
          balanceInFlight = null
        })
      return balanceInFlight
    }

    function readSizeConfig() {
      for (const p of SIZE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && typeof parsed.scale === 'number') {
            return {
              scale: parsed.scale,
              sound: parsed.sound !== false,
              vol: typeof parsed.vol === 'number' ? parsed.vol : 0.9,
              soundSet: parsed.soundSet === 'fx1' ? 'fx1' : 'duck',
              usageMode: normalizeUsageMode(parsed.usageMode),
              peakMode: parsed.peakMode === 'liangwen' || parsed.peakMode === 'qiangqiang' ? parsed.peakMode : 'default',
              bubbleOn: parsed.bubbleOn !== false,
              turnCostOn: parsed.turnCostOn !== false,
              turnCostCloseMs: typeof parsed.turnCostCloseMs === 'number' ? parsed.turnCostCloseMs : 5000,
              scrollGapOn: parsed.scrollGapOn === true,
              scrollGapPx: typeof parsed.scrollGapPx === 'number' ? Math.round(parsed.scrollGapPx) : 17,
              display: normalizeDisplay(parsed.display),
              qwenEnabled: parsed.qwenEnabled !== false,
              qwenCap: typeof parsed.qwenCap === 'number' && parsed.qwenCap > 0 ? Math.round(parsed.qwenCap) : 0,
              qwenWarnPct: typeof parsed.qwenWarnPct === 'number' && parsed.qwenWarnPct > 0 ? parsed.qwenWarnPct : 70,
              qwenCalib: typeof parsed.qwenCalib === 'number' && parsed.qwenCalib > 0 ? parsed.qwenCalib : 1,
              qwenWindowAnchor:
                typeof parsed.qwenWindowAnchor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.qwenWindowAnchor)
                  ? parsed.qwenWindowAnchor
                  : '',
            }
          }
        } catch (err) {}
      }
      return null
    }

    // 配置改为对象入参（原来 12 个位置参数已经加不动了）；调用点只有一个。
    function writeSizeConfig(parsed) {
      const cfg = parsed && typeof parsed === 'object' ? parsed : {}
      const um = normalizeUsageMode(cfg.usageMode)
      const pm = cfg.peakMode === 'liangwen' || cfg.peakMode === 'qiangqiang' ? cfg.peakMode : 'default'
      const bo = cfg.bubbleOn !== false
      const tco = cfg.turnCostOn !== false
      const tcc = typeof cfg.turnCostCloseMs === 'number' ? (cfg.turnCostCloseMs > 0 ? cfg.turnCostCloseMs : 0) : 5000
      const sgo = cfg.scrollGapOn === true
      const sgp = typeof cfg.scrollGapPx === 'number' && cfg.scrollGapPx > 0 ? Math.round(cfg.scrollGapPx) : 0
      const result = {
        ok: true,
        scale: cfg.scale,
        sound: cfg.sound !== false,
        vol: typeof cfg.vol === 'number' ? cfg.vol : 0.9,
        soundSet: cfg.soundSet === 'fx1' ? 'fx1' : 'duck',
        usageMode: um,
        peakMode: pm,
        bubbleOn: bo,
        turnCostOn: tco,
        turnCostCloseMs: tcc,
        scrollGapOn: sgo,
        scrollGapPx: sgp,
        display: normalizeDisplay(cfg.display),
        qwenEnabled: cfg.qwenEnabled !== false,
        qwenCap: typeof cfg.qwenCap === 'number' && cfg.qwenCap > 0 ? Math.round(cfg.qwenCap) : 0,
        qwenWarnPct:
          typeof cfg.qwenWarnPct === 'number' && cfg.qwenWarnPct > 0 ? Math.round(Math.min(100, cfg.qwenWarnPct)) : 70,
        qwenCalib: typeof cfg.qwenCalib === 'number' && cfg.qwenCalib > 0 ? cfg.qwenCalib : 1,
        qwenWindowAnchor:
          typeof cfg.qwenWindowAnchor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cfg.qwenWindowAnchor)
            ? cfg.qwenWindowAnchor
            : '',
      }
      const body = JSON.stringify(Object.assign({}, result, { updatedAt: new Date().toISOString() }))
      for (const p of SIZE_FILE_CANDIDATES) {
        try {
          fs.writeFileSync(p, body, 'utf8')
          return result
        } catch (err) {}
      }
      return { ok: false, error: '无法持久化挂件配置' }
    }

    function readBody(req) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > 8192) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/image.png',
      handler: (req, res) => {
        try {
          const bytes = loadImage()
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('whale image unavailable: ' + String((err && err.message) || err))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/rua.gif',
      handler: (req, res) => {
        try {
          const bytes = loadGif()
          res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('rua gif unavailable: ' + String((err && err.message) || err))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/balance.json',
      handler: async (req, res) => {
        try {
          const payload = await getBalance()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(payload))
        } catch (err) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/last-turn.json',
      handler: (req, res) => {
        // 返回最近一轮已完成的对话消耗；seq 递增供前端判断「新的一轮」
        const payload = lastTurn
          ? {
              ok: true,
              seq: lastTurnSeq,
              turn: lastTurn.turn,
              amount: lastTurn.amount,
              credits: lastTurn.credits,
              provider: lastTurn.provider,
              tokens: lastTurn.tokens,
              ts: lastTurn.ts,
            }
          : { ok: true, seq: 0, turn: null, amount: null, credits: null, provider: '', tokens: null, ts: null }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/size.json',
      handler: async (req, res) => {
        if (req.method === 'PUT' || req.method === 'POST') {
          try {
            const body = await readBody(req)
            const parsed = JSON.parse(body)
            const scale = typeof parsed.scale === 'number' ? parsed.scale : null
            if (scale === null) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'missing scale' }))
              return
            }
            // 用量模式变化时让余额缓存失效，下次请求立即按新模式计算
            if (typeof parsed.usageMode === 'string') {
              const old = readSizeConfig()
              if (!old || normalizeUsageMode(old.usageMode) !== normalizeUsageMode(parsed.usageMode)) {
                balanceCache = null
              }
            }
            const result = writeSizeConfig(parsed)
            // Token Plan 口径类参数变了要立刻丢掉估算缓存
            if (
              'qwenCap' in parsed || 'qwenCalib' in parsed || 'qwenWarnPct' in parsed ||
              'qwenWindowAnchor' in parsed || 'qwenEnabled' in parsed || 'qwenTier' in parsed
            ) {
              invalidateQwenConfig()
            }
            res.writeHead(result.ok ? 200 : 500, JSON_HEADERS)
            res.end(JSON.stringify(result))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
          }
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(readSizeConfig() || {}))
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/qwen.json',
      handler: (req, res) => {
        // 阿里云百炼 Token Plan（qwen 等套餐模型）用量估算：周窗口 Credits、
        // 剩余、重置倒计时、近 7 天曲线、ROI、告警级别。纯本地账本，不碰密钥。
        try {
          const payload = getQwenPayload()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(payload))
        } catch (err) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    function loadSound(candidates) {
      for (const p of candidates) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) return bytes
        } catch (err) {}
      }
      return null
    }

    function serveSound(req, res, candidates) {
      const bytes = loadSound(candidates)
      if (!bytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('sound unavailable')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    }

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/sound/press.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        serveSound(req, res, set.press)
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/sound/release.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        serveSound(req, res, set.release)
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/widget.js',
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(WIDGET_JS)
      },
    }))

    disposers.push(ctx.webServer.tapIndex((html) => {
      if (html.indexOf('/dsh-whale/widget.js') !== -1) return html
      const tag = '<script defer src="/dsh-whale/widget.js"></script>'
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
      return html + tag
    }))

    ctx.effect(() => () => {
      if (qwenFlushTimer) {
        clearTimeout(qwenFlushTimer)
        qwenFlushTimer = null
      }
      flushQwenLedger()
      for (const d of disposers) {
        try { d() } catch (err) {}
      }
    })
}

export { name, inject, apply }
