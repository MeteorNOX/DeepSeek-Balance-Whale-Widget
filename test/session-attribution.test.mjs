#!/usr/bin/env node
// 会话归属（session attribution）：两条会话同时存在、且各自的路由上有**同名模型**时，
// 结算出来的"上一轮消耗"必须各记各的账。
//
// 为什么要这条测试：宿主在每次请求前会 append `request/context {provider, model}`，
// 但挂件目前只用事件里的 `message.source.model` 计费 —— 同一个模型名挂在两个 provider 下
// （例如套餐路由与免费额度路由都提供 qwen3.8-flash）时，last-turn.json 说不出"这一轮是谁家的账"，
// 前端只能靠猜。本测试不启浏览器、不启 dsh，用假 root 跑真实 apply()。
//
//   node test/session-attribution.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-attr-')) // 绝不碰用户真账本

const routes = new Map()
const topics = new Map()
const fakeCtx = {
  webServer: {
    register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) },
    tapIndex: () => () => {},
  },
  credentials: { resolve: () => null },
  connection: { on: () => () => {}, send: () => {} },
  get: () => null,
  on: (topic, cb) => {
    if (!topics.has(topic)) topics.set(topic, [])
    topics.get(topic).push(cb)
    return () => {
      const arr = topics.get(topic)
      const i = arr.indexOf(cb)
      if (i >= 0) arr.splice(i, 1)
    }
  },
  effect: (fn) => { try { fn() } catch (err) {} },
}
const root = {
  effect: fakeCtx.effect,
  on: fakeCtx.on,
  inject: (names, cb) => cb(fakeCtx),
}

let passed = 0
let failed = 0
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++
    console.log('  ok  ' + name)
  }, (err) => {
    failed++
    console.log('  FAIL ' + name + '：' + String(err && err.message).split('\n')[0])
  })
}

function emit(sid, event) {
  for (const cb of topics.get('session/event') || []) cb({ id: sid }, event)
}
function dispose(sid) {
  for (const cb of topics.get('session/disposed') || []) cb({ id: sid })
}
async function get(p) {
  const r = routes.get(p)
  assert.ok(r, '路由没注册：' + p + '（已注册 ' + routes.size + ' 条）')
  let code = 0
  let body = ''
  await r.handler({ method: 'GET', headers: { host: '127.0.0.1:3080' }, url: p }, {
    writeHead: (c) => { code = c },
    end: (t2) => { body = t2 },
  })
  assert.equal(code, 200, p + ' 应回 200')
  return JSON.parse(body || 'null')
}
function turnOf(model) {
  return [
    { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 4000, cacheReadTokens: 120000, outputTokens: 900 }, message: { source: { model } } } },
    { type: 'turn/end', data: { turn: 1 } },
  ]
}

const mod = await import(url.pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const plugin = mod.default || mod
assert.equal(typeof plugin.apply, 'function', '插件没导出 apply')
plugin.apply(root)
await new Promise((r) => setTimeout(r, 60)) // 让 inject 回调与首帧拉取落地

const NAMES = '同名模型跨 provider'
await t('上一轮消耗里带着"这轮是谁家的账"（provider 字段）', async () => {
  emit('s-plan', { type: 'request/context', data: { provider: 'tokenplan', model: 'qwen3.8-flash' } })
  for (const ev of turnOf('qwen3.8-flash')) emit('s-plan', ev)
  const j = await get('/dsh-whale/last-turn.json')
  assert.equal(j.turn, 1, '本轮序号要对得上')
  assert.equal(j.provider, 'tokenplan', 'last-turn.json 应报出本轮所属 provider')
})
await t(NAMES + '：后一条会话不得沿用前一条的账', async () => {
  emit('s-free', { type: 'request/context', data: { provider: 'bailian', model: 'qwen3.8-flash' } })
  for (const ev of turnOf('qwen3.8-flash')) emit('s-free', ev)
  const j = await get('/dsh-whale/last-turn.json')
  assert.equal(j.provider, 'bailian', '切到免费额度路由的会话，结算要报 bailian')
})
await t(NAMES + '：切回原会话仍认自己那本账（不按"最后一次"猜）', async () => {
  for (const ev of [{ type: 'assistant/message', data: { turn: 2, usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 100 }, message: { source: { model: 'qwen3.8-flash' } } } }, { type: 'turn/end', data: { turn: 2 } }]) emit('s-plan', ev)
  const j = await get('/dsh-whale/last-turn.json')
  assert.equal(j.provider, 'tokenplan', 's-plan 的第二轮还得记回套餐账')
})
await t('会话销毁后不留归属残迹（新会话不被旧账污染）', async () => {
  dispose('s-free')
  emit('s-new', { type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } })
  for (const ev of turnOf('deepseek-chat')) emit('s-new', ev)
  const j = await get('/dsh-whale/last-turn.json')
  assert.equal(j.provider, 'deepseek', '新会话要认自己的路由')
})
await t('没走过任何请求的会话（读不到归属）不得报错，只把 provider 留空', async () => {
  for (const ev of turnOf('mystery-model')) emit('s-blind', ev)
  const j = await get('/dsh-whale/last-turn.json')
  assert.ok(j && typeof j.provider === 'string', 'provider 字段必须存在，值可以是空串')
})

console.log('会话归属测试：' + passed + ' 通过 / ' + failed + ' 失败')
process.exit(failed ? 1 : 0)
