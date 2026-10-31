// 今日 Token（全渠道）汇总：泡泡「今日 Token」模块的数据源。
//
// 口径（"所有渠道"）：
//   · dsh      —— DSH 会话里跑过的**全部模型**：直接读用量账本 today 的 events（成本已是人民币口径，
//                 由 accounting.mjs 的峰谷/缓存价算出；未知模型按 Flash 价兜底 ⇒ 标注 costEstimated）
//   · codex    —— ~/.codex/sessions 的当日聚合（这是挂件自己的扫描，**不受**"是否添加 Codex 模型"那个
//                 开关影响 —— 这一块统计的是"本机所有渠道"，不是"我在挂件里配了哪些模型"）
//   · opencode —— 读本地 opencode CLI 的 SQLite 会话库（只读）
//   · claude   —— 读 Claude Code 的会话 JSONL（只读）
//
// 全部是**本地只读**扫描：不发任何外部网络请求，不碰凭据。
// 结果缓存 20 秒：模块会被 60 秒余额轮询 + 每次显示泡泡各取一次，不能每次都重算。
//
// 依赖由宿主注入（见 index.js 里的 createTokenStats 调用）：todayKey / readUsageLedger / addMoney /
// readSizeConfig / codexHome / version。拆到单独文件里是因为 CONTRIBUTING 要求别再往 index.js
// 那个大单文件里堆 —— 这一段是纯取数逻辑，没有任何 ctx / 路由依赖，抽出来不需要改一行调用方。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import readline from 'node:readline'
import { execFile } from 'node:child_process'

export function createTokenStats(deps) {
  const { todayKey, readUsageLedger, addMoney, readSizeConfig, codexHome, version } = deps || {}
  if (typeof todayKey !== 'function' || typeof readUsageLedger !== 'function' || typeof addMoney !== 'function') {
    throw new TypeError('createTokenStats 需要宿主注入 todayKey / readUsageLedger / addMoney')
  }

  const TOKEN_STATS_TTL = 20000
  let tokenStatsCache = null
  let tokenStatsAt = 0
  let tokenStatsP = null
  function dshTodayTokenChannel() {
    const led = readUsageLedger()
    const events = Array.isArray(led.events) ? led.events : []
    const day = todayKey()
    let tokens = 0
    let cost = 0
    const byModel = new Map()
    for (const e of events) {
      if (!e || e.day !== day) continue
      const t = Number(e.tokens) || 0
      const c = Number(e.cost) || 0
      tokens += t
      cost = addMoney(cost, c)
      const name = String(e.model || '未知')
      const cur = byModel.get(name) || { model: name, tokens: 0, cost: 0 }
      cur.tokens += t
      cur.cost = addMoney(cur.cost, c)
      byModel.set(name, cur)
    }
    return {
      key: 'dsh', name: 'DSH 会话', ok: true,
      tokens, cost, currency: 'CNY', costEstimated: true,
      byModel: Array.from(byModel.values()).sort((a, b) => b.tokens - a.tokens),
    }
  }
  // ===== Codex（~/.codex/sessions/**/rollout-*.jsonl[.zst]）=====
  // 口径（由 probe/codex-usage.mjs 勘察、已用 282 个真实文件验证）：
  //   · 时间：每条记录自带 timestamp（ISO8601 UTC 毫秒），按 +08:00 切自然日
  //   · token：payload.info.total_token_usage 是**单调累计量**，必须做差；
  //     直接累加 last_token_usage 会重复计（同一事件被落盘 2 次，实测多算 1.7%~62%）
  //   · 首条 / 计数回退：只取该条 last_token_usage（新文件会继承父会话累计量，最大 5828 万 token）
  //   · total = input + output；cachedInput ⊂ input、reasoning ⊂ output（是「其中」不是并列，不能相加）
  //   · 文件全是 zstd 压缩（.jsonl.zst），用 Node 内置 zlib 解
  async function walkFiles(roots, re, minMtimeMs) {
    const out = []
    const stack = roots.slice()
    while (stack.length) {
      const dir = stack.pop()
      let entries = []
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (err) { continue }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { stack.push(p); continue }
        if (!e.isFile() || !re.test(e.name)) continue
        try {
          const st = await fs.promises.stat(p)
          if (!minMtimeMs || st.mtimeMs >= minMtimeMs) out.push({ path: p, mtimeMs: st.mtimeMs })
        } catch (err) {}
      }
    }
    return out
  }
  async function* readLinesOf(file) {
    const raw = fs.createReadStream(file, { highWaterMark: 1 << 20 })
    const stream = file.endsWith('.zst') ? raw.pipe(zlib.createZstdDecompress()) : raw
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) yield line
  }
  function codexChannelFromSnap(snap) {
    if (!snap || !snap.ok) {
      return { key: 'codex', name: 'Codex', ok: false, error: (snap && snap.error) || '扫描失败', tokens: 0, byModel: [] }
    }
    return {
      key: 'codex', name: 'Codex', ok: true,
      tokens: Number(snap.tokens) || 0,
      byModel: snap.byModel || [],
      cost: null, currency: '', costEstimated: false,
      records: Number(snap.records) || 0,
      files: Number(snap.files) || 0,
      lastActivity: snap.lastActivity || null,
    }
  }
  let codexTokenSnap = null
  let codexTokenAt = 0
  let codexTokenP = null
  async function codexScanToday() {
    const home = codexHome()
    if (!home) return { ok: false, skipped: true, error: '未找到 Codex 目录', tokens: 0, byModel: [] }
    const day = todayKey()
    const range = beijingDayRange(day)
    const files = await walkFiles(
      [path.join(home, 'sessions'), path.join(home, 'archived_sessions')],
      /^rollout-.*\.jsonl(\.zst)?$/,
      range[0]
    )
    let tokens = 0
    let records = 0
    let lastActivity = 0
    const byModel = new Map()
    for (const f of files) {
      let model = null
      let prev = null
      try {
        for await (const line of readLinesOf(f.path)) {
          if (!line) continue
          const hasToken = line.includes('"token_count"')
          const hasTurn = line.includes('"turn_context"')
          if (!hasToken && !hasTurn) continue
          let o = null
          try { o = JSON.parse(line) } catch (err) { continue }
          if (!o) continue
          if (hasTurn && o.type === 'turn_context' && o.payload && typeof o.payload.model === 'string') {
            model = o.payload.model
            continue
          }
          if (!hasToken || !o.payload || o.payload.type !== 'token_count') continue
          const info = o.payload.info || {}
          const t = info.total_token_usage
          const l = info.last_token_usage
          const lastTotal = l ? (Number(l.total_tokens) || (Number(l.input_tokens) || 0) + (Number(l.output_tokens) || 0)) : 0
          let delta = 0
          if (t) {
            const cur = {
              input: Number(t.input_tokens) || 0,
              output: Number(t.output_tokens) || 0,
              total: Number(t.total_tokens) || (Number(t.input_tokens) || 0) + (Number(t.output_tokens) || 0),
            }
            // 单调递增 → 取差值（重复落盘天然得 0）；首条 / 回退 → 只取本条 last
            if (prev && cur.input >= prev.input && cur.output >= prev.output) delta = Math.max(0, cur.total - prev.total)
            else delta = lastTotal
            prev = cur
          } else delta = lastTotal
          const ts = Date.parse(o.timestamp || '')
          if (!isFinite(ts)) continue
          if (ts > lastActivity) lastActivity = ts
          if (!(ts >= range[0] && ts < range[1]) || !delta) continue
          records++
          tokens += delta
          const key = model || 'unknown'
          const bucket = byModel.get(key) || { model: key, tokens: 0, records: 0 }
          bucket.tokens += delta
          bucket.records++
          byModel.set(key, bucket)
        }
      } catch (err) { continue }
    }
    return {
      ok: true, tokens, records, files: files.length, lastActivity: lastActivity || null,
      byModel: Array.from(byModel.values()).sort((a, b) => b.tokens - a.tokens),
    }
  }
  async function codexTodayTokenChannel() {
    const now = Date.now()
    if (codexTokenSnap && codexTokenSnap.ok && codexTokenSnap.day === todayKey() && now - codexTokenAt < 60000) {
      return codexChannelFromSnap(codexTokenSnap)
    }
    if (!codexTokenP) {
      codexTokenP = codexScanToday()
        .then((snap) => { codexTokenSnap = Object.assign({ day: todayKey() }, snap); codexTokenAt = Date.now(); return codexTokenSnap })
        .catch((err) => {
          codexTokenSnap = { ok: false, day: todayKey(), error: String((err && err.message) || err) }
          codexTokenAt = Date.now()
          return codexTokenSnap
        })
        .finally(() => { codexTokenP = null })
    }
    // 冷启动要解压几十个文件（~3s）：最多等 4 秒，超时先给空态，下一轮就有缓存
    const snap = await Promise.race([codexTokenP, new Promise((r) => setTimeout(() => r(null), 4000))])
    if (!snap) {
      if (codexTokenSnap && codexTokenSnap.ok) return codexChannelFromSnap(codexTokenSnap)
      return { key: 'codex', name: 'Codex', ok: false, pending: true, tokens: 0, byModel: [] }
    }
    return codexChannelFromSnap(snap)
  }
  // 汇率：设置里没配就按 7.1（模块标题里写明"估算"）
  function tokenUsdRate() {
    try {
      const cfg = readSizeConfig() || {}
      const r = Number(cfg.usdRate)
      if (isFinite(r) && r > 0.5 && r < 20) return r
    } catch (err) {}
    return 7.1
  }
  // ===== opencode（本地 opencode CLI 的会话库）=====
  // 由 probe/opencode-usage.mjs 勘察得出（见 whale-quota-ui/probe/opencode-usage.md）
  // 用量存在 message 表 data 列（JSON）：tokens.{input,output,reasoning,cache.read,cache.write}、cost（USD）、providerID/modelID。
  // 没有按天聚合表，只能按 time_created（epoch ms）过滤 —— message 表仅 7MB，全扫约 12ms；part/event 表别碰（661MB/214MB）。
  const OPENCODE_SQL = `SELECT COALESCE(json_extract(data,'$.providerID'),'') AS prov,
      COALESCE(json_extract(data,'$.modelID'),'') AS model,
      COUNT(*) AS n,
      COALESCE(SUM(json_extract(data,'$.tokens.input')),0) AS tin,
      COALESCE(SUM(json_extract(data,'$.tokens.output')),0) AS tout,
      COALESCE(SUM(json_extract(data,'$.tokens.reasoning')),0) AS trea,
      COALESCE(SUM(json_extract(data,'$.tokens.cache.read')),0) AS tcr,
      COALESCE(SUM(json_extract(data,'$.tokens.cache.write')),0) AS tcw,
      COALESCE(SUM(json_extract(data,'$.cost')),0) AS cost
    FROM message
    WHERE time_created >= ? AND time_created < ? AND json_extract(data,'$.role') = 'assistant'
    GROUP BY prov, model ORDER BY cost DESC`
  const OPENCODE_LAST_SQL = `SELECT COALESCE(MAX(time_created),0) AS last FROM message WHERE json_extract(data,'$.role') = 'assistant'`
  let opencodeCache = null
  let opencodeCacheAt = 0
  function opencodeDbPath() {
    const env = String(process.env.OPENCODE_DB || '').trim()
    if (env && fs.existsSync(env)) return env
    const p = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
    return fs.existsSync(p) ? p : ''
  }
  // 北京时间当天 [start, end)；中国无夏令时，固定 +08:00
  function beijingDayRange(day) {
    const parts = String(day || todayKey()).split('-').map(Number)
    const start = Date.UTC(parts[0], parts[1] - 1, parts[2]) - 8 * 3600 * 1000
    return [start, start + 86400000]
  }
  function execFileText(file, args, opts) {
    return new Promise((resolve, reject) => {
      execFile(file, args, Object.assign({ encoding: 'utf8', timeout: 8000, maxBuffer: 8 << 20 }, opts || {}), (err, stdout) => {
        if (err) reject(err)
        else resolve(String(stdout || ''))
      })
    })
  }
  // 只读三级：node:sqlite（Node 22 实验特性，会打一条 ExperimentalWarning）→ sqlite3 -readonly -json
  async function opencodeRows(db, sql, params) {
    try {
      const mod = await import('node:sqlite')
      const conn = new mod.DatabaseSync(db, { readOnly: true })
      try {
        const stmt = conn.prepare(sql)
        return stmt.all.apply(stmt, params)
      } finally { try { conn.close() } catch (err) {} }
    } catch (err) {
      // 回退：sqlite3 CLI。参数全是数字，内联安全；顺手把 ? 占位符按顺序替换。
      // 桌面端宿主跑在 Electron 主进程里（拿不到 node:sqlite、PATH 也不含 anaconda），所以逐个试绝对路径。
      let i = 0
      const inline = sql.replace(/\?/g, () => String(Math.trunc(Number(params[i++]) || 0)))
      let lastErr = err
      for (const bin of ['/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3', '/opt/anaconda3/bin/sqlite3', 'sqlite3']) {
        try {
          const out = await execFileText(bin, ['-readonly', '-json', db, inline])
          const trimmed = out.trim()
          return trimmed ? JSON.parse(trimmed) : []
        } catch (e2) { lastErr = e2 }
      }
      throw lastErr
    }
  }
  async function opencodeTodayTokenChannel() {
    const db = opencodeDbPath()
    if (!db) return { key: 'opencode', name: 'OpenCode', ok: false, skipped: true, reason: 'no-db', tokens: 0, byModel: [] }
    const day = todayKey()
    if (opencodeCache && opencodeCache.day === day && Date.now() - opencodeCacheAt < 60000) return opencodeCache.value
    const range = beijingDayRange(day)
    let rows = []
    let lastActivity = null
    try {
      rows = await opencodeRows(db, OPENCODE_SQL, [range[0], range[1]])
      const la = await opencodeRows(db, OPENCODE_LAST_SQL, [])
      if (la && la[0] && Number(la[0].last)) lastActivity = Number(la[0].last)
    } catch (err) {
      return { key: 'opencode', name: 'OpenCode', ok: false, error: String((err && err.message) || err), tokens: 0, byModel: [] }
    }
    const rate = tokenUsdRate()
    let tokens = 0
    let usd = 0
    let records = 0
    const byModel = []
    for (const r of rows) {
      const t = (Number(r.tin) || 0) + (Number(r.tout) || 0) + (Number(r.trea) || 0) + (Number(r.tcr) || 0) + (Number(r.tcw) || 0)
      const c = Number(r.cost) || 0
      tokens += t
      usd += c
      records += Number(r.n) || 0
      byModel.push({
        model: [r.prov, r.model].filter(Boolean).join('/') || 'unknown',
        tokens: t,
        costUsd: Number(c.toFixed(6)),
        cost: Number((c * rate).toFixed(4)),
        records: Number(r.n) || 0,
      })
    }
    byModel.sort((a, b) => b.tokens - a.tokens)
    const value = {
      key: 'opencode', name: 'OpenCode', ok: true,
      tokens,
      cost: Number((usd * rate).toFixed(4)),
      costEstimated: true,
      currency: 'CNY',
      costUsd: Number(usd.toFixed(6)),
      records,
      byModel,
      lastActivity,
    }
    opencodeCache = { day, value }
    opencodeCacheAt = Date.now()
    return value
  }
  // ===== Claude Code（~/.claude/projects/**/*.jsonl）=====
  // 只认 type:"assistant" 且带 message.usage 的行；usage 是每次响应一次性下发，不需要做差。
  // input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens（全部输入，与 Codex 口径对齐）
  // total = input + output；同一 message.id 只计一次（压缩/重放会重复落盘）。
  // 注：Claude Code 的 transcript 会被定期清理，且本机走本地代理改写模型名 ⇒ 只统计 token，不估钱。
  let claudeTokenSnap = null
  let claudeTokenAt = 0
  async function claudeTodayTokenChannel() {
    const now = Date.now()
    if (claudeTokenSnap && claudeTokenSnap.day === todayKey() && now - claudeTokenAt < 60000) return claudeTokenSnap.value
    const root = String(process.env.CLAUDE_PROJECTS_DIR || '').trim() || path.join(os.homedir(), '.claude', 'projects')
    const range = beijingDayRange(todayKey())
    let files = []
    try { files = await walkFiles([root], /\.jsonl$/, range[0] - 6 * 3600 * 1000) } catch (err) { files = [] }
    const seen = new Set()
    let tokens = 0
    let records = 0
    let lastActivity = 0
    const byModel = new Map()
    for (const f of files) {
      try {
        for await (const line of readLinesOf(f.path)) {
          if (!line || line.indexOf('"usage"') < 0) continue
          let o = null
          try { o = JSON.parse(line) } catch (err) { continue }
          if (!o) continue
          const msg = o.message && typeof o.message === 'object' ? o.message : null
          const usage = (msg && msg.usage) || o.usage
          if (!usage || typeof usage !== 'object') continue
          if (msg && msg.role && msg.role !== 'assistant') continue
          if (!msg && o.type !== 'assistant') continue
          const ts = Date.parse(o.timestamp || (msg && msg.timestamp) || '')
          if (!isFinite(ts)) continue
          if (ts > lastActivity) lastActivity = ts
          if (!(ts >= range[0] && ts < range[1])) continue
          const id = (msg && (msg.id || msg.message_id)) || o.uuid || o.requestId
          if (id) {
            if (seen.has(id)) continue
            seen.add(id)
          }
          const input = (Number(usage.input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0)
          const output = Number(usage.output_tokens) || 0
          const total = input + output
          const model = String((msg && msg.model) || o.model || 'claude')
          const bucket = byModel.get(model) || { model, tokens: 0, records: 0 }
          bucket.tokens += total
          bucket.records++
          byModel.set(model, bucket)
          tokens += total
          records++
        }
      } catch (err) { continue }
    }
    const value = {
      key: 'claude', name: 'Claude Code', ok: true,
      tokens,
      byModel: Array.from(byModel.values()).sort((a, b) => b.tokens - a.tokens),
      cost: null, currency: '', costEstimated: false,
      records,
      files: files.length,
      lastActivity: lastActivity || null,
    }
    claudeTokenSnap = { day: todayKey(), value }
    claudeTokenAt = Date.now()
    return value
  }
  async function tokenStatsPayload() {
    const now = Date.now()
    if (tokenStatsCache && now - tokenStatsAt < TOKEN_STATS_TTL) return tokenStatsCache
    if (tokenStatsP) return tokenStatsP
    tokenStatsP = (async () => {
      const channels = []
      try { channels.push(dshTodayTokenChannel()) } catch (err) {
        channels.push({ key: 'dsh', name: 'DSH 会话', ok: false, error: String((err && err.message) || err), tokens: 0, byModel: [] })
      }
      try { channels.push(await codexTodayTokenChannel()) } catch (err) {
        channels.push({ key: 'codex', name: 'Codex', ok: false, error: String((err && err.message) || err), tokens: 0, byModel: [] })
      }
      // 单渠道失败不影响整体：把错误留在该渠道的条目里，前端 hover 能看到，而不是静默少一行
      try { channels.push(await opencodeTodayTokenChannel()) } catch (err) {
        channels.push({ key: 'opencode', name: 'OpenCode', ok: false, error: String((err && err.message) || err), tokens: 0, byModel: [] })
      }
      try { channels.push(await claudeTodayTokenChannel()) } catch (err) {
        channels.push({ key: 'claude', name: 'Claude Code', ok: false, error: String((err && err.message) || err), tokens: 0, byModel: [] })
      }
      let tokens = 0
      let cost = 0
      let costEstimated = false
      const byModelMap = new Map()
      for (const c of channels) {
        if (!c || !c.ok) continue
        tokens += Number(c.tokens) || 0
        if (c.cost !== null && c.cost !== undefined) {
          cost = addMoney(cost, Number(c.cost) || 0)
          if (c.costEstimated) costEstimated = true
        }
        for (const m of (c.byModel || [])) {
          const key = String(m.model || '未知')
          const cur = byModelMap.get(key) || { model: key, tokens: 0, cost: 0 }
          cur.tokens += Number(m.tokens) || 0
          cur.cost = addMoney(cur.cost, Number(m.cost) || 0)
          byModelMap.set(key, cur)
        }
      }
      const payload = {
        ok: true,
        version,
        day: todayKey(),
        at: Date.now(),
        tokens,
        cost,
        costEstimated,
        currency: 'CNY',
        usdRate: tokenUsdRate(),
        byModel: Array.from(byModelMap.values()).sort((a, b) => b.tokens - a.tokens),
        channels,
      }
      tokenStatsCache = payload
      tokenStatsAt = Date.now()
      return payload
    })()
      .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
      .finally(() => { tokenStatsP = null })
    return tokenStatsP
  }

  return { payload: tokenStatsPayload }
}
