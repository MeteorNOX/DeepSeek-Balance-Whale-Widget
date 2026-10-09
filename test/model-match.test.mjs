// 归属规则：把「本会话在用的 provider/model」认到注册表里具体哪本账上。
// 规则次序见 lib/model-match.js —— 服务商同名 → 服务商分段 → 模型名精确 → 子串。
import assert from 'node:assert/strict'
import { matchWhaleModel, normMatchName, matchProviderTokens } from '../lib/model-match.js'

let fails = 0
function t(name, fn) {
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (err) {
    fails++
    console.error('  FAIL ' + name + '：' + (err && err.message))
  }
}

// 注册表的形状：内置 DeepSeek + 用户自建的阿里 Token Plan（provider/matchIds 与真实配置同形）
const MODELS = [
  { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', matchIds: ['deepseek'] },
  {
    id: 'api_tokenplan', name: '阿里 Token Plan', provider: 'tokenplan',
    matchIds: ['qwen3.8-flash', 'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash', 'qwen3.6-plus'],
  },
]
const MODELS_DS = MODELS.concat([{ id: 'api_ds', name: '百炼按量', provider: 'dashscope', matchIds: ['qwen-plus'] }])

// 语料：真实出现过的 provider/model（前三条是「跟着换账」的主角）
const CORPUS = [
  ['tokenplan', 'qwen3.8-flash', 'api_tokenplan'],
  ['deepseek-official', 'deepseek-v4-flash', 'deepseek'],
  ['deepseek', 'deepseek-chat', 'deepseek'],
  ['tokenplan', 'qwen3.8-max-0902', 'api_tokenplan'],
  ['tokenplan', 'qwen3.7-max-2026-05-17', 'api_tokenplan'],
  ['bailian', 'qwen3.8-max', 'api_tokenplan'],
  ['openrouter', 'z-ai/glm-5.2', ''],
  ['llm-pi-ai', 'anthropic/claude-sonnet-5', ''],
  ['moonshot-intl', 'kimi-k2.6', ''],
]

t('每条真实读数认到预期的那本账', () => {
  for (const [provider, model, want] of CORPUS) {
    const r = matchWhaleModel(MODELS, { provider, model })
    assert.equal(r ? r.id : '', want, provider + '/' + model + ' 应认成 ' + (want || '(空)') + '，实为 ' + JSON.stringify(r))
  }
})

t('服务商同名优先于模型名子串（dashscope 在场时按量那条不被套餐抢走）', () => {
  const r = matchWhaleModel(MODELS_DS, { provider: 'dashscope', model: 'qwen-plus' })
  assert.equal(r.id, 'api_ds')
  const r2 = matchWhaleModel(MODELS_DS, { provider: 'bailian', model: 'qwen3.8-max' })
  assert.equal(r2.id, 'api_tokenplan', '模型名精确命中 matchIds 要压过更短的子串命中')
})

t('没有任何输入时返回 null，认不出账时 id 留空', () => {
  assert.equal(matchWhaleModel(MODELS, null), null)
  assert.equal(matchWhaleModel(MODELS, {}), null)
  assert.equal(matchWhaleModel(MODELS, { provider: '   ', model: '' }), null)
  assert.equal(matchWhaleModel([], { provider: 'tokenplan', model: 'qwen3.8-flash' }).id, '')
})

t('大小写、下划线、空白与带斜杠的模型名都不影响认账', () => {
  assert.equal(matchWhaleModel(MODELS, { provider: 'TokenPlan', model: ' QWEN3.8-FLASH ' }).id, 'api_tokenplan')
  assert.equal(matchWhaleModel(MODELS, { provider: 'deepseek_official', model: 'deepseek-v4-pro' }).id, 'deepseek')
})

t('过短的 matchId 不参与子串匹配（防两个字母的 id 把谁都认成自己）', () => {
  const tables = [{ id: 'x', provider: 'xai', matchIds: ['ai'] }].concat(MODELS)
  assert.equal(matchWhaleModel(tables, { provider: 'whatever', model: 'qwen3.8-flash' }).id, 'api_tokenplan')
})

t('归宿字段原样回传：认不出账也把 provider/model 带出来（调用方要靠它显示「没认到」）', () => {
  const r = matchWhaleModel(MODELS, { provider: 'openrouter', model: 'z-ai/glm-5.2' })
  assert.equal(r.provider, 'openrouter')
  assert.equal(r.model, 'z-ai/glm-5.2')
  assert.equal(r.id, '')
})

t('归一化与分词只服务匹配，不改动被匹配的值', () => {
  assert.equal(normMatchName(' DeepSeek_Official '), 'deepseek-official', '去空白 + 转小写 + 下划线折成连字符')
  assert.equal(normMatchName('TokenPlan'), 'tokenplan')
  assert.ok(matchProviderTokens('tokenplan').indexOf('tokenplan') >= 0)
  assert.equal(normMatchName(null), '')
})

console.log(fails ? '\n' + fails + ' 项不通过' : '\n全绿：归属规则 7 组')
process.exitCode = fails ? 1 : 0
