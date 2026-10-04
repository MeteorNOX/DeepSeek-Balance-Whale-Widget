import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as config from '../lib/api-config.mjs'

const source = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))

// Run the real host functions without applying the plugin, opening a server,
// reading a user's registry or resolving any real credential.
function host() {
  let registry = { models: [] }, response = {}
  const requests = [], writes = [], credentialWrites = []
  const context = vm.createContext({
    ...config, URL, console, AbortSignal: { timeout: () => undefined },
    customPriceAt: 0, CUSTOM_PRICES: {}, CUSTOM_PRICE_META: {}, API_BUILTIN_ID: 'deepseek',
    readApiRegistry: () => structuredClone(registry),
    writeApiRegistry: value => { registry = plain(value); writes.push(plain(value)) },
    codexInvalidate: () => {}, todayKey: () => '2026-10-04',
    apiUsageNewDay: () => ({}), addMoney: (a, b) => a + b,
    ctx: { credentials: {
      resolve: async () => ({ value: 'FAKE_KEY' }),
      set: async (...args) => { credentialWrites.push(args) },
    } },
    fetch: async (url, init) => {
      requests.push({ url, ...init })
      return { ok: true, json: async () => response }
    },
  })
  const templates = source.match(/^const API_TEMPLATES = \{[\s\S]*?^\}/m)
  assert.ok(templates, 'production template table is available')
  vm.runInContext(templates[0], context)
  for (const name of ['apiTemplateOf', 'pickJsonPath', 'mergeNonEmpty', 'stripEmptyDeep',
    'originOfUrl', 'templateOrigins', 'credentialMayGoTo', 'warnCredDestinationOnce',
    'keyForDestination', 'assertSafeApiUrl', 'httpMethodOf', 'apiFetchJson', 'apiBusinessError',
    'pickQuotaEntry', 'fetchModelQuota', 'apiSaveModel', 'apiAttributeEvent', 'refreshCustomPrices']) {
    const match = source.match(new RegExp('^    (?:async )?function ' + name + '\\([^]*?^    }', 'm'))
    assert.ok(match, 'production function exists: ' + name)
    vm.runInContext(match[0], context)
  }
  return {
    context, requests, writes, credentialWrites,
    registry: () => registry,
    respond: value => { response = value },
    setRegistry: value => { registry = structuredClone(value) },
  }
}

test('quota save/fetch preserves json, method, body, pick and path-only overrides', async () => {
  const h = host(), c = h.context
  const input = { id: 'quota', provider: 'custom', allowCustomHost: true, params: { uuid: 'sample' }, quota: {
    url: 'https://example.invalid/quota', method: 'POST', body: '{"uuid":"{uuid}"}',
    json: { pick: { list: 'limits', types: ['CREDIT_LIMIT'], unit: 3 }, percent: 'percentage' },
  } }
  assert.equal((await c.apiSaveModel(input)).ok, true)
  assert.deepEqual(h.registry().models[0].quota, input.quota)
  h.respond({ limits: [{ type: 'CREDIT_LIMIT', unit: 3, percentage: 42 }] })
  assert.equal((await c.fetchModelQuota(h.registry().models[0])).usedPct, 42)
  assert.equal(h.requests[0].method, 'POST')
  assert.deepEqual(JSON.parse(h.requests[0].body), { uuid: 'sample' })
  await c.apiSaveModel({ id: 'inherited', provider: 'zhipu_glm_coding', quota: { json: { percent: 'actual.used' } } })
  h.respond({ actual: { used: 17 } })
  assert.equal((await c.fetchModelQuota(h.registry().models[1])).usedPct, 17)
  assert.equal(h.requests[1].url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
})

test('old flattened quota overrides remain readable without mutating or migrating data', async () => {
  const h = host()
  const model = { provider: 'custom', allowCustomHost: true, quota: {
    url: 'https://example.invalid/quota', percent: 'old', json: { percent: 'current' },
    windows: [{ key: 'weekly', label: '周', percent: 'week' }],
  } }
  const before = structuredClone(model)
  h.respond({ old: 90, current: 7, week: 18 })
  const result = await h.context.fetchModelQuota(model)
  assert.equal(result.usedPct, 7)
  assert.equal(result.windows[0].usedPct, 18)
  assert.deepEqual(model, before)
  assert.equal(h.writes.length, 0)
})

test('quota window selection ignores array order and unknown numbers stay unknown', async () => {
  const h = host()
  h.respond({ data: { limits: [
    { type: 'TIME_LIMIT', unit: 5, percentage: 99 },
    { type: 'CREDIT_LIMIT', unit: 6, percentage: 31 },
    { type: 'TOKENS_LIMIT', unit: 3, percentage: 10 },
  ] } })
  const result = await h.context.fetchModelQuota({ provider: 'zhipu_glm_coding' })
  assert.deepEqual(plain(result.windows).map(w => w.usedPct), [10, 31])
  for (const value of [null, undefined, '', '  ', false, true, [], {}, 'NaN']) {
    h.respond({ data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, percentage: value, nextResetTime: 1791200000000 }] } })
    const result = await h.context.fetchModelQuota({ provider: 'zhipu_glm_coding' })
    assert.equal(result.usedPct, null)
    assert.equal(result.windows[0].usedPct, null)
  }
  h.respond({ data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, percentage: 0 }] } })
  assert.equal((await h.context.fetchModelQuota({ provider: 'zhipu_glm_coding' })).usedPct, 0)
  h.respond({ used: null })
  const unknown = await h.context.fetchModelQuota({ provider: 'custom', allowCustomHost: true,
    quota: { url: 'https://example.invalid/quota', json: { percent: 'used' } } })
  assert.equal(unknown.code, 'PARSE')
})

test('quota override can be cleared and explicit empty matchIds restores template defaults', async () => {
  const h = host(), c = h.context
  await c.apiSaveModel({ id: 'model', provider: 'dashscope', quota: { json: { percent: 'used' } }, matchIds: ['special'] })
  await c.apiSaveModel({ id: 'model', provider: 'dashscope', quota: null, matchIds: [] })
  const model = h.registry().models[0]
  assert.equal(model.quota, undefined)
  assert.equal(model.matchIds, undefined)
  assert.deepEqual(config.modelMatchIds(model, c.apiTemplateOf(model.provider)), ['qwen', 'qwq', 'qvq'])
})

test('JSON placeholders escape values, preserve types and never recursively expand inserted values', () => {
  const body = { uuid: '{uuid}', nested: ['{key}', false, 3, null], literal: '{value}', combined: 'base={base}' }
  const value = 'a"b\\c\n\t中文'
  assert.deepEqual(JSON.parse(config.bodyWithPlaceholders(body, 'FAKE"KEY', 'https://example.invalid', { uuid: value, value: '{key}' })), {
    uuid: value, nested: ['FAKE"KEY', false, 3, null], literal: '{key}', combined: 'base=https://example.invalid',
  })
  assert.throws(() => config.bodyWithPlaceholders('{"uuid":"{absent}"}', 'SECRET', '', {}), /缺少参数: absent/)
  assert.throws(() => config.jsonBodyTemplate('{"uuid":{uuid}}'), /有效 JSON/)
  assert.throws(() => config.jsonBodyTemplate(JSON.stringify('x'.repeat(4000))), /4000/)
})

test('invalid request templates are rejected before writes or fetch; valid bodies survive save/fetch', async () => {
  const h = host(), c = h.context
  for (const body of ['{broken', '{"uuid":"{missing}"}']) {
    const result = await c.apiSaveModel({ id: 'bad', provider: 'custom', keyValue: 'FAKE', balance: { method: 'POST', body } })
    assert.equal(result.ok, false)
  }
  assert.equal(h.writes.length, 0)
  assert.equal(h.credentialWrites.length, 0)
  assert.equal(h.requests.length, 0)
  await assert.rejects(() => c.apiFetchJson('https://example.invalid', '', 'FAKE', { method: 'POST', body: '{broken' }), /有效 JSON/)
  assert.equal(h.requests.length, 0)
  assert.equal((await c.apiSaveModel({ id: 'ok', provider: 'custom', params: { uuid: 'a"b\\c' }, balance: { method: 'POST', body: '{"uuid":"{uuid}"}' } })).ok, true)
  const model = h.registry().models[0]
  await c.apiFetchJson('https://example.invalid', 'Bearer {key}', 'FAKE', { ...model.balance, params: model.params })
  assert.deepEqual(JSON.parse(h.requests[0].body), { uuid: 'a"b\\c' })
  assert.equal(h.requests[0].headers['Content-Type'], 'application/json')
  await c.apiFetchJson('https://example.invalid', '', 'FAKE')
  assert.equal(h.requests[1].body, undefined)
  assert.equal(h.requests[1].method, undefined)
})

test('saved matchIds and template fallbacks feed the real event and custom-price paths', async () => {
  const h = host(), c = h.context
  await c.apiSaveModel({ id: 'api_test', provider: 'dashscope', name: '阿里百炼', matchIds: [' qwen ', 'qwen', null], price: { hit: 1, miss: 2, out: 3 } })
  assert.deepEqual(h.registry().models[0].matchIds, ['qwen'])
  assert.equal(c.apiAttributeEvent('qwen3.8-flash', 0.1, 1000), true)
  c.refreshCustomPrices()
  assert.equal(c.CUSTOM_PRICES.qwen.out[0], 3)
  await c.apiSaveModel({ id: 'api_test', provider: 'dashscope', name: '阿里百炼', matchIds: [] })
  assert.equal(c.apiAttributeEvent('qwq-test', 0.1, 1000), true)
  c.refreshCustomPrices()
  assert.equal(c.CUSTOM_PRICES.qwq.out[0], 3)
  await c.apiSaveModel({ id: 'api_test', provider: 'dashscope', name: '阿里百炼', matchIds: ['override'] })
  assert.equal(c.apiAttributeEvent('qwen3.8-flash', 0.1, 1000), false)
  assert.equal(c.apiAttributeEvent('override-model', 0.1, 1000), true)
})

test('custom quota requests still require destination consent before fetching', async () => {
  const h = host()
  const result = await h.context.fetchModelQuota({ provider: 'custom', quota: {
    url: 'https://example.invalid/quota', method: 'POST', body: '{"key":"{key}"}', json: { percent: 'used' },
  } })
  assert.equal(result.code, 'DEST_NOT_ALLOWED')
  assert.equal(h.requests.length, 0)
})
