// 宿主仿真：拿真实账本的副本喂 lib/tokenplan-server.js，验路由读数、配置迁移、事件归属、失败四态
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const TMP = path.join(os.tmpdir(), 'dshw-tp-test-' + process.pid)
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'dsh-usage'), { recursive: true })
// 夹具全部自造。以前这两份是从 ~/.dsh 复制真实账本，于是「本机此刻的额度状态」决定用例红绿：
// 线上带着当天的触顶标记且估算用量很高时，tokenplan-usage.js 的确认闸会把 rateLimitedAt 盖成 null
// （触顶优先于限流），下面那条 TPM 断言必红；线上恰好没有触顶标记时它又假绿。
// 自造：用量账本给今天一条 1.5e8 输出 token（按量价 2.7 元/百万 → 40,500 Credits，占默认档 45,000 的 90%），
// 自家账本只写套餐起点、不带任何触顶/限流标记。
// 夹具全部自造。以前这两份是从 ~/.dsh 复制真实账本，于是「本机此刻的额度状态」决定用例红绿：
// 线上带着当天的触顶标记且估算用量很高时，tokenplan-usage.js 的确认闸会把 rateLimitedAt 盖成 null
// （触顶优先于限流），下面那条 TPM 断言必红；线上恰好没有触顶标记时它又假绿。
// 自造口径：① 大额放**昨天**（窗口内但非今天）—— 两份账本按天取大，放今天会把「一步进账」的增量盖住；
// ② 套餐起点放 15 天前，保证昨天与今天都落在窗口里，plan.dayIndex 在 1..30；③ 不带任何触顶/限流标记。
const D = (offsetDays) => {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
const TODAY_KEY = D(0)
const YESTERDAY_KEY = D(-1)
const PLAN_START_KEY = D(-15)
// 昨天 1.5e8 输出 token：按量价 2.7 元/百万 → 40,500 Credits，占默认档 45,000 的 90%（够过 85% 的确认闸）
fs.writeFileSync(path.join(TMP, 'dsh-usage', 'usage-ledger.json'), JSON.stringify({
  version: 1,
  days: { [YESTERDAY_KEY]: { tokenplan: { 'qwen3.8-flash': { inputTokens: 0, outputTokens: 150000000, cacheReadTokens: 0, calls: 3 } } } },
}), 'utf8')
fs.writeFileSync(path.join(TMP, '.dshw-qwen.json'), JSON.stringify({ version: 1, subscribed: PLAN_START_KEY, days: {} }), 'utf8')
// 旧版 size 文件自己造一份：迁移断言不能依赖线上文件此刻有没有那些键
fs.writeFileSync(path.join(TMP, '.dshw-size.json'), JSON.stringify({
  scale: 1.5, sound: true, vol: 0.15, soundSet: 'duck', usageMode: 'ledger', peakMode: 'default',
  bubbleOn: true, turnCostOn: true, turnCostCloseMs: 5000, scrollGapOn: false, scrollGapPx: 17,
  theme: 'mint', display: 'qwen', qwenEnabled: true, qwenCap: 0, qwenWarnPct: 70, qwenCalib: 1,
  qwenWindowAnchor: '', qwenPlanStart: '', qwenPlanPriceCny: 0,
}), 'utf8')
process.env.DSH_HOME = TMP

const { installTokenPlan } = await import('../lib/tokenplan-server.js')

const routes = new Map()
const handlers = new Map()
const ctx = {
  credentials: { resolve: async (ref) => (ref === 'TOKENPLAN_API_KEY' ? { value: 'sk-sp-test' } : null) },
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
  webServer: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path) } },
}
// 模板条目由 index.js 提供，这里给一份同形替身（真条目由下面那条源码断言把住）
const tp = installTokenPlan(ctx, { templates: { tokenplan: { name: '阿里 Token Plan（订阅）', keyRef: 'TOKENPLAN_API_KEY', quota: { source: 'estimate' } } } })

let passed = 0
const ok = (label, fn) => { fn(); passed++; console.log('  ok ' + label) }

async function call(p) {
  const route = routes.get(p)
  assert.ok(route, '路由缺失: ' + p)
  const res = { code: 0, body: '', writeHead(code) { this.code = code }, end(text) { this.body = text } }
  await route.handler({ method: 'GET' }, res)
  return { code: res.code, json: JSON.parse(res.body || 'null') }
}

ok('两条只读路由挂上，写路由一律不挂', () => {
  assert.ok(routes.has('/dsh-whale/tokenplan.json'))
  assert.ok(routes.has('/dsh-whale/tokenplan-quota.json'))
  assert.ok(![...routes].some((p) => /config|write|set/.test(p)), '不该有写面路由')
})
ok('index.js 的接线四处都在（import / 模板声明 estimate 来源 / 按 source 分派 / apply 里 install）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ installTokenPlan \} from '\.\/tokenplan-server\.js'/)
  assert.match(src, /tokenplan: \{[\s\S]{0,900}?quota: \{[\s\S]{0,220}?source: 'estimate'/)
  assert.match(src, /function quotaSourceOf\(q\)[\s\S]{0,520}?return q\.url \? 'api' : 'none'/)
  assert.match(src, /if \(source === 'estimate'\) return await quotaEstimate\(\)/)
  assert.match(src, /installTokenPlan\(ctx, \{ templates: API_TEMPLATES \}\)/)
})

const snap = (await call('/dsh-whale/tokenplan.json')).json
ok('明细快照：账本在、数不为零', () => {
  assert.equal(snap.ok, true)
  // 09-23：上限与窗口长度都归配置管（档位表 45,000/月 或实测值），这里不该再钉死某个数 ——
  // 钉死的下场就是官方一改单位，这条用例变成「测试替配置撒谎」。
  assert.ok(snap.cap >= 1000 && snap.cap <= 1000000, 'cap 量级要在 Credits 范围内：' + snap.cap)
  assert.ok(snap.used > 0, 'used 应大于 0，实得 ' + snap.used)
  assert.ok(Math.abs(snap.pct - (snap.used / snap.cap) * 100) <= 0.2, '百分比必须是这份分子除以自己的分母：' + snap.pct + ' vs ' + snap.used + '/' + snap.cap)
  assert.ok(isFinite(snap.pct) && snap.pct >= 0 && snap.pct <= 999)
  assert.equal(snap.ledgerSource, 'dsh-usage')
})
ok('接线自检段：模板已挂、凭据解析得到', () => {
  assert.equal(snap.chain.templateMounted, true)
  assert.equal(snap.chain.hasKey, true)
  assert.equal(snap.chain.templateName, '阿里 Token Plan（订阅）')
})
ok('配置迁移：旧 size 文件里的 qwen* 键搬进自家文件', () => {
  const f = path.join(TMP, '.dshw-tokenplan.json')
  assert.ok(fs.existsSync(f), '没写出 .dshw-tokenplan.json')
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).qwenWarnPct, 70)
})
ok('套餐起点：从每日报告的 subscribed 拿到，plan 段非空', () => {
  assert.ok(snap.plan, 'plan 为空说明没拿到套餐起点')
  assert.equal(snap.plan.totalDays, 30)
  assert.ok(snap.plan.dayIndex >= 1 && snap.plan.dayIndex <= 30)
})

const quota = (await call('/dsh-whale/tokenplan-quota.json')).json
ok('上游 plan 同形：usedPct / remainPct / resetAt / level，且没有 error 段', () => {
  assert.equal(quota.ok, true)
  assert.equal(quota.error, undefined)
  assert.ok(isFinite(quota.usedPct) && quota.usedPct >= 0 && quota.usedPct <= 100)
  assert.ok(Math.abs(quota.usedPct + quota.remainPct - 100) < 0.15, '两侧百分比应互补')
  assert.ok(quota.resetAt > Date.now(), '重置时刻应在未来')
  assert.match(quota.level, /(剩 |已超 )?[\d.]+k? Cr · 周第 \d+\/7 · 套餐第 \d+\/30/)
  // 出处是协议字段：读的人不必翻注释就知道这个百分比是接口读的还是本地折的
  assert.equal(quota.source, 'estimate', 'source 没写成协议字段')
  assert.ok(['calibrated', 'tier-table', 'tier-table-default', 'user-cap', 'unknown'].includes(quota.reliability),
    'reliability 取值超出约定词汇：' + quota.reliability)
  assert.ok(typeof quota.capSource === 'string' && quota.capSource, '这个标签没有可复核的原始出处字段')
  assert.ok(typeof quota.calibSource === 'string' && quota.calibSource, '校准出处没跟着一起出')
})
const direct = await tp.planSnapshot()
ok('planSnapshot() 直连可用（上游短路走的就是它）', () => {
  assert.equal(direct.ok, true)
  assert.equal(direct.usedPct, quota.usedPct)
  assert.equal(direct.resetAt, quota.resetAt)
})

const emit = (event) => handlers.get('session/event')({ id: 's1', header: {} }, event)
const before = (await call('/dsh-whale/tokenplan.json')).json
emit({ type: 'request/context', data: { provider: 'tokenplan', model: 'qwen3.8-flash' } })
emit({ type: 'assistant/message', turn: 1, step: 0, data: { turn: 1, step: 0, message: { source: { model: 'qwen3.8-flash' } }, usage: { inputTokens: 100000, cacheReadTokens: 200000, outputTokens: 50000 } } })
emit({ type: 'assistant/message', turn: 1, step: 0, data: { turn: 1, step: 0, usage: { inputTokens: 100000 } } })
const after = (await call('/dsh-whale/tokenplan.json')).json
ok('事件流：套餐路由的一步进账、重复投递不二次进账', () => {
  const est = 100 * ((100000 / 1e6) * 0.8 + (200000 / 1e6) * 0.1 + (50000 / 1e6) * 2.7) // Credits = 按量价 × 100
  assert.ok(after.used > before.used, 'used 没涨')
  assert.ok(Math.abs(after.used - before.used - est) < 0.01, '涨幅应为 ' + est + '，实得 ' + (after.used - before.used))
})
emit({ type: 'request/context', data: { provider: 'bailian', model: 'qwen3.8-flash' } })
const bBase = (await call('/dsh-whale/tokenplan.json')).json
emit({ type: 'assistant/message', turn: 2, step: 0, data: { turn: 2, step: 0, message: { source: { model: 'qwen3.8-flash' } }, usage: { inputTokens: 500000, outputTokens: 900000 } } })
const bAfter = (await call('/dsh-whale/tokenplan.json')).json
ok('事件流：同名模型走百炼按量路由不掺进套餐账', () => {
  assert.ok(bAfter.used >= bBase.used) // 当日取大值合并，按量那一步不该把套餐账抬高
  assert.equal(bAfter.used, bBase.used)
})

const beforeThrottle = (await call('/dsh-whale/tokenplan.json')).json
emit({ type: 'request/context', data: { provider: 'tokenplan', model: 'qwen3.8-flash' } })
emit({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Allocated quota exceeded, please try again later. error-code#token-limit', status: 429, code: 'RequestLimitTriggered' } } } })
const throttled = (await call('/dsh-whale/tokenplan.json')).json
ok('429 TPM 限流：只标限流，不造触顶', () => {
  assert.ok(throttled.rateLimitedAt, 'rateLimitedAt 应写入')
  assert.equal(throttled.quotaHitAt, beforeThrottle.quotaHitAt)
})
emit({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Your token-plan 1-week quota has been exhausted. The quota will reset at 09-19 07:14:00 UTC.', status: 429, code: 'QuotaExhausted' } } } })
const capped = (await call('/dsh-whale/tokenplan.json')).json
ok('周额度真耗尽：判成触顶（这条 429 不再是限流）', () => {
  assert.ok(capped.quotaHitAt, 'quotaHitAt 应写入，本样本用量 ' + capped.pct + '%')
  assert.equal(capped.capConfirmPct, 85)
})
ok('脏标记升级：没有 quotaHitKind 的旧触顶标记一律丢弃', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, '.dshw-qwen.json'), 'utf8'))
  if (raw.quotaHitAt) assert.equal(raw.quotaHitKind, 'cap', '落盘的触顶标记必须带 kind')
})

// 配置改文件即生效（写面没有路由）
// 故意给一个**大于**档位默认值的上限：这样「百分比变小」只能由分母变化解释。
// （原先写 20000 是假设默认档 10000；09-23 默认档换成官方月度 45000 后，20000 反而会把百分比抬高，用例就变成测自己的假设了。）
fs.writeFileSync(path.join(TMP, '.dshw-tokenplan.json'), JSON.stringify({ version: 1, qwenCap: 90000, qwenWarnPct: 60 }), 'utf8')
tp.reload()
const recap = (await call('/dsh-whale/tokenplan.json')).json
ok('改配置文件 + reload：新上限立刻进汇总，告警线跟着走', () => {
  assert.equal(recap.cap, 90000)
  assert.equal(recap.alert.warnPct, 60)
  assert.ok(recap.pct < snap.pct)
})
fs.writeFileSync(path.join(TMP, '.dshw-tokenplan.json'), JSON.stringify({ version: 1, qwenWarnPct: 70 }), 'utf8')
tp.reload()
const defCap = (await call('/dsh-whale/tokenplan.json')).json
ok('qwenCap 缺省回到档位值 45000（standard，09-23 抄自控制台订阅总览的月度额度）', () => assert.equal(defCap.cap, 45000))

tp.dispose()
fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n' + passed + ' passed')
