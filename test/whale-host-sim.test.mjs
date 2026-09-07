#!/usr/bin/env node
// 宿主集成仿真：用假 ctx 跑真实 lib/index.js 的 apply()，验证
//   · request/context 路由归属（tokenplan / bailian 同名模型不串账）
//   · 事件流实时累计 Credits → /dsh-whale/qwen.json
//   · last-turn.json 的 credits / amount 分轨
//   · size.json 的 display / qwenWarnPct 往返
//   · 失败信号分诊：429 限流 ≠ 周额度触顶；真触顶要估算也接近上限
//   · 触顶 / 存疑 / 限流 三态各自的告警与落盘行为
// 全程用临时 DSH_HOME，绝不碰用户真账本。
//   node test/whale-host-sim.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-sim-'))
const TMP_DIRS = [] // 各场景临时家目录，跑完统一清
process.env.DSH_HOME = TMP // 必须在 import 之前设置：模块加载时解析路径

const routes = new Map()
const topics = new Map()
const effects = []
const ctx = {
  webServer: {
    register: (r) => {
      routes.set(r.path, r)
      return () => routes.delete(r.path)
    },
    tapIndex: (fn) => {
      effects.push(fn)
      return () => {}
    },
  },
  credentials: { resolve: () => null }, // 无 key：余额接口应优雅失败，不影响用量
  on: (topic, cb) => {
    if (!topics.has(topic)) topics.set(topic, [])
    topics.get(topic).push(cb)
    return () => {
      const arr = topics.get(topic)
      const i = arr.indexOf(cb)
      if (i >= 0) arr.splice(i, 1)
    }
  },
  effect: (fn) => {
    effects.push(fn)
    return () => {}
  },
}

const mod = await import(pathToFileUrl(path.join(PKG, 'lib', 'index.js')))
assert.equal(mod.name, 'whale-balance-widget')
mod.apply(ctx)

function emit(topic, ...args) {
  for (const cb of (topics.get(topic) || []).slice()) cb(...args)
}
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const route = routes.get(urlPath.split('?')[0])
    if (!route) return reject(new Error('route missing: ' + urlPath))
    const req = { method }
    if (body !== undefined) {
      req.on = (ev, cb) => {
        // 只演 data → end；error 挂上但绝不触发（触发了 readBody 就 400 了）
        if (ev === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify(body))))
        else if (ev === 'end') process.nextTick(cb)
      }
    }
    const res = {
      statusCode: 200,
      headers: null,
      payload: null,
      writeHead(code, h) {
        this.statusCode = code
        this.headers = h
      },
      end(body) {
        this.payload = body
        resolve({ status: this.statusCode, json: body ? JSON.parse(body) : null })
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}
function pathToFileUrl(p) {
  return new URL('file:///' + p.replace(/\\/g, '/'))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
const t = (name, cond, extra) => {
  if (cond) {
    passed++
    console.log('  ok   ' + name + (extra ? '  ' + extra : ''))
  } else {
    process.exitCode = 1
    console.log('  FAIL ' + name + (extra ? '  ' + extra : ''))
  }
}

console.log('\n[路由] 注册表')
t('/dsh-whale/qwen.json 已注册', routes.has('/dsh-whale/qwen.json'))
t('/dsh-whale/balance.json 保持原样', routes.has('/dsh-whale/balance.json'))
t('/dsh-whale/size.json 保持原样', routes.has('/dsh-whale/size.json'))
t('widget 事件流订阅在跑', (topics.get('session/event') || []).length > 0)

console.log('\n[事件] tokenplan 累计 Credits')
// 1e6 输入 + 1e5 输出 + 5e5 缓存命中，qwen3.8-flash 0.8/2.7/0.1 元/百万
// → 0.8 + 0.27 + 0.05 = ¥1.12 → 112 Credits
emit('session/event', { id: 's1' }, { type: 'request/context', data: { provider: 'tokenplan', model: 'qwen3.8-flash', contextWindow: 128000 } })
emit('session/event', { id: 's1' }, {
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 0,
    message: { source: { model: 'qwen3.8-flash' } },
    usage: { inputTokens: 1e6, outputTokens: 1e5, cacheReadTokens: 5e5, cacheWriteTokens: 0, reasoningTokens: 0 },
  },
})
// 同一步重复投递：必须被去重
emit('session/event', { id: 's1' }, {
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 0,
    message: { source: { model: 'qwen3.8-flash' } },
    usage: { inputTokens: 1e6, outputTokens: 1e5, cacheReadTokens: 5e5 },
  },
})
emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

let q = (await request('GET', '/dsh-whale/qwen.json')).json
t('qwen.json ok=true（仅靠事件流实时账本）', q.ok === true, 'source=' + q.source)
t('Credits = 112（价目精确对账）', Math.abs(q.used - 112) < 0.01, 'used=' + q.used)
// 不断言具体第几天：锚点是「账本里第一个有量的一天」，跨过午夜就会 +1（产品对，日期敏感）
t('窗口天数落在 1..7 且与重置一致', q.dayIndex >= 1 && q.dayIndex <= 7 && q.daysLeft === 7 - q.dayIndex + 1 && q.windowIndex >= 0, 'dayIndex=' + q.dayIndex + ' daysLeft=' + q.daysLeft)
t('cap 默认 10000（Standard）', q.cap === 10000)
t('estimated 标记为真', q.estimated === true)
t('byModel 只有 qwen3.8-flash', q.byModel.length === 1 && q.byModel[0].model === 'qwen3.8-flash', JSON.stringify(q.byModel))
t('ROI 用套餐价 139 元', q.payg.planPriceCny === 139)

const turn = (await request('GET', '/dsh-whale/last-turn.json')).json
t('last-turn 带 credits 而非 ¥', turn.credits > 0 && turn.amount === null, JSON.stringify({ amount: turn.amount, credits: turn.credits }))
t('last-turn 标 provider', turn.provider === 'tokenplan', turn.provider)

console.log('\n[事件] bailian 同名模型不得进套餐账')
const beforeUsed = q.used
emit('session/event', { id: 's2' }, { type: 'request/context', data: { provider: 'bailian', model: 'qwen3.8-flash' } })
emit('session/event', { id: 's2' }, {
  type: 'assistant/message',
  data: { turn: 1, step: 0, message: { source: { model: 'qwen3.8-flash' } }, usage: { inputTokens: 2e6, outputTokens: 2e5 } },
})
emit('session/event', { id: 's2' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
q = (await request('GET', '/dsh-whale/qwen.json?r=2')).json
t('bailian 流量未计入 Credits', Math.abs(q.used - beforeUsed) < 0.01, beforeUsed + ' → ' + q.used)
const turn2 = (await request('GET', '/dsh-whale/last-turn.json')).json
t('bailian 轮次走 ¥ 价目（amount 有值、credits 为空）', turn2.amount !== null && turn2.credits === null, JSON.stringify({ amount: turn2.amount, credits: turn2.credits }))

console.log('\n[事件] 429 限流不是触顶（本机 2026-09-07 真实抓包）')
// 这条 payload 逐字来自 一次真实 429 的 turn/end（本机抓包）：百炼套餐网关
// 每分钟 token 配额(TPM)打满时回的就是它，文案里带 quota/exhausted，旧判定
// 把它算成周额度触顶，于是 66.5% 的用量长期显示「已触顶 · 暂停」。
const TPM_429 = {
  message: '429: {"message":"Allocated quota exceeded, please increase your quota limit. ' +
    'For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code#token-limit",' +
    '"id":"c82db889-37e8-4c02-9064-4f0253385854","type":"insufficient_quota","code":"insufficient_quota"}',
  code: 'QUOTA',
}
emit('session/event', { id: 's1' }, { type: 'request/context', data: { provider: 'tokenplan', model: 'qwen3.8-flash' } })
emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: TPM_429 } } })
q = (await request('GET', '/dsh-whale/qwen.json?r=3')).json
t('TPM 限流不记触顶', !q.quotaHitAt, JSON.stringify({ quotaHitAt: q.quotaHitAt }))
t('TPM 限流记成 rateLimitedAt', !!q.rateLimitedAt, String(q.rateLimitedAt))
t('限流不得伪造告警级别（1.1% 用量仍是 ok）', q.alert.level === 'ok' && q.alert.shouldAnnounce === false, JSON.stringify(q.alert))
t('限流不抹掉真实用量', q.used > 0 && q.remaining > 0, 'used=' + q.used + ' pct=' + q.pct)

console.log('\n[事件] 真触顶：估算用量确实接近上限时才成立')
// 把上限压到 120 Cr，当前累计（~112 Cr）就是 9x%，属于「该信这个报错」的区间
await request('PUT', '/dsh-whale/size.json', { scale: 0.3, display: 'qwen', qwenCap: 120, qwenWarnPct: 70 })
emit('session/event', { id: 's1' }, { type: 'request/context', data: { provider: 'tokenplan', model: 'qwen3.8-flash' } })
emit('session/event', { id: 's1' }, {
  type: 'turn/end',
  data: { turn: 4, reason: { kind: 'error', error: { message: '403 本周套餐额度已用尽，请等待重置', code: 'QUOTA', status: 403 } } },
})
q = (await request('GET', '/dsh-whale/qwen.json?r=4')).json
t('接近上限时的额度报错记为触顶', !!q.quotaHitAt, 'pct=' + q.pct + ' quotaHitAt=' + q.quotaHitAt)
t('级别至少 warn 且带 shouldAnnounce', ['warn', 'high', 'exhausted'].indexOf(q.alert.level) >= 0 && q.alert.shouldAnnounce === true, JSON.stringify(q.alert))
const q2 = (await request('GET', '/dsh-whale/qwen.json?r=5')).json
t('同窗口同级不重复冒泡', q2.alert.shouldAnnounce === false)

console.log('\n[事件] 额度报错 + 估算还剩很多 → 只能算存疑')
await request('PUT', '/dsh-whale/size.json', { scale: 0.3, display: 'qwen', qwenCap: 10000, qwenWarnPct: 70 })
emit('session/event', { id: 's1' }, { type: 'request/context', data: { provider: 'tokenplan', model: 'qwen3.8-flash' } })
emit('session/event', { id: 's1' }, {
  type: 'turn/end',
  data: { turn: 5, reason: { kind: 'error', error: { message: '403 quota exhausted', code: 'QUOTA', status: 403 } } },
})
const qs = (await request('GET', '/dsh-whale/qwen.json?r=6')).json
t('低用量下的额度报错不显示已触顶', !qs.quotaHitAt, 'pct=' + qs.pct)
t('但要留痕成存疑，不能当无事发生', !!qs.quotaHitSuspectAt, JSON.stringify({ s: qs.quotaHitSuspectAt, p: qs.pct }))
t('存疑也不抬高级别', qs.alert.level === 'ok', JSON.stringify(qs.alert))

console.log('\n[事件] 归属收紧：不该算触顶的失败')
const rl0 = (await request('GET', '/dsh-whale/qwen.json?r=7')).json.rateLimitedAt // 上面 TPM 限流留下的
emit('session/event', { id: 's9' }, { type: 'request/context', data: { provider: 'bailian', model: 'qwen3.8-flash' } })
emit('session/event', { id: 's9' }, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'error', error: { message: '429 Allocated quota exceeded, please try later', code: 'QUOTA' } } },
})
const qa = (await request('GET', '/dsh-whale/qwen.json?r=8')).json
t('非套餐 provider 的 quota 报错不刷新触顶', !qa.quotaHitAt, JSON.stringify({ quotaHitAt: qa.quotaHitAt }))
t('非套餐 provider 也不刷新限流标记', qa.rateLimitedAt === rl0, JSON.stringify({ before: rl0, after: qa.rateLimitedAt }))
const before = (await request('GET', '/dsh-whale/qwen.json?r=9')).json
emit('session/event', { id: 's1' }, { type: 'request/context', data: { provider: 'tokenplan', model: 'qwen3.8-flash' } })
emit('session/event', { id: 's1' }, {
  type: 'turn/end',
  data: { turn: 6, reason: { kind: 'error', error: { message: '403: Free quota exhausted. To continue accessing the model on a paid basis, please add funds', code: 'AUTH', status: 403 } } },
})
const qf = (await request('GET', '/dsh-whale/qwen.json?r=10')).json
t('百炼免费额度耗尽不新增任何额度信号',
  qf.quotaHitAt === before.quotaHitAt && qf.quotaHitSuspectAt === before.quotaHitSuspectAt && qf.rateLimitedAt === rl0,
  JSON.stringify({ h: qf.quotaHitAt, s: qf.quotaHitSuspectAt, r: qf.rateLimitedAt }))
t('限流也不会压低已显示的用量', qf.pct > 0 && qf.used > 0, 'pct=' + qf.pct)

console.log('\n[配置] size.json 往返')
const put = await request('PUT', '/dsh-whale/size.json', {
  scale: 0.3,
  sound: true,
  vol: 0.5,
  soundSet: 'duck',
  usageMode: 'ledger',
  peakMode: 'default',
  bubbleOn: true,
  turnCostOn: true,
  turnCostCloseMs: 5000,
  scrollGapOn: false,
  scrollGapPx: 17,
  display: 'qwen',
  qwenWarnPct: 20,
})
t('PUT 接受并回显 display/qwenWarnPct', put.json.display === 'qwen' && put.json.qwenWarnPct === 20, JSON.stringify({ d: put.json.display, w: put.json.qwenWarnPct }))
const get = await request('GET', '/dsh-whale/size.json')
t('GET 复读一致', get.json.display === 'qwen' && get.json.qwenWarnPct === 20)
t('落盘到临时 DSH_HOME', fs.existsSync(path.join(TMP, '.dshw-size.json')))
q = (await request('GET', '/dsh-whale/qwen.json?r=5')).json
t('阈值改动即时生效（warnPct=20 → 1.2% 仍 ok）', q.alert.warnPct === 20, 'pct=' + q.pct)
const bad = await request('PUT', '/dsh-whale/size.json', { scale: 0.3, display: 'bogus', qwenWarnPct: 900 })
t('脏值被 clamp/回落', bad.json.display === 'ds' && bad.json.qwenWarnPct === 100, JSON.stringify({ d: bad.json.display, w: bad.json.qwenWarnPct }))

console.log('\n[持久化] 实时账本落盘')
await sleep(2400) // markQwenDirty 的 2s 去抖
const ledFile = path.join(TMP, '.dshw-qwen.json')
t('.dshw-qwen.json 已写出', fs.existsSync(ledFile))
if (fs.existsSync(ledFile)) {
  const led = JSON.parse(fs.readFileSync(ledFile, 'utf8'))
  const keys = Object.keys(led.days)
  t('账本按本地日记一天', keys.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(keys[0]), keys.join(','))
  t('落盘值含 credits/alert 与两类信号', led.days[keys[0]].credits > 0 && !!led.alert && !!led.quotaHitAt && !!led.rateLimitedAt,
    JSON.stringify({ quotaHitAt: led.quotaHitAt, rateLimitedAt: led.rateLimitedAt }))
}

console.log('\n[账本升级] 老版本记错的触顶标记必须作废')
// 0.2.11 之前把 429 限流也记成 quotaHitAt，这条脏数据能活 6 小时；
// 升级后见到没有 quotaHitKind 的触顶标记一律丢掉，带了 kind 的才继续生效。
// 注意：账本一旦读进内存就不再回头看文件，所以两种家目录都要在装配前写好。
const todayKey = new Date().toLocaleDateString('en-CA')
const mkLegacyDay = (credits) => ({
  credits, payg: credits / 100, tokens: credits * 1000, calls: 5,
  models: { 'qwen3.8-flash': { credits, tokens: credits * 1000, calls: 5 } }, unknown: {},
})
async function bootLedger(home, ledger, tag) {
  TMP_DIRS.push(home)
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, '.dshw-qwen.json'), JSON.stringify(ledger), 'utf8')
  process.env.DSH_HOME = home
  const routes = new Map()
  const mod = await import(pathToFileUrl(path.join(PKG, 'lib', 'index.js')) + '?v=' + tag)
  mod.apply({
    webServer: { register: (r) => { routes.set(r.path, r); return () => {} }, tapIndex: () => () => {} },
    credentials: { resolve: () => null },
    on: () => () => {},
    effect: () => () => {},
  })
  return new Promise((resolve) => {
    routes.get('/dsh-whale/qwen.json').handler({ method: 'GET' }, {
      writeHead() {},
      end(b) { resolve(JSON.parse(b)) },
    })
  })
}
const seedHit = (kind) => {
  const led = { version: 1, days: { [todayKey]: mkLegacyDay(9000) }, quotaHitAt: Date.now() - 60000, quotaHitCode: 'QUOTA' }
  if (kind) led.quotaHitKind = 'cap'
  return led
}
const qOld = await bootLedger(fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-lg-old-')), seedHit(false), 'old')
t('脏 quotaHitAt 不再下发（既不显示已触顶也不显示存疑）', !qOld.quotaHitAt && !qOld.quotaHitSuspectAt, JSON.stringify({ h: qOld.quotaHitAt, s: qOld.quotaHitSuspectAt, pct: qOld.pct }))
t('作废标记不影响用量读数', Math.abs(qOld.used - 9000) < 1 && qOld.pct === 90, 'used=' + qOld.used)
const qNew = await bootLedger(fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-lg-new-')), seedHit(true), 'new')
t('带 quotaHitKind 的新标记仍正常生效', !!qNew.quotaHitAt && qNew.pct === 90, JSON.stringify({ h: qNew.quotaHitAt, pct: qNew.pct }))

console.log('\n[优雅降级] 无 key / 无账本（换一座空 DSH_HOME 重新装配）')
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-empty-'))
process.env.DSH_HOME = empty
const routesB = new Map()
const ctxB = {
  webServer: {
    register: (r) => {
      routesB.set(r.path, r)
      return () => {}
    },
    tapIndex: () => () => {},
  },
  credentials: { resolve: () => null },
  on: () => () => {},
  effect: () => () => {},
}
const mod2 = await import(pathToFileUrl(path.join(PKG, 'lib', 'index.js')) + '?v=2')
mod2.apply(ctxB)
const qe = await new Promise((resolve) => {
  routesB.get('/dsh-whale/qwen.json').handler({ method: 'GET' }, {
    writeHead(code) { this.code = code },
    end(b) { resolve({ code: this.code, json: JSON.parse(b) }) },
  })
})
t('空环境仍返回 200 且 ok=false（前端显示「暂无套餐用量记录」）', qe.code === 200 && qe.json.ok === false, JSON.stringify(qe.json).slice(0, 140))
t('空环境不含任何密钥字段', JSON.stringify(qe.json).indexOf('sk-') === -1)

console.log('\n' + passed + ' 项通过')
fs.rmSync(TMP, { recursive: true, force: true })
fs.rmSync(empty, { recursive: true, force: true })
for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true })
