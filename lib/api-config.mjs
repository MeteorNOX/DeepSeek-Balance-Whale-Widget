// Pure configuration helpers shared by saving, fetching and event matching.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const quotaPaths = ['percent', 'remainPct', 'weeklyRemainPct', 'remain', 'total', 'resetAt', 'resetAtMs', 'level']

export function quotaNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function jsonBodyTemplate(body) {
  if (body === undefined || body === null || body === '') return ''
  const text = typeof body === 'string' ? body.trim() : JSON.stringify(body)
  if (!text) return ''
  if (text.length > 4000) throw new Error('请求体不能超过 4000 个字符')
  try { JSON.parse(text) } catch { throw new Error('请求体必须是有效 JSON，占位符请放在字符串中（例如 {"uuid":"{uuid}"}）') }
  return text
}

export function bodyWithPlaceholders(body, key, base, params) {
  const text = jsonBodyTemplate(body)
  if (!text) return ''
  // Replace once in JSON string values. Credentials/parameters never become JSON syntax,
  // and inserted values containing another placeholder are not expanded a second time.
  const values = Object.create(null)
  for (const [name, value] of Object.entries(object(params) ? params : {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(name) && ['string', 'number', 'boolean'].includes(typeof value)) values[name] = String(value)
  }
  values.key = String(key ?? '')
  values.base = String(base ?? '')
  const visit = (value, depth = 0) => {
    if (depth > 64) throw new Error('请求体的 JSON 嵌套不能超过 64 层')
    if (typeof value === 'string') return value.replace(/\{([A-Za-z_][A-Za-z0-9_]{0,30})\}/g, (_, name) => {
      if (!own(values, name)) throw new Error('请求体缺少参数: ' + name)
      return values[name]
    })
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1))
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, depth + 1)]))
    return value
  }
  return JSON.stringify(visit(JSON.parse(text)))
}

function quotaPick(pick) {
  if (!object(pick) || !pick.list) return undefined
  const out = { list: String(pick.list).slice(0, 200) }
  if (pick.type) out.type = String(pick.type).slice(0, 40)
  if (Array.isArray(pick.types)) out.types = pick.types.slice(0, 4).map(value => String(value).slice(0, 40))
  for (const key of ['unit', 'number']) {
    const value = quotaNumber(pick[key])
    if (value !== null) out[key] = value
  }
  return out
}

export function normalizeQuotaConfig(value) {
  if (!object(value)) return {}
  const out = {}, json = {}
  if (value.url) out.url = String(value.url).slice(0, 500)
  if (value.auth !== undefined) out.auth = String(value.auth || '').slice(0, 200)
  if (value.method) out.method = String(value.method).trim().toUpperCase().slice(0, 8)
  if (value.body !== undefined) out.body = jsonBodyTemplate(value.body)
  // 0.3.18 saved fields at quota.percent/windows instead of quota.json.*.
  // Read that shape without rewriting user files; an explicit json field wins.
  const fields = { ...value, ...(object(value.json) ? value.json : {}) }
  for (const key of quotaPaths) if (fields[key]) json[key] = String(fields[key]).slice(0, 200)
  const pick = quotaPick(fields.pick)
  if (pick) json.pick = pick
  if (Array.isArray(fields.windows)) json.windows = fields.windows.slice(0, 6).map(window => {
    const item = object(window) ? window : {}
    const out = { key: String(item.key || '').slice(0, 20), label: String(item.label || '').slice(0, 20) }
    for (const key of ['percent', 'resetAt']) if (item[key]) out[key] = String(item[key]).slice(0, 200)
    const pick = quotaPick(item.pick)
    if (pick) out.pick = pick
    return out
  })
  if (Object.keys(json).length) out.json = json
  return out
}

export function normalizeMatchIds(values) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.filter(value => typeof value === 'string')
    .map(value => value.trim().slice(0, 100)).filter(Boolean))].slice(0, 20)
}

export function modelMatchIds(model, template) {
  const custom = normalizeMatchIds(model && model.matchIds)
  if (custom.length) return custom
  const defaults = normalizeMatchIds(template && template.matchIds)
  return defaults.length ? defaults : normalizeMatchIds([model && model.name, model && model.id])
}
