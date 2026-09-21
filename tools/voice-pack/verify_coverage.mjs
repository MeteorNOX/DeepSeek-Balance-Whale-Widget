// 覆盖率验收：挂件内置语录 ↔ 已安装语音包，逐条核对。
//
// 为什么必须有（真实事故）：语音包只配了 40 条，而挂件内置其实是 48 行/47 条唯一文本，
// 且有一条转录少抄了结尾的"..."——约 1/6 的概率弹出语录却没声音，而当时的测试全绿，
// 因为它拿"我自己转录的清单"去验"我自己打的包"，自洽但错的。
// 本脚本以**挂件源码**为唯一事实来源，去真实语音包里查指纹，因此能抓出这类漏配。
//
// 用法:
//   node verify_coverage.mjs [--widget <whale-widget.js>] [--home <DSH_HOME>] [--pack <packId>] [--transcription <jobs.json>]
// 退出码非 0 = 有语录没声音，或包里有挂件不会显示的条目。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : def
}
const WIDGET = arg('--widget', path.resolve(HERE, '..', '..', 'assets', 'whale-widget.js'))
const HOME = arg('--home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
const VOICE_ROOT = path.join(HOME, 'whale-voice')

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}

// —— 1. 挂件源码 → 权威语录 ——
const src = fs.readFileSync(WIDGET, 'utf8')
const s = src.indexOf('var BUBBLE_DEFAULT_ITEMS')
if (s < 0) { console.error(`在 ${WIDGET} 里找不到 BUBBLE_DEFAULT_ITEMS`); process.exit(1) }
const eq = src.indexOf('=', s)
let i = src.indexOf('[', eq)
let d = 0
let end = -1
for (let j = i; j < src.length; j++) {
  const c = src[j]
  if (c === '[') d++
  else if (c === ']') { d--; if (!d) { end = j; break } }
  else if (c === '"' || c === "'") {
    const q = c
    j++
    while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++ }
  }
}
const items = vm.runInNewContext('(' + src.slice(i, end + 1) + ')')
const lines = []
;(function collect(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(collect); return }
  if (node.kind === 'choice' && Array.isArray(node.options)) node.options.forEach((o) => collect(o && o.item))
  if (Array.isArray(node.modules)) {
    for (const m of node.modules) {
      if (m && m.type === 'random' && Array.isArray(m.lines)) {
        for (const ln of m.lines) if (ln && typeof ln.t === 'string' && ln.t.trim()) lines.push(ln.t)
      }
    }
  }
})(items)
t('能从挂件源码抠出内置语录', () => {
  if (!lines.length) throw new Error('一条都没抠出来（解析逻辑可能失效）')
})
const uniq = [...new Set(lines)]
console.log(`   挂件内置 ${lines.length} 行 → 去重 ${uniq.length} 条（不写死条数，避免"漏配却测试全绿"）`)

// —— 2. 指纹规则必须与前端运行时一致（NFC + 空白归一化）——
const normalize = (text) => String(text == null ? '' : text).normalize('NFC').replace(/\s+/g, ' ').trim()
const fingerprint = (text) => createHash('sha256').update(normalize(text), 'utf8').digest('hex')

// —— 3. 真实语音包 ——
const regPath = path.join(VOICE_ROOT, 'registry.json')
t(`注册表存在（${regPath}）`, () => { if (!fs.existsSync(regPath)) throw new Error('不存在：先跑 build_pack.mjs') })
const registry = JSON.parse(fs.readFileSync(regPath, 'utf8'))
const cfgPath = path.join(VOICE_ROOT, 'config.json')
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}
const packId = arg('--pack', '') || cfg.packId || registry.selectedPackId || (registry.packs && registry.packs[0] && registry.packs[0].id)
const manPath = path.join(VOICE_ROOT, 'packs', packId, 'manifest.json')
t(`选中包清单存在（pack=${packId}）`, () => { if (!fs.existsSync(manPath)) throw new Error('不存在：' + manPath) })
const man = JSON.parse(fs.readFileSync(manPath, 'utf8'))
const byHash = new Map(man.utterances.map((u) => [u.textHash, u]))

const missing = []
const badFile = []
let covered = 0
let variantTotal = 0
for (const text of uniq) {
  const u = byHash.get(fingerprint(text))
  if (!u) { missing.push(text); continue }
  // 一条语录可以有多个变体（运行时随机播）：variants **已包含主版本**（variants[0].file === file），
  // 所以有 variants 时直接用它，不要再把 file 拼一遍（否则会误判"同一句重复变体"）。
  const parts = Array.isArray(u.variants) && u.variants.length ? u.variants : [{ file: u.file, bytes: u.bytes }]
  variantTotal += parts.length
  const bad = parts.filter((p) => {
    const f = path.join(VOICE_ROOT, 'packs', packId, p.file)
    return !fs.existsSync(f) || (Number.isFinite(p.bytes) && fs.statSync(f).size !== p.bytes)
  })
  if (bad.length) badFile.push(`${text}（缺/坏：${bad.map((b) => b.file).join(', ')}）`)
  else covered++
}
t(`挂件内置语录全部命中语音包（${covered}/${uniq.length}，含变体共 ${variantTotal} 个片段）`, () => {
  if (missing.length) throw new Error(`有 ${missing.length} 条弹出时会没声音：\n        ` + missing.join('\n        '))
  if (badFile.length) throw new Error(`片段缺失/字节不符：` + badFile.join(' | '))
})
t('多变体完整性（同一句的变体文件互不重复、且都在包目录内）', () => {
  const seenFiles = new Set()
  for (const u of man.utterances) {
    const parts = Array.isArray(u.variants) && u.variants.length ? u.variants : [{ file: u.file }]
    const local = new Set()
    for (const p of parts) {
      if (!p.file || typeof p.file !== 'string') throw new Error(`${u.id} 有变体缺 file 字段`)
      if (local.has(p.file)) throw new Error(`${u.id} 同一句出现重复变体文件 ${p.file}`)
      local.add(p.file)
      if (seenFiles.has(p.file)) throw new Error(`${p.file} 被多条语录共用（会串味）`)
      seenFiles.add(p.file)
      const abs = path.resolve(path.join(VOICE_ROOT, 'packs', packId), p.file)
      if (path.relative(path.join(VOICE_ROOT, 'packs', packId), abs).startsWith('..')) {
        throw new Error(`${p.file} 逃出包目录`)
      }
    }
  }
})
t('包内没有挂件不会显示的条目', () => {
  const keep = new Set(uniq.map(fingerprint))
  const extra = man.utterances.filter((u) => !keep.has(u.textHash))
  if (extra.length) throw new Error(`多出 ${extra.length} 条：` + extra.map((u) => u.id).join(' '))
})

// —— 4. 可选：与生成时的转录清单交叉核对（抓"手工转录抄错字"）——
const trans = arg('--transcription', '')
if (trans && fs.existsSync(trans)) {
  const jobs = JSON.parse(fs.readFileSync(trans, 'utf8'))
  const mine = new Set(jobs.map((j) => j.widget_text).filter(Boolean))
  t('转录清单与挂件源码逐字一致（含 ↓ 等符号）', () => {
    const miss = uniq.filter((x) => !mine.has(x))
    const extra = [...mine].filter((x) => !uniq.includes(x))
    if (miss.length || extra.length) {
      throw new Error(`挂件有转录没有 ${miss.length} 条 / 转录有挂件没有 ${extra.length} 条：\n        ` + [...miss, ...extra].join('\n        '))
    }
  })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败（包内 ${man.utterances.length} 条）`)
process.exit(fail ? 1 : 0)
