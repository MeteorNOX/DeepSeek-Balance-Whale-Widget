import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAccount, DEFAULT_CREDENTIALS, DEFAULT_LABELS, normalizeOrigin, createRateLimiter, learnRateLimitCap, DEFAULT_USER_TOKEN_CREDENTIALS } from './providers.js'

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
  '.dshwv-bubble svg{display:block;width:100%;height:100%;pointer-events:none}',
  '.dshwv-bubble svg path,.dshwv-bubble svg ellipse{pointer-events:none;cursor:pointer}',
  '.dshwv-bubble.dshwv-bubble-open svg path,.dshwv-bubble.dshwv-bubble-open svg ellipse{pointer-events:visiblePainted}',
  '.dshwv-bubble .dshwv-bshape,.dshwv-bubble .dshwv-b1,.dshwv-bubble .dshwv-b2{opacity:0;transform:scale(.7);transform-box:fill-box;transform-origin:50% 50%;transition:opacity .2s ease,transform .2s ease}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-bshape,.dshwv-bubble.dshwv-bubble-open .dshwv-b1,.dshwv-bubble.dshwv-bubble-open .dshwv-b2{opacity:1;transform:none}',
  '.dshwv-gif{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);max-width:calc(var(--dshw-u) * 560);max-height:calc(var(--dshw-u) * 400);display:none;opacity:0;transition:opacity .2s ease;pointer-events:none;-webkit-user-drag:none;user-select:none;object-fit:contain}',
  '.dshwv-root.dshwv-left .dshwv-gif{transform:translate(-50%,-50%) scaleX(-1)}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-gif{opacity:1}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-b2{transition-delay:0s}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-b1{transition-delay:.13s}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-bshape{transition-delay:.26s}',
  '.dshwv-bubble .dshwv-bshape{transition-delay:.1s}',
  '.dshwv-bubble .dshwv-b1{transition-delay:.2s}',
  '.dshwv-bubble .dshwv-b2{transition-delay:.3s}',
  '.dshwv-text{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);text-align:center;color:#536ba9;line-height:1.15;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .16s ease,transform .3s ease}',
  '.dshwv-bubble.dshwv-bubble-open .dshwv-text{opacity:1;transition:opacity .16s ease .36s,transform .3s ease}',
  '.dshwv-root.dshwv-left .dshwv-text{transform:translate(-50%,-50%) scaleX(-1)}',
  '.dshwv-label{font-size:calc(var(--dshw-u) * 66);font-weight:600;letter-spacing:.06em}',
  '.dshwv-amount{font-size:calc(var(--dshw-u) * 128);font-weight:800;line-height:1.05}',
  '.dshwv-period{font-size:calc(var(--dshw-u) * 104);font-weight:800;line-height:1.05}',
  '.dshwv-wrap{white-space:normal;max-width:calc(var(--dshw-u) * 560);line-height:1.2}',
  '.dshwv-hint{font-size:calc(var(--dshw-u) * 56);color:#9fb0d9;letter-spacing:.02em;margin-top:calc(var(--dshw-u) * 9);min-height:calc(var(--dshw-u) * 64);line-height:1.15}',
  '.dshwv-menu-btn{position:absolute;top:calc(40.55% + 4px);right:4px;width:26px;height:26px;border:none;border-radius:6px;background:rgba(32,49,112,.85);cursor:pointer;pointer-events:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:0;z-index:2;opacity:0;transition:opacity .15s ease}',
  '.dshwv-menu-btn.dshwv-menu-btn-visible{opacity:1}',
  '.dshwv-menu-btn span{display:block;width:14px;height:2px;background:#fff;border-radius:1px}',
  '.dshwv-menu-btn:hover{background:#203170}',
  '.dshwv-menu{position:fixed;min-width:196px;background:rgba(255,255,255,.92);border:1px solid rgba(32,49,112,.35);border-radius:10px;padding:10px 12px;opacity:0;transform:scale(.92) translateY(-4px);transform-origin:top right;transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);pointer-events:none;z-index:10000;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:light}',
  '.dshwv-menu.dshwv-menu-open{opacity:1;transform:scale(1) translateY(0);pointer-events:auto}',
  '.dshwv-menu-row{display:flex;align-items:center;gap:8px;margin:5px 0;color:#203170;font-size:12px;white-space:nowrap}',
  '.dshwv-range{flex:1;min-width:0;accent-color:#203170}',
  '.dshwv-number{width:44px;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:2px 4px;font-size:12px;color:#203170;background:#fff;box-sizing:border-box}',
  '.dshwv-number:disabled{opacity:.4;background:rgba(32,49,112,.06);cursor:not-allowed}',
  '.dshwv-sound{flex:1;border:1px solid rgba(32,49,112,.4);border-radius:6px;background:rgba(32,49,112,.08);color:#203170;font-size:12px;padding:3px 0;cursor:pointer}',
  '.dshwv-sound:hover{background:rgba(32,49,112,.16)}',
  '.dshwv-check{width:16px;height:16px;accent-color:#203170;cursor:pointer;flex:0 0 auto}',
  '.dshwv-menu-sep{height:1px;background:rgba(32,49,112,.25);margin:6px 0}',
  '.dshwv-volpct{width:44px;text-align:right;color:#203170;font-size:12px}',
  '.dshwv-menu-btn2{flex:1;border:none;border-radius:6px;background:rgba(32,49,112,.08);color:#203170;font-size:12px;padding:5px 0;cursor:pointer}',
  '.dshwv-menu-btn2:hover{background:rgba(32,49,112,.18)}',
  // 「显示」多选触发按钮：叠加 .dshwv-sound 取得与其它菜单控件一致的
  // 边框/底色/圆角/字号，仅附加 flex 布局以容纳选中 tag（chips）
  '.dshwv-multi{flex:1;min-width:0;display:flex}',
  '.dshwv-multi-trigger{min-width:0;display:flex;align-items:center;gap:4px;padding:3px 6px;text-align:left}',
  '.dshwv-chips{flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow-x:auto;scrollbar-width:none}',
  '.dshwv-chips::-webkit-scrollbar{display:none}',
  '.dshwv-chip{flex:0 0 auto;display:inline-flex;align-items:center;border:none;border-radius:5px;background:rgba(32,49,112,.12);color:#203170;font-size:11px;line-height:1;padding:3px 6px;max-width:86px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}',
  '.dshwv-chip:hover{background:rgba(32,49,112,.22)}',
  '.dshwv-chip.dshwv-chip-cur{background:#203170;color:#fff}',
  '.dshwv-chip-empty{color:#9fb0d9;font-size:11px;flex:0 0 auto}',
  '.dshwv-caret{flex:0 0 auto;color:#203170;font-size:10px;pointer-events:none}',
  '.dshwv-multi-panel{position:fixed;min-width:180px;max-height:220px;overflow-y:auto;background:rgba(255,255,255,.97);border:1px solid rgba(32,49,112,.35);border-radius:8px;padding:6px;z-index:10001;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:light;color:#203170;font-size:12px;display:none}',
  '.dshwv-multi-panel.dshwv-multi-open{display:block}',
  '.dshwv-multi-row{display:flex;align-items:center;gap:7px;padding:5px 6px;border-radius:6px;cursor:pointer;white-space:nowrap}',
  '.dshwv-multi-row:hover{background:rgba(32,49,112,.09)}',
  '.dshwv-multi-box{width:15px;height:15px;flex:0 0 auto;border:1.5px solid #203170;border-radius:4px;position:relative;background:#fff}',
  '.dshwv-multi-row.dshwv-multi-on .dshwv-multi-box::after{content:"";position:absolute;left:2.5px;top:0.5px;width:6px;height:9px;border:solid #203170;border-width:0 2px 2px 0;transform:rotate(45deg)}',
  '.dshwv-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:#c3cdea}',
  '.dshwv-dot-ok{background:#2fa24c}',
  '.dshwv-dot-err{background:#e0433f}',
  '.dshwv-multi-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}',
  '.dshwv-overlay{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(20,26,54,.45);display:none;align-items:center;justify-content:center;z-index:20000}',
  '.dshwv-modal{width:min(460px,calc(100vw - 48px));max-height:calc(100vh - 64px);overflow:auto;background:#fff;border-radius:12px;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.28);color:#203170;font-size:13px;line-height:1.5}',
  '.dshwv-modal-title{font-size:15px;font-weight:700;margin-bottom:10px}',
  '.dshwv-modal-sec{font-weight:700;margin:12px 0 4px;padding-top:10px;border-top:1px solid rgba(32,49,112,.15)}',
  '.dshwv-modal-guide{color:#536ba9;white-space:pre-line;word-break:break-all}',
  '.dshwv-modal-row{display:flex;align-items:center;gap:8px;margin:6px 0}',
  '.dshwv-modal-row label{flex:0 0 64px;font-weight:600}',
  '.dshwv-modal-input{flex:1;min-width:0;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:6px 8px;font-size:13px;color:#203170;background:#fff;box-sizing:border-box}',
  '.dshwv-modal-input:disabled{opacity:.55;background:rgba(32,49,112,.05)}',
  '.dshwv-modal-num{width:76px;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:6px 8px;font-size:13px;color:#203170;background:#fff;box-sizing:border-box}',
  '.dshwv-modal-err{color:#e0433f;font-size:12px;min-height:16px;margin-top:4px}',
  '.dshwv-modal-ok{color:#2fa24c;font-size:12px;min-height:16px;margin-top:4px}',
  '.dshwv-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
  '.dshwv-modal-btn{border:none;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer}',
  '.dshwv-modal-btn-save{background:#203170;color:#fff}',
  '.dshwv-modal-btn-cancel{background:rgba(32,49,112,.1);color:#203170}',
  '.dshwv-modal-btn:disabled{opacity:.5;cursor:default}',
  '.dshwv-modal-hint{color:#9fb0d9;font-size:12px;margin-top:2px}',
  '.dshwv-modal-used{color:#536ba9;font-size:12px;word-break:break-all}',
  '.dshwv-modal-select{flex:1;min-width:0;border:1px solid rgba(32,49,112,.4);border-radius:6px;background:rgba(32,49,112,.08);color:#203170;font-size:13px;padding:6px 4px;cursor:pointer}',
  '.dshwv-modal-details{margin:6px 0}',
  '.dshwv-modal-details summary{cursor:pointer;color:#203170;font-size:12px;font-weight:600;user-select:none}',
  '.dshwv-modal-details .dshwv-modal-guide{margin-top:6px;padding:8px 10px;background:rgba(32,49,112,.05);border-radius:8px}'
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
var peakSelect = document.createElement('select')
peakSelect.className = 'dshwv-sound'
peakSelect.appendChild(soundOpt('default', '默认'))
peakSelect.appendChild(soundOpt('liangwen', '梁文峰谷'))
peakSelect.appendChild(soundOpt('qiangqiang', '!?强强?!'))
peakSelect.addEventListener('change', function () { setPeakMode(peakSelect.value) })
// 「显示」= 多选下拉（改进 v1.1）：触发器内嵌选中 tag（chips），点 chip 直接切
// 到该账户展示；▾ 展开浮层可勾选多个账户；气泡点击在选中账户间轮流更换。
var multiWrap = document.createElement('div')
multiWrap.className = 'dshwv-multi'
multiWrap.title = '勾选气泡要展示的账户（多选）；点 tag 立即切换该账户，点击鲸鱼图片轮流更换'
var multiTrigger = document.createElement('button')
multiTrigger.type = 'button'
multiTrigger.className = 'dshwv-sound dshwv-multi-trigger'
var chipsBox = document.createElement('span')
chipsBox.className = 'dshwv-chips'
var multiCaret = document.createElement('span')
multiCaret.className = 'dshwv-caret'
multiCaret.textContent = '▾'
multiTrigger.appendChild(chipsBox)
multiTrigger.appendChild(multiCaret)
multiWrap.appendChild(multiTrigger)
// 浮层挂在 body（与菜单同层级）；打开时按触发器矩形定位，点击面板内部不冒泡关闭
var multiPanel = document.createElement('div')
multiPanel.className = 'dshwv-multi-panel'
var panelOpen = false
multiTrigger.addEventListener('click', function (e) { e.stopPropagation(); toggleMultiPanel() })
multiPanel.addEventListener('click', function (e) { e.stopPropagation() })
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
var row5 = menuRow()
row5.appendChild(menuLabel('峰谷'))
row5.appendChild(peakSelect)
var rowDisplay = menuRow()
rowDisplay.appendChild(menuLabel('显示'))
rowDisplay.appendChild(multiWrap)
var currencySelect = document.createElement('select')
currencySelect.className = 'dshwv-sound'
currencySelect.title = '选择余额显示符号（¥ / $，金额数值不变）'
var currencyAutoOpt = document.createElement('option')
currencyAutoOpt.value = 'auto'
currencyAutoOpt.textContent = '自动'
currencySelect.appendChild(currencyAutoOpt)
var currencyCnyOpt = document.createElement('option')
currencyCnyOpt.value = 'CNY'
currencyCnyOpt.textContent = 'CNY'
currencySelect.appendChild(currencyCnyOpt)
var currencyUsdOpt = document.createElement('option')
currencyUsdOpt.value = 'USD'
currencyUsdOpt.textContent = 'USD'
currencySelect.appendChild(currencyUsdOpt)
currencySelect.addEventListener('change', function () { setDisplayCurrency(currencySelect.value) })
var rowCurrency = menuRow()
rowCurrency.appendChild(menuLabel('货币'))
rowCurrency.appendChild(currencySelect)
var settingsBtn = document.createElement('button')
settingsBtn.type = 'button'
settingsBtn.className = 'dshwv-menu-btn2'
settingsBtn.textContent = '设置'
settingsBtn.title = 'New API 用户余额凭据 · 实时令牌指引 · 接口查询限制'
settingsBtn.addEventListener('click', function () { closeMenu(); openSettings() })
var rowSettings = menuRow()
rowSettings.appendChild(menuLabel('凭据'))
rowSettings.appendChild(settingsBtn)
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
menuBox.appendChild(row5)
menuBox.appendChild(rowDisplay)
menuBox.appendChild(rowCurrency)
menuBox.appendChild(row6)
menuBox.appendChild(row7)
menuBox.appendChild(menuSep1)
menuBox.appendChild(row9)
menuBox.appendChild(rowSettings)

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
  if (costBubbleActive) {
    // 消耗金额泡泡：点击关闭（确认）
    hideCostBubble()
    return
  }
  // 气泡点击 = 随机台词交互（v1.1 定稿）：首次点击切到随机台词段，再次点击
  // 关闭。多账户轮流更换在「点击鲸鱼图片」上（见 endDrag）。
  if (bubbleRandomActive) {
    // 再次点击：关闭
    hideBubble()
  } else {
    // 首次点击：切到随机台词段，并重置自动关闭计时——
    // 保证第二段台词有完整停留时间（否则第 4 秒点击只看到 0.5 秒）
    bubbleRandomActive = true
    bubbleRandomLines = pickRandomLines()
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
document.body.appendChild(root)
document.body.appendChild(menuBox)
document.body.appendChild(multiPanel)

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
  message: '',
  providers: [],
  accounts: {},
  displayProvider: '',
  // 「点击显示」多选：selectedProviders = 勾选的 accountId 集合（按选项顺序
  // 归一），pendingSelection = size.json 里读到的持久化集合（首次刷新时消费），
  // selectedInit 标记首次采纳已完成。
  selectedProviders: [],
  pendingSelection: null,
  selectedInit: false,
  displayFigure: null,
  displayFigureCurrency: null,
  displayCurrency: '',
  rateLimit: null,
  refreshMs: REFRESH_MS
}
// —— 多中转站：点击显示 ——
function displayAccountId(dp) {
  var id = dp || 'deepseek'
  var colon = id.indexOf(':')
  if (colon !== -1) id = id.slice(0, colon)
  return id
}
// 「已用配额」独立模式已移除：把遗留的 '{accountId}:usage' 归一化为纯
// '{accountId}'，避免下拉框（已无 usage 选项）因旧值而无选中项。
function normalizeDisplayProvider(dp) {
  var id = typeof dp === 'string' && dp !== '' ? dp : 'deepseek'
  var colon = id.indexOf(':')
  if (colon !== -1) id = id.slice(0, colon)
  return id
}
function displayModeOf() {
  // 已用配额展示选项已移除：余额卡片按账户数据自适应，不再有独立的
  // 「已用配额」模式。未配置访问令牌（无用户余额）时自动显示 token 级已用。
  return 'balance'
}
function getDisplayAccount() {
  return state.accounts[displayAccountId(state.displayProvider)] || null
}
function getDisplayMode() {
  return displayModeOf(state.displayProvider)
}
function computeDisplayFigure(acc, mode) {
  if (!acc || acc.ok !== true) return null
  if (acc.type === 'deepseek') {
    if (mode === 'usage') return acc.todayUsage
    return acc.balance
  }
  // 余额态：
  // - newapi 有真实用户余额时优先显示用户余额（token 级 unlimited_quota
  //   只影响 token 配额口径，不能把 40.93 的用户余额盖成 123.28 的已用）；
  // - 未配置访问令牌（无用户余额，balance 缺省）→ 显示 token 级已用
  //   （用户要求：余额没配置令牌时显示已用额度）；
  // - 其余按旧规则：token 级不限额且无用户余额 → 展示已用。
  if (acc.type === 'newapi' && acc.balance !== undefined && acc.balance !== null) return acc.balance
  if (acc.unlimited) return acc.used
  // 未配置访问令牌：token 级已用仍可读，作余额占位
  if (acc.type === 'newapi' && !acc.userTokenConfigured && acc.used !== undefined && acc.used !== null) return acc.used
  // 订阅型账户（kimi-coding/minimax/zhipu-coding 等）：没有钱包余额，
  // 金额行回退展示第一个窗口的已用量（如已用 prompt 数）
  if (acc.windows && acc.windows.length && acc.windows[0].used !== undefined && acc.windows[0].used !== null) {
    return acc.windows[0].used
  }
  return acc.balance
}
// 按「货币」偏好取最终金额与币种符号。'auto' 用账户自身币种
// （newapi 余额态优先用户余额币种 balanceCurrency，如 CNY）；
// 'CNY'/'USD' 仅切换显示符号（¥/$，金额数值不变、不虚构汇率换算），
// 其余历史值按 auto 处理。仅余额态生效。
function displayFigureParts(acc, mode) {
  if (!acc || acc.ok !== true) return null
  var base = computeDisplayFigure(acc, mode)
  if (mode !== 'balance') return { value: base, currency: acc.currency }
  var pref = state.displayCurrency || 'auto'
  var autoCur = acc.balanceCurrency || acc.currency
  var cur = (pref === 'CNY' || pref === 'USD') ? pref : autoCur
  return { value: base, currency: cur }
}
// New API 余额态的提示行：未配置访问令牌 → 引导去「设置」弹窗；
// 用户不限额 → 显示已用；用户余额读取失败 → 显示具体原因；
// 有真实用户余额 → 已用摘要（token 级不限额不影响用户余额行）；
// 其余（无用户余额）→ 沿用 token 级「不限额度」逻辑。
function newapiBalanceHint(acc) {
  // 未配置访问令牌：金额行已回退到 token 级已用，提示行同时给出「未配置令牌」
  // 与「已用额度」线索，引导用户去设置弹窗，避免把已用误当成余额。
  if (!acc.userTokenConfigured) {
    return acc.used === undefined || acc.used === null
      ? '未配置访问令牌 · 设置'
      : '未配置访问令牌 · 已用 ' + fmt(acc.used, acc.currency)
  }
  if (acc.userUnlimited) {
    return acc.used === undefined || acc.used === null
      ? '不限额度'
      : '不限额度 · 已用 ' + fmt(acc.used, acc.currency)
  }
  if (acc.userBalanceError) {
    var be = String(acc.userBalanceError)
    if (be.indexOf('http-401') === 0 || be.indexOf('http-403') === 0) return '访问令牌无效'
    if (be.indexOf('upstream-') === 0) return '访问令牌被拒'
    if (be === 'rate-limited') return '查询频率超限'
    if (be === 'timeout') return '查询超时'
    if (be === 'unreachable') return '网络不可达'
    return be.slice(0, 14)
  }
  if (acc.balance !== undefined && acc.balance !== null) {
    return acc.used === undefined || acc.used === null
      ? '已用 --'
      : '已用 ' + fmt(acc.used, acc.currency)
  }
  return relayHint(acc, 'balance')
}
function windowPercent(w) {
  if (!w || w.limit === undefined || w.limit === null || !(Number(w.limit) > 0)) return 0
  if (w.used === undefined || w.used === null) return 0
  return Math.round(Number(w.used) / Number(w.limit) * 100)
}
function relayHint(acc, mode) {
  // 不限额：金额行显示已用，提示行显示周期限额或不限额度
  if (acc.unlimited) {
    if (acc.used === undefined || acc.used === null) return '已用：暂不可用/不限额度'
    var w0 = acc.windows && acc.windows.length ? acc.windows[0] : null
    if (w0 && w0.limit !== undefined && w0.limit !== null && Number(w0.limit) > 0) {
      return '限额 ' + fmt(w0.limit, acc.currency) + ' · ' + windowPercent(w0) + '%'
    }
    return '不限额度'
  }
  if (mode === 'usage') {
    if (acc.used === undefined || acc.used === null) return '已用：暂不可用'
    var w1 = acc.windows && acc.windows.length ? acc.windows[0] : null
    if (w1 && w1.limit !== undefined && w1.limit !== null && Number(w1.limit) > 0) {
      return '限额 ' + fmt(w1.limit, acc.currency) + ' · ' + windowPercent(w1) + '%'
    }
    if (acc.granted !== undefined && acc.granted !== null && Number(acc.granted) > 0) {
      return '已用/限额 ' + fmt(acc.used, acc.currency) + ' / ' + fmt(acc.granted, acc.currency)
    }
    return '已用 ' + fmt(acc.used, acc.currency)
  }
  // 余额态：提示行 = 已用摘要。百分比窗口（opencode-go / 智谱 coding 等
  // 只有 percent+resetsAt 的上游）渲染「剩余 N% · 重置」；数字窗口沿用
  // 已用/限额；带 usedPercent 的混合窗口并列输出。
  const w2 = acc.windows && acc.windows.length ? acc.windows[0] : null
  if (w2 && w2.used !== undefined && w2.used !== null) {
    if (Number(w2.limit) > 0) {
      return kindZh(w2.kind) + '已用 ' + fmt(w2.used, acc.currency) + ' / ' + fmt(w2.limit, acc.currency) + resetTail(w2)
    }
    return '已用 ' + fmt(w2.used, acc.currency) + resetTail(w2)
  }
  if (w2 && w2.usedPercent !== undefined && w2.usedPercent !== null) {
    const left = Math.round(100 - Number(w2.usedPercent))
    return kindZh(w2.kind) + '剩 ' + Math.max(0, left) + '%' + resetTail(w2)
  }
  // 无窗口的钱包型余额（智谱账户报表等）：只显示已用金额
  if (acc.used !== undefined && acc.used !== null) {
    return '已用 ' + fmt(acc.used, acc.currency)
  }
  return '暂不可用'
}
// 窗口类型的中文前缀（会话/日/周/月），仅订阅窗口行使用
function kindZh(kind) {
  if (kind === 'session') return '5小时'
  if (kind === 'daily') return '每日'
  if (kind === 'weekly') return '每周'
  if (kind === 'monthly') return '每月'
  return ''
}
// 窗口重置时刻的后缀：当天显示 HH:mm，跨天显示 M/D HH:mm；无则空串
function resetTail(win) {
  const raw = win && win.resetsAt
  if (!raw) return ''
  const ms = typeof raw === 'number' ? raw : Date.parse(raw)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  return ' · 重置 ' + (sameDay ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm)
}
function optionList() {
  var out = []
  var list = state.providers || []
  for (var i = 0; i < list.length; i++) {
    var p = list[i]
    if (p && p.accountId) out.push(p)
  }
  return out
}
// 勾选集合按当前选项顺序归一：去重、丢弃已不存在的账户（配置文件里删了
// 中转站后选项消失，勾选集合同步收缩），保证「气泡轮流」的顺序稳定。
function orderedSelection() {
  var opts = optionList()
  var sel = state.selectedProviders || []
  var out = []
  for (var i = 0; i < opts.length; i++) {
    if (sel.indexOf(opts[i].accountId) !== -1) out.push(opts[i].accountId)
  }
  return out
}
// 首次刷新采纳 size.json 持久化集合（无则默认全选）；其后每次只做裁剪，
// 防止配置变化（增删中转站）留下悬空引用。
function ensureSelection() {
  var ids = []
  var opts = optionList()
  for (var i = 0; i < opts.length; i++) ids.push(opts[i].accountId)
  if (!state.selectedInit) {
    state.selectedInit = true
    var picked = []
    if (state.pendingSelection) {
      for (var j = 0; j < state.pendingSelection.length; j++) {
        var want = normalizeDisplayProvider(state.pendingSelection[j])
        if (ids.indexOf(want) !== -1 && picked.indexOf(want) === -1) picked.push(want)
      }
      state.pendingSelection = null
    }
    state.selectedProviders = picked.length > 0 ? picked : ids
  } else {
    var pruned = orderedSelection()
    state.selectedProviders = pruned.length > 0 ? pruned : ids
  }
  var cur = normalizeDisplayProvider(state.displayProvider)
  if (state.selectedProviders.indexOf(cur) === -1) {
    state.displayProvider = state.selectedProviders[0] || 'deepseek'
  }
}
function toggleSelect(id) {
  var sel = orderedSelection()
  var idx = sel.indexOf(id)
  if (idx === -1) {
    sel.push(id)
  } else {
    // 至少保留一个账户：取消最后一个勾选视为无效操作
    if (sel.length <= 1) return
    sel.splice(idx, 1)
  }
  state.selectedProviders = sel
  var cur = normalizeDisplayProvider(state.displayProvider)
  if (sel.indexOf(cur) === -1) state.displayProvider = sel[0] || 'deepseek'
  shown = null
  buildDisplayControl()
  render()
  saveConfig()
}
function setCurrent(id, opt) {
  opt = opt || {}
  state.displayProvider = normalizeDisplayProvider(id)
  shown = null
  buildDisplayControl()
  render()
  saveConfig()
  if (!opt.silent) refresh(false)
}
function accountDotClass(accountId) {
  var acc = state.accounts ? state.accounts[accountId] : null
  if (acc && acc.ok === true) return 'dshwv-dot dshwv-dot-ok'
  if (acc) return 'dshwv-dot dshwv-dot-err'
  return 'dshwv-dot'
}
function buildChips() {
  chipsBox.innerHTML = ''
  var sel = orderedSelection()
  var cur = normalizeDisplayProvider(state.displayProvider)
  var map = {}
  var list = state.providers || []
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].accountId) map[list[i].accountId] = list[i]
  if (sel.length === 0) {
    var empty = document.createElement('span')
    empty.className = 'dshwv-chip-empty'
    empty.textContent = '暂无可显示账户'
    chipsBox.appendChild(empty)
    return
  }
  for (var j = 0; j < sel.length; j++) {
    var id = sel[j]
    var ent = map[id] || {}
    var chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'dshwv-chip' + (id === cur ? ' dshwv-chip-cur' : '')
    chip.textContent = ent.label || id
    chip.title = id === cur ? '正在展示 · 点击鲸鱼图片可轮流更换' : '点击切换到该账户展示'
    chip.addEventListener('click', function (e) { e.stopPropagation(); setCurrent(this.getAttribute('data-id'), { silent: true }) })
    chip.setAttribute('data-id', id)
    chipsBox.appendChild(chip)
  }
}
function buildPanelRows() {
  multiPanel.innerHTML = ''
  var list = optionList()
  var sel = orderedSelection()
  if (list.length === 0) {
    var none = document.createElement('div')
    none.className = 'dshwv-multi-label'
    none.style.padding = '4px 6px'
    none.textContent = '暂无账户'
    multiPanel.appendChild(none)
    return
  }
  for (var i = 0; i < list.length; i++) {
    var p = list[i]
    var on = sel.indexOf(p.accountId) !== -1
    var row = document.createElement('div')
    row.className = 'dshwv-multi-row' + (on ? ' dshwv-multi-on' : '')
    row.setAttribute('data-id', p.accountId)
    row.title = (p.derivedFromDsh ? '来自 DSH 模型提供商 · 自动跟随。' : '') +
      (p.ok === false && typeof p.error === 'string'
        ? '该账户查询异常：' + p.error + '（仍可选中展示错误详情）'
        : '点击选择/取消在气泡中展示该账户')
    var box = document.createElement('span')
    box.className = 'dshwv-multi-box'
    var dot = document.createElement('span')
    dot.className = accountDotClass(p.accountId)
    var name = document.createElement('span')
    name.className = 'dshwv-multi-label'
    name.textContent = (p.label || p.accountId)
    row.appendChild(box)
    row.appendChild(dot)
    row.appendChild(name)
    row.addEventListener('click', function () { toggleSelect(this.getAttribute('data-id')) })
    multiPanel.appendChild(row)
  }
}
function buildDisplayControl() {
  ensureSelection()
  buildChips()
  buildPanelRows()
}
function positionMultiPanel() {
  try {
    var r = multiTrigger.getBoundingClientRect()
    var vp = viewport()
    var width = Math.max(r.width, 190)
    multiPanel.style.minWidth = width + 'px'
    var rightGapPx = vp.w - r.right
    multiPanel.style.left = 'auto'
    multiPanel.style.right = Math.max(rightGapPx, 8) + 'px'
    var ph = Math.min(220, multiPanel.scrollHeight || 160)
    var belowRoom = vp.h - r.bottom - 12
    var aboveRoom = r.top - 12
    if (belowRoom >= ph || belowRoom >= aboveRoom) {
      multiPanel.style.top = (r.bottom + 4) + 'px'
      multiPanel.style.bottom = 'auto'
    } else {
      multiPanel.style.bottom = (vp.h - r.top + 4) + 'px'
      multiPanel.style.top = 'auto'
    }
  } catch (err) {}
}
function openMultiPanel() {
  panelOpen = true
  buildPanelRows()
  positionMultiPanel()
  multiPanel.classList.add('dshwv-multi-open')
}
function closeMultiPanel() {
  if (!panelOpen) return
  panelOpen = false
  multiPanel.classList.remove('dshwv-multi-open')
}
function toggleMultiPanel() {
  if (panelOpen) closeMultiPanel()
  else openMultiPanel()
}
function buildCurrencySelect() {
  // 选项固定为 自动/CNY/USD（创建时已生成）；这里只同步当前值，
  // 历史遗留值（如旧版 'raw'）不在选项内时回退 'auto'。
  var want = state.displayCurrency || 'auto'
  var found = false
  for (var j = 0; j < currencySelect.options.length; j++) {
    if (currencySelect.options[j].value === want) { found = true; break }
  }
  currencySelect.value = found ? want : 'auto'
}
function setDisplayCurrency(v) {
  state.displayCurrency = (v === 'CNY' || v === 'USD') ? v : 'auto'
  buildCurrencySelect()
  shown = null
  saveConfig()
  render()
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
var RANDOM_GROUPS = [
  { w: 45, lines: buildGroup1 },
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
      el.style.display = ''
      el.className = (BUBBLE_STYLE_CLASS[ln.s] || 'dshwv-label') + (ln.w ? ' dshwv-wrap' : '')
      el.textContent = ln.t
      el.style.color = ln.c || ''
    } else {
      el.style.display = 'none'
      el.textContent = ''
      el.style.color = ''
    }
  }
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
    return
  }
  hintEl.style.transition = 'opacity .18s ease'
  hintEl.style.opacity = '0'
  hintFadeTimer = setTimeout(function () {
    hintFadeTimer = null
    hintEl.textContent = text
    hintEl.style.opacity = '1'
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
  labelEl.textContent = 'DeepSeek 余额'
  labelEl.style.color = ''
  amountEl.style.display = ''
  amountEl.className = 'dshwv-amount'
  amountEl.style.color = ''
  hintEl.style.display = ''
  hintEl.className = 'dshwv-hint'
  hintEl.style.color = ''
  render()
}
function showBubble() {
  if (!bubbleOn) return
  // 消耗金额泡泡显示期间，余额变动不再弹出普通泡泡
  if (costBubbleActive) return
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
function showCostBubble(amount) {
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
  // 样式：第一行 A（标签），第二行 B（红色金额），居中两行
  gifEl.style.display = 'none'
  gifEl.style.opacity = ''
  labelEl.style.display = ''
  labelEl.className = 'dshwv-label'
  labelEl.textContent = '上一轮对话消耗:'
  labelEl.style.color = ''
  amountEl.style.display = ''
  amountEl.className = 'dshwv-amount'
  amountEl.textContent = '¥ ' + (isFinite(amount) ? Number(amount).toFixed(2) : '--')
  amountEl.style.color = '#e0433f'
  hintEl.style.display = 'none'
  hintEl.textContent = ''
  hintEl.style.color = ''
  textBox.style.transition = ''
  textBox.style.opacity = ''
  bubbleBox.classList.add('dshwv-bubble-open')
  if (turnCostCloseMs > 0) {
    costBubbleTimer = setTimeout(hideCostBubble, turnCostCloseMs)
  }
}
function hideCostBubble() {
  if (costBubbleTimer) { clearTimeout(costBubbleTimer); costBubbleTimer = null }
  costBubbleActive = false
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
  if (currency === 'CNY') return '¥ ' + fixed
  if (currency === 'USD') return '$ ' + fixed
  if (currency) return fixed + ' ' + currency
  return fixed
}
function animateAmount(from, to, currency, duration) {
  // 消耗金额泡泡显示期间，余额数字滚动不触碰金额行
  if (costBubbleActive) return
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
    if (costBubbleActive) {
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
// 多选轮换位置标记：勾选多个账户时，提示行前缀 [i/N] 让用户知道当前气泡
// 展示的是第几个账户（点击气泡可轮流切换）。
function cycleMarker() {
  var cyc = orderedSelection()
  if (cyc.length <= 1) return ''
  var ci = cyc.indexOf(normalizeDisplayProvider(state.displayProvider))
  return '[' + ((ci >= 0 ? ci : 0) + 1) + '/' + cyc.length + '] '
}
function render() {
  // 消耗金额泡泡显示期间，余额渲染不覆盖其内容（金额行/标题行/提示行）
  if (costBubbleActive) return
  var acc = getDisplayAccount()
  var mode = getDisplayMode()
  var amount, hint, label
  if (acc && acc.ok === true) {
    label = acc.label || 'DeepSeek 官方'
    var parts = displayFigureParts(acc, mode)
    var fig = parts ? parts.value : null
    var cur = parts ? parts.currency : acc.currency
    if (mode === 'usage') {
      amount = (fig !== undefined && fig !== null) ? fmt(fig, cur) : '--'
      hint = acc.type === 'deepseek' ? '今日已用' : relayHint(acc, mode)
    } else {
      amount = shown !== null && fig !== undefined && fig !== null ? fmt(shown, cur) : ((fig !== undefined && fig !== null) ? fmt(fig, cur) : '--')
      // 官方走今日已用；New API 走访问令牌专用提示；其余中转站/订阅型走
      // 通用窗口提示（relayHint）——订阅型没有「访问令牌」概念
      hint = acc.type === 'deepseek'
        ? '今日已用 ' + ((acc.todayUsage !== null && acc.todayUsage !== undefined) ? fmt(acc.todayUsage, acc.currency) : '--')
        : acc.type === 'newapi'
          ? newapiBalanceHint(acc)
          : relayHint(acc, 'balance')
    }
  } else if (acc) {
    // 账户错误：金额行 = 上次数值或 --，提示行 = 具体原因（截断 14 字符，与现有错误展示一致）
    label = acc.label || 'DeepSeek 官方'
    amount = shown !== null ? fmt(shown, acc.currency) : '--'
    var reason = acc.message || acc.error || ''
    hint = reason ? reason.slice(0, 14) : '获取失败 · 点击重试'
  } else {
    // 尚未拿到 providers（首帧或旧载荷）：沿用旧路径
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
    label = 'DeepSeek 余额'
  }
  labelEl.textContent = label
  amountEl.textContent = amount
  var mark = cycleMarker()
  if (mark && hint && !bubbleRandomActive) hint = mark + hint
  if (bubbleRandomActive && bubbleRandomLines) {
    applyBubbleLines(bubbleRandomLines)
  } else {
    setHint(hint)
  }
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
  express()
}
function refresh() {
  if (busy) return
  busy = true
  if (animDelayTimer) { clearTimeout(animDelayTimer); animDelayTimer = null }
  if (state.balance === null) { state.status = 'loading'; render() }
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
        if (Array.isArray(data.accounts)) {
          var accMap = {}
          for (var i = 0; i < data.accounts.length; i++) {
            var a = data.accounts[i]
            if (a && a.accountId) accMap[a.accountId] = a
          }
          state.accounts = accMap
        }
        if (Array.isArray(data.providers)) state.providers = data.providers
        // 仅在首次加载时采纳服务端 displayProvider；用户切换后的本地选择
        // 不被 25s 缓存内的旧值覆盖（缓存 payload 里的 displayProvider 可能滞后）。
        if (!state.displayProvider && data.displayProvider) state.displayProvider = normalizeDisplayProvider(data.displayProvider)
        // 多选集合：首次采纳 size.json 持久化值（无则全选），其后裁剪悬空项
        ensureSelection()
        // 货币偏好与限流状态：偏好只在首次加载采纳服务端值（避免 25s 缓存
        // 内的旧值覆盖用户刚做的本地选择）；限流状态始终以服务端为准，
        // 自动刷新间隔按 recommendedRefreshMs 动态安排。
        if (!state.displayCurrency && typeof data.displayCurrency === 'string') state.displayCurrency = data.displayCurrency
        if (data.rateLimit && typeof data.rateLimit === 'object') {
          state.rateLimit = data.rateLimit
          if (typeof data.rateLimit.recommendedRefreshMs === 'number' &&
              isFinite(data.rateLimit.recommendedRefreshMs) &&
              data.rateLimit.recommendedRefreshMs >= 15000) {
            state.refreshMs = Math.min(data.rateLimit.recommendedRefreshMs, 5 * 60 * 1000)
          } else {
            state.refreshMs = REFRESH_MS
          }
        }
        // 凭据版本：跟随服务端（换 key 后由 last-turn 轮询触发即时刷新）
        if (typeof data.credVersion === 'number') lastCredVersionSeen = data.credVersion
        buildDisplayControl()
        buildCurrencySelect()
        var acc = getDisplayAccount()
        var mode = getDisplayMode()
        var parts = displayFigureParts(acc, mode)
        var nf = parts && parts.value !== null && parts.value !== undefined && isFinite(Number(parts.value)) ? Number(parts.value) : null
        var ncur = parts ? (parts.currency || '') : String(data.currency || 'CNY')
        var nb = Number(data.totalBalance)
        var nc = String(data.currency || 'CNY')
        state.balance = nb
        state.currency = nc
        state.message = ''
        state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null
        state.isPeak = !!data.isPeak
        var valueChanged = state.displayFigure !== null && nf !== null && nf !== state.displayFigure
        var currencyChanged = state.displayFigureCurrency !== null && ncur !== state.displayFigureCurrency
        if (valueChanged && !currencyChanged) {
          showBubble()
          state.status = 'changing'
          // balance-change bubble: wait 0.3s after it floats out, then roll the number
          if (animDelayTimer) clearTimeout(animDelayTimer)
          animDelayTimer = setTimeout(function () {
            animDelayTimer = null
            animateAmount(shown, nf, ncur, ANIM_MS)
          }, 300)
          if (settleTimer) clearTimeout(settleTimer)
          settleTimer = setTimeout(function () {
            settleTimer = null
            if (state.status === 'changing') { state.status = 'ok'; render() }
          }, CHANGE_MS + 300)
        } else {
          if (animId === null && nf !== null) shown = nf
          state.status = 'ok'
          render()
        }
        state.displayFigure = nf
        state.displayFigureCurrency = ncur
      } else {
        // 失败也携带 accounts/providers：错误账户走新渲染路径显示具体原因
        if (data && Array.isArray(data.accounts)) {
          var accMapE = {}
          for (var i = 0; i < data.accounts.length; i++) {
            var a = data.accounts[i]
            if (a && a.accountId) accMapE[a.accountId] = a
          }
          state.accounts = accMapE
        }
        if (data && Array.isArray(data.providers)) state.providers = data.providers
        if (data && data.displayProvider && !state.displayProvider) state.displayProvider = normalizeDisplayProvider(data.displayProvider)
        ensureSelection()
        // 失败载荷同样携带限流状态（rateLimit 恒追加），一并采纳
        if (data && data.rateLimit && typeof data.rateLimit === 'object') {
          state.rateLimit = data.rateLimit
          if (typeof data.rateLimit.recommendedRefreshMs === 'number' &&
              isFinite(data.rateLimit.recommendedRefreshMs) &&
              data.rateLimit.recommendedRefreshMs >= 15000) {
            state.refreshMs = Math.min(data.rateLimit.recommendedRefreshMs, 5 * 60 * 1000)
          }
        }
        if (typeof data.credVersion === 'number') lastCredVersionSeen = data.credVersion
        buildDisplayControl()
        buildCurrencySelect()
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
      // 每次刷新结束（成功/失败/手动）都重新安排下一次自动刷新
      scheduleNextRefresh()
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
    fetch(SIZE_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scale: state.scale, sound: soundOn, vol: soundVol, soundSet: soundSet, usageMode: usageMode, peakMode: peakMode, bubbleOn: bubbleOn, turnCostOn: turnCostOn, turnCostCloseMs: turnCostCloseMs, scrollGapOn: scrollGapOn, scrollGapPx: scrollGapPx, displayProvider: state.displayProvider, selectedProviders: orderedSelection().slice(0, 16), displayCurrency: state.displayCurrency || 'auto' }) })
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
  closeMultiPanel()
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
    if (e.target.closest('.dshwv-bubble') || e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-menu-btn') || e.target.closest('.dshwv-multi-panel')) return
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
  if (el && el.closest && (el.closest('.dshwv-bubble') || el.closest('.dshwv-menu') || el.closest('.dshwv-menu-btn') || el.closest('.dshwv-multi-panel'))) {
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
  // 点击鲸鱼图片（v1.1 定稿）：勾选多个账户时轮流切换到下一个选中账户，
  // 气泡同步淡出换入该账户内容并重置停留计时；气泡未开时先打开。
  // 勾选单个/选项未就绪时维持原行为——只打开气泡。（手动刷新已取消，
  // 刷新交给自动调度与菜单切换；菜单 tag 点击仍直接指定账户。）
  if (clickAllowed && !drag.moved) {
    var cyc = orderedSelection()
    if (cyc.length > 1) {
      var ci = cyc.indexOf(normalizeDisplayProvider(state.displayProvider))
      state.displayProvider = cyc[(ci + 1) % cyc.length]
      shown = null
      buildDisplayControl()
      saveConfig()
      if (bubbleShown) {
        // 气泡已开着（含随机台词态）：切回余额内容再淡入新账户数据
        bubbleRandomActive = false
        bubbleRandomLines = null
        swapBubbleContent(function () {
          lastHintText = null
          restoreBubbleLines()
        })
        if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
        bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
      } else {
        showBubble()
      }
      return
    }
    showBubble()
    return
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
  if (panelOpen) closeMultiPanel()
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
    if (d && typeof d.displayProvider === 'string' && d.displayProvider !== '') {
      state.displayProvider = normalizeDisplayProvider(d.displayProvider)
    }
    // 持久化的「显示」多选集合：先记下，首次 balance.json 到达时按选项裁剪采纳
    if (d && Array.isArray(d.selectedProviders)) {
      var pickedSel = []
      for (var si = 0; si < d.selectedProviders.length; si++) {
        if (typeof d.selectedProviders[si] === 'string' && d.selectedProviders[si] !== '') pickedSel.push(d.selectedProviders[si])
      }
      if (pickedSel.length > 0) state.pendingSelection = pickedSel
    }
    if (d && typeof d.displayCurrency === 'string' && d.displayCurrency !== '') {
      state.displayCurrency = d.displayCurrency
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

// —— 自动刷新动态调度 ——
// 间隔由服务端 recommendedRefreshMs 决定：按「每周期查询次数 × 窗口 ÷ 上限」
// 把额度均匀摊开（默认上限 20 次/5 分钟）。每次刷新结束后重新安排下一次；
// 手动刷新/切换显示/保存设置也会经 refresh() 的 finally 重新排程。
var refreshTimer = null
function scheduleNextRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(function () {
    refreshTimer = null
    refresh(false)
  }, state.refreshMs)
}

// —— 每轮对话消耗检测：轮询 last-turn.json，出现新 seq 时弹消耗金额泡泡 ——
var LAST_TURN_URL = '/dsh-whale/last-turn.json'
var lastCostSeq = 0
var lastCostAligned = false
// 服务端凭据版本（credVersion）：任一 DSH API 密钥被修改即递增。本端点每秒
// 轮询，发现版本变化立即刷新余额——修复「显示不随 DSH API 密钥自动更新」。
var lastCredVersionSeen = null
function pollLastTurn() {
  try {
    fetch(LAST_TURN_URL, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (!d || !d.ok) return
        if (typeof d.credVersion === 'number') {
          if (lastCredVersionSeen === null) {
            lastCredVersionSeen = d.credVersion
          } else if (d.credVersion !== lastCredVersionSeen) {
            // 密钥变更：服务端已清缓存 + 失败负缓存，立刻按新 key 重取并渲染
            lastCredVersionSeen = d.credVersion
            refresh(false)
            return
          }
        }
        if (typeof d.seq !== 'number') return
        if (!lastCostAligned) {
          // 首次拿到数据：只对齐 seq，不弹旧轮次
          lastCostSeq = d.seq
          lastCostAligned = true
          return
        }
        if (d.seq > lastCostSeq) {
          lastCostSeq = d.seq
          if (d.turn !== null && d.amount !== null) {
            showCostBubble(Number(d.amount))
          }
        }
      })
      .catch(function () {})
  } catch (err) {}
}
setInterval(pollLastTurn, 1000)

// —— 设置弹窗：New API 用户余额（下拉选站点 + ID/令牌）· 实时令牌（教程折叠 + 输入保存）· 接口查询次数限制 ——
var settingsOverlay = null
var settingsNewapiSelect = null
var settingsNewapiEmpty = null
var settingsNewapiIdInput = null
var settingsNewapiTkInput = null
var settingsNewapiStatus = null
var settingsPlatformInput = null
var settingsPlatformStatus = null
var settingsLimitUsed = null
var settingsLimitMsg = null
var NEWAPI_TOKEN_URL = '/dsh-whale/user-token.json'
var PLATFORM_TOKEN_URL = '/dsh-whale/platform-token.json'
function buildSettingsOverlay() {
  if (settingsOverlay) return
  var ov = document.createElement('div')
  ov.className = 'dshwv-overlay'
  var box = document.createElement('div')
  box.className = 'dshwv-modal'
  var title = document.createElement('div')
  title.className = 'dshwv-modal-title'
  title.textContent = '鲸鱼挂件设置'

  // ① New API 用户余额（下拉选择站点，一组输入框，界面不臃肿）
  var sec1 = document.createElement('div')
  sec1.className = 'dshwv-modal-sec'
  sec1.textContent = 'New API 用户余额'
  var sec1Hint = document.createElement('div')
  sec1Hint.className = 'dshwv-modal-hint'
  sec1Hint.textContent = '前往 中转站 个人设置 → 安全设置生成系统访问令牌；用户 ID 可在个人设置页顶部查看。'
  var rowSel = document.createElement('div')
  rowSel.className = 'dshwv-modal-row'
  var selLabel = document.createElement('label')
  selLabel.textContent = '站点'
  settingsNewapiSelect = document.createElement('select')
  settingsNewapiSelect.className = 'dshwv-modal-select'
  settingsNewapiSelect.addEventListener('change', syncSettingsNewapiStatus)
  rowSel.appendChild(selLabel)
  rowSel.appendChild(settingsNewapiSelect)
  settingsNewapiEmpty = document.createElement('div')
  settingsNewapiEmpty.className = 'dshwv-modal-hint'
  settingsNewapiEmpty.textContent = '暂无 New API 账户（在 .dshw-size.json 的 providers 中配置）'
  settingsNewapiEmpty.style.display = 'none'

  var rowId = document.createElement('div')
  rowId.className = 'dshwv-modal-row'
  var idLabel = document.createElement('label')
  idLabel.textContent = '用户 ID'
  settingsNewapiIdInput = document.createElement('input')
  settingsNewapiIdInput.className = 'dshwv-modal-input'
  settingsNewapiIdInput.type = 'text'
  settingsNewapiIdInput.placeholder = '个人设置页顶部查看'
  rowId.appendChild(idLabel)
  rowId.appendChild(settingsNewapiIdInput)

  var rowTk = document.createElement('div')
  rowTk.className = 'dshwv-modal-row'
  var tkLabel = document.createElement('label')
  tkLabel.textContent = '访问令牌'
  settingsNewapiTkInput = document.createElement('input')
  settingsNewapiTkInput.className = 'dshwv-modal-input'
  settingsNewapiTkInput.type = 'password'
  settingsNewapiTkInput.placeholder = '安全设置中生成'
  rowTk.appendChild(tkLabel)
  rowTk.appendChild(settingsNewapiTkInput)

  var rowBtn = document.createElement('div')
  rowBtn.className = 'dshwv-modal-row'
  var saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'dshwv-modal-btn dshwv-modal-btn-save'
  saveBtn.textContent = '保存'
  settingsNewapiStatus = document.createElement('span')
  settingsNewapiStatus.className = 'dshwv-modal-hint'
  settingsNewapiStatus.textContent = ''
  rowBtn.appendChild(saveBtn)
  rowBtn.appendChild(settingsNewapiStatus)
  saveBtn.addEventListener('click', function () {
    var accountId = settingsNewapiSelect.value
    var id = settingsNewapiIdInput.value.replace(/^\s+|\s+$/g, '')
    var tk = settingsNewapiTkInput.value.replace(/^\s+|\s+$/g, '')
    settingsNewapiStatus.className = 'dshwv-modal-err'
    if (!accountId) { settingsNewapiStatus.textContent = '请选择站点'; return }
    if (!id || !tk) { settingsNewapiStatus.textContent = '请填写用户 ID 与访问令牌'; return }
    saveBtn.disabled = true
    settingsNewapiStatus.textContent = '保存中…'
    fetch(NEWAPI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: accountId, userId: id, token: tk })
    }).then(function (r) { return r.json() }).then(function (d) {
      saveBtn.disabled = false
      if (d && d.ok) {
        settingsNewapiStatus.className = 'dshwv-modal-ok'
        settingsNewapiStatus.textContent = '已保存'
        settingsNewapiIdInput.value = ''
        settingsNewapiTkInput.value = ''
        refresh(false)
      } else {
        settingsNewapiStatus.textContent = (d && d.error) ? String(d.error).slice(0, 60) : '保存失败'
      }
    }).catch(function (e) {
      saveBtn.disabled = false
      settingsNewapiStatus.textContent = '保存失败: ' + String((e && e.message) || e).slice(0, 40)
    })
  })

  // ② 实时·令牌（可选）：教程折叠，输入框直接改 DEEPSEEK_PLATFORM_TOKEN
  var sec2 = document.createElement('div')
  sec2.className = 'dshwv-modal-sec'
  sec2.textContent = '实时·令牌（可选）'
  var sec2Details = document.createElement('details')
  sec2Details.className = 'dshwv-modal-details'
  var sec2Summary = document.createElement('summary')
  sec2Summary.textContent = '查看获取教程'
  var sec2Guide = document.createElement('div')
  sec2Guide.className = 'dshwv-modal-guide'
  sec2Guide.textContent = '需要 DEEPSEEK_PLATFORM_TOKEN\\n\\n鲸鱼娘直接调用 DeepSeek 平台用量接口，按峰谷定价实时换算今日已用，精确到每小时的 token 用量。\\n\\n令牌在哪获取：\\n1. 浏览器打开并登录 https://platform.deepseek.com\\n2. 按 F12 打开开发者工具 → 切到 Network（网络） 标签\\n3. 在平台页面点击「用量」或刷新页面，找到名为 usage/by_api_key/amount 的请求\\n4. 点开该请求 → Request Headers（请求标头） → 复制 Authorization 的值（形如 Bearer eyJ... 的一长串）\\n5. 把整段值（含 Bearer 前缀或只要后面的 token 部分均可）配置为 DSH 凭据 DEEPSEEK_PLATFORM_TOKEN：\\n   # 在 DSH 凭据服务中设置，例如编辑 $env:USERPROFILE\\.dsh\\.credentials.yaml\\n   # DEEPSEEK_PLATFORM_TOKEN: <你复制的令牌>\\n6. 重启 dsh web，在菜单 → 用量里选择「实时·令牌」'
  sec2Details.appendChild(sec2Summary)
  sec2Details.appendChild(sec2Guide)

  var rowPt = document.createElement('div')
  rowPt.className = 'dshwv-modal-row'
  var ptLabel = document.createElement('label')
  ptLabel.textContent = '令牌'
  settingsPlatformInput = document.createElement('input')
  settingsPlatformInput.className = 'dshwv-modal-input'
  settingsPlatformInput.type = 'password'
  settingsPlatformInput.placeholder = '粘贴 DEEPSEEK_PLATFORM_TOKEN 后保存'
  rowPt.appendChild(ptLabel)
  rowPt.appendChild(settingsPlatformInput)
  var rowPtBtn = document.createElement('div')
  rowPtBtn.className = 'dshwv-modal-row'
  var ptSaveBtn = document.createElement('button')
  ptSaveBtn.type = 'button'
  ptSaveBtn.className = 'dshwv-modal-btn dshwv-modal-btn-save'
  ptSaveBtn.textContent = '保存到凭据服务'
  settingsPlatformStatus = document.createElement('span')
  settingsPlatformStatus.className = 'dshwv-modal-hint'
  settingsPlatformStatus.textContent = ''
  rowPtBtn.appendChild(ptSaveBtn)
  rowPtBtn.appendChild(settingsPlatformStatus)
  ptSaveBtn.addEventListener('click', function () {
    var tk = settingsPlatformInput.value.replace(/^\s+|\s+$/g, '')
    settingsPlatformStatus.className = 'dshwv-modal-err'
    if (!tk) { settingsPlatformStatus.textContent = '请粘贴令牌'; return }
    ptSaveBtn.disabled = true
    settingsPlatformStatus.textContent = '保存中…'
    fetch(PLATFORM_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tk })
    }).then(function (r) { return r.json() }).then(function (d) {
      ptSaveBtn.disabled = false
      if (d && d.ok) {
        settingsPlatformStatus.className = 'dshwv-modal-ok'
        settingsPlatformStatus.textContent = '已保存'
        settingsPlatformInput.value = ''
        refresh(false)
      } else {
        settingsPlatformStatus.textContent = (d && d.error) ? String(d.error).slice(0, 60) : '保存失败'
      }
    }).catch(function (e) {
      ptSaveBtn.disabled = false
      settingsPlatformStatus.textContent = '保存失败: ' + String((e && e.message) || e).slice(0, 40)
    })
  })

  // ③ 接口查询次数（自适应，只读展示：429 retry-after 自动学习）
  var sec3 = document.createElement('div')
  sec3.className = 'dshwv-modal-sec'
  sec3.textContent = '接口查询次数（自适应）'
  settingsLimitUsed = document.createElement('div')
  settingsLimitUsed.className = 'dshwv-modal-used'
  settingsLimitMsg = document.createElement('div')
  settingsLimitMsg.className = 'dshwv-modal-hint'

  var actions = document.createElement('div')
  actions.className = 'dshwv-modal-actions'
  var closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'dshwv-modal-btn dshwv-modal-btn-cancel'
  closeBtn.textContent = '关闭'
  closeBtn.addEventListener('click', closeSettings)
  actions.appendChild(closeBtn)

  box.appendChild(title)
  box.appendChild(sec1)
  box.appendChild(sec1Hint)
  box.appendChild(rowSel)
  box.appendChild(settingsNewapiEmpty)
  box.appendChild(rowId)
  box.appendChild(rowTk)
  box.appendChild(rowBtn)
  box.appendChild(sec2)
  box.appendChild(sec2Details)
  box.appendChild(rowPt)
  box.appendChild(rowPtBtn)
  box.appendChild(sec3)
  box.appendChild(settingsLimitUsed)
  box.appendChild(settingsLimitMsg)
  box.appendChild(actions)
  ov.appendChild(box)
  ov.addEventListener('click', function (e) { if (e.target === ov) closeSettings() })
  document.body.appendChild(ov)
  settingsOverlay = ov
}
function syncSettingsNewapiStatus() {
  var accountId = settingsNewapiSelect.value
  var acc = accountId ? (state.accounts[accountId] || {}) : {}
  settingsNewapiStatus.className = acc.userTokenConfigured ? 'dshwv-modal-ok' : 'dshwv-modal-hint'
  settingsNewapiStatus.textContent = acc.userTokenConfigured ? '已配置' : '未配置'
}
function rebuildSettingsNewapi() {
  settingsNewapiSelect.innerHTML = ''
  var list = state.providers || []
  var hasNewapi = false
  for (var i = 0; i < list.length; i++) {
    var p = list[i]
    if (!p || p.type !== 'newapi') continue
    hasNewapi = true
    var opt = document.createElement('option')
    opt.value = p.accountId
    opt.textContent = (p.label || p.accountId) + (p.baseUrl ? (' · ' + p.baseUrl) : '')
    settingsNewapiSelect.appendChild(opt)
  }
  settingsNewapiEmpty.style.display = hasNewapi ? 'none' : 'block'
  settingsNewapiSelect.style.display = hasNewapi ? '' : 'none'
  settingsNewapiIdInput.style.display = hasNewapi ? '' : 'none'
  settingsNewapiTkInput.style.display = hasNewapi ? '' : 'none'
  syncSettingsNewapiStatus()
}
function refreshSettingsLimitInfo() {
  var rl = state.rateLimit || null
  var origins = rl && rl.origins ? rl.origins : {}
  var parts = []
  for (var k in origins) {
    if (Object.prototype.hasOwnProperty.call(origins, k)) {
      var o = origins[k]
      parts.push(k + ' 已用 ' + o.used + ' / 上限 ' + o.max + '（剩余 ' + o.remaining + (o.learned ? ' · 已学习' : ' · 默认') + '）')
    }
  }
  settingsLimitUsed.textContent = parts.length ? parts.join(' · ') : '本窗口尚未发起查询'
  var per = rl && typeof rl.perCycleCalls === 'number' ? rl.perCycleCalls : null
  settingsLimitMsg.textContent = per !== null && per > 0
    ? ('自适应限流：收到站点 429 时按 retry-after 自动学习可用次数；本周期 ' + per + ' 次查询 → 自动刷新约 ' + Math.round(state.refreshMs / 1000) + ' 秒')
    : '自适应限流：收到站点 429 时按 retry-after 自动学习可用次数，并自动安排刷新间隔'
}
function openSettings() {
  buildSettingsOverlay()
  rebuildSettingsNewapi()
  refreshSettingsLimitInfo()
  settingsOverlay.style.display = 'flex'
}
function closeSettings() {
  if (settingsOverlay) settingsOverlay.style.display = 'none'
}
})()`


const name = 'whale-balance-widget'
const inject = ['webServer', 'credentials']

function apply(ctx) {
    // 自适应查询限流：起点上限 15 次 / 5 分钟 / origin（实测 api.hohai.eu.org：
    // 60 次 / 20 分钟，等效 15 次 / 5 分钟）。无手动设置：收到站点 429 时
    // 读 retry-after，按「封禁窗口内实际已发请求数」自动推算该站点的真实
    // 配额并收紧上限（learnRateLimitCap），学到的值持久化到
    // $DSH_HOME/.dshw-ratelimit.json，重启后继续生效。
    // 全宿主共享一个 gate；按 origin 分桶计数，账户之间互不影响。
    // 自动刷新间隔按「每周期查询次数 × 窗口 ÷ 当前上限」动态安排
    // （recommendedRefreshMs），见 getBalancePayload。
    const RELAY_RATE_LIMIT_MAX = 15
    const RELAY_RATE_WINDOW_MS = 5 * 60 * 1000
    const relayLimiter = createRateLimiter({ windowMs: RELAY_RATE_WINDOW_MS, max: RELAY_RATE_LIMIT_MAX })

    // 自适应学习结果的持久化文件（与 size.json 分离，互不干扰；无 BOM 写入）
    const RATE_FILE_CANDIDATES = [path.join(DSH_HOME, '.dshw-ratelimit.json')]
    function readLearnedRates() {
      for (const p of RATE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && typeof parsed === 'object') return parsed
        } catch (err) {}
      }
      return {}
    }
    function saveLearnedRates(map) {
      for (const p of RATE_FILE_CANDIDATES) {
        try {
          fs.writeFileSync(p, JSON.stringify(map), 'utf8')
          return
        } catch (err) {}
      }
    }
    // 启动时恢复已学到的上限（各 origin 独立）
    const learnedRates = readLearnedRates()
    for (const origin of Object.keys(learnedRates)) {
      const entry = learnedRates[origin]
      if (entry && typeof entry.max === 'number') relayLimiter.setMax(origin, entry.max)
    }

    // 收到站点 429 时学习：recent = retry-after 窗口内我们实际发出的请求数。
    // 第一个请求就 429（recent 太小）说明是站内其它流量触发，不动上限。
    function learnRateLimit(origin, retryAfterMs) {
      try {
        const recent = relayLimiter.historyCount(origin, retryAfterMs)
        const learned = learnRateLimitCap(recent, retryAfterMs, RELAY_RATE_WINDOW_MS)
        if (!learned.learned) return
        relayLimiter.setMax(origin, learned.per5min)
        const store = readLearnedRates()
        store[origin] = {
          max: learned.per5min,
          observedCap: recent,
          retryAfterMs: retryAfterMs,
          learnedAt: Date.now(),
        }
        saveLearnedRates(store)
        console.log(
          `[whale-balance] 自适应限流: ${origin} 触发 429（retry-after=${Math.round(retryAfterMs / 1000)}s，窗口内已发 ${recent} 次）→ 上限收紧为 ${learned.per5min} 次/5 分钟`
        )
      } catch (err) {}
    }

    // 当前这一个读取周期实际放行/发出的上游请求数（被 gate 拒掉的不算，
    // 因为没发请求、不消耗额度）。用于给前端算自动刷新间隔。
    let cycleCalls = 0
    let lastCycleCalls = 0
    function relayGuard(origin) {
      const ok = relayLimiter(origin)
      if (ok) cycleCalls++
      return ok
    }
    // 本周期触及的 origin 中最严的上限（自适应值优先），作为刷新区间的分母。
    function effectiveMinMax() {
      const stats = relayLimiter.stats()
      const keys = Object.keys(stats)
      if (keys.length === 0) return relayLimiter.max()
      let m = Infinity
      for (const k of keys) m = Math.min(m, stats[k].max)
      return Number.isFinite(m) ? m : relayLimiter.max()
    }
    // 每周期消耗 cost 次查询时，把额度均匀摊到整个窗口的刷新间隔：
    // interval = cost × window / max，向上取整到 5 秒，夹在 [15s, 5min]。
    function recommendedRefreshMs(cost) {
      if (!(cost > 0)) return null
      const ms = Math.ceil((cost * RELAY_RATE_WINDOW_MS) / effectiveMinMax() / 5000) * 5000
      return Math.min(Math.max(ms, 15000), RELAY_RATE_WINDOW_MS)
    }

    // 失败负缓存：瞬时错误（网络/超时/限流/429）按账户记住结果，TTL 内不再
    // 触碰上游，避免把站点额度烧在反复重试上。
    const relayFailCache = new Map() // accountId -> { at, ttlMs, result }
    const FAIL_CACHE_TTL_MS = 60 * 1000

    // 换算率缓存：origin -> 上次成功读到的 { scale, siteCurrency }。
    // quota_per_unit 几乎不变；/api/status 被限流或抖动失败时用它兜底换算，
    // 避免金额回退成原始配额整数（如 65755622.00 之类）。
    const statusScaleCache = new Map()

    // 429 负缓存统一在站点封禁时长上加 30 秒余量：retry-after 到点立即
    // 重试容易因站点窗口未完全重置而立刻再吃一个 429（自适应上限收紧后
    // 可用次数更宝贵，不能浪费在窗口边界上）。
    const RATE_MARGIN_MS = 30 * 1000

    function relayFailTtl(r) {
      // 本地 gate 拒绝：等本窗口滚动即可
      if (r.error === 'rate-limited') return RELAY_RATE_WINDOW_MS + RATE_MARGIN_MS
      // 站点 429：按它的 retry-after 封禁时长 + 30 秒余量做负缓存（实测
      // 封禁约 20 分钟），拿不到 header 时退回 5 分钟 + 余量
      if (r.error === 'http-429') {
        if (typeof r.retryAfterMs === 'number' && r.retryAfterMs > 0) {
          return Math.min(r.retryAfterMs + RATE_MARGIN_MS, 24 * 3600 * 1000)
        }
        return RELAY_RATE_WINDOW_MS + RATE_MARGIN_MS
      }
      return FAIL_CACHE_TTL_MS
    }

    const relayTransient = (error) =>
      error === 'unreachable' || error === 'timeout' || error === 'rate-limited' || error === 'http-429'

    let imageBytes = null
    let balanceCache = null
    let balanceInFlight = null
    // 凭据版本号：任一凭据引用在 DSH 凭据服务里被写入/修改（GUI 设置保存、
    // 外部编辑 .credentials.yaml 触发热重载）时递增。随 balance.json 与
    // last-turn.json 下发给前端，前端据此立即刷新余额展示——否则换 key 后
    // 要等最长 5 分钟的自适应刷新周期才生效，表现为「显示不随 API 密钥更新」。
    let credVersion = 0
    let gifBytes = null

    // —— 跟随 DSH 模型提供商（settings 可选注入，v1.2 即时同步）——
    // 存在 settings 服务时捕获引用（用于从 llm-* 命名空间发现中转站配置）；
    // 缺席（老宿主/测试 mock）时保持 null，跟随功能静默停用。
    // 订阅 settings 文档更新事件（GUI 保存 / 外部编辑 settings.yaml 热重载都
    // 会按命名空间派发）：llm-* 命名空间一变即递增 credVersion 并清空全部
    // 余额缓存——前端 last-turn 轮询 ≤1 秒内拉到新版本号立即重取，「即时同步」；
    // 与凭据事件共用同一前端通道（credVersion 单调递增即可）。
    let settingsSvc = null
    try {
      ctx.inject(['settings'], (sc) => {
        settingsSvc = sc.settings
        const bus = typeof (sc && sc.on) === 'function' ? sc.on : (typeof ctx.on === 'function' ? ctx.on : null)
        if (!bus) return
        try {
          bus('settings/document-updated', (ns) => {
            if (typeof ns !== 'string' || ns.indexOf('llm-') !== 0) return
            try {
              credVersion++
              balanceCache = null
              relayFailCache.clear()
              console.log('[whale-balance] DSH 模型提供商变更 (' + ns + ') → 版本 ' + credVersion + '，已失效余额缓存')
            } catch (err) {}
          })
        } catch (err) {}
      })
    } catch (err) {}
    // 每轮对话消耗统计：按 (session.id, turn) 分桶聚合，完成后写入 lastTurn。
    // 用 Map 分桶避免主会话与子代理（spawn/fork）并行时串账。
    let turnAggs = new Map() // sessionId -> { turn, cost, tokens, lastTs }
    let lastTurn = null // { turn, amount, tokens, ts }
    let lastTurnSeq = 0
    const disposers = []

    function finalizeTurn(sessionId) {
      const agg = turnAggs.get(sessionId)
      if (agg && agg.cost > 0) {
        lastTurn = { turn: agg.turn, amount: agg.cost, tokens: agg.tokens, ts: agg.lastTs }
        lastTurnSeq++
      }
      turnAggs.delete(sessionId)
    }
    // 监听会话事件流：assistant/message 携带每步真实 usage，按 (session,turn) 聚合；
    // turn/end 时结算该会话本轮并写入 lastTurn
    function handleSessionEvent(sessionId, event) {
      try {
        const type = event && event.type
        const d = event && event.data
        if (!d || typeof d !== 'object') return
        if (type === 'turn/end') {
          finalizeTurn(sessionId)
          return
        }
        if (type !== 'assistant/message') return
        const turn = Number(d.turn)
        const usage = d.usage
        if (!usage || typeof usage !== 'object' || !isFinite(turn)) return
        let agg = turnAggs.get(sessionId)
        if (!agg || agg.turn !== turn) {
          if (agg) finalizeTurn(sessionId)
          agg = { turn, cost: 0, tokens: 0, lastTs: Date.now() }
          turnAggs.set(sessionId, agg)
        }
        const input = Number(usage.inputTokens) || 0
        const cache = Number(usage.cacheReadTokens) || 0
        const output = Number(usage.outputTokens) || 0
        const reasoning = Number(usage.reasoningTokens) || 0
        agg.tokens += input + cache + output + reasoning
        // 定价换算（CNY/百万 token；缓存命中=输入价，其余按各自档位）
        const model = d.message && d.message.source ? d.message.source.model : ''
        const p = priceFor(model)
        const off = isPeakTime(Math.floor(Date.now() / 1000)) ? 1 : 0
        agg.cost += (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + ((output + reasoning) / 1e6) * p.out[off]
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
      if (session && session.id) turnAggs.delete(session.id)
    }))

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
          balanceInfos: Array.isArray(data.balance_infos) ? data.balance_infos : [],
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

    // —— 多中转站 · provider 配置归一化 ——
    // 读取规则（PRD 6.2）：无 providers 字段 → 等价 [{type:'deepseek', credential:'DEEPSEEK_API_KEY'}]。
    // 字段缺失/类型错误时该账户按「配置无效」给出明确原因，不影响其它账户。
    function normalizeProviders(cfg) {
      const list = Array.isArray(cfg.providers) ? cfg.providers : null
      if (!list || list.length === 0) {
        return [{ type: 'deepseek', label: DEFAULT_LABELS.deepseek, baseUrl: undefined, credential: DEFAULT_CREDENTIALS.deepseek }]
      }
      const out = []
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue
        const type = raw.type
        if (type !== 'deepseek' && type !== 'newapi' && type !== 'sub2api') continue
        out.push({
          type: type,
          label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : DEFAULT_LABELS[type],
          baseUrl: type === 'deepseek' ? undefined : normalizeOrigin(raw.baseUrl),
          credential: typeof raw.credential === 'string' && raw.credential.trim() !== '' ? raw.credential : DEFAULT_CREDENTIALS[type],
          // New API 用户余额令牌：仅在 size.json 显式指定 userToken/userId 时
          // 采用该名字；否则由 scopedTokenNames 按账户作用域解析（首个账户 =
          // 历史全局名 NEWAPI_USER_TOKEN/NEWAPI_USER_ID，旧数据零迁移兼容）。
          ...(type === 'newapi'
            ? {
                ...(typeof raw.userToken === 'string' && raw.userToken.trim() !== '' ? { userToken: raw.userToken } : {}),
                ...(typeof raw.userId === 'string' && raw.userId.trim() !== '' ? { userId: raw.userId } : {}),
              }
            : {}),
        })
      }
      if (out.length === 0) {
        return [{ type: 'deepseek', label: DEFAULT_LABELS.deepseek, baseUrl: undefined, credential: DEFAULT_CREDENTIALS.deepseek }]
      }
      return out
    }

    // 为同类型多账户生成稳定 accountId：首个不带后缀（newapi），后续 -1、-2。
    function assignAccountId(type, names) {
      const n = names[type] || 0
      names[type] = n + 1
      return n === 0 ? type : type + '-' + n
    }

    // —— 跟随 DSH 模型提供商（同步语义 v1.2.1，2026-08-27）——
    // 「跟随DSH」开启时，鲸鱼中转站账户以 DSH 设置 → 模型提供商（llm-* 命名
    // 空间里带 apiKeyEnv + baseURL 的条目）为唯一事实来源：
    //   - 每个 DSH 提供商行 = 一个鲸鱼账户（baseURL 归一为 origin；一站多 key
    //     就在 DSH 里配多行，各行独立额度视图）；
    //   - 相同 origin+凭据名 的重复行去重（防 GUI 层叠伪影）；
    //   - DeepSeek 官方域与本机/内网地址跳过（官方已有专属账户）；
    //   - size.json 手工 providers 里的中转站视为跟随前历史 → 自动移除
    //     （见 purgeManualRelayHistory），不再「手工优先」。
    function settingsSections() {
      if (!settingsSvc) return []
      try {
        const list = typeof settingsSvc.describe === 'function'
          ? settingsSvc.describe({ redactSecrets: true })
          : []
        return Array.isArray(list) ? list : []
      } catch (err) { return [] }
    }
    function isLocalOrigin(origin) {
      try {
        const h = new URL(origin).hostname.toLowerCase()
        return h === 'localhost' || h.endsWith('.localhost') ||
          /^127\./.test(h) || h === '0.0.0.0' || h === '::1'
      } catch (err) { return false }
    }
    // 按站点/路径猜上游适配类型（v1.3 多上游对接）：DSH 提供商行只带
    // baseURL + apiKeyEnv，主机名与 /coding 路径是唯一判别信号；识别不了时
    // 回落 newapi（New API 通用信封）。路径判断用「原始 URL」——origin 化会
    // 抹掉 /coding 等关键后缀。
    function inferSchemeKind(fullUrl) {
      const u = String(fullUrl || '').toLowerCase()
      let host = ''
      try { host = new URL(u).hostname.toLowerCase() } catch (err) {}
      const coding = u.indexOf('/coding') !== -1
      if (host.indexOf('openrouter') !== -1) return 'openrouter'
      if (host.indexOf('minimax') !== -1) return 'minimax'
      if (host.indexOf('opencode') !== -1) return 'opencode-go'
      if (host.indexOf('moonshot') !== -1 || host.indexOf('kimi.com') !== -1) return coding ? 'kimi-coding' : 'moonshot'
      if (host.indexOf('bigmodel') !== -1 || host.indexOf('z.ai') !== -1) return coding ? 'zhipu-coding' : 'zhipu'
      return 'newapi'
    }
    // 无 baseURL 的内置预设行（v1.3.2，如 llm-pi-ai 的 zai——域名在 DSH 插件
    // 内部而 settings 行只有 apiKeyEnv）：按「行名/显示名/凭据名」关键词映射
    // 已知厂商。区域取向：智谱族默认**国内站 open.bigmodel.cn**（国内账号为
    // 主流，实测国际站 api.z.ai 对国内 key 直接 404）；行内出现 z.ai /
    // international / global / 海外 字样才切国际站 api.z.ai。
    // minimax 同理：minimaxi（中国版）优先于 minimax（全球版）识别。
    function inferKnownVendor(rowKey, displayName, credentialName) {
      const s = [rowKey, displayName, credentialName].map((x) => String(x || '').toLowerCase()).join(' | ')
      if (!s.trim()) return null
      if (s.indexOf('openrouter') !== -1) {
        return { kind: 'openrouter', origin: 'https://openrouter.ai' }
      }
      // 中国版域名串 minimaxi 必须先于 minimax 判断
      if (s.indexOf('minimaxi') !== -1 || s.indexOf('minimax-cn') !== -1) {
        return { kind: 'minimax', origin: 'https://api.minimaxi.com' }
      }
      if (s.indexOf('minimax') !== -1) {
        return { kind: 'minimax', origin: 'https://api.minimax.io' }
      }
      if (s.indexOf('opencode') !== -1) {
        return { kind: 'opencode-go', origin: 'https://opencode.ai' }
      }
      if (s.indexOf('moonshot') !== -1 || s.indexOf('kimi') !== -1) {
        return { kind: 'moonshot', origin: 'https://api.moonshot.cn' }
      }
      const zhipuFamily =
        s.indexOf('zhipu') !== -1 ||
        s.indexOf('bigmodel') !== -1 ||
        s.indexOf('glm') !== -1 ||
        /(^|[^a-z0-9])z\.?ai([^a-z0-9]|$)/.test(s)
      if (zhipuFamily) {
        const intl = s.indexOf('z.ai') !== -1 || s.indexOf('international') !== -1 || s.indexOf('global') !== -1 || s.indexOf('海外') !== -1
        return { kind: intl ? 'zhipu' : 'zhipu', origin: intl ? 'https://api.z.ai' : 'https://open.bigmodel.cn' }
      }
      return null
    }
    function deriveRelayProvidersFromSettings() {
      const out = []
      if (!settingsSvc || typeof settingsSvc.describe !== 'function') return out
      const seenPair = new Set()
      const labelCount = {}
      for (const desc of settingsSections()) {
        let provs = null
        try {
          // 形态 A：descriptor.value.providers = { name: {...} }（settings 解析层）
          // 行名（YAML key，如 'zai'/'hohai'）一并保留为 rowName——内置预设行
          // 没有 baseURL 时它是厂商识别的重要线索
          if (desc && desc.value && typeof desc.value === 'object' && desc.value.providers && typeof desc.value.providers === 'object') {
            provs = Object.entries(desc.value.providers).map(([name, entry]) => ({ ...(entry && typeof entry === 'object' ? entry : {}), rowName: name }))
          } else {
            // 形态 B：用户原始文档层直接写 providers 键值对
            const userSec = desc && desc.user && typeof desc.user === 'object' ? desc.user : null
            const raw = userSec && userSec.providers && typeof userSec.providers === 'object'
              ? Object.entries(userSec.providers).map(([name, entry]) => ({ ...(entry && typeof entry === 'object' ? entry : {}), rowName: name }))
              : null
            if (raw && raw.length > 0) provs = raw
          }
        } catch (err) { provs = null }
        if (!Array.isArray(provs)) continue
        for (const pr of provs) {
          if (!pr || typeof pr !== 'object') continue
          // 凭据引用名（apiKeyEnv）存在才可能查到余额；兼容 baseUrl/baseURL 两种键名
          if (typeof pr.apiKeyEnv !== 'string' || pr.apiKeyEnv.trim() === '') continue
          const rawUrl = typeof pr.baseURL === 'string' && pr.baseURL.trim() !== '' ? pr.baseURL : pr.baseUrl
          const origin = normalizeOrigin(rawUrl)
          if (origin && origin.indexOf('api.deepseek.com') !== -1) continue // 官方域跳过
          if (origin && isLocalOrigin(origin)) continue // 本机/内网自建跳过

          let kind = null
          let vendorOrigin = null
          if (origin) {
            // 显式 baseURL：按主机名/路径选适配器
            kind = inferSchemeKind(rawUrl)
          } else {
            // 内置预设行（无 baseURL，如 llm-pi-ai 的 zai）：关键词映射已知厂商，
            // 取默认官方域名；识别不了（自建站等）只能跳过——无法确定查询地址
            const vendor = inferKnownVendor(pr.rowName, pr.displayName, pr.apiKeyEnv)
            if (!vendor) continue
            kind = vendor.kind
            vendorOrigin = vendor.origin
          }
          const finalBase = origin || vendorOrigin
          // 同站点同 key 去重（含类型：moonshot 余额行与 kimi-coding 订阅行可并存）
          const pairKey = finalBase + '|' + kind + '|' + pr.apiKeyEnv.trim()
          if (seenPair.has(pairKey)) continue
          seenPair.add(pairKey)
          let label = String(finalBase).replace(/^https?:\/\//, '').slice(0, 40)
          if (typeof pr.displayName === 'string' && pr.displayName.trim() !== '') label = pr.displayName.trim().slice(0, 40)
          else if (!origin && typeof pr.rowName === 'string' && pr.rowName.trim() !== '') label = pr.rowName.slice(0, 40)
          // 同名标签消歧（多行未设 displayName 时）
          labelCount[label] = (labelCount[label] || 0) + 1
          if (labelCount[label] > 1) label += ' #' + labelCount[label]
          out.push({
            type: kind,
            label: label,
            baseUrl: finalBase,
            credential: pr.apiKeyEnv,
            derivedFromDsh: true,
          })
        }
      }
      return out
    }

    // —— 手工中转站历史清理（v1.2.2 恒开）——
    // size.json 显式 providers 里的非 deepseek 条目属于「跟随前的手工历史」：
    // settings 服务可用时移除并写回文件。之后再次进入时已无中转站条目 →
    // 自然跳过（自限，不反复写盘）。唯一护栏：settings 服务缺席（老宿主 /
    // 未启用 mock）时无法派生替代账户，绝不清除，保持原行为。
    function purgeManualRelayHistory(cfg) {
      if (!settingsSvc || typeof settingsSvc.describe !== 'function') return cfg
      for (const p of SIZE_FILE_CANDIDATES) {
        let raw = null
        try { raw = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (err) { continue }
        if (!raw || typeof raw !== 'object') continue
        if (!Array.isArray(raw.providers)) return cfg // 无显式 providers：无历史可清
        const kept = raw.providers.filter((x) => x && typeof x === 'object' && x.type === 'deepseek')
        const removed = raw.providers.length - kept.length
        if (removed <= 0) return cfg // 已干净
        try {
          fs.writeFileSync(p, JSON.stringify({ ...raw, providers: kept.length > 0 ? kept : [{ type: 'deepseek' }] }), 'utf8')
          console.log('[whale-balance] 跟随DSH 开启：已移除手工中转站历史配置 ×' + removed + '（账户清单以 DSH 模型提供商为准）')
          return readSizeConfig() || cfg
        } catch (err) {
          return cfg
        }
      }
      return cfg
    }

    // 访问令牌作用域化（v1.2）：每个 New API 账户独立的凭据引用名。
    // 首个账户（accountId==='newapi'）恰好等于历史全局名 NEWAPI_USER_TOKEN /
    // NEWAPI_USER_ID —— 旧凭据数据零迁移；其余账户加 <ID 大写下划线化> 后缀
    // （凭据名语法只允许字母数字下划线，不允许连字符）。size.json 显式指定
    // userToken/userId 时仍以显式名为准。
    function scopedTokenNames(p) {
      if (p.userToken || p.userId) {
        return { tokenName: p.userToken, userIdName: p.userId }
      }
      if (p.accountId === 'newapi') {
        return { tokenName: DEFAULT_USER_TOKEN_CREDENTIALS.userToken, userIdName: DEFAULT_USER_TOKEN_CREDENTIALS.userId }
      }
      const safeId = String(p.accountId).toUpperCase().replace(/[^A-Z0-9]/g, '_')
      return {
        tokenName: DEFAULT_USER_TOKEN_CREDENTIALS.userToken + '_' + safeId,
        userIdName: DEFAULT_USER_TOKEN_CREDENTIALS.userId + '_' + safeId,
      }
    }

    // 解析 displayProvider：'{accountId}' = 余额态。
    // 「已用配额」独立模式已移除：历史遗留的 '{accountId}:usage' 归一化为
    // 余额态（未配置访问令牌时余额态自动回退到 token 级已用）。
    function resolveDisplay(displayProvider, accounts) {
      const dp = typeof displayProvider === 'string' && displayProvider !== '' ? displayProvider : 'deepseek'
      let accountId = dp
      let mode = 'balance'
      const colon = dp.indexOf(':')
      if (colon !== -1) {
        accountId = dp.slice(0, colon)
        mode = 'balance'
      }
      const found = accounts.find((a) => a.accountId === accountId)
      if (!found) {
        const first = accounts[0]
        return { accountId: first ? first.accountId : 'deepseek', mode: 'balance' }
      }
      return { accountId: accountId, mode: mode }
    }

    // 官方余额的货币变体：balance_infos 里每个币种都是平台真实报价，
    // 不做任何换算（无可靠汇率来源）。'auto' = 现有 pickBalanceInfo 策略。
    function currencyOptionsOf(balanceInfos) {
      if (!Array.isArray(balanceInfos)) return []
      const seen = new Set()
      const out = []
      for (const info of balanceInfos) {
        if (!info || typeof info !== 'object') continue
        const code = String(info.currency || '').trim()
        const value = Number(info.total_balance)
        if (code === '' || !Number.isFinite(value) || seen.has(code)) continue
        seen.add(code)
        out.push({ key: code, label: code, value: value, currency: code })
      }
      return out
    }

    // 读取 DeepSeek 官方账户（保留 0.2.9 的 fetchBalance / recordLedgerUsage /
    // fetchUsage 原路，守「无 providers 配置时顶层字段不变」回归红线）。
    async function readDeepseekAccount(cfg, mode) {
      const balance = await fetchBalance()
      if (!balance.ok) {
        return {
          ok: false, code: balance.code, error: balance.error, transient: balance.transient,
          isAvailable: false, todayUsage: null, usageMode: mode,
        }
      }
      // 无论哪种模式，都先把余额观测记入账本（自动累积「鲸鱼记账」数据）
      const led = recordLedgerUsage(Number(balance.totalBalance), balance.currency)
      let todayUsage = led.todayUsage
      let resolvedMode = mode
      if (mode === 'token') {
        let cred = null
        try { cred = await ctx.credentials.resolve('DEEPSEEK_PLATFORM_TOKEN') } catch (err) {}
        if (cred) {
          const u = await fetchUsage()
          if (u && u.amount !== undefined) { todayUsage = u.amount; resolvedMode = 'token' }
        }
      }
      return {
        ok: true,
        balance: Number(balance.totalBalance),
        currency: String(balance.currency),
        updatedAt: balance.updatedAt,
        todayUsage: todayUsage,
        usageMode: resolvedMode,
        isAvailable: true,
        currencyOptions: currencyOptionsOf(balance.balanceInfos),
      }
    }

    // 读取一个中转站账户（newapi / sub2api），走 readAccount 适配器。
    // 瞬时失败按账户负缓存；所有上游请求过 20 次/5 分钟的查询 gate。
    async function readRelayAccount(p) {
      const cached = relayFailCache.get(p.accountId)
      if (cached && Date.now() - cached.at < cached.ttlMs) return cached.result

      let credential
      let userToken
      let userId
      try {
        const r1 = await ctx.credentials.resolve(p.credential)
        credential = r1 && r1.value
        // New API 用户余额令牌：按账户作用域解析（首个账户 = 历史全局名，
        // 其余账户用专属名；显式 userToken/userId 配置优先）。
        if (p.type === 'newapi') {
          const tokNames = scopedTokenNames(p)
          if (tokNames.tokenName) {
            const r2 = await ctx.credentials.resolve(tokNames.tokenName)
            // 容错：粘贴值允许带 "Bearer " 前缀，剥掉再下发
            userToken = r2 && typeof r2.value === 'string' ? r2.value.replace(/^Bearer\s+/i, '').trim() : undefined
          }
          if (tokNames.userIdName) {
            const r3 = await ctx.credentials.resolve(tokNames.userIdName)
            userId = r3 && typeof r3.value === 'string' ? r3.value.trim() : undefined
          }
        }
      } catch (err) {
        credential = undefined
      }
      const r = await readAccount({
        type: p.type,
        baseUrl: p.baseUrl === undefined ? undefined : p.baseUrl,
        credential: credential || undefined,
        credentialName: p.credential,
        label: p.label,
        userToken: userToken || undefined,
        userId: userId || undefined,
        scaleFallback: p.baseUrl ? statusScaleCache.get(p.baseUrl) : undefined,
        guard: relayGuard,
      })
      // 换算率缓存：状态接口成功时记住 quota_per_unit/quota_display_type，
      // 下次状态接口失败（限流/网络抖动）时用它兜底换算，避免把配额整数
      // 当金额显示成天文数字（实测超限后出现过 65755622.00 这类原始值）。
      if (p.baseUrl && r.statusScale) statusScaleCache.set(p.baseUrl, r.statusScale)
      // 自适应限流学习：站点 429 且带 retry-after → 按实测样本收紧该站点上限
      if (r.error === 'http-429' && typeof r.retryAfterMs === 'number' && p.baseUrl) {
        learnRateLimit(p.baseUrl, r.retryAfterMs)
      }
      const transient = relayTransient(r.error)
      const out = { ...r, transient: transient }
      if (!r.ok && transient) {
        relayFailCache.set(p.accountId, { at: Date.now(), ttlMs: relayFailTtl(r), result: out })
      }
      return out
    }

    // 汇总某个 provider 的完整账户记录进 accounts。
    function buildAccount(p, r) {
      const dshFlag = p.derivedFromDsh ? { derivedFromDsh: true } : {}
      if (p.type === 'deepseek') {
        return {
          accountId: p.accountId, type: 'deepseek', label: p.label,
          baseUrl: undefined, ok: !!r.ok, code: r.code, error: r.error, transient: r.transient,
          isAvailable: !!r.isAvailable, unlimited: false,
          balance: r.balance, currency: r.currency, todayUsage: r.todayUsage,
          usageMode: r.usageMode, updatedAt: r.updatedAt,
          currencyOptions: Array.isArray(r.currencyOptions) ? r.currencyOptions : [],
          ...dshFlag,
        }
      }
      return {
        accountId: p.accountId, type: p.type, label: p.label,
        baseUrl: p.baseUrl === undefined ? undefined : p.baseUrl,
        ok: r.ok === true, error: r.ok ? undefined : r.error, message: r.message, transient: r.transient,
        isAvailable: r.isAvailable, unlimited: r.unlimited,
        currency: r.currency, balance: r.total, used: r.used, granted: r.granted,
        windows: r.windows, keyName: r.keyName, expiresAt: r.expiresAt, code: r.ok ? undefined : r.error,
        // New API 用户余额（/api/user/self）：配置状态与降级信息。
        // 凭据名不透传前端（凭据引用属宿主内部事实）。
        userTokenConfigured: r.userTokenConfigured === true,
        ...(r.balanceCurrency ? { balanceCurrency: r.balanceCurrency } : {}),
        ...(r.userUnlimited ? { userUnlimited: true } : {}),
        ...(r.userBalanceError ? { userBalanceError: r.userBalanceError } : {}),
        ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}),
        currencyOptions: Array.isArray(r.currencyOptions) ? r.currencyOptions : [],
        ...dshFlag,
      }
    }

    function accountSummary(a) {
      return {
        accountId: a.accountId, type: a.type, label: a.label, baseUrl: a.baseUrl,
        ok: !!a.ok, error: a.ok ? undefined : a.error, isAvailable: a.isAvailable, unlimited: a.unlimited,
        ...(a.derivedFromDsh ? { derivedFromDsh: true } : {}),
      }
    }

    // 按「货币」偏好调整当前显示账户的币种符号。'auto' 用账户自身币种
    // （newapi 余额态优先用户余额币种 balanceCurrency，如 CNY）；
    // 'CNY'/'USD' 仅切换显示符号（¥/$，金额数值不变、不虚构汇率换算），
    // 其余历史值（如旧版 'raw'）按 auto 处理。仅余额态生效。
    function pickDisplayFigure(acc, mode, pref) {
      if (mode !== 'balance' || !acc) return null
      const autoCurrency = acc.balanceCurrency ?? acc.currency
      const cur = pref === 'CNY' || pref === 'USD' ? pref : autoCurrency
      // 未配置访问令牌（newapi 无用户余额，balance 缺省）→ 回退到 token 级
      // 已用额度作余额占位；订阅型账户（无钱包概念）回退到首个窗口的已用量。
      let value = acc.balance !== undefined && acc.balance !== null
        ? acc.balance
        : acc.type === 'newapi' && !acc.userTokenConfigured && acc.used !== undefined && acc.used !== null
          ? acc.used
          : acc.balance
      if ((value === undefined || value === null) && Array.isArray(acc.windows) && acc.windows.length > 0) {
        value = acc.windows[0].used !== undefined ? acc.windows[0].used : value
      }
      return { value, currency: cur }
    }

    // 统一的账户清单解析（v1.2.2 恒开）：清单 = 官方(手工或默认) + DSH 派生
    // 中转站，手工中转站历史先行清除。getBalancePayload 与 user-token 路由
    // 共用同一顺序，保证「设置弹窗保存的目标账户」与「载荷里的账户」编号一致。
    function resolveProviderList(cfg) {
      const effCfg = purgeManualRelayHistory(cfg)
      const baseProvs = normalizeProviders(effCfg)
      const provs = [...baseProvs, ...deriveRelayProvidersFromSettings()]
      const names = {}
      for (const p of provs) p.accountId = assignAccountId(p.type, names)
      return provs
    }

    async function getBalancePayload() {
      const cfg = readSizeConfig() || {}
      const mode = normalizeUsageMode(cfg.usageMode)
      const provs = resolveProviderList(cfg)

      // 历史自动清理（v1.2.2 恒开）：当前账户清单（手工官方 + DSH 派生中转站）
      // 就是全部应存在的站点——把已消失站点的历史痕迹一并清掉：
      //   - statusScaleCache 的换算率缓存项；
      //   - .dshw-ratelimit.json 里学到的限流上限（学习值随站点生灭）。
      {
        const liveOrigins = new Set()
        for (const p of provs) if (p.baseUrl) liveOrigins.add(p.baseUrl)
        for (const k of Array.from(statusScaleCache.keys())) {
          if (!liveOrigins.has(k)) statusScaleCache.delete(k)
        }
        try {
          const store = readLearnedRates()
          let dirty = false
          for (const k of Object.keys(store)) {
            if (!liveOrigins.has(k)) { delete store[k]; dirty = true }
          }
          if (dirty) saveLearnedRates(store)
        } catch (err) {}
      }

      // 并行读取各账户，单个失败互不影响。周期查询次数从 0 计，
      // 读取结束后固化到 lastCycleCalls 供前端安排自动刷新间隔。
      cycleCalls = 0
      const results = await Promise.all(provs.map((p) => (p.type === 'deepseek'
        ? readDeepseekAccount(cfg, mode)
        : readRelayAccount(p))))
      lastCycleCalls = cycleCalls
      const accounts = results.map((r, i) => buildAccount(provs[i], r))
      const providers = accounts.map(accountSummary)

      const display = resolveDisplay(cfg.displayProvider, accounts)
      const current = accounts.find((a) => a.accountId === display.accountId) || accounts[0]
      const displayProvider = display.accountId
      const displayCurrency = typeof cfg.displayCurrency === 'string' && cfg.displayCurrency !== '' ? cfg.displayCurrency : 'auto'

      let full
      if (current && current.type === 'deepseek') {
        if (!current.ok) {
          full = { ok: false, code: current.code, error: current.error }
          if (current.transient !== undefined) full.transient = current.transient
        } else {
          // 键序与 0.2.9 一致：ok,totalBalance,currency,updatedAt,isPeak,todayUsage,usageMode
          full = {
            ok: true,
            totalBalance: current.balance,
            currency: current.currency,
            updatedAt: current.updatedAt,
          }
          full.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
          full.todayUsage = current.todayUsage
          full.usageMode = current.usageMode
          // 货币偏好：balance_infos 里的真实报价变体。
          const picked = pickDisplayFigure(current, display.mode, displayCurrency)
          if (picked && picked.value !== undefined) {
            full.totalBalance = picked.value
            full.currency = picked.currency
          }
        }
      } else if (current) {
        // 中转站：顶层字段别名到当前显示账户（余额态→balance；未配置访问
        // 令牌时回退到 token 级已用）。「已用配额」独立模式已移除。
        const picked = pickDisplayFigure(current, display.mode, displayCurrency)
        const figure = picked && picked.value !== undefined ? picked.value : current.balance
        full = {
          ok: current.ok,
          totalBalance: figure !== undefined ? figure : null,
          currency: picked ? picked.currency : current.currency,
          todayUsage: current.used !== undefined ? current.used : null,
          usageMode: 'relay',
        }
        full.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
        if (!current.ok) {
          full.code = current.code || current.error
          full.error = current.message || current.error
          if (current.transient !== undefined) full.transient = current.transient
        }
      } else {
        full = { ok: false, error: '无可用账户' }
      }
      full.displayProvider = displayProvider
      full.providers = providers
      full.accounts = accounts
      // 「点击显示」多选集合：仅回显 size.json 里已持久化的值，供前端首次
      // 初始化选中 tag；未配置时前端默认全选。凭据版本号驱动换 key 后即时刷新。
      const selectedProviders = normalizeSelectedProviderList(cfg.selectedProviders)
      if (selectedProviders) full.selectedProviders = selectedProviders
      full.credVersion = credVersion
      full.displayCurrency = displayCurrency
      full.currencyOptions = current && Array.isArray(current.currencyOptions) ? current.currencyOptions : []
      // 自适应限流状态（设置弹窗只读展示）：每 origin 的已用/上限/剩余/
      // 是否已学习，加每周期查询数与推荐自动刷新间隔。recommendedRefreshMs
      // = 每周期查询次数 × 窗口 ÷ 当前最严上限，前端据此动态调度
      // （见 WIDGET_JS scheduleNextRefresh）。
      full.rateLimit = {
        windowMs: RELAY_RATE_WINDOW_MS,
        mode: 'adaptive',
        origins: relayLimiter.stats(),
        perCycleCalls: lastCycleCalls,
        recommendedRefreshMs: recommendedRefreshMs(lastCycleCalls),
      }
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

    // 「点击显示」多选集合（改进：多选下拉 + 气泡轮流更换）：accountId 字符串
    // 数组，最多 16 项；空数组/非数组视为未配置，由前端默认全选。
    function normalizeSelectedProviderList(v) {
      if (!Array.isArray(v)) return undefined
      const out = []
      for (const x of v) {
        if (typeof x === 'string' && x.trim() !== '') out.push(x.trim().slice(0, 64))
        if (out.length >= 16) break
      }
      return out.length > 0 ? out : undefined
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
              providers: Array.isArray(parsed.providers) ? parsed.providers : undefined,
              displayProvider: typeof parsed.displayProvider === 'string' ? parsed.displayProvider : undefined,
              selectedProviders: normalizeSelectedProviderList(parsed.selectedProviders),
              displayCurrency: typeof parsed.displayCurrency === 'string' && parsed.displayCurrency !== '' ? parsed.displayCurrency : 'auto',
            }
          }
        } catch (err) {}
      }
      return null
    }

    function writeSizeConfig(scale, sound, vol, soundSet, usageMode, peakMode, bubbleOn, turnCostOn, turnCostCloseMs, scrollGapOn, scrollGapPx, displayProvider, displayCurrency, selectedProviders) {
      const um = normalizeUsageMode(usageMode)
      const pm = peakMode === 'liangwen' || peakMode === 'qiangqiang' ? peakMode : 'default'
      const bo = bubbleOn !== false
      const tco = turnCostOn !== false
      const tcc = typeof turnCostCloseMs === 'number' ? (turnCostCloseMs > 0 ? turnCostCloseMs : 0) : 5000
      const sgo = scrollGapOn === true
      const sgp = typeof scrollGapPx === 'number' && scrollGapPx > 0 ? Math.round(scrollGapPx) : 0
      // 菜单 PUT 只携带「点击显示」选择值，不携带 providers（用户直接编辑文件）；
      // 写入时必须保留旧文件里已有的 providers，避免一次 PUT 清掉用户手配的中转站。
      let dp = typeof displayProvider === 'string' && displayProvider !== '' ? displayProvider : undefined
      let dc = typeof displayCurrency === 'string' && displayCurrency !== '' && displayCurrency !== 'auto' ? displayCurrency : undefined
      // 多选集合同理：PUT 没带就保留旧值（缩放拖拽等高频写入不能冲掉选中 tag）
      let sp = normalizeSelectedProviderList(selectedProviders)
      let providers
      for (const p of SIZE_FILE_CANDIDATES) {
        try {
          const old = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (old && typeof old === 'object') {
            if (providers === undefined && Array.isArray(old.providers)) providers = old.providers
            if (dp === undefined && typeof old.displayProvider === 'string' && old.displayProvider !== '') dp = old.displayProvider
            if (sp === undefined) sp = normalizeSelectedProviderList(old.selectedProviders)
            if (dc === undefined && typeof old.displayCurrency === 'string' && old.displayCurrency !== '') dc = old.displayCurrency
          }
        } catch (err) {}
      }
      const body = JSON.stringify({
        ...(providers !== undefined ? { providers: providers } : {}),
        scale: scale,
        sound: sound !== false,
        vol: typeof vol === 'number' ? vol : 0.9,
        soundSet: soundSet === 'fx1' ? 'fx1' : 'duck',
        usageMode: um,
        peakMode: pm,
        bubbleOn: bo,
        turnCostOn: tco,
        turnCostCloseMs: tcc,
        scrollGapOn: sgo,
        scrollGapPx: sgp,
        ...(dp !== undefined ? { displayProvider: dp } : {}),
        ...(sp !== undefined ? { selectedProviders: sp } : {}),
        ...(dc !== undefined ? { displayCurrency: dc } : {}),
        updatedAt: new Date().toISOString(),
      })
      for (const p of SIZE_FILE_CANDIDATES) {
        try {
          fs.writeFileSync(p, body, 'utf8')
          return {
            ok: true,
            scale: scale,
            sound: sound !== false,
            vol: typeof vol === 'number' ? vol : 0.9,
            soundSet: soundSet === 'fx1' ? 'fx1' : 'duck',
            usageMode: um,
            peakMode: pm,
            bubbleOn: bo,
            turnCostOn: tco,
            turnCostCloseMs: tcc,
            scrollGapOn: sgo,
            scrollGapPx: sgp,
            ...(dp !== undefined ? { displayProvider: dp } : {}),
            ...(sp !== undefined ? { selectedProviders: sp } : {}),
            ...(dc !== undefined ? { displayCurrency: dc } : {}),
          }
        } catch (err) {}
      }
      return { ok: false, error: '无法持久化挂件尺寸' }
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
        // 返回最近一轮已完成的对话消耗；seq 递增供前端判断「新的一轮」。
        // 顺带携带 credVersion：前端每秒轮询本端点，凭据（API 密钥）变更后
        // 版本号变化即触发一次即时余额刷新，实现「显示随 DSH 密钥自动更新」。
        const payload = lastTurn
          ? { ok: true, seq: lastTurnSeq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, ts: lastTurn.ts, credVersion: credVersion }
          : { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null, credVersion: credVersion }
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
            // 「点击显示」当前账户/多选集合变化同样失效余额缓存：payload 顶层
            // 字段（totalBalance/currency）按 cfg.displayProvider 别名到所选
            // 账户，不清缓存会让切换后 25 秒内读到旧账户的顶层快照。
            {
              const oldCfg = readSizeConfig()
              const curDp = oldCfg ? oldCfg.displayProvider : undefined
              const newDp = typeof parsed.displayProvider === 'string' ? parsed.displayProvider : undefined
              const curSp = oldCfg && Array.isArray(oldCfg.selectedProviders) ? JSON.stringify(oldCfg.selectedProviders) : undefined
              const newSp = Array.isArray(parsed.selectedProviders) ? JSON.stringify(normalizeSelectedProviderList(parsed.selectedProviders)) : undefined
              if ((curDp !== undefined && newDp !== undefined && curDp !== newDp) || (curSp !== undefined && newSp !== undefined && curSp !== newSp)) {
                balanceCache = null
              }
            }
            const result = writeSizeConfig(scale, parsed.sound !== false, parsed.vol, parsed.soundSet, parsed.usageMode, parsed.peakMode, parsed.bubbleOn, parsed.turnCostOn, parsed.turnCostCloseMs, parsed.scrollGapOn, parsed.scrollGapPx, parsed.displayProvider, parsed.displayCurrency, parsed.selectedProviders)
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

    // 设置弹窗：保存某个 New API 账户的用户余额凭据（用户 ID + 系统访问令牌）。
    // 值只写入 DSH 凭据服务（.credentials.yaml 的 refs:），绝不写入 size.json、
    // 绝不回显给浏览器。401/403 与其它错误只回错误文案。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/user-token.json',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '仅支持 POST' }))
          return
        }
        try {
          const body = await readBody(req)
          const parsed = JSON.parse(body)
          const accountId = typeof parsed.accountId === 'string' ? parsed.accountId : ''
          const userId = typeof parsed.userId === 'string' ? parsed.userId.replace(/^\s+|\s+$/g, '') : ''
          // 粘贴值允许带 "Bearer " 前缀（与实时·令牌一致），存前剥掉，
          // 避免 Authorization 头出现双 Bearer 被站点 401
          const token = typeof parsed.token === 'string'
            ? parsed.token.replace(/^\s+|\s+$/g, '').replace(/^Bearer\s+/i, '')
            : ''
          if (accountId === '' || userId === '' || token === '') {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '缺少 accountId / userId / token' }))
            return
          }
          if (token.length > 512 || userId.length > 64) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '输入过长（令牌 ≤512、用户ID ≤64 字符）' }))
            return
          }
          // 与 getBalancePayload 同一账户清单解析（含 DSH 派生账户），
          // 保证设置弹窗保存的目标与载荷展示的编号一致
          const provs = resolveProviderList(readSizeConfig() || {})
          const p = provs.find((x) => x.accountId === accountId)
          if (!p || p.type !== 'newapi') {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '该账户不是 New API 类型或不存在' }))
            return
          }
          // 每站点独立令牌（v1.2）：写该账户作用域专属凭据名（首个账户即
          // 历史全局名），后续读取按同名解析—— PackyAPI 不再复用 hohai 的令牌。
          const tokNames = scopedTokenNames(p)
          await ctx.credentials.set(tokNames.userIdName, userId)
          await ctx.credentials.set(tokNames.tokenName, token)
          // 凭据已变：失效所有缓存，下次刷新立即按新令牌拉取
          balanceCache = null
          relayFailCache.clear()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    // 设置弹窗：直接修改 DEEPSEEK_PLATFORM_TOKEN（实时·令牌 模式用）。
    // 与 user-token 同规则：值只进 DSH 凭据服务，不回显、不落 size.json。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/platform-token.json',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '仅支持 POST' }))
          return
        }
        try {
          const body = await readBody(req)
          const parsed = JSON.parse(body)
          const token = typeof parsed.token === 'string' ? parsed.token.replace(/^\s+|\s+$/g, '') : ''
          if (token === '') {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '缺少 token' }))
            return
          }
          if (token.length > 8192) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '输入过长（≤8192 字符）' }))
            return
          }
          await ctx.credentials.set('DEEPSEEK_PLATFORM_TOKEN', token)
          // 令牌模式下的今日已用依赖该凭据：失效缓存，下次刷新立即重算
          balanceCache = null
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
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

    // —— 凭据变更自动跟随（修复：显示不随 DSH API 密钥更新）——
    // DSH 凭据服务的提交事件：GUI 设置里保存/修改任意凭据引用、挂件设置
    // 弹窗写入令牌、外部编辑 .credentials.yaml（provider 热重载）都会触发。
    // 收到即递增 credVersion 并失效全部余额缓存（25 秒余额快照 + 中转站
    // 失败负缓存），下一次 balance.json 读取按新密钥实时解析。前端每秒轮询
    // last-turn.json 时发现版本号变化会立即主动刷新，不再等自适应刷新周期
    // （最长 5 分钟）。ctx.credentials.set 的内部写入同样经 notifyUpdated
    // 到达这里，与 user-token / platform-token 路由中已有的手动清缓存互为冗余。
    disposers.push(ctx.on('credentials/reference-updated', () => {
      try {
        credVersion++
        balanceCache = null
        relayFailCache.clear()
        console.log('[whale-balance] 凭据变更 → 递增版本 ' + credVersion + ' 并失效余额缓存')
      } catch (err) {}
    }))

    ctx.effect(() => () => {
      for (const d of disposers) {
        try { d() } catch (err) {}
      }
    })
}

export { name, inject, apply }
