import fs from 'node:fs'
import {
  IMAGE_CANDIDATES,
  SKIN_FILES,
  normalizeSkin,
  SIZE_FILE_CANDIDATES,
  USAGE_FILE_CANDIDATES,
  SOUND_SETS,
  normalizeSoundSet,
  soundSetFromUrl,
  RUA_GIF_CANDIDATES,
  priceFor,
  isPeakTime,
  clampScale,
  clampVol,
  JSON_HEADERS,
  BALANCE_URL,
  BALANCE_TTL_MS,
} from './constants.js'
import { WIDGET_JS } from './widget.js'



const name = 'whale-balance-widget'
const inject = ['webServer', 'credentials']

function apply(ctx) {
    const imageCache = {}
    let balanceCache = null
    let balanceInFlight = null
    let gifBytes = null
    // 每轮对话消耗统计：按 (session.id, turn) 分桶聚合，完成后写入 lastTurn。
    // 用 Map 分桶避免主会话与子代理（spawn/fork）并行时串账。
    let turnAggs = new Map() // sessionId -> { turn, cost, tokens, lastTs }
    let lastTurn = null // { turn, amount, tokens, ts }
    let lastTurnSeq = 0
    const disposers = []

    function finalizeTurn(sessionId) {
      const agg = turnAggs.get(sessionId)
      if (agg && agg.cost > 0) {
        lastTurn = { turn: agg.turn, amount: agg.cost, tokens: agg.tokens, ts: agg.lastTs }
        lastTurnSeq++
      }
      turnAggs.delete(sessionId)
    }
    // 监听会话事件流：assistant/message 携带每步真实 usage，按 (session,turn) 聚合；
    // turn/end 时结算该会话本轮并写入 lastTurn
    function handleSessionEvent(sessionId, event) {
      try {
        const type = event && event.type
        const d = event && event.data
        if (!d || typeof d !== 'object') return
        if (type === 'turn/end') {
          finalizeTurn(sessionId)
          return
        }
        if (type !== 'assistant/message') return
        const turn = Number(d.turn)
        const usage = d.usage
        if (!usage || typeof usage !== 'object' || !isFinite(turn)) return
        let agg = turnAggs.get(sessionId)
        if (!agg || agg.turn !== turn) {
          if (agg) finalizeTurn(sessionId)
          agg = { turn, cost: 0, tokens: 0, lastTs: Date.now() }
          turnAggs.set(sessionId, agg)
        }
        const input = Number(usage.inputTokens) || 0
        const cache = Number(usage.cacheReadTokens) || 0
        const output = Number(usage.outputTokens) || 0
        const reasoning = Number(usage.reasoningTokens) || 0
        agg.tokens += input + cache + output + reasoning
        // 定价换算（CNY/百万 token；缓存命中=输入价，其余按各自档位）
        const model = d.message && d.message.source ? d.message.source.model : ''
        const p = priceFor(model)
        const off = isPeakTime(Math.floor(Date.now() / 1000)) ? 1 : 0
        agg.cost += (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + ((output + reasoning) / 1e6) * p.out[off]
        agg.lastTs = Date.now()
      } catch (err) {}
    }

    // 监听所有会话的追加事件；按会话 id 分桶，turn/end 时结算该会话本轮
    disposers.push(ctx.on('session/event', (session, event) => {
      const sid = session && session.id ? session.id : 'default'
      handleSessionEvent(sid, event)
    }))
    // 会话销毁时清理残留聚合，避免内存泄漏
    disposers.push(ctx.on('session/disposed', (session) => {
      if (session && session.id) turnAggs.delete(session.id)
    }))

    function loadGif() {
      if (gifBytes) return gifBytes
      for (const p of RUA_GIF_CANDIDATES) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) {
            gifBytes = bytes
            return bytes
          }
        } catch (err) {}
      }
      throw new Error('rua gif not found')
    }

    function loadImage(skin) {
      const key = normalizeSkin(skin)
      if (imageCache[key]) return imageCache[key]
      const candidates = key === 'default' ? IMAGE_CANDIDATES : SKIN_FILES[key]
      for (const p of candidates) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) {
            imageCache[key] = bytes
            return bytes
          }
        } catch (err) {}
      }
      throw new Error('whale image not found: ' + key)
    }

    function pickBalanceInfo(infos) {
      if (!Array.isArray(infos) || infos.length === 0) return null
      const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
      return (
        infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
        infos.find((x) => num(x) > 0) ||
        infos.find((x) => x && x.currency === 'CNY') ||
        infos[0]
      )
    }

    async function fetchBalance() {
      let cred
      try {
        cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
      } catch (err) {
        return { ok: false, code: 'NO_KEY', error: '凭据读取失败: ' + String((err && err.message) || err).slice(0, 160) }
      }
      if (!cred) {
        return { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY' }
      }
      let lastErr = null
      for (let attempt = 0; attempt < 2; attempt++) {
        let res
        try {
          res = await fetch(BALANCE_URL, {
            headers: { Authorization: 'Bearer ' + cred.value },
            signal: AbortSignal.timeout(20000),
          })
        } catch (err) {
          lastErr = err
          if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
          continue
        }
        if (!res.ok) {
          lastErr = new Error('HTTP ' + res.status)
          if (res.status < 500) break
          if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
          continue
        }
        let data
        try {
          data = await res.json()
        } catch (err) {
          return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
        }
        const info = pickBalanceInfo(data && data.balance_infos)
        if (!info || info.total_balance === undefined) {
          return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
        }
        return {
          ok: true,
          totalBalance: Number(info.total_balance),
          currency: String(info.currency || 'CNY'),
          updatedAt: new Date().toISOString(),
        }
      }
      const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
      return {
        ok: false,
        code: 'HTTP',
        transient: transient,
        error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
      }
    }

    async function fetchUsage() {
      let cred
      try {
        cred = await ctx.credentials.resolve('DEEPSEEK_PLATFORM_TOKEN')
      } catch (err) {
        return { error: 'platform cred resolve failed' }
      }
      if (!cred) return { error: 'no platform token' }
      const token = String(cred.value).replace(/^Bearer\s+/i, '')
      try {
        const now = new Date()
        const tz = -now.getTimezoneOffset() * 60
        const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
        const end = start + 86400
        const url = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=' + start + '&end=' + end + '&tz=' + tz
        const res = await fetch(url, {
          headers: { Authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) return { error: 'http ' + res.status }
        const data = await res.json()
        const u = computeTodayUsage(data)
        if (u && isFinite(u.amount)) return { amount: u.amount, tokens: u.tokens }
        return { error: 'no usage' }
      } catch (err) {
        return { error: String((err && err.message) || err) }
      }
    }

    function computeTodayUsage(data) {
      // data.data.biz_data.series[]: [{model, buckets:[{time, usage:{RESPONSE_TOKEN, PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN}}]}]
      let d = data
      if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
      else if (d && d.data && Array.isArray(d.data.series)) d = d.data
      const series = Array.isArray(d.series) ? d.series : null
      if (!series || series.length === 0) return null
      let cost = 0
      let tokens = 0
      let found = false
      for (const s of series) {
        if (!s || typeof s !== 'object') continue
        const p = priceFor(s.model)
        const buckets = Array.isArray(s.buckets) ? s.buckets : []
        for (const b of buckets) {
          const u = b && b.usage
          if (!u || typeof u !== 'object') continue
          const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0
          const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0
          const out = Number(u.RESPONSE_TOKEN) || 0
          if (hit + miss + out === 0) continue
          found = true
          tokens += hit + miss + out
          const pi = isPeakTime(b.time) ? 1 : 0
          cost += (hit / 1e6) * p.hit[pi] + (miss / 1e6) * p.miss[pi] + (out / 1e6) * p.out[pi]
        }
      }
      return found ? { amount: cost, tokens: tokens } : null
    }

    function todayKey() {
      const d = new Date()
      const p = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }
    // 原子写：先写同目录临时文件再 rename，避免写到一半被打断留下半截 JSON
    // （记账文件每次余额轮询都会重写，被截断后当天用量会整份丢失）。
    function writeJsonAtomic(p, body) {
      const tmp = p + '.tmp'
      try {
        fs.writeFileSync(tmp, body, 'utf8')
        fs.renameSync(tmp, p)
        return true
      } catch (err) {
        try { fs.unlinkSync(tmp) } catch (e) {}
        return false
      }
    }
    function readUsageLedger() {
      for (const p of USAGE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') return parsed
        } catch (err) {}
      }
      return { date: todayKey(), lastBalance: null, todayUsage: 0, history: {} }
    }
    function writeUsageLedger(led) {
      const body = JSON.stringify(led)
      for (const p of USAGE_FILE_CANDIDATES) {
        if (writeJsonAtomic(p, body)) return true
      }
      return false
    }
    // 记账模式：每次观测到余额后，用余额正差值累计当天用量（跨天自动归零并归档）。
    // 币种感知：观测币种与上次不同时只重置基准、不记差值——数值跳变来自币种
    // 切换而非真实消费（[0] 选币时代 CNY/USD 随机切换曾记出巨额假账，见 #13）。
    function recordLedgerUsage(currentBalance, currency) {
      const t = todayKey()
      let led = readUsageLedger()
      const cur = String(currency || '')
      const currencyChanged =
        typeof led.lastCurrency === 'string' && led.lastCurrency !== '' &&
        cur !== '' && led.lastCurrency !== cur
      if (led.date !== t) {
        if (led.date && typeof led.todayUsage === 'number') {
          led.history = led.history || {}
          led.history[led.date] = led.todayUsage
        }
        // 跨天后的第一次观测：把「上次观测 → 本次观测」的余额下降计入新的一天，
        // 否则夜间（或关机期间）的消费会被整段丢弃。币种变化时只换基准不记账。
        const prevBal = typeof led.lastBalance === 'number' ? led.lastBalance : null
        const carried =
          !currencyChanged && prevBal !== null && typeof currentBalance === 'number' && currentBalance < prevBal
            ? prevBal - currentBalance
            : 0
        led.date = t
        led.lastBalance = currentBalance
        led.lastCurrency = cur
        led.todayUsage = carried
      } else if (currencyChanged) {
        // 币种切换：只换基准，不把差值记成消费
        led.lastBalance = currentBalance
        led.lastCurrency = cur
      } else {
        const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
        if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
          led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
        }
        led.lastBalance = currentBalance
        led.lastCurrency = cur
      }
      const keys = Object.keys(led.history || {}).sort()
      while (keys.length > 30) {
        delete led.history[keys.shift()]
      }
      writeUsageLedger(led)
      return led
    }
    function normalizeUsageMode(m) {
      return m === 'token' ? 'token' : 'ledger'
    }

    async function getBalancePayload() {
      const payload = await fetchBalance()
      if (!payload.ok) return payload
      // 无论哪种模式，都先把余额观测记入账本（自动累积「鲸鱼记账」数据）
      const led = recordLedgerUsage(Number(payload.totalBalance), payload.currency)
      const cfg = readSizeConfig() || {}
      const mode = normalizeUsageMode(cfg.usageMode)
      const full = { ...payload }
      full.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
      if (mode === 'ledger') {
        full.todayUsage = led.todayUsage
        full.usageMode = 'ledger'
        return full
      }
      // token：尝试平台令牌实时计算
      let cred = null
      try {
        cred = await ctx.credentials.resolve('DEEPSEEK_PLATFORM_TOKEN')
      } catch (err) {}
      if (cred) {
        const u = await fetchUsage()
        if (u && u.amount !== undefined) {
          full.todayUsage = u.amount
          full.usageMode = 'token'
          return full
        }
      }
      // 无令牌或令牌失败：回落记账模式
      full.todayUsage = led.todayUsage
      full.usageMode = 'ledger'
      return full
    }

    function getBalance() {
      const now = Date.now()
      if (balanceCache && now - balanceCache.at < BALANCE_TTL_MS) {
        return Promise.resolve(balanceCache.payload)
      }
      if (balanceInFlight) return balanceInFlight
      balanceInFlight = getBalancePayload()
        .then((payload) => {
          if (payload.ok) {
            // 用写入时刻而非请求发起时刻计 TTL：一次慢请求最多可耗 20s，
            // 按发起时刻算会让缓存刚存下就已过期大半。
            balanceCache = { at: Date.now(), payload }
            return payload
          }
          if (payload.transient && balanceCache) {
            // transient network/API blip: keep serving the last known balance
            return { ...balanceCache.payload, stale: true, error: payload.error }
          }
          if (!payload.transient) console.error('[whale-balance]', payload.code, payload.error)
          return payload
        })
        .catch((err) => ({
          ok: false,
          code: 'ERROR',
          error: '余额服务异常: ' + String((err && err.message) || err).slice(0, 200),
        }))
        .finally(() => {
          balanceInFlight = null
        })
      return balanceInFlight
    }

    function readSizeConfig() {
      for (const p of SIZE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && typeof parsed.scale === 'number') {
            return {
              scale: clampScale(parsed.scale),
              sound: parsed.sound !== false,
              vol: clampVol(typeof parsed.vol === 'number' ? parsed.vol : 0.9),
              soundSet: normalizeSoundSet(parsed.soundSet),
              usageMode: normalizeUsageMode(parsed.usageMode),
              peakMode: parsed.peakMode === 'liangwen' || parsed.peakMode === 'qiangqiang' ? parsed.peakMode : 'default',
              bubbleOn: parsed.bubbleOn !== false,
              turnCostOn: parsed.turnCostOn !== false,
              turnCostCloseMs: typeof parsed.turnCostCloseMs === 'number' ? parsed.turnCostCloseMs : 5000,
              scrollGapOn: parsed.scrollGapOn === true,
              scrollGapPx: typeof parsed.scrollGapPx === 'number' ? Math.round(parsed.scrollGapPx) : 17,
              skin: normalizeSkin(parsed.skin),
            }
          }
        } catch (err) {}
      }
      return null
    }

    function writeSizeConfig(scale, sound, vol, soundSet, usageMode, peakMode, bubbleOn, turnCostOn, turnCostCloseMs, scrollGapOn, scrollGapPx, skin) {
      const um = normalizeUsageMode(usageMode)
      const pm = peakMode === 'liangwen' || peakMode === 'qiangqiang' ? peakMode : 'default'
      const bo = bubbleOn !== false
      const tco = turnCostOn !== false
      const tcc = typeof turnCostCloseMs === 'number' ? (turnCostCloseMs > 0 ? turnCostCloseMs : 0) : 5000
      const sgo = scrollGapOn === true
      const sgp = typeof scrollGapPx === 'number' && scrollGapPx > 0 ? Math.round(scrollGapPx) : 0
      const sk = normalizeSkin(skin)
      const sc = clampScale(scale)
      const vl = clampVol(vol)
      const body = JSON.stringify({
        scale: sc,
        sound: sound !== false,
        vol: vl,
        soundSet: normalizeSoundSet(soundSet),
        usageMode: um,
        peakMode: pm,
        bubbleOn: bo,
        turnCostOn: tco,
        turnCostCloseMs: tcc,
        scrollGapOn: sgo,
        scrollGapPx: sgp,
        skin: sk,
        updatedAt: new Date().toISOString(),
      })
      for (const p of SIZE_FILE_CANDIDATES) {
        if (writeJsonAtomic(p, body)) {
          return {
            ok: true,
            scale: sc,
            sound: sound !== false,
            vol: vl,
            soundSet: normalizeSoundSet(soundSet),
            usageMode: um,
            peakMode: pm,
            bubbleOn: bo,
            turnCostOn: tco,
            turnCostCloseMs: tcc,
            scrollGapOn: sgo,
            scrollGapPx: sgp,
            skin: sk,
          }
        }
      }
      return { ok: false, error: '无法持久化挂件尺寸' }
    }

    function readBody(req) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > 8192) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-naijing/image.png',
      handler: (req, res) => {
        try {
          let skin = 'default'
          try {
            skin = normalizeSkin(new URL(req.url, 'http://localhost').searchParams.get('skin'))
          } catch (err) {}
          const bytes = loadImage(skin)
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('whale image unavailable: ' + String((err && err.message) || err))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-naijing/rua.gif',
      handler: (req, res) => {
        try {
          const bytes = loadGif()
          res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('rua gif unavailable: ' + String((err && err.message) || err))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-naijing/balance.json',
      handler: async (req, res) => {
        try {
          const payload = await getBalance()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(payload))
        } catch (err) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-naijing/last-turn.json',
      handler: (req, res) => {
        // 返回最近一轮已完成的对话消耗；seq 递增供前端判断「新的一轮」
        const payload = lastTurn
          ? { ok: true, seq: lastTurnSeq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, ts: lastTurn.ts }
          : { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-naijing/size.json',
      handler: async (req, res) => {
        if (req.method === 'PUT' || req.method === 'POST') {
          try {
            const body = await readBody(req)
            const parsed = JSON.parse(body)
            const scale = typeof parsed.scale === 'number' ? parsed.scale : null
            if (scale === null) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'missing scale' }))
              return
            }
            // 用量模式变化时让余额缓存失效，下次请求立即按新模式计算
            if (typeof parsed.usageMode === 'string') {
              const old = readSizeConfig()
              if (!old || normalizeUsageMode(old.usageMode) !== normalizeUsageMode(parsed.usageMode)) {
                balanceCache = null
              }
            }
            const result = writeSizeConfig(scale, parsed.sound !== false, parsed.vol, parsed.soundSet, parsed.usageMode, parsed.peakMode, parsed.bubbleOn, parsed.turnCostOn, parsed.turnCostCloseMs, parsed.scrollGapOn, parsed.scrollGapPx, parsed.skin)
            res.writeHead(result.ok ? 200 : 500, JSON_HEADERS)
            res.end(JSON.stringify(result))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
          }
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(readSizeConfig() || {}))
      },
    }))

    function loadSound(candidates) {
      for (const p of candidates) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) return bytes
        } catch (err) {}
      }
      return null
    }

    function serveSound(req, res, candidates) {
      const bytes = loadSound(candidates)
      if (!bytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('sound unavailable')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    }

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-naijing/sound/press.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        serveSound(req, res, set.press)
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-naijing/sound/release.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        serveSound(req, res, set.release)
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-naijing/widget.js',
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(WIDGET_JS)
      },
    }))

    disposers.push(ctx.webServer.tapIndex((html) => {
      if (html.indexOf('/dsh-whale-naijing/widget.js') !== -1) return html
      const tag = '<script defer src="/dsh-whale-naijing/widget.js"></script>'
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
      return html + tag
    }))

    ctx.effect(() => () => {
      for (const d of disposers) {
        try { d() } catch (err) {}
      }
    })
}

export { name, inject, apply }

