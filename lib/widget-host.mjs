import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MEDIA_POLICY, decodeMediaDataUrl, validateImage, validateWav } from './media-validation.mjs'
import { readResourceJson, writeResourceJson, atomicResourceWrite, validResourceId, resourcePath, pickResourceDirectory, checkMediaBudget, importResource, deleteResource } from './resource-store.mjs'

// Package root: lib/index.js -> package root. Keeps the bundle relocatable
// when installed as a normal DSH npm plugin (node_modules or a local link).
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// DSH home: used for the widget memory/role/audio files, since node_modules may
// be read-only or cleaned on update.
export function createWidgetHost(dataRoot, { fs = nodeFs } = {}) {
const DSH_HOME = dataRoot

// Whale image: package-relative first (ship DSniang1/DSniang02.png in assets/),
// legacy absolute paths as fallback.
const IMAGE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'DSniang1.png'),
  path.join(PACKAGE_ROOT, 'assets', 'DSniang02.png'),
]
// 自定义角色图片存放目录（第一个可写的会被使用；roles.json 存角色元数据）
const ROLE_DIR_CANDIDATES = [
  path.join(DSH_HOME, 'whale-roles'),
  path.join(DSH_HOME, 'profiles', 'web', 'whale-roles'),
]
const ROLE_INDEX_NAME = 'roles.json'
const ROLE_DEFAULT_ID = 'default'
// 自定义音频片段存放目录（每个片段一个 <id>.wav + audio.json 索引）
const AUDIO_DIR_CANDIDATES = [
  path.join(DSH_HOME, 'whale-audio'),
  path.join(DSH_HOME, 'profiles', 'web', 'whale-audio'),
]
const AUDIO_INDEX_NAME = 'audio.json'
// 内置预设音效组（不可删、不可改），对应 assets 里的 Ya/D 系列
const PRESET_GROUPS = {
  duck: { id: 'duck', name: '小黄鸭', press: 'ya1', release: 'ya2', preset: true },
  fx1: { id: 'fx1', name: '音效1', press: 'd1', release: 'd2', preset: true },
}
// 内置预设片段（不可删），映射到 SOUND_SETS 的文件
const PRESET_FRAGMENTS = {
  ya1: { id: 'ya1', name: '小黄鸭·按下', preset: true },
  ya2: { id: 'ya2', name: '小黄鸭·松开', preset: true },
  d1: { id: 'd1', name: '音效1·按下', preset: true },
  d2: { id: 'd2', name: '音效1·松开', preset: true },
}
// Size memory file: prefer writable DSH home locations, then legacy fallbacks.
const SIZE_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-size.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-size.json'),
]
// Usage ledger file (小鲸鱼记账 mode): same policy as the size file.
const USAGE_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-usage.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-usage.json'),
]
// 每轮消耗 seq 持久化文件：避免插件热重载后 seq 归零导致页面把新轮次误判为旧轮次吞掉
const TURN_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-turn.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-turn.json'),
]
// Sound assets: package-relative first (ship Ya1/Ya2/D1/D2.mp3 in assets/),
// legacy absolute paths as fallback.
const BUBBLE_FILE_CANDIDATES = [path.join(DSH_HOME, '.dshw-bubble.json')]
// 泡泡图库(独立于角色图库):图片文件目录 + 索引
const BUBBLE_IMG_DIR_CANDIDATES = [path.join(DSH_HOME, 'whale-bubble-imgs')]
const BUBBLE_IMG_INDEX_NAME = 'bubble-imgs.json'
// 内置默认泡泡图(语义 id → assets 文件):面板常驻可选;全新安装无用户图库时
// bubble-img.png 从内置清单回退加载。文件同时位于 package assets/ 与开发回退目录。
const DEFAULT_BUBBLE_IMGS = [
  { id: 'bimg_petpet', name: 'petpet', file: 'bubble-petpet.gif', format: 'gif' },
  { id: 'bimg_yue_money', name: 'Yue_要米', file: 'bubble-yue-money.gif', format: 'gif' },
]
function bubbleImgFileCandidates(file) {
  return [
    path.join(PACKAGE_ROOT, 'assets', file),
  ]
}
function loadBuiltinBubbleImgBytes(def) {
  if (!def || !def.file) return null
  for (const p of bubbleImgFileCandidates(def.file)) {
    try {
      const bytes = fs.readFileSync(p)
      if (bytes && bytes.length > 0) return bytes
    } catch (err) {}
  }
  return null
}
const SOUND_SETS = {
  duck: { press: [path.join(PACKAGE_ROOT, 'assets', 'Ya1.mp3')], release: [path.join(PACKAGE_ROOT, 'assets', 'Ya2.mp3')] },
  fx1: { press: [path.join(PACKAGE_ROOT, 'assets', 'D1.mp3')], release: [path.join(PACKAGE_ROOT, 'assets', 'D2.mp3')] },
}
function soundSetFromUrl(url) {
  try {
    const q = String(url || '').split('?')[1] || ''
    const m = /(?:^|&)set=([^&]+)/.exec(q)
    return m ? decodeURIComponent(m[1]) : ''
  } catch (err) { return '' }
}
const RUA_GIF_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'rua.gif'),
]
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// 浏览器端挂件代码已拆分为独立文件 whale-widget.js(与本文件同目录),
// 不再内嵌模板字面量:可直接 node --check / IDE 高亮,改 widget 后硬刷新页面即生效(无需重启 DSH)。
// 每次请求按 mtime 判断是否需要重读,避免常驻缓存导致改了不生效。
const WIDGET_FILE_CANDIDATES = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'whale-widget.js'),
  path.join(PACKAGE_ROOT, 'whale-widget.js'),
  path.join(PACKAGE_ROOT, 'assets', 'whale-widget.js'),
]
let widgetJsCache = null // { text, mtimeMs }
function loadWidgetJs() {
  for (const p of WIDGET_FILE_CANDIDATES) {
    try {
      const st = fs.statSync(p)
      if (widgetJsCache && widgetJsCache.mtimeMs === st.mtimeMs) return widgetJsCache.text
      const text = fs.readFileSync(p, 'utf8')
      widgetJsCache = { text, mtimeMs: st.mtimeMs }
      return text
    } catch (err) {}
  }
  return widgetJsCache ? widgetJsCache.text : ''
}

return {
  name: 'whale-balance-widget',
  inject: ['webServer', 'credentials'],
  apply(ctx) {
    let imageBytes = null
    let balanceCache = null
    let balanceInFlight = null
    let gifBytes = null
    const disposers = []
    const storageWarnings = new Map()
    function readLibrary(file, fallback, validate, strict = false, maxBytes) {
      try {
        const result = readResourceJson(file, fallback, validate, { fs, ...(maxBytes ? { maxBytes } : {}) })
        storageWarnings.delete(file)
        return result
      } catch (error) {
        storageWarnings.set(file, error.message)
        if (strict) throw error
        return structuredClone(fallback)
      }
    }
    function libraryWarning(file) {
      const warning = storageWarnings.get(file)
      return warning ? { warning, editable: false } : { editable: true }
    }
    function validEntries(entries) {
      return Array.isArray(entries) && entries.every(entry => entry && typeof entry === 'object' && validResourceId(entry.id)) && new Set(entries.map(entry => entry.id)).size === entries.length
    }
    function mediaPath(dir, id, ext) { return resourcePath(DSH_HOME, dir, id, ext, { fs }) }
    function mediaBudget(bytes, count) { checkMediaBudget(DSH_HOME, bytes, count, { fs }) }
    function readMediaBytes(file, maxBytes) {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('素材文件过大或不是普通文件')
      return fs.readFileSync(file)
    }

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

    function loadImage() {
      if (imageBytes) return imageBytes
      for (const p of IMAGE_CANDIDATES) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) {
            imageBytes = bytes
            return bytes
          }
        } catch (err) {}
      }
      throw new Error('whale image not found')
    }

    function getBalance(force) { return ctx.whale.getBalance({ force: !!force }) }
    function usageRecordsPayload() { return ctx.whale.usageRecords() }
    function readUsageSettings() { return ctx.whale.readUsageSettings() }
    function writeUsageSettings(patch) { return ctx.whale.writeUsageSettings(patch) }
    function normalizeUsageMode() { return 'ledger' }

    function readSizeConfig() {
      for (const p of SIZE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && typeof parsed.scale === 'number') {
            return {
              scale: parsed.scale,
              sound: parsed.sound !== false,
              vol: typeof parsed.vol === 'number' ? parsed.vol : 0.9,
              soundSet: typeof parsed.soundSet === 'string' && parsed.soundSet ? parsed.soundSet : 'duck',
              usageMode: normalizeUsageMode(parsed.usageMode),
              bubbleOn: parsed.bubbleOn !== false,
              turnCostOn: parsed.turnCostOn !== false,
              turnCostCloseMs: typeof parsed.turnCostCloseMs === 'number' ? parsed.turnCostCloseMs : 5000,
              scrollGapOn: parsed.scrollGapOn === true,
              scrollGapPx: typeof parsed.scrollGapPx === 'number' ? Math.round(parsed.scrollGapPx) : 17,
              menuBtnHide: parsed.menuBtnHide === true,
            }
          }
        } catch (err) {}
      }
      return null
    }

    function writeSizeConfig(scale, sound, vol, soundSet, usageMode, bubbleOn, turnCostOn, turnCostCloseMs, scrollGapOn, scrollGapPx, menuBtnHide) {
      const um = normalizeUsageMode(usageMode)
      const bo = bubbleOn !== false
      const tco = turnCostOn !== false
      const tcc = typeof turnCostCloseMs === 'number' ? (turnCostCloseMs > 0 ? turnCostCloseMs : 0) : 5000
      const sgo = scrollGapOn === true
      const sgp = typeof scrollGapPx === 'number' && scrollGapPx > 0 ? Math.round(scrollGapPx) : 0
      const mbh = menuBtnHide === true
      const body = JSON.stringify({
        scale: scale,
        sound: sound !== false,
        vol: typeof vol === 'number' ? vol : 0.9,
        soundSet: typeof soundSet === 'string' && soundSet ? soundSet : 'duck',
        usageMode: um,
        bubbleOn: bo,
        turnCostOn: tco,
        turnCostCloseMs: tcc,
        scrollGapOn: sgo,
        scrollGapPx: sgp,
        menuBtnHide: mbh,
        updatedAt: new Date().toISOString(),
      })
      for (const p of SIZE_FILE_CANDIDATES) {
        try {
          readResourceJson(p, null, value => value && typeof value.scale === 'number', { fs })
          atomicResourceWrite(p, body, { fs, backup: true })
          return {
            ok: true,
            scale: scale,
            sound: sound !== false,
            vol: typeof vol === 'number' ? vol : 0.9,
            soundSet: typeof soundSet === 'string' && soundSet ? soundSet : 'duck',
            usageMode: um,
            bubbleOn: bo,
            turnCostOn: tco,
            turnCostCloseMs: tcc,
            scrollGapOn: sgo,
            scrollGapPx: sgp,
            menuBtnHide: mbh,
          }
        } catch (err) { return { ok: false, error: err.message || '无法持久化挂件尺寸' } }
      }
      return { ok: false, error: '无法持久化挂件尺寸' }
    }

    function readBody(req) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > 512 * 1024) {
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

    function readBodyMax(req, maxBytes) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > maxBytes) {
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

    // —— 自定义角色存储：whale-roles/ 目录，每个角色一个 <id>.png + roles.json 索引 ——
    function pickRoleDir() {
      return pickResourceDirectory(ROLE_DIR_CANDIDATES, ROLE_INDEX_NAME, { fs })
    }

    function defaultRolesIndex() {
      return {
        version: 1,
        roles: [
          // 默认小鲸鱼初始置顶；pinnedAt=1 作为基线，任何新置顶（Date.now()）都会排在它上面
          { id: ROLE_DEFAULT_ID, name: '小鲸鱼', pinnedAt: 1, createdAt: 0 },
        ],
      }
    }

    function readRolesIndex(strict = false) {
      const dir = pickRoleDir()
      const parsed = readLibrary(path.join(dir, ROLE_INDEX_NAME), defaultRolesIndex(), value => value && validEntries(value.roles), strict)
      if (!parsed.roles.some(r => r.id === ROLE_DEFAULT_ID)) parsed.roles.unshift(defaultRolesIndex().roles[0])
      return parsed
    }

    function writeRolesIndex(index) {
      const dir = pickRoleDir()
      readRolesIndex(true)
      return writeResourceJson(path.join(dir, ROLE_INDEX_NAME), index, { fs })
    }

    // 排序：置顶的在前（pinnedAt 大者先，即最新置顶在最上面），未置顶按创建时间倒序
    function sortRoles(roles) {
      return roles.slice().sort((a, b) => {
        const ap = a.pinnedAt && a.pinnedAt > 0 ? a.pinnedAt : 0
        const bp = b.pinnedAt && b.pinnedAt > 0 ? b.pinnedAt : 0
        if (ap && bp) return bp - ap
        if (ap) return -1
        if (bp) return 1
        return (b.createdAt || 0) - (a.createdAt || 0)
      })
    }

    function rolesPayload() {
      const index = readRolesIndex()
      return {
        ok: true,
        ...libraryWarning(path.join(pickRoleDir(), ROLE_INDEX_NAME)),
        roles: sortRoles(index.roles).map((r) => ({
          id: r.id,
          name: String(r.name || r.id),
          url: r.id === ROLE_DEFAULT_ID ? '/dsh-whale/image.png' : '/dsh-whale/role-image.png?id=' + encodeURIComponent(r.id),
          pinned: !!(r.pinnedAt && r.pinnedAt > 0),
          pinnedAt: r.pinnedAt || null,
          createdAt: r.createdAt || null,
          // format: 'png' | 'gif' | 'apng'（旧角色无 format 字段 → png）
          format: ['gif', 'apng', 'jpeg', 'webp'].includes(r.format) ? r.format : 'png',
        })),
      }
    }

    // 角色文件按格式映射扩展名：gif→.gif，apng/png→.png（APNG 文件仍是 PNG 容器）
    function roleFileExt(format) {
      return format === 'gif' ? 'gif' : format === 'jpeg' ? 'jpg' : format === 'webp' ? 'webp' : 'png'
    }

    function roleFilePath(id, format) {
      if (!validResourceId(id) || id === ROLE_DEFAULT_ID) return null
      return mediaPath(pickRoleDir(), id, roleFileExt(format))
    }

    function roleImagePath(id) {
      // 查找角色元数据确定扩展名；找不到默认 png
      const { role } = roleIndexFind(id)
      if (!role) return null
      const format = role.format || 'png'
      const p = roleFilePath(id, format)
      return p
    }

    function roleIdFromUrl(url) {
      try {
        const q = String(url || '').split('?')[1] || ''
        const m = /(?:^|&)id=([^&]+)/.exec(q)
        return m ? decodeURIComponent(m[1]) : ''
      } catch (err) { return '' }
    }

    function roleIndexFind(id, strict = false) {
      const index = readRolesIndex(strict)
      const role = index.roles.find((r) => r && r.id === id)
      return { index, role }
    }

    // —— 自定义音频：whale-audio/ 目录，片段 <id>.wav + audio.json 索引 ——
    function pickAudioDir() {
      return pickResourceDirectory(AUDIO_DIR_CANDIDATES, AUDIO_INDEX_NAME, { fs })
    }

    function defaultAudioIndex() {
      return { version: 1, groups: [], fragments: [] }
    }

    function readAudioIndex(strict = false) {
      const dir = pickAudioDir()
      return readLibrary(path.join(dir, AUDIO_INDEX_NAME), defaultAudioIndex(), value => value && validEntries(value.groups) && validEntries(value.fragments), strict)
    }

    function writeAudioIndex(index) {
      const dir = pickAudioDir()
      readAudioIndex(true)
      return writeResourceJson(path.join(dir, AUDIO_INDEX_NAME), index, { fs })
    }

    // 自定义片段 id -> 文件路径；预设片段无文件
    function audioFragmentPath(id) {
      if (!validResourceId(id)) return null
      if (PRESET_FRAGMENTS[id]) return null
      return mediaPath(pickAudioDir(), id, 'wav')
    }

    function audioIdFromUrl(url) {
      try {
        const q = String(url || '').split('?')[1] || ''
        const m = /(?:^|&)id=([^&]+)/.exec(q)
        return m ? decodeURIComponent(m[1]) : ''
      } catch (err) { return '' }
    }

    // 片段列表：预设片段 + 用户自定义片段
    function audioFragmentsPayload() {
      const index = readAudioIndex()
      const presets = Object.keys(PRESET_FRAGMENTS).map((k) => ({
        id: k,
        name: PRESET_FRAGMENTS[k].name,
        preset: true,
      }))
      const custom = index.fragments.map((f) => ({
        id: f.id,
        name: String(f.name || f.id),
        preset: false,
        createdAt: f.createdAt || null,
      }))
      return presets.concat(custom)
    }

    // 音效组列表：预设组 + 用户自定义组（置顶优先，组内按创建时间倒序）
    function audioGroupsPayload() {
      const index = readAudioIndex()
      // 排序：置顶的自定义组最前，其次预设组，最后未置顶的自定义组（按创建时间倒序）
      const customs = index.groups.slice().map((g) => ({
        id: g.id,
        name: String(g.name || g.id),
        press: typeof g.press === 'string' ? g.press : null,
        release: typeof g.release === 'string' ? g.release : null,
        preset: false,
        pinned: !!(g.pinnedAt && g.pinnedAt > 0),
        pinnedAt: g.pinnedAt || null,
        createdAt: g.createdAt || 0,
      }))
      const pinned = customs.filter((g) => g.pinned).sort((a, b) => b.pinnedAt - a.pinnedAt)
      const unpinned = customs.filter((g) => !g.pinned).sort((a, b) => b.createdAt - a.createdAt)
      const presets = Object.keys(PRESET_GROUPS).map((k) => {
        const g = PRESET_GROUPS[k]
        return { id: g.id, name: g.name, press: g.press, release: g.release, preset: true, pinned: false, pinnedAt: null, createdAt: 0 }
      })
      return pinned.concat(presets, unpinned)
    }

    function audioPayload() {
      const groups = audioGroupsPayload(), fragments = audioFragmentsPayload()
      return {
        ok: true,
        ...libraryWarning(path.join(pickAudioDir(), AUDIO_INDEX_NAME)),
        groups,
        fragments,
      }
    }

    // 取片段音频字节：预设走 SOUND_SETS 文件，自定义走 whale-audio/<id>.wav
    function loadAudioFragmentBytes(fragId) {
      if (PRESET_FRAGMENTS[fragId]) {
        // 预设片段映射到对应音效文件：ya1->duck.press, ya2->duck.release, d1->fx1.press, d2->fx1.release
        const map = { ya1: ['duck', 'press'], ya2: ['duck', 'release'], d1: ['fx1', 'press'], d2: ['fx1', 'release'] }
        const [setName, slot] = map[fragId]
        const set = SOUND_SETS[setName]
        if (!set) return null
        return loadSound(set[slot])
      }
      const p = audioFragmentPath(fragId)
      if (!p) return null
      try {
        const bytes = readMediaBytes(p, MEDIA_POLICY.audioBytes)
        if (bytes && bytes.length > 0) return bytes
      } catch (err) {}
      return null
    }

    // 组内实际使用的片段：若自定义组引用的片段被删，回退到预设
    // 返回 '' 表示该槽显式留空（该事件静音），调用方应据此不发音频
    function groupFragmentId(groupId, slot) {
      const custom = readAudioIndex().groups.find((g) => g && g.id === groupId)
      if (custom) {
        const fid = custom[slot]
        if (fid === '') return ''
        if (fid) {
          if (PRESET_FRAGMENTS[fid]) return fid
          if (customFragExists(fid)) return fid
        }
        // 无字段/引用失效 → 回退预设：新组无引用时用 duck
        return slot === 'press' ? PRESET_GROUPS.duck.press : PRESET_GROUPS.duck.release
      }
      const preset = PRESET_GROUPS[groupId]
      if (preset) return preset[slot]
      return slot === 'press' ? PRESET_GROUPS.duck.press : PRESET_GROUPS.duck.release
    }

    function customFragExists(id) {
      try {
        const p = audioFragmentPath(id)
        if (!p) return false
        const st = fs.statSync(p)
        return st.isFile()
      } catch (err) { return false }
    }

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/image.png',
      handler: (req, res) => {
        try {
          const bytes = loadImage()
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
      path: '/dsh-whale/rua.gif',
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
      path: '/dsh-whale/balance.json',
      handler: async (req, res) => {
        try {
          const payload = await getBalance(new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1')
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
      path: '/dsh-whale/last-turn.json',
      handler: (req, res) => {
        // 返回最近一轮已完成的对话消耗；seq 递增供前端判断「新的一轮」
        const payload = ctx.whale.lastTurn()
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/size.json',
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
            const result = writeSizeConfig(scale, parsed.sound !== false, parsed.vol, parsed.soundSet, parsed.usageMode, parsed.bubbleOn, parsed.turnCostOn, parsed.turnCostCloseMs, parsed.scrollGapOn, parsed.scrollGapPx, parsed.menuBtnHide)
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

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/usage-records.json',
      handler: async (req, res) => {
        try {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(usageRecordsPayload()))
        } catch (err) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
        }
      },
    }))
    // 用量设置(任务结束音/余额预警/今日预算)
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/usage-settings.json',
      handler: async (req, res) => {
        try {
          if (req.method === 'PUT' || req.method === 'POST') {
            const body = await readBody(req)
            const parsed = JSON.parse(body || '{}')
            if (!parsed || typeof parsed !== 'object') throw new Error('bad body')
            const result = writeUsageSettings(parsed)
            res.writeHead(result.ok ? 200 : 400, JSON_HEADERS)
            res.end(JSON.stringify(result))
            return
          }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, settings: readUsageSettings() }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/roles.json',
      handler: async (req, res) => {
        if (req.method === 'POST' || req.method === 'PUT') {
          try {
            // 放宽到 30MB：支持最大 20MB 的 GIF（base64 膨胀约 1.33 倍）
            const body = await readBodyMax(req, 30 * 1024 * 1024)
            const parsed = JSON.parse(body)
            const name = String(parsed.name || '').trim().slice(0, 20) || '新角色'
            const { bytes: buf, mime } = decodeMediaDataUrl(parsed.image, ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], MEDIA_POLICY.roleBytes)
            const media = validateImage(buf, { mime }), fmt = media.format
            if (['gif', 'apng'].includes(parsed.format) && parsed.format !== fmt) throw new Error('声明的动画格式与文件不一致')
            const id = 'role_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
            const dir = pickRoleDir()
            const index = readRolesIndex(true)
            mediaBudget(buf.length, index.roles.filter(role => role.id !== ROLE_DEFAULT_ID).length)
            index.roles.push({ id, name, format: fmt, width: media.width, height: media.height, frames: media.frames, pinnedAt: null, createdAt: Date.now() })
            importResource(mediaPath(dir, id, roleFileExt(fmt)), buf, () => writeRolesIndex(index), { fs })
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(rolesPayload()))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
          }
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(rolesPayload()))
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/role-pin.json',
      handler: async (req, res) => {
        try {
          const body = await readBodyMax(req, 8192)
          const parsed = JSON.parse(body)
          const id = String(parsed.id || '')
          const { index, role } = roleIndexFind(id, true)
          if (!role) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'role not found' }))
            return
          }
          role.pinnedAt = parsed.pinned === true ? Date.now() : null
          writeRolesIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(rolesPayload()))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/role-delete.json',
      handler: async (req, res) => {
        try {
          const body = await readBodyMax(req, 8192)
          const parsed = JSON.parse(body)
          const id = String(parsed.id || '')
          if (id === ROLE_DEFAULT_ID) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'cannot delete default role' }))
            return
          }
          const { index, role } = roleIndexFind(id, true)
          if (!role) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'role not found' }))
            return
          }
          // 先按角色 format 确定文件路径（必须在从索引移除之前，否则查不到 format 默认成 png，删不掉 .gif）
          const fmt = role.format || 'png'
          const p = roleFilePath(id, fmt)
          if (!p) throw new Error('角色编号无效')
          const original = structuredClone(index)
          index.roles = index.roles.filter((r) => r.id !== id)
          deleteResource(p, () => writeRolesIndex(index), () => writeRolesIndex(original), { fs })
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(rolesPayload()))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/role-image.png',
      handler: (req, res) => {
        try {
          const id = roleIdFromUrl(req.url)
          const p = roleImagePath(id)
          if (!p) throw new Error('bad role id')
          const bytes = readMediaBytes(p, MEDIA_POLICY.roleBytes)
          // 按角色格式返回对应 MIME：gif 动图 → image/gif；png/apng 都是 PNG 容器 → image/png
          const { role } = roleIndexFind(id)
          const mime = role && role.format === 'gif' ? 'image/gif' : role?.format === 'jpeg' ? 'image/jpeg' : role?.format === 'webp' ? 'image/webp' : 'image/png'
          res.writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('role image unavailable')
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/audio.json',
      handler: async (req, res) => {
        if (req.method === 'POST' || req.method === 'PUT') {
          try {
            const body = await readBodyMax(req, Math.ceil(MEDIA_POLICY.audioBytes / 3) * 4 + 4096)
            const parsed = JSON.parse(body)
            const action = parsed.action
            const index = readAudioIndex(true)
            if (action === 'upload-fragment') {
              const name = String(parsed.name || '').trim().slice(0, 40) || '未命名音频'
              const { bytes: buf } = decodeMediaDataUrl(parsed.audio, ['audio/wav'], MEDIA_POLICY.audioBytes)
              const media = validateWav(buf)
              mediaBudget(buf.length, index.fragments.length)
              const id = 'audio_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
              index.fragments.push({ id, name, duration: media.duration, createdAt: Date.now() })
              importResource(mediaPath(pickAudioDir(), id, 'wav'), buf, () => writeAudioIndex(index), { fs })
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, id, fragments: audioFragmentsPayload() }))
              return
            }
            if (action === 'save-group') {
              const id = String(parsed.id || '')
              const name = String(parsed.name || '').trim().slice(0, 20) || '未命名音效组'
              const press = String(parsed.press ?? '')
              const release = String(parsed.release ?? '')
              // 校验引用片段存在（预设或自定义）；空字符串=该槽留空(该事件静音)，允许保存
              const frags = audioFragmentsPayload().map((f) => f.id)
              const validPress = press === '' ? '' : (frags.includes(press) ? press : PRESET_GROUPS.duck.press)
              const validRelease = release === '' ? '' : (frags.includes(release) ? release : PRESET_GROUPS.duck.release)
              if (id && index.groups.some((g) => g.id === id)) {
                const g = index.groups.find((x) => x.id === id)
                g.name = name
                g.press = validPress
                g.release = validRelease
              } else {
                if (index.groups.length >= MEDIA_POLICY.maxItemsPerLibrary) throw new Error('自定义音效组最多 256 项')
                const gid = 'group_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
                index.groups.push({ id: gid, name, press: validPress, release: validRelease, pinnedAt: null, createdAt: Date.now() })
              }
              writeAudioIndex(index)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
              return
            }
            if (action === 'delete-group') {
              const id = String(parsed.id || '')
              if (PRESET_GROUPS[id]) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'cannot delete preset group' }))
                return
              }
              index.groups = index.groups.filter((g) => g.id !== id)
              writeAudioIndex(index)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
              return
            }
            if (action === 'delete-fragment') {
              const id = String(parsed.id || '')
              if (PRESET_FRAGMENTS[id]) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'cannot delete preset fragment' }))
                return
              }
              if (!validResourceId(id) || !index.fragments.some(f => f.id === id)) throw new Error('音频片段不存在')
              const original = structuredClone(index)
              const p = audioFragmentPath(id)
              if (!p) throw new Error('音频片段编号无效')
              index.fragments = index.fragments.filter((f) => f.id !== id)
              deleteResource(p, () => writeAudioIndex(index), () => writeAudioIndex(original), { fs })
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, fragments: audioFragmentsPayload(), groups: audioGroupsPayload() }))
              return
            }
            if (action === 'pin-group') {
              const id = String(parsed.id || '')
              const g = index.groups.find((x) => x.id === id)
              if (!g) {
                res.writeHead(404, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'group not found' }))
                return
              }
              g.pinnedAt = parsed.pinned === true ? Date.now() : null
              writeAudioIndex(index)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
              return
            }
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
          }
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(audioPayload()))
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/audio-fragment.wav',
      handler: (req, res) => {
        try {
          const id = audioIdFromUrl(req.url)
          const bytes = loadAudioFragmentBytes(id)
          if (!bytes) throw new Error('bad fragment id')
          // 预设片段是 mp3（来自 assets），自定义片段是 wav —— Content-Type 必须与字节匹配，
          // 否则浏览器解码路径/加载行为异常（MIME 与字节不符会导致听感差异）
          const mime = PRESET_FRAGMENTS[id] ? 'audio/mpeg' : 'audio/wav'
          res.writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('audio fragment unavailable')
        }
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
      path: '/dsh-whale/sound/press.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        // 自定义音效组：set 为组 id 时按组内 press 片段取音频
        const setName = soundSetFromUrl(req.url)
        if (setName && !SOUND_SETS[setName]) {
          const fragId = groupFragmentId(setName, 'press')
          if (fragId === '') { res.writeHead(204); res.end(); return } // 留空槽：该事件静音
          const bytes = loadAudioFragmentBytes(fragId)
          if (bytes) {
            res.writeHead(200, {
              'Content-Type': PRESET_FRAGMENTS[fragId] ? 'audio/mpeg' : 'audio/wav',
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
        }
        serveSound(req, res, set.press)
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/sound/release.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        const setName = soundSetFromUrl(req.url)
        if (setName && !SOUND_SETS[setName]) {
          const fragId = groupFragmentId(setName, 'release')
          if (fragId === '') { res.writeHead(204); res.end(); return } // 留空槽：该事件静音
          const bytes = loadAudioFragmentBytes(fragId)
          if (bytes) {
            res.writeHead(200, {
              'Content-Type': PRESET_FRAGMENTS[fragId] ? 'audio/mpeg' : 'audio/wav',
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
        }
        serveSound(req, res, set.release)
      },
    }))

    function pickBubbleImgDir() {
      return pickResourceDirectory(BUBBLE_IMG_DIR_CANDIDATES, BUBBLE_IMG_INDEX_NAME, { fs })
    }
    function defaultBubbleImgIndex() {
      return { version: 1, images: [] }
    }
    function readBubbleImgIndex(strict = false) {
      return readLibrary(path.join(pickBubbleImgDir(), BUBBLE_IMG_INDEX_NAME), defaultBubbleImgIndex(), value => value && validEntries(value.images), strict)
    }
    function writeBubbleImgIndex(index) {
      readBubbleImgIndex(true)
      return writeResourceJson(path.join(pickBubbleImgDir(), BUBBLE_IMG_INDEX_NAME), index, { fs })
    }
    function bubbleImgPayload() {
      const index = readBubbleImgIndex()
      // 内置默认图常驻(先列出,不占 createdAt 排序;用户图库含同 id 时不重复)
      const seen = {}
      index.images.forEach((im) => { seen[im.id] = 1 })
      const builtins = DEFAULT_BUBBLE_IMGS.filter((d) => !seen[d.id]).map((d) => ({
        id: d.id,
        name: String(d.name || d.id),
        format: d.format === 'gif' ? 'gif' : 'png',
        url: '/dsh-whale/bubble-img.png?id=' + encodeURIComponent(d.id),
        createdAt: null,
        builtin: true,
      }))
      return {
        ok: true,
        ...libraryWarning(path.join(pickBubbleImgDir(), BUBBLE_IMG_INDEX_NAME)),
        images: builtins.concat(index.images.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((im) => ({
          id: im.id,
          name: String(im.name || im.id),
          format: im.format === 'gif' ? 'gif' : 'png',
          url: '/dsh-whale/bubble-img.png?id=' + encodeURIComponent(im.id),
          createdAt: im.createdAt || null,
        }))),
      }
    }
    function bubbleImgIdFromUrl(url) {
      try {
        const q = String(url || '').split('?')[1] || ''
        const m = /(?:^|&)id=([^&]+)/.exec(q)
        return m ? decodeURIComponent(m[1]) : ''
      } catch (err) { return '' }
    }
    function loadBubbleConfig(strict = false) {
      return readLibrary(BUBBLE_FILE_CANDIDATES[0], null, value => value && value.v === 1 && Array.isArray(value.items) && Array.isArray(value.lib), strict, 512 * 1024)
    }
    function writeBubbleConfig(cfg) {
      loadBubbleConfig(true)
      return writeResourceJson(BUBBLE_FILE_CANDIDATES[0], cfg, { fs })
    }

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/bubble.json',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST' || req.method === 'PUT') {
            const body = await readBodyMax(req, 512 * 1024)
            const parsed = JSON.parse(body)
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items) || !Array.isArray(parsed.lib)) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'invalid bubble config' }))
              return
            }
            const cfg = { v: 1, items: parsed.items, lib: parsed.lib, tapAdvance: parsed.tapAdvance !== false }
            writeBubbleConfig(cfg)
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify({ ok: true, config: cfg }))
            return
          }
          const cfg = loadBubbleConfig()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, config: cfg, ...libraryWarning(BUBBLE_FILE_CANDIDATES[0]) }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/bubble-imgs.json',
      handler: (req, res) => {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(bubbleImgPayload()))
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/bubble-img-upload.json',
      handler: async (req, res) => {
        try {
          const body = await readBodyMax(req, Math.ceil(MEDIA_POLICY.bubbleBytes / 3) * 4 + 4096)
          const parsed = JSON.parse(body)
          const action = parsed && parsed.action
          const index = readBubbleImgIndex(true)
          if (action === 'upload') {
            const name = String(parsed.name || '').trim().slice(0, 40) || ''
            const { bytes: buf, mime } = decodeMediaDataUrl(parsed.data, ['image/png', 'image/gif'], MEDIA_POLICY.bubbleBytes)
            const media = validateImage(buf, { mime, maxBytes: MEDIA_POLICY.bubbleBytes })
            const format = media.extension
            mediaBudget(buf.length, index.images.length)
            const id = 'bimg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
            index.images.push({ id, name, format, width: media.width, height: media.height, frames: media.frames, createdAt: Date.now() })
            importResource(mediaPath(pickBubbleImgDir(), id, format), buf, () => writeBubbleImgIndex(index), { fs })
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(bubbleImgPayload()))
            return
          }
          if (action === 'delete') {
            const id = String(parsed.id || '')
            if (!validResourceId(id)) throw new Error('图片编号无效')
            const img = index.images.find((x) => x.id === id)
            if (!img) {
              res.writeHead(404, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'image not found' }))
              return
            }
            const original = structuredClone(index)
            index.images = index.images.filter((x) => x.id !== id)
            const ext = img.format === 'gif' ? 'gif' : 'png'
            deleteResource(mediaPath(pickBubbleImgDir(), id, ext), () => writeBubbleImgIndex(index), () => writeBubbleImgIndex(original), { fs })
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(bubbleImgPayload()))
            return
          }
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/bubble-img.png',
      handler: (req, res) => {
        try {
          const id = bubbleImgIdFromUrl(req.url)
          if (!validResourceId(id)) throw new Error('图片编号无效')
          // 1) 用户图库优先
          const index = readBubbleImgIndex()
          const img = index.images.find((x) => x.id === id)
          if (img) {
            const ext = img.format === 'gif' ? 'gif' : 'png'
            const bytes = readMediaBytes(mediaPath(pickBubbleImgDir(), id, ext), MEDIA_POLICY.bubbleBytes)
            res.writeHead(200, {
              'Content-Type': img.format === 'gif' ? 'image/gif' : 'image/png',
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
          // 2) 内置默认图回退(全新安装无用户图库时,泡泡序列引用的语义 id 也能出图)
          const def = DEFAULT_BUBBLE_IMGS.find((x) => x.id === id)
          if (def) {
            const bytes = loadBuiltinBubbleImgBytes(def)
            if (bytes) {
              res.writeHead(200, {
                'Content-Type': def.format === 'gif' ? 'image/gif' : 'image/png',
                'Cache-Control': 'no-store',
                'Content-Length': String(bytes.length),
              })
              res.end(bytes)
              return
            }
          }
          throw new Error('bad image id')
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('bubble image unavailable')
        }
      },
    }))

          disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/widget.js',
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadWidgetJs())
      },
    }))

    disposers.push(ctx.webServer.tapIndex((html) => {
      if (html.indexOf('/dsh-whale/widget.js') !== -1) return html
      const tag = '<script defer src="/dsh-whale/widget.js"></script>'
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
      return html + tag
    }))

    ctx.effect(() => () => {
      for (const d of disposers) {
        try { d() } catch (err) {}
      }
    })
  },
}

}
