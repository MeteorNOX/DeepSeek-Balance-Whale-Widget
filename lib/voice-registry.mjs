// voice-registry.mjs —— 语录配音的语音包注册表（宿主侧，零依赖）
//
// 职责边界：只做「发现语音包 → 校验清单 → 按文本指纹解析出可安全读取的 WAV 路径」，
// 不碰 HTTP、不碰播放、不碰 UI。任何异常都收敛成「不可用」，绝不向上抛。
//
// 目录约定（跟随插件既有约定：用户资源放 DSH_HOME，不放 node_modules）：
//   <DSH_HOME>/whale-voice/registry.json          有哪些语音包
//   <DSH_HOME>/whale-voice/packs/<packId>/manifest.json   包内清单（语录↔文件）
//   <DSH_HOME>/whale-voice/packs/<packId>/quote-*.wav     语音文件
//
// 绑定策略：**文本指纹**（NFC + 空白归一 + sha256）。
//   语录是可被用户随时改文案的，所以「同一句话」才是唯一可靠的键；文案一改，指纹不匹配 → 静默不播，
//   绝不会出现「显示的文字和播出的语音不是同一句」。清单里同时保留 id/text 只作诊断与将来做
//   「重新生成变了的那几句」时的锚点，不参与匹配。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

export const VOICE_DIR_NAME = 'whale-voice'
export const REGISTRY_NAME = 'registry.json'
export const CONFIG_NAME = 'config.json'
export const PACKS_DIR_NAME = 'packs'
export const MANIFEST_NAME = 'manifest.json'
export const SCHEMA_VERSION = 1
const ID_RE = /^[a-z0-9._-]{1,64}$/

// —— 文本归一：必须与前端 whale-voice-runtime.js 的实现逐字一致 ——
export function normalizeVoiceText(text) {
  return String(text == null ? '' : text).normalize('NFC').replace(/\s+/g, ' ').trim()
}

export function hashVoiceText(text) {
  return createHash('sha256').update(normalizeVoiceText(text), 'utf8').digest('hex')
}

// 语音根目录：沿用 whale-audio / whale-roles 的「第一个可写候选」约定
export function getVoiceRoot(homeDir) {
  const home = homeDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const candidates = [
    path.join(home, VOICE_DIR_NAME),
    path.join(home, 'profiles', 'web', VOICE_DIR_NAME),
  ]
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        fs.accessSync(dir, fs.constants.W_OK)
        return dir
      }
    } catch (err) { /* 试下一个 */ }
  }
  return candidates[0]
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return null
  }
}

function safeId(v) {
  return typeof v === 'string' && ID_RE.test(v) ? v : null
}

// 注册表：缺失/损坏/字段不合法 → 返回空壳（插件照常启动，只是没有语音包）
export function loadRegistry(homeDir) {
  const empty = { schemaVersion: SCHEMA_VERSION, defaultPackId: null, packs: [] }
  const raw = readJson(path.join(getVoiceRoot(homeDir), REGISTRY_NAME))
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.packs)) return empty
  const packs = []
  for (const p of raw.packs) {
    if (!p || typeof p !== 'object') continue
    const id = safeId(p.id)
    if (!id) continue
    const manifest = typeof p.manifest === 'string' && p.manifest ? p.manifest : path.posix.join(PACKS_DIR_NAME, id, MANIFEST_NAME)
    packs.push({
      id,
      label: typeof p.label === 'string' && p.label ? p.label : id,
      manifest,
      enabled: p.enabled !== false,
    })
  }
  const def = safeId(raw.defaultPackId)
  return {
    schemaVersion: SCHEMA_VERSION,
    defaultPackId: packs.some((p) => p.id === def) ? def : (packs[0] ? packs[0].id : null),
    packs,
  }
}

// 清单里的 manifest 相对路径必须在语音根目录内（挡路径穿越）
function manifestPath(homeDir, rel) {
  const root = getVoiceRoot(homeDir)
  const abs = path.resolve(root, rel)
  const relCheck = path.relative(root, abs)
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null
  return abs
}

export function loadManifest(homeDir, packId) {
  const reg = loadRegistry(homeDir)
  const pack = reg.packs.find((p) => p.id === packId)
  if (!pack || !pack.enabled) return null
  const abs = manifestPath(homeDir, pack.manifest)
  if (!abs) return null
  const raw = readJson(abs)
  if (!raw || !Array.isArray(raw.utterances)) return null
  const dir = path.dirname(abs)
  const utterances = []
  const byHash = new Map()
  for (const u of raw.utterances) {
    if (!u || typeof u !== 'object') continue
    const file = typeof u.file === 'string' ? u.file : ''
    if (!file) continue
    // 文件必须是包目录内的普通文件：不允许绝对路径 / ..
    const insidePack = (rel) => {
      const abs = path.resolve(dir, rel)
      const r = path.relative(dir, abs)
      if (r.startsWith('..') || path.isAbsolute(r)) return null
      try { return fs.statSync(abs).isFile() ? abs : null } catch (err) { return null }
    }
    const absFile = insidePack(file)
    if (!absFile) continue // 主文件缺失 → 该条不可用，其余条目照常
    // —— 多变体：同一句可以有多条录音，运行时随机播其中一个 ——
    // 兼容：没有 variants 字段时就是单版本（files 只有一个）。变体文件缺失的逐个跳过，
    // 只要主版本还在，这条语录就仍然可播（绝不因为某个变体丢了就整条静音）。
    const primaryStat = fs.statSync(absFile)
    const files = [{ file: absFile, bytes: primaryStat.size, durationMs: Number.isFinite(u.durationMs) ? Math.round(u.durationMs) : null }]
    const variants = Array.isArray(u.variants) ? u.variants : []
    for (let vi = 0; vi < variants.length; vi++) {
      const v = variants[vi]
      const vf = v && typeof v.file === 'string' ? insidePack(v.file) : null
      if (!vf || vf === absFile) continue
      const st = fs.statSync(vf)
      files.push({ file: vf, bytes: st.size, durationMs: Number.isFinite(v && v.durationMs) ? Math.round(v.durationMs) : null })
    }
    const text = typeof u.text === 'string' ? u.text : ''
    const hash = typeof u.textHash === 'string' && u.textHash ? u.textHash : (text ? hashVoiceText(text) : '')
    if (!hash) continue
    const item = {
      id: safeId(u.id) || `u${utterances.length + 1}`,
      text,
      textHash: hash,
      file: absFile,
      files,
      bytes: primaryStat.size,
      durationMs: files[0].durationMs,
    }
    utterances.push(item)
    if (!byHash.has(hash)) byHash.set(hash, item)
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    packId: pack.id,
    label: typeof raw.label === 'string' && raw.label ? raw.label : pack.label,
    voice: typeof raw.voice === 'string' ? raw.voice : '',
    engine: typeof raw.engine === 'string' ? raw.engine : '',
    format: typeof raw.format === 'string' ? raw.format : 'wav',
    sampleRate: Number.isFinite(raw.sampleRate) ? raw.sampleRate : 48000,
    channels: Number.isFinite(raw.channels) ? raw.channels : 1,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    utterances,
    byHash,
  }
}

// —— 语音开关与选中音色包：单独一个 config.json ——
// 为什么不塞进 .dshw-size.json：那是挂件尺寸/音效的位置参数串（writeSizeConfig 已是 12 个位置参数），
// 再往里面加字段会让每次调用都要多传两个参数，且语音资源与语音配置分居两处。这里按"资源与配置同居"收在一起。
// 缺省语义：enabled 缺省 = true（真装了语音包才可能出声；没装包时启用与否都不影响任何行为）。
export function readVoiceConfig(homeDir) {
  const raw = readJson(path.join(getVoiceRoot(homeDir), CONFIG_NAME))
  const cfg = { enabled: true, packId: null }
  if (!raw || typeof raw !== 'object') return cfg
  if (raw.enabled === false) cfg.enabled = false
  else if (raw.enabled === true) cfg.enabled = true
  const id = safeId(raw.packId)
  if (id) cfg.packId = id
  return cfg
}

export function writeVoiceConfig(homeDir, patch) {
  const root = getVoiceRoot(homeDir)
  const cur = readVoiceConfig(homeDir)
  const next = {
    enabled: patch && patch.enabled === false ? false : (patch && patch.enabled === true ? true : cur.enabled),
    packId: patch && typeof patch.packId === 'string' ? (safeId(patch.packId) || null) : cur.packId,
  }
  try {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, CONFIG_NAME), JSON.stringify({
      enabled: next.enabled, packId: next.packId, updatedAt: new Date().toISOString(),
    }, null, 1), 'utf8')
    return { ok: true, ...next }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), ...next }
  }
}

// 只看「有哪些包、各多少条」——给 /voice-packs.json 用，不泄漏本地路径
export function listPacks(homeDir) {
  const reg = loadRegistry(homeDir)
  const cfg = readVoiceConfig(homeDir)
  const packs = []
  for (const p of reg.packs) {
    const m = p.enabled ? loadManifest(homeDir, p.id) : null
    packs.push({
      id: p.id,
      label: p.label,
      enabled: p.enabled,
      available: !!m,
      utterances: m ? m.utterances.length : 0,
      voice: m ? m.voice : '',
      engine: m ? m.engine : '',
      generatedAt: m ? m.generatedAt : '',
    })
  }
  const usable = packs.filter((p) => p.available && p.enabled)
  let selected = cfg.packId
  if (!selected || !usable.some((p) => p.id === selected)) {
    selected = usable.some((p) => p.id === reg.defaultPackId) ? reg.defaultPackId : (usable[0] ? usable[0].id : null)
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: cfg.enabled,
    selectedPackId: selected,
    defaultPackId: reg.defaultPackId,
    packs,
  }
}

// 给 /voice-pack-manifest.json 用：把绝对路径换成路由 URL
export function publicManifest(homeDir, packId) {
  const m = loadManifest(homeDir, packId)
  if (!m) return null
  return {
    schemaVersion: SCHEMA_VERSION,
    packId: m.packId,
    label: m.label,
    voice: m.voice,
    engine: m.engine,
    format: m.format,
    sampleRate: m.sampleRate,
    channels: m.channels,
    generatedAt: m.generatedAt,
    utterances: m.utterances.map((u) => {
      // 用**不带媒体扩展名**的 URL：实测本机 IDM 的"高级集成"会按 .wav/.mp3 扩展名拦截 fetch/XHR
      // 并返回 204 空响应（媒体元素播放不受影响，但没必要把功能押在那上面）。
      // 同一条数据另有 /dsh-whale/voice-fragment.wav 别名，两边内容一致。
      const urlOf = (idx) => `/dsh-whale/voice-audio?pack=${encodeURIComponent(m.packId)}&id=${encodeURIComponent(u.id)}`
        + (idx ? `&v=${idx}` : '')
      const files = Array.isArray(u.files) && u.files.length ? u.files : [{ file: u.file, bytes: u.bytes, durationMs: u.durationMs }]
      return {
        id: u.id,
        textHash: u.textHash,
        url: urlOf(0),
        // 多变体：前端随机挑一个播（不用连续重复同一条）；单版本时就是长度为 1 的数组
        urls: files.map((f, i) => urlOf(i)),
        bytes: files[0].bytes,
        durationMs: files[0].durationMs,
      }
    }),
  }
}

// 按文本指纹解析出一个可读 WAV 文件（播放路径的实际入口）
export function resolveByText(homeDir, packId, text) {
  const m = loadManifest(homeDir, packId)
  if (!m) return null
  const hit = m.byHash.get(hashVoiceText(text))
  if (!hit) return null
  return hit
}

// 按 utterance id 解析（/voice-fragment.wav 用）；variantIndex 选多变体里的第几个（默认主版本）
export function resolveById(homeDir, packId, utteranceId, variantIndex) {
  const m = loadManifest(homeDir, packId)
  if (!m) return null
  const id = safeId(utteranceId)
  if (!id) return null
  const u = m.utterances.find((x) => x.id === id)
  if (!u) return null
  const files = Array.isArray(u.files) && u.files.length ? u.files : [{ file: u.file, bytes: u.bytes, durationMs: u.durationMs }]
  const n = Number(variantIndex)
  const idx = Number.isFinite(n) && n >= 0 && n < files.length ? Math.floor(n) : 0
  const f = files[idx]
  return { id: u.id, text: u.text, textHash: u.textHash, file: f.file, bytes: f.bytes, durationMs: f.durationMs, variant: idx, variants: files.length }
}

// 诊断：给日志/自检用
export function describe(homeDir) {
  const reg = loadRegistry(homeDir)
  return {
    root: getVoiceRoot(homeDir),
    defaultPackId: reg.defaultPackId,
    packs: listPacks(homeDir).packs,
  }
}
