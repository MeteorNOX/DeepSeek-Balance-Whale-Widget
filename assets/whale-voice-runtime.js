// whale-voice-runtime.js —— 语录配音的前端运行时（IIFE，零依赖，无构建）
//
// 与挂件的分工：挂件只管「什么时候该出声」（泡泡渲染完成后调用一次），
// 本运行时管「该不该出声、放哪一条、怎么放、被打断怎么办」。
//
// 绑定策略与宿主 voice-registry.mjs 一致：**按文本指纹（NFC + 空白归一 + SHA-256）匹配**。
// 匹配不上（用户改了文案 / 没有语音包 / 没有 crypto.subtle）一律静默，绝不播错音频。
//
// 对外 API（挂件只用得到前两个）：
//   window.__dshWhaleVoice.play({ text, volume })   → boolean（是否已受理，不代表必然播出）
//   window.__dshWhaleVoice.interrupt(ms)            → 停止当前语音并静音 ms 毫秒（音效优先级用）
//   window.__dshWhaleVoice.getStatus()              → 诊断快照
//   window.__dshWhaleVoice.reload()                 → 丢弃缓存重新拉清单
(function () {
  if (window.__dshWhaleVoice) return
  var PACKS_URL = '/dsh-whale/voice-packs.json'
  var MANIFEST_URL = '/dsh-whale/voice-pack-manifest.json?pack='
  var CACHE_MAX = 8 // 常驻缓冲的音频元素上限（按需加载，靠 LRU 回收；多变体会多占几个）

  var state = {
    ready: false, enabled: false, packId: null, packs: [],
    lastError: '', blockedUntil: 0, active: null, played: 0, skipped: 0,
  }
  var index = null // textHash -> utterance
  var loading = null
  var cache = new Map() // cacheKey（id#变体序号）-> HTMLAudioElement（Map 迭代顺序即 LRU）
  var lastVariant = {} // utteranceId -> 上次播的变体序号（避免同一句连着播同一个版本）

  function normalize(text) {
    return String(text == null ? '' : text).normalize('NFC').replace(/\s+/g, ' ').trim()
  }
  // —— 纯 JS SHA-256（标准实现，逐位等同 Node crypto / WebCrypto）——
  // 为什么需要它：crypto.subtle 只在「安全上下文」可用，而 DSH 网页从局域网其它设备访问时是
  // http://192.168.x.x:3080（非安全上下文），subtle 为 undefined。没有它就会算不出指纹、
  // 语音在局域网访问下全部静默——所以这里内置一份同算法兜底，保证两边指纹一致。
  var SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0 }
  function sha256Hex(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
    var len = bytes.length
    var padLen = (((len + 9) >> 6) + 1) << 6
    var buf = new Uint8Array(padLen)
    buf.set(bytes)
    buf[len] = 0x80
    var dv = new DataView(buf.buffer)
    dv.setUint32(padLen - 8, Math.floor(len / 536870912)) // 高 32 位（短文本恒为 0）
    dv.setUint32(padLen - 4, (len << 3) >>> 0)
    var w = new Uint32Array(64)
    for (var off = 0; off < padLen; off += 64) {
      var i
      for (i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
      for (i = 16; i < 64; i++) {
        var x = w[i - 15]
        var y = w[i - 2]
        var s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0
        var s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
      for (i = 0; i < 64; i++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
        var ch = ((e & f) ^ (~e & g)) >>> 0
        var t1 = (h + S1 + ch + SHA_K[i] + w[i]) >>> 0
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
        var t2 = (S0 + maj) >>> 0
        h = g; g = f; f = e; e = (d + t1) >>> 0
        d = c; c = b; b = a; a = (t1 + t2) >>> 0
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
    }
    var out = ''
    for (var k = 0; k < 8; k++) out += ('00000000' + H[k].toString(16)).slice(-8)
    return out
  }
  function utf8Bytes(text) {
    if (window.TextEncoder) return new TextEncoder().encode(text)
    var esc = unescape(encodeURIComponent(text))
    var arr = new Uint8Array(esc.length)
    for (var i = 0; i < esc.length; i++) arr[i] = esc.charCodeAt(i) & 0xff
    return arr
  }
  // 指纹必须与宿主 voice-registry.hashVoiceText 逐位一致
  async function fingerprint(text) {
    var bytes = utf8Bytes(normalize(text))
    try {
      if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
        var digest = await window.crypto.subtle.digest('SHA-256', bytes)
        var view = new Uint8Array(digest)
        var out = ''
        for (var i = 0; i < view.length; i++) out += ('0' + view[i].toString(16)).slice(-2)
        return out
      }
    } catch (err) { /* 落到纯 JS 实现 */ }
    return sha256Hex(bytes)
  }
  function clamp01(v) {
    var n = Number(v)
    return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.9
  }

  function loadIndex(force) {
    if (index && !force) return Promise.resolve(index)
    if (loading && !force) return loading
    loading = fetch(PACKS_URL, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (cfg) {
        state.packs = (cfg && cfg.packs) || []
        state.enabled = !(cfg && cfg.enabled === false)
        var usable = state.packs.filter(function (p) { return p && p.available && p.enabled !== false })
        var want = (cfg && cfg.selectedPackId) || (cfg && cfg.defaultPackId) || null
        var ok = false
        for (var i = 0; i < usable.length; i++) if (usable[i].id === want) ok = true
        state.packId = ok ? want : (usable[0] ? usable[0].id : null)
        if (!state.packId) { index = new Map(); state.ready = true; return index }
        return fetch(MANIFEST_URL + encodeURIComponent(state.packId), { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (m) {
            var map = new Map()
            var list = (m && m.utterances) || []
            for (var j = 0; j < list.length; j++) {
              var u = list[j]
              if (u && u.textHash && u.url) map.set(u.textHash, u)
            }
            index = map
            state.ready = true
            return map
          })
      })
      .catch(function (err) {
        state.lastError = String((err && err.message) || err)
        index = new Map()
        state.ready = true
        return index
      })
    return loading
  }

  // 取某条语录可用的全部变体 URL（兼容只有 url 的旧清单）
  function urlsOf(hit) {
    if (hit && Array.isArray(hit.urls) && hit.urls.length) return hit.urls
    return hit && hit.url ? [hit.url] : []
  }
  // 随机挑一个变体；有多个时避开"上一次播的那个"，避免连续两次听到同一版本
  function pickVariant(hit) {
    var urls = urlsOf(hit)
    if (!urls.length) return -1
    if (urls.length === 1) return 0
    var prev = lastVariant[hit.id]
    var idx = Math.floor(Math.random() * urls.length)
    if (idx === prev) idx = (idx + 1 + Math.floor(Math.random() * (urls.length - 1))) % urls.length
    lastVariant[hit.id] = idx
    return idx
  }

  function elementFor(hit, idx) {
    var key = hit.id + '#' + idx
    var el = cache.get(key)
    if (el) { // 命中即刷新 LRU 次序
      cache.delete(key)
      cache.set(key, el)
      return el
    }
    try {
      el = new Audio(urlsOf(hit)[idx])
      el.preload = 'auto'
    } catch (err) { return null }
    cache.set(key, el)
    while (cache.size > CACHE_MAX) {
      var oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return el
  }

  function stopActive() {
    if (!state.active) return
    try { state.active.pause() } catch (err) {}
    try { state.active.currentTime = 0 } catch (err) {}
    state.active = null
  }

  function play(opts) {
    opts = opts || {}
    try {
      if (state.blockedUntil > Date.now()) { state.skipped++; return false }
      var text = opts.text || ''
      if (!normalize(text)) { state.skipped++; return false }
      loadIndex(false).then(function (map) {
        if (!map || !map.size) { state.skipped++; return }
        if (state.enabled === false) { state.skipped++; return }
        if (state.blockedUntil > Date.now()) { state.skipped++; return }
        return fingerprint(text).then(function (h) {
          if (!h) { state.skipped++; return }
          var hit = map.get(h)
          if (!hit) { state.skipped++; return } // 文案不匹配 → 静默
          var idx = pickVariant(hit)
          if (idx < 0) { state.skipped++; return }
          var el = elementFor(hit, idx)
          if (!el) { state.skipped++; return }
          stopActive()
          try { el.currentTime = 0 } catch (err) {}
          try { el.volume = clamp01(opts.volume) } catch (err) {}
          state.active = el
          state.played++
          state.lastPick = { id: hit.id, variant: idx, variants: urlsOf(hit).length }
          var p = el.play()
          if (p && p.catch) p.catch(function () { /* 自动播放被拦等：静默 */ })
        })
      }).catch(function () {})
      return true
    } catch (err) { return false }
  }

  // 音效优先级：任务结束音等要出声前先打断语录，并在 ms 毫秒内禁止新语录
  function interrupt(ms) {
    try {
      stopActive()
      var hold = Number(ms)
      if (isFinite(hold) && hold > 0) state.blockedUntil = Date.now() + hold
    } catch (err) {}
  }

  function getStatus() {
    return {
      ready: state.ready, enabled: state.enabled, packId: state.packId,
      packs: state.packs.map(function (p) { return { id: p.id, label: p.label, available: p.available, utterances: p.utterances } }),
      utterances: index ? index.size : null, cached: cache.size,
      multiVariant: index ? Array.prototype.filter.call(Array.from(index.values()), function (u) { return urlsOf(u).length > 1 }).length : null,
      lastPick: state.lastPick || null,
      played: state.played, skipped: state.skipped,
      blockedForMs: Math.max(0, state.blockedUntil - Date.now()),
      lastError: state.lastError,
    }
  }

  function reload() {
    loading = null
    index = null
    state.ready = false
    cache.clear()
    return loadIndex(true).then(getStatus)
  }

  window.__dshWhaleVoice = {
    play: play,
    interrupt: interrupt,
    getStatus: getStatus,
    reload: reload,
    // 诊断/自检用：两条指纹路径都暴露出来，便于对拍（测试页与服务端各自算一遍比对）
    fingerprintOf: fingerprint,
    sha256HexOf: function (text) { return sha256Hex(utf8Bytes(normalize(text))) },
    normalizeOf: normalize,
  }

  // 预热：挂载即拉一次清单（只读小 JSON），避免第一次弹泡泡时语音迟到；
  // 失败不影响任何功能——所有调用点都会在需要时重新走 loadIndex。
  try { loadIndex(false) } catch (err) {}
})()
