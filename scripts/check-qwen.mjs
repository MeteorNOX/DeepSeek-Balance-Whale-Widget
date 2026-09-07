#!/usr/bin/env node
// 阿里 Token Plan 用量检测 —— 独立验证脚本（不重启 dsh web 也能跑）
//
//   node scripts/check-qwen.mjs
//
// 检查项：
//   1) 语法：lib/index.js / lib/tokenplan-usage.js / 注入前端的 WIDGET_JS
//   2) 口径：与外部按量报表脚本逐日 Credits 对比（设 TOKENPLAN_REPORT 才跑，容差 1%）
//   3) 真实数据：读 ~/.dsh/dsh-usage/usage-ledger.json 跑一遍 summarize()
//   4) 线上路由：GET http://127.0.0.1:3080/dsh-whale/qwen.json（404 说明还没重启 dsh web）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as TP from '../lib/tokenplan-usage.js'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.DSH_PORT || process.env.PORT || 3080)
let fails = 0
const ok = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name + (extra ? '  ' + extra : ''))
  else {
    fails++
    console.log('  FAIL ' + name + (extra ? '  ' + extra : ''))
  }
}
const info = (name, extra) => console.log('  ..   ' + name + (extra ? '  ' + extra : ''))

// —— 1) 语法 ——
console.log('\n[1] 语法')
for (const f of ['lib/index.js', 'lib/tokenplan-usage.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(PKG, f)], { stdio: 'pipe' })
    ok('node --check ' + f, true)
  } catch (err) {
    ok('node --check ' + f, false, String(err.stderr || err.message).slice(0, 300))
  }
}
try {
  const src = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8')
  const start = src.indexOf('const WIDGET_JS = `')
  const bodyStart = start >= 0 ? src.indexOf('`', start) + 1 : -1
  const end = bodyStart >= 0 ? src.indexOf('})()`', bodyStart) : -1
  if (bodyStart < 0 || end < 0) throw new Error('WIDGET_JS 边界没找到')
  const client = src.slice(bodyStart, end + 4)
  // ${} 会真的插值进前端脚本，模板里必须只有字面量
  ok('WIDGET_JS 无 ${} 插值', client.indexOf('${') === -1)
  // 前端脚本不允许出现 fetch 到外网/密钥字样的东西
  ok('WIDGET_JS 不直连外网（fetch 只能是本机相对路径）', /fetch\(\s*['\"]https?:/i.test(client) === false)
  new Function(client)
  ok('WIDGET_JS 可编译（' + client.split('\n').length + ' 行）', true)
  // 顶层 var 提升陷阱：声明行晚于同名赋值行，会把已建好的 DOM 引用抹成初始值
  const lines = client.split('\n')
  const decl = new Map()
  const assigns = []
  lines.forEach((line, i) => {
    const d = /^var ([A-Za-z0-9_$]+)\s*=/.exec(line)
    if (d && !decl.has(d[1])) decl.set(d[1], i + 1)
    const a = /^([A-Za-z0-9_$]+)\s*=[^=]/.exec(line)
    if (a) assigns.push([a[1], i + 1])
  })
  const clobber = []
  for (const pair of assigns) {
    const declared = decl.get(pair[0])
    if (declared && declared > pair[1]) clobber.push(pair[0] + '(赋值 ' + pair[1] + ' 行 / 声明 ' + declared + ' 行)')
  }
  ok('WIDGET_JS 顶层无 var 提升抹值陷阱', clobber.length === 0, clobber.join(' '))
} catch (err) {
  ok('WIDGET_JS 可编译', false, String((err && err.message) || err))
}

// —— 2) 真实账本 ——
console.log('\n[2] 真实账本 → summarize()')
const LEDGER = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-usage', 'usage-ledger.json')
let ledgerDays = {}
if (!fs.existsSync(LEDGER)) {
  info('账本不存在', LEDGER + '（装 dsh-usage 并跑过一轮后才有）')
} else {
  const doc = JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
  ledgerDays = TP.parseLedger(doc, 'tokenplan')
  const keys = Object.keys(ledgerDays).sort()
  ok('账本可解析', true, keys.length + ' 天有 tokenplan 记录')
  const s = TP.summarize({ ledgerDays, selfDays: {}, cfg: TP.normalizeConfig({}), nowMs: Date.now() })
  console.log(
    '  ..   本周 ' + s.used + ' / ' + s.cap + ' Cr（' + s.pct + '%）· 锚点来源 ' + s.anchorSource,
  )
  console.log('       窗口第 ' + s.dayIndex + '/7 天，' + (s.daysLeft) + ' 天后重置；锚点来源 ' + s.anchorSource)
  console.log('       今日 ' + s.today.credits + ' Cr / ' + s.today.calls + ' 次；来源 ' + s.source)
  console.log('       按模型 ' + s.byModel.map((m) => m.model + '=' + m.credits).join(', '))
  console.log('       等价按量 ¥' + s.payg.windowCny + ' / 套餐 ¥' + s.payg.planPriceCny + ' → ROI ' + s.payg.roiPercent + '%')
  console.log('       告警 ' + s.alert.level + '（阈值 ' + s.alert.warnPct + '%）')
  ok('used 与 series 合计一致', Math.abs(s.used - s.series.reduce((a, b) => a + b.credits, 0)) < 0.05)
  ok('pct ∈ [0,∞) 且 cap>0', s.cap > 0 && s.pct >= 0)
  ok('未知模型清单已标记', Array.isArray(s.unknownModels))

  // —— 3) 与 python 报表逐日对账 ——
  console.log('\n[3] 与外部按量报表脚本对账（需设环境变量 TOKENPLAN_REPORT，容差 1%）')
  const pyScript = process.env.TOKENPLAN_REPORT || ''
  if (!fs.existsSync(pyScript)) {
    info('跳过（未设置环境变量 TOKENPLAN_REPORT）', pyScript)
  } else {
    let py = null
    try {
      const out = execFileSync(
        process.env.PYTHON || 'python',
        ['-B', pyScript, '--json', '--days', '7'],
        { encoding: 'utf8', timeout: 60000 },
      )
      py = JSON.parse(out.slice(out.indexOf('{')))
    } catch (err) {
      ok('调用 python 报表', false, String(err.message || err).slice(0, 200))
    }
    if (py) {
      let worst = 0
      let worstDay = ''
      let compared = 0
      for (const day of py.days || []) {
        const mine = (py.per_day_est_credits && py.per_day_est_credits[day]) ?? null
        if (mine === null) continue
        const theirs = ledgerDays[day] ? TP.round(ledgerDays[day].credits, 1) : 0
        compared++
        const diff = Math.abs(theirs - mine)
        const rel = mine > 0 ? diff / mine : diff
        if (rel > worst) {
          worst = rel
          worstDay = day + '（python ' + mine + ' vs node ' + theirs + '）'
        }
      }
      ok('逐日 Credits 对账 ' + compared + ' 天，偏差 < 1%', worst < 0.01, worstDay)
      if (py.by_model) {
        const models = Object.keys(py.by_model)
        info('python 侧模型', models.join(', '))
        for (const m of models) {
          const est = TP.estimateUsage(
            m,
            {
              inputTokens: py.by_model[m].inp,
              outputTokens: py.by_model[m].out,
              cacheReadTokens: py.by_model[m].cache,
            },
          )
          const diff = Math.abs(est.payg - py.by_model[m].cost)
          ok('  ' + m + ' 价目一致', diff / Math.max(1e-9, py.by_model[m].cost) < 0.01, '¥' + est.payg.toFixed(3) + ' vs ¥' + py.by_model[m].cost)
        }
      }
    }
  }
}

// —— 4) 线上路由 ——
console.log('\n[4] 运行中的 dsh web 路由')
try {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  const res = await fetch('http://127.0.0.1:' + PORT + '/dsh-whale/qwen.json', { signal: ctrl.signal })
  clearTimeout(timer)
  if (res.status === 404) {
    info('/dsh-whale/qwen.json 404', '→ 符合预期：改完还没重启 dsh web，重启后应返回 200')
  } else {
    const data = await res.json()
    ok('路由 200 且返回 payload', typeof data === 'object' && data !== null, 'ok=' + data.ok + ' used=' + data.used + ' pct=' + data.pct + '%')
    if (data.ok) {
      ok('payload 含 alert 结构', !!data.alert && typeof data.alert.level === 'string', JSON.stringify(data.alert))
      ok('payload 不含密钥字段', JSON.stringify(data).indexOf('api') === -1 && JSON.stringify(data).indexOf('sk-') === -1)
      // 活体探针：本机真出过事 —— 一次 429 每分钟限流让 66.5% 的用量显示成
      // 「已触顶 · 暂停」。远没到上限却报触顶，就是那个 bug 复发。
      ok('触顶标记与用量自洽（pct < ' + TP.CAP_CONFIRM_PCT + '% 不得确认触顶）',
        !(data.quotaHitAt && data.pct < TP.CAP_CONFIRM_PCT),
        'pct=' + data.pct + ' quotaHitAt=' + (data.quotaHitAt || 'null'))
      ok('跑的是已分诊限流/触顶的新构建', 'rateLimitedAt' in data && 'quotaHitSuspectAt' in data,
        '缺这两个字段 = 改完还没重启 dsh web')
      ok('告警级别不由额度信号之外的东西伪造',
        !(data.alert && data.alert.level !== 'ok' && !data.quotaHitAt && data.pct < (data.alert.warnPct || 70)),
        JSON.stringify({ level: data.alert && data.alert.level, pct: data.pct, warnPct: data.alert && data.alert.warnPct }))
    }
  }
} catch (err) {
  info('dsh web 未在本机 ' + PORT + ' 端口响应', String((err && err.message) || err).slice(0, 80))
}

console.log('\n' + (fails ? fails + ' 项失败' : '全部通过'))
process.exit(fails ? 1 : 0)
