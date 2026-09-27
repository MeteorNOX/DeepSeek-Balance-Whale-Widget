// 会话在用的模型（provider + model）→ 挂件注册表里的那一条账户（deepseek / api_tokenplan / …）
//
// 浏览器侧另有一份同规则的镜像实现（挂件客户端是独立 script，import 不到这个包，只能各写一份）。
// 本文件是服务端那一份；test/model-match.test.mjs 用真实出现过的 provider/model 语料钉住规则，
// 改规则时那边要同改 —— 两份实现的行为必须一致，否则同一句话在服务端与前端会认到两本账。
//
// 次序（越前越强）：
//   ① 服务商同名               provider 与注册表 provider 规范化后相等
//   ② 服务商分段同名           deepseek-official / moonshot_intl → deepseek / moonshot
//   ③ 模型名精确命中 matchIds  tokenplan 那条里就写着 qwen3.8-flash
//   ④ 模型名互为子串（取最长） 带日期的快照名 qwen3.7-max-2026-05-17 命中 qwen3.7-max
// 全都没命中：id 留空。前端把空 id 当「认不出这本账」，宁可两家都显示，也绝不把泡泡弄哑。

export function normMatchName(value) {
  const s = value === null || value === undefined ? '' : String(value)
  return s.trim().toLowerCase().replace(/_/g, '-')
}

export function matchProviderTokens(value) {
  const parts = normMatchName(value).split('-')
  const out = []
  for (const p of parts) if (p.length > 1) out.push(p)
  return out
}

function candidateIds(model) {
  const out = []
  const ids = Array.isArray(model.matchIds) ? model.matchIds : []
  for (const x of ids) { const n = normMatchName(x); if (n && out.indexOf(n) < 0) out.push(n) }
  const self = normMatchName(model.id)
  if (self && out.indexOf(self) < 0) out.push(self)
  return out
}

/**
 * @param models - 挂件注册表（apiAllModels() 或下发给前端的 models 数组）
 * @param sel - { provider, model }，来自会话投影 modelSelection 或 settings.yaml 的默认模型
 * @returns { provider, model, id } —— 没有可判定的输入时返回 null，判不出账户时 id 为空串
 */
export function matchWhaleModel(models, sel) {
  const list = (Array.isArray(models) ? models : []).filter((m) => m && typeof m === 'object')
  const src = sel && typeof sel === 'object' ? sel : null
  if (!src) return null
  const rawProvider = src.provider === null || src.provider === undefined ? '' : String(src.provider)
  const rawModel = src.model === null || src.model === undefined ? '' : String(src.model)
  const prov = normMatchName(rawProvider)
  const want = normMatchName(rawModel)
  if (!prov && !want) return null
  const hit = (m) => ({ provider: rawProvider, model: rawModel, id: String(m.id === undefined || m.id === null ? '' : m.id) })

  for (const m of list) { const p = normMatchName(m.provider); if (p && p === prov) return hit(m) }

  const toks = matchProviderTokens(prov)
  for (const m of list) { const p = normMatchName(m.provider); if (p && toks.indexOf(p) >= 0) return hit(m) }
  const pTokens = matchProviderTokens(prov)
  for (const m of list) {
    const mt = matchProviderTokens(m.provider)
    let shared = false
    for (const t of mt) if (pTokens.indexOf(t) >= 0) { shared = true; break }
    if (shared) return hit(m)
  }

  if (want) {
    for (const m of list) if (candidateIds(m).indexOf(want) >= 0) return hit(m)
    let best = null
    let bestLen = 0
    for (const m of list) {
      const ids = candidateIds(m)
      for (const id of ids) {
        if (id.length < 4) continue
        const nested = want.indexOf(id) >= 0 || (id.indexOf(want) >= 0 && want.length >= 4)
        if (nested && id.length > bestLen) { best = m; bestLen = id.length }
      }
    }
    if (best) return hit(best)
  }

  return { provider: rawProvider, model: rawModel, id: '' }
}
