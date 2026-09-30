// 活体验收：打此刻线上 dsh web 的只读路由 + 读注册表文件，证明 Token Plan 已经通到上游那条额度链
// 上游 v0.3.0 起，自定义路由都被套上 connection 信任栅栏（没浏览器 cookie 一律 401），
// 所以这里只打**我们自己那两条免鉴权只读路由**；模型注册表直接读盘（写面路由一律不开）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = (process.env.DSH_BASE || 'http://127.0.0.1:3080').replace(/\/+$/, '')
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DSH_PORT_ONLY = !/tokenplan/i.test(process.argv.join(' '))

async function get(p) {
  const res = await fetch(BASE + p, { signal: AbortSignal.timeout(15000) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (err) {}
  return { code: res.status, text, json }
}
let fails = 0
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok ' + label + (detail ? '（' + detail + '）' : ''))
  else { fails++; console.log('  FAIL ' + label + (detail ? '（' + detail + '）' : '')) }
}

const tp = await get('/dsh-whale/tokenplan.json')
ok('服务端半边是新构建', tp.code === 200 && tp.json && tp.json.ok === true,
  'HTTP ' + tp.code + '（404/401 = 线上还是旧构建，或被鉴权挡了：要重启 dsh web）')
if (tp.json && tp.json.ok) {
  const p = tp.json
  ok('明细读数齐', isFinite(p.cap) && isFinite(p.used) && isFinite(p.pct) && p.resetAt > 0,
    '已用 ' + p.used + '/' + p.cap + ' Cr · ' + p.pct + '% · 周第 ' + p.dayIndex + '/7 · 剩 ' + p.remaining.toFixed(0) + ' Cr')
  ok('账本来源是 dsh-usage', p.ledgerSource === 'dsh-usage', 'source=' + p.ledgerSource)
  ok('30 天套餐期已配上（起点日期）', !!(p.plan && p.plan.totalDays),
    p.plan ? '套餐第 ' + p.plan.dayIndex + '/' + p.plan.totalDays + ' 天 · 剩 ' + p.plan.daysLeft + ' 天 · 日均 ' + (p.pace && p.pace.perDay) + ' Cr' : 'plan 为空：套餐起点没配上')
  ok('接线自检：模板已挂进上游', !!(p.chain && p.chain.templateMounted), p.chain ? p.chain.templateName : '无 chain')
  ok('接线自检：凭据解析得到（不回明文）', !!(p.chain && p.chain.hasKey), 'hasKey=' + (p.chain && p.chain.hasKey))
  const hit = p.quotaHitAt ? '触顶@' + new Date(p.quotaHitAt).toLocaleString('zh-CN') : (p.rateLimitedAt ? '限流@' + new Date(p.rateLimitedAt).toLocaleTimeString('zh-CN') : '无限流/触顶')
  console.log('  ℹ️ 信号：' + hit + ' · 告警档 ' + (p.alert && p.alert.level) + '（告警线 ' + (p.alert && p.alert.warnPct) + '%）')
}

const quota = await get('/dsh-whale/tokenplan-quota.json')
ok('上游 plan 同形的读数齐', quota.code === 200 && quota.json && quota.json.ok === true &&
  isFinite(quota.json.usedPct) && quota.json.resetAt > 0 && !!quota.json.level,
  quota.json && quota.json.level ? quota.json.level : 'HTTP ' + quota.code)

let reg = null
try {
  for (const p of [path.join(HOME, '.dshw-api.json'), path.join(HOME, 'profiles', 'web', '.dshw-api.json')]) {
    if (fs.existsSync(p)) { reg = JSON.parse(fs.readFileSync(p, 'utf8')); break }
  }
} catch (err) { reg = null }
const model = reg && Array.isArray(reg.models) ? reg.models.find((m) => m && m.provider === 'tokenplan') : null
ok('记账模型已注册（菜单：小鲸鱼记账 → 模型）', !!model,
  model ? model.name + ' / ' + model.id : '注册表里没有 provider=tokenplan 的模型：在挂件菜单里添加，厂商选「阿里 Token Plan（订阅）」')
ok('记账模型带 matchIds（上游按它做归属与单价，缺了就两头都不通）',
  !!(model && Array.isArray(model.matchIds) && model.matchIds.length),
  model && model.matchIds && model.matchIds.length ? model.matchIds.join(' ') :
    '注册表那条没有 matchIds：上游 apiAttributeEvent / refreshCustomPrices 都只按 matchIds（缺省退到 name/id）做子串匹配，' +
    '事件里的模型名是 qwen3.8-flash，匹配不到「阿里 Token Plan」→ 泡泡「今日已用」恒 0，且上游按 DeepSeek 默认价估算')
const attributed = model && reg.usage ? reg.usage[model.id] : null
console.log(attributed
  ? '  ok  上游归属链已通（usage 里有本模型：今日 ' + (attributed.eventCost || 0) + ' 元 / ' + (attributed.eventTokens || 0) + ' tokens）'
  : '  —   上游 usage 段还没有本模型的记录（还没在套餐模型上跑过会话就会这样，不算故障）')

console.log(fails ? '\n' + fails + ' 项不通过' : '\n全绿：Token Plan 的读数已经在挂件的额度链上')
process.exitCode = fails ? 1 : 0
