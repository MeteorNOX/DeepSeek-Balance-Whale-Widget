// 归属表 + settings.yaml 那一段的解析
import assert from 'node:assert/strict'
import { createActiveModelTracker, parseAgentDefaultModel, FROM_SESSION, FROM_DEFAULT } from '../lib/active-model.js'

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

const MODELS = [
  { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', matchIds: ['deepseek'] },
  { id: 'api_tokenplan', name: '阿里 Token Plan', provider: 'tokenplan', matchIds: ['qwen3.8-flash', 'qwen3.8-max'] },
]
const DEFAULT = { provider: 'deepseek', model: 'deepseek-chat' }
const ev = (type, data) => ({ type, data })

t('会话级读数压过全局默认（同一句里 provider 也不同，不能认错账）', () => {
  const tr = createActiveModelTracker()
  tr.note('s1', ev('request/context', { provider: 'tokenplan', model: 'qwen3.8-flash' }))
  const r = tr.resolve(MODELS, 's1', () => DEFAULT)
  assert.equal(r.id, 'api_tokenplan')
  assert.equal(r.from, FROM_SESSION)
  assert.equal(r.matched, true)
})

t('会话里换过模型就跟得上：后一条读数覆盖前一条', () => {
  const tr = createActiveModelTracker()
  tr.note('s1', ev('request/context', { provider: 'tokenplan', model: 'qwen3.8-flash' }))
  tr.note('s1', ev('model/selection', { provider: 'deepseek', model: 'deepseek-v4-pro' }))
  assert.equal(tr.resolve(MODELS, 's1', () => DEFAULT).id, 'deepseek')
})

t('没记过的会话落回全局默认，并如实标注来源', () => {
  const tr = createActiveModelTracker()
  const r = tr.resolve(MODELS, 'never-seen', () => DEFAULT)
  assert.equal(r.id, 'deepseek')
  assert.equal(r.from, FROM_DEFAULT)
})

t('两个来源都没有读数时返回 null（调用方据此显示「认不出」而不是编一本账）', () => {
  const tr = createActiveModelTracker()
  assert.equal(tr.resolve(MODELS, 's1', () => null), null)
  assert.equal(tr.resolve(MODELS, 's1', () => ({ provider: '', model: '' })), null)
  assert.equal(tr.resolve(MODELS, '', () => null), null)
})

t('认不出账：id 留空、matched=false，但原始 provider/model 要带出来', () => {
  const tr = createActiveModelTracker()
  tr.note('s1', ev('request/context', { provider: 'openrouter', model: 'z-ai/glm-5.2' }))
  const r = tr.resolve(MODELS, 's1', () => DEFAULT)
  assert.equal(r.id, '')
  assert.equal(r.matched, false)
  assert.equal(r.provider, 'openrouter')
  assert.equal(r.model, 'z-ai/glm-5.2')
})

t('只认那两种事件；空读数和别的事件都不许覆盖已有读数', () => {
  const tr = createActiveModelTracker()
  assert.equal(tr.note('s1', ev('request/context', { provider: 'tokenplan', model: 'qwen3.8-flash' })), true)
  assert.equal(tr.note('s1', ev('assistant/message', { provider: 'deepseek', model: 'deepseek-chat' })), false)
  assert.equal(tr.note('s1', ev('request/context', {})), false)
  assert.equal(tr.note('s1', ev('request/context', { provider: '   ', model: '' })), false)
  assert.equal(tr.note('', ev('request/context', { provider: 'deepseek', model: 'deepseek-chat' })), false)
  assert.equal(tr.resolve(MODELS, 's1', () => DEFAULT).id, 'api_tokenplan', '被空读数盖掉了')
})

t('会话销毁即忘记；超过上限按最久未更新淘汰', () => {
  const tr = createActiveModelTracker({ max: 2 })
  tr.note('a', ev('request/context', { provider: 'tokenplan', model: 'qwen3.8-flash' }))
  tr.note('b', ev('request/context', { provider: 'deepseek', model: 'deepseek-chat' }))
  tr.note('a', ev('request/context', { provider: 'tokenplan', model: 'qwen3.8-max' })) // a 变成最新
  tr.note('c', ev('request/context', { provider: 'deepseek', model: 'deepseek-v4-pro' }))
  assert.equal(tr.size(), 2)
  assert.equal(tr.peek('b'), null, '最久没更新的那个应被淘汰')
  assert.ok(tr.peek('a') && tr.peek('c'))
  assert.equal(tr.forget('a'), true)
  assert.equal(tr.peek('a'), null)
  assert.equal(tr.forget('a'), false)
})

t('settings.yaml：读到 agent-default-model 那两行（含引号与缩进）', () => {
  const text = [
    'llm:',
    '  agent-default-model:',
    "    provider: 'tokenplan'",
    '    model: "qwen3.8-flash"',
    '  other: 1',
  ].join('\n')
  assert.deepEqual(parseAgentDefaultModel(text), { provider: 'tokenplan', model: 'qwen3.8-flash' })
})

t('settings.yaml：撞到下一个顶层键就收工，不把别人的 provider/model 读成自己的', () => {
  const text = [
    'llm:',
    '  agent-default-model:',
    '    provider: deepseek',
    'other-top:',
    '  provider: someone-else',
    '  model: not-mine',
  ].join('\n')
  assert.deepEqual(parseAgentDefaultModel(text), { provider: 'deepseek', model: '' })
})

t('settings.yaml：没有这一段 / 空文本 / 该段为空都返回 null（调用方据此显示「没认到」）', () => {
  assert.equal(parseAgentDefaultModel('llm:\n  other: 1\n'), null)
  assert.equal(parseAgentDefaultModel(''), null)
  assert.equal(parseAgentDefaultModel(null), null)
  assert.equal(parseAgentDefaultModel('agent-default-model:\n  note: 没有 provider 也没有 model\n'), null)
})

t('settings.yaml：只给 model 也要认（provider 可能写在同一家族下）', () => {
  assert.deepEqual(parseAgentDefaultModel('agent-default-model:\n  model: qwen3.8-max\n'), { provider: '', model: 'qwen3.8-max' })
})

console.log(fails ? '\n' + fails + ' 项不通过' : '\n全绿：归属表 11 组')
process.exitCode = fails ? 1 : 0
