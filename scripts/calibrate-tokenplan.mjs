// 对表校准：拿控制台读数 + 本地事件流，算出该写进 qwenCalib 的系数（以及它现在到底能不能写）。
// 用法（--from 是页面上统计周期的起始时刻，不给就只报上下界、不写盘）：
//   node scripts/calibrate-tokenplan.mjs --cap 45000 --pct 4.83 --at '2026-09-23 14:30' [--from '2026-09-22 15:14'] [--write]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const EVENTS = path.join(DSH, '.dshw-usage.json')
const CFG = path.join(DSH, '.dshw-tokenplan.json')
const CR_PER_CNY = 100 // 1 Credit = 0.01 元 —— 这条正是待阿里云确认的假设

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i > 0 ? process.argv[i + 1] : null
}
function toMs(s, label) {
  if (s === null || s === undefined) return null
  const t = /^[0-9]+$/.test(String(s)) ? Number(s) : Date.parse(String(s).replace(' ', 'T'))
  if (!isFinite(t)) throw new Error(label + ' 时刻格式不认：' + s)
  return t
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }
function isPlan(e) { return !!(e && isFinite(e.ts) && /^qwen/i.test(String(e.model || ''))) }
export function impliedCalib(events, atMs, fromMs, consoleCr) {
  let cr = 0, tok = 0, n = 0
  for (const e of events || []) if (isPlan(e) && e.ts >= fromMs && e.ts <= atMs) { cr += (Number(e.cost) || 0) * CR_PER_CNY; tok += Number(e.tokens) || 0; n++ }
  return { localCr: cr, tokens: tok, calls: n, calib: cr > 0 ? consoleCr / cr : null }
}
function fmt(ms) {
  const d = new Date(ms)
  const p2 = (x) => (x < 10 ? '0' : '') + x
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
}
function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
function inWindow(ev, from, to) { return impliedCalib(ev, to, from, 0).localCr }

if (process.argv[2] === '--self') {
  const ev = [{ ts: 1000, cost: 1, tokens: 1e6, model: 'qwen3.8-flash' }]
  const r = impliedCalib(ev, 2000, 0, 50)
  console.log('self: 本地 ' + r.localCr + ' Cr、页面 50 Cr → calib=' + r.calib)
  process.exit(r.calib === 0.5 && r.localCr === 100 && r.calls === 1 ? 0 : 1)
}
const cap = Number(arg('cap'))
if (!isFinite(cap) || cap <= 0) { console.log('缺 --cap（控制台上的周额度上限，如 45000）'); process.exit(2) }
const pctArg = arg('pct') === null ? null : Number(arg('pct'))
const usedArg = arg('used') === null ? null : Number(arg('used'))
const consoleCr = usedArg !== null ? usedArg : (isFinite(pctArg) ? (pctArg / 100) * cap : NaN)
if (!isFinite(consoleCr) || consoleCr <= 0) { console.log('缺 --pct 或 --used：页面「本周期已用」的百分比或绝对值'); process.exit(2) }
const at = toMs(arg('at') || fmt(Date.now()), '--at')
const from = toMs(arg('from'), '--from')
const ev = (readJson(EVENTS).events || []).filter(isPlan)
if (!ev.length) { console.log('事件流是空的：' + EVENTS); process.exit(1) }
console.log('页面读数：上限 ' + cap.toLocaleString() + ' Cr、本周期已用 ≈ ' + consoleCr.toFixed(1) + ' Cr（时刻 ' + fmt(at) + '）')
// 两点法：同一周期内两个页面读数，差一比就绕开了「窗口起点不知道」这个死结
const second = arg('at2') === null ? null : toMs(arg('at2'), '--at2')
if (second !== null) {
  const pct2 = arg('pct2') === null ? null : Number(arg('pct2'))
  const used2 = arg('used2') === null ? null : Number(arg('used2'))
  const cr2 = used2 !== null ? used2 : (isFinite(pct2) ? (pct2 / 100) * cap : NaN)
  if (!isFinite(cr2) || cr2 <= 0) { console.log('两点法缺 --pct2 或 --used2（第二次页面读数）'); process.exit(2) }
  const a = impliedCalib(ev, at, 0, consoleCr)
  const b = impliedCalib(ev, second, 0, cr2)
  const dConsole = cr2 - consoleCr
  const dLocal = b.localCr - a.localCr
  // 两点法只看增量，所以这里印的是「本地自开机以来的累计」，不是窗口内累计 —— 别拿它当已用额度读
  console.log('两点：' + fmt(at) + ' 页面 ' + consoleCr.toFixed(1) + ' / 本地累计 ' + a.localCr.toFixed(1) + '；' + fmt(second) + ' 页面 ' + cr2.toFixed(1) + ' / 本地累计 ' + b.localCr.toFixed(1))
  if (!(dLocal > 0)) { console.log('本地增量不是正的（' + dLocal.toFixed(1) + '）—— 两点之间没跑套餐调用，换一对点再来'); process.exit(1) }
  console.log('  → 只按增量算 qwenCalib = ' + (dConsole / dLocal).toFixed(4) + '（分母只用这段区间的增量，与窗口起点无关；增量为负则不采信）')
  console.log('  ' + (dConsole > 0 ? '同段页面增量 ' + dConsole.toFixed(1) + ' Cr / 本地增量 ' + dLocal.toFixed(1) + ' Cr' : '页面增量是负的（' + dConsole.toFixed(1) + '）—— 中间跨了一次重置，这次拟合作废'))
  process.exit(0)
}
if (from === null) {
  const today = impliedCalib(ev, at, dayStart(at), consoleCr)
  const two = impliedCalib(ev, at, dayStart(at) - 86400000, consoleCr)
  console.log('没给 --from（统计周期起点）→ 同一个读数能落在两个系数之间，别拿一个读数硬凑：')
  console.log('  只看今天     本地 ' + today.localCr.toFixed(1) + ' Cr → qwenCalib ≈ ' + (today.calib || 0).toFixed(3))
  console.log('  今天+昨天    本地 ' + two.localCr.toFixed(1) + ' Cr → qwenCalib ≈ ' + (two.calib || 0).toFixed(3))
  console.log('  相差 ' + (two.localCr / today.localCr).toFixed(2) + ' 倍；要落盘就补 --from（页面上统计周期的起始时刻）')
  process.exit(0)
}
const r = impliedCalib(ev, at, from, consoleCr)
console.log('窗口 ' + fmt(from) + ' → ' + fmt(at) + '：本地估算 ' + r.localCr.toFixed(1) + ' Cr / ' + r.tokens.toLocaleString() + ' tokens / ' + r.calls + ' 条事件')
if (r.calib === null) { console.log('窗口内本地为 0 —— 窗口给错了，不写'); process.exit(1) }
console.log('  → 隐含 qwenCalib = ' + r.calib.toFixed(4) + '；这批 token 折 ' + (consoleCr / (r.tokens / 1e6)).toFixed(2) + ' Cr/百万，现用价目表给 ' + (r.localCr / (r.tokens / 1e6)).toFixed(2) + '，差 ' + (1 / r.calib).toFixed(2) + ' 倍')
if (!arg('write')) { console.log('（没加 --write，只报数）'); process.exit(0) }
const cfg = readJson(CFG)
const bak = CFG + '.bak-' + fmt(Date.now()).replace(/[-: ]/g, '')
fs.copyFileSync(CFG, bak)
cfg.qwenCap = cap
cfg.qwenCalib = Number(r.calib.toFixed(4))
cfg.qwenCalibNote = '对表 ' + fmt(at) + '（窗口起 ' + fmt(from) + '，本地 ' + r.localCr.toFixed(0) + ' vs 页面 ' + consoleCr.toFixed(0) + '）'
cfg.qwenWindowAnchorExact = fmt(from)
cfg.qwenCapNote = '控制台 ' + fmt(at) + ' 读数'
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
console.log('已写 ' + CFG + '（备份 ' + path.basename(bak) + '）；约 30 秒内生效，不用重启 dsh web')
