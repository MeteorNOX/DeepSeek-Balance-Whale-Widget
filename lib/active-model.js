// 归属：本会话到底在用哪个 provider/model —— 服务端能看到的两个来源，按可信度排
//
//   ① 宿主事件 `session/event` 的 `request/context` / `model/selection`（会话级：
//      这一步实际请求的是谁）。这是最准的一手读数 —— 会话里换过模型它也跟得上。
//   ② `settings.yaml` 的 `agent-default-model`（全局兜底：新会话还没发过请求时用）。
//
// 为什么要它：一家提供方在注册表里往往只有一条账（例如订阅套餐），而它会报出十几个
// 模型名。只有把「本会话实际在用的那个模型」认到具体哪本账上，用量与额度才不会记到
// 隔壁家去。认账规则见 lib/model-match.js（服务商同名 → 服务商分段 → 模型名精确 → 子串）。
import { matchWhaleModel } from './model-match.js'

// `settings.yaml` 里 `agent-default-model:` 那一段的解析：只认这一段里的 provider / model 两行。
// 不引 YAML 依赖（为两行字拉一个包不值），所以规则写死在这一个纯函数里，方便直接拿文本测。
export function parseAgentDefaultModel(text) {
  const raw = text === null || text === undefined ? '' : String(text)
  if (!raw) return null
  const KEY = 'agent-default-model:'
  const LINE = /^\s{2,}(provider|model):\s*(.+)$/
  const TOP = /^\S/
  const SQ = String.fromCharCode(39)
  const DQ = String.fromCharCode(34)
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== KEY) continue
    const out = { provider: '', model: '' }
    for (let k = i + 1; k < lines.length && k < i + 8; k++) {
      const mm = LINE.exec(lines[k])
      if (!mm) {
        if (TOP.test(lines[k])) break // 撞到下一个顶层键就收工，别把别人的 provider/model 读成自己的
        continue
      }
      let v = mm[2].trim()
      const q = v[0]
      if (v.length > 1 && (q === SQ || q === DQ) && v[v.length - 1] === q) v = v.slice(1, -1)
      out[mm[1]] = v
    }
    return out.model || out.provider ? out : null
  }
  return null
}

export const FROM_SESSION = 'session'
export const FROM_DEFAULT = 'default'

// 只记这两种事件：前者是「这一步要请求谁」，后者是会话里显式换了模型。
const SEEN_EVENTS = ['request/context', 'model/selection']

/**
 * 会话级读数表。按会话 id 分桶；读不到就什么都不做（不覆盖已有读数）。
 * @param {{max?: number}} [options] max：最多记多少个会话（默认 500，按最久未更新淘汰）
 */
export function createActiveModelTracker(options) {
  const opts = options && typeof options === 'object' ? options : {}
  const max = Number.isFinite(opts.max) && opts.max > 0 ? Math.floor(opts.max) : 500
  const byId = new Map()

  // 事件载荷里认 provider/model；两者都空就当没读到（别用空值盖掉上一次的真读数）
  function pick(data) {
    if (!data || typeof data !== 'object') return null
    const provider = typeof data.provider === 'string' ? data.provider.trim() : ''
    const model = typeof data.model === 'string' ? data.model.trim() : ''
    return provider || model ? { provider, model } : null
  }

  const api = {
    /** 记下一条事件读数；返回是否真的记了 */
    note(sessionId, event) {
      const id = String(sessionId || '')
      if (!id || !event || typeof event !== 'object') return false
      if (SEEN_EVENTS.indexOf(String(event.type || '')) < 0) return false
      const sel = pick(event.data)
      if (!sel) return false
      if (byId.has(id)) byId.delete(id) // 重新插到队尾：淘汰时先丢最久没更新的
      byId.set(id, { provider: sel.provider, model: sel.model, at: Date.now() })
      while (byId.size > max) byId.delete(byId.keys().next().value)
      return true
    },
    /** 会话销毁时清掉，避免长跑堆积 */
    forget(sessionId) {
      return byId.delete(String(sessionId || ''))
    },
    /** 原始读数（没记过就是 null），调用方要看它判断「是会话级还是兜底」 */
    peek(sessionId) {
      const v = byId.get(String(sessionId || ''))
      return v ? { provider: v.provider, model: v.model, at: v.at } : null
    },
    /**
     * 解析成本会话认下的那本账。
     * @param models 注册表（apiAllModels() 那种形状）
     * @param sessionId 会话 id
     * @param readDefault 兜底读数函数，返回 {provider, model} 或 null
     * @returns {provider, model, id, from, matched} 或 null（两个来源都没有读数）
     */
    resolve(models, sessionId, readDefault) {
      const own = api.peek(sessionId)
      let sel = own
      let from = FROM_SESSION
      if (!sel) {
        const d = typeof readDefault === 'function' ? readDefault() : null
        if (d && (d.provider || d.model)) {
          sel = { provider: String(d.provider || ''), model: String(d.model || '') }
          from = FROM_DEFAULT
        }
      }
      if (!sel) return null
      const hit = matchWhaleModel(Array.isArray(models) ? models : [], sel)
      return {
        provider: sel.provider || '',
        model: sel.model || '',
        id: hit && hit.id ? String(hit.id) : '',
        from,
        matched: !!(hit && hit.id),
      }
    },
    size() { return byId.size },
  }
  return api
}
