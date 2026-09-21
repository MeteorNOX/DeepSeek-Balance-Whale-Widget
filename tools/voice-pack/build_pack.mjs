// 把生成好的语录 wav 打成一个语音包，落到真实 DSH_HOME（宿主路由就是从这里读的）
//
// 用法:
//   node build_pack.mjs --pack my-pack --label 示例语音包 --jobs jobs.json [--no-default] [--dry]
//   jobs.json: [{ "out": "<wav 路径>", "text": "语录文本" }, ...]（多出的字段忽略）
//
// 产出目录（跟随插件约定，不放 node_modules）：
//   <DSH_HOME>/whale-voice/packs/<packId>/manifest.json        清单（文本指纹 → 文件）
//   <DSH_HOME>/whale-voice/packs/<packId>/quote.001.<hash8>.wav
//   <DSH_HOME>/whale-voice/registry.json                       包注册表（upsert 本包，不删其它包）
//   <DSH_HOME>/whale-voice/config.json                         选中本包（--no-default 时不动）
//
// 幂等：重复跑会重建本包（清掉本包里已不在清单中的旧 wav），其它包原样保留。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const flag = (name) => argv.includes('--' + name)

const packId = arg('pack')
const voice = arg('voice', '')
const jobsFile = arg('jobs')
const HOME = arg('home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
const DRY = flag('dry')
const SET_DEFAULT = !flag('no-default')

if (!packId || !/^[a-z0-9._-]{1,64}$/.test(packId)) {
  console.error('需要 --pack <小写 id>（只允许 a-z0-9._-）')
  process.exit(1)
}
if (!jobsFile) {
  console.error('需要 --jobs <jobs.json>')
  process.exit(1)
}

const norm = (t) => String(t == null ? '' : t).normalize('NFC').replace(/\s+/g, ' ').trim()
const hashOf = (t) => createHash('sha256').update(norm(t), 'utf8').digest('hex')

// 读 wav 头（不引依赖）：采样率/声道/时长
function wavInfo(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path.basename(file)} 不是合法 WAV`)
  }
  let off = 12
  let fmt = null
  let dataLen = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      }
    } else if (id === 'data') {
      dataLen = size
    }
    off += 8 + size + (size % 2)
  }
  if (!fmt) throw new Error(`${path.basename(file)} 缺 fmt 块`)
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bits / 8)
  return { ...fmt, durationMs: bytesPerSec ? Math.round((dataLen / bytesPerSec) * 1000) : 0, bytes: buf.length }
}

// 读 PCM16 样本算整体 RMS（dBFS）：用于检查"同一句的多个变体响度是否接近"。
// 只支持 16bit 单/双声道（本项目的包都是这种），其它位深直接返回 null，不猜。
function wavRmsDb(file) {
  const buf = fs.readFileSync(file)
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), bits: buf.readUInt16LE(off + 22) }
    else if (id === 'data') data = buf.subarray(off + 8, off + 8 + size)
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data || fmt.bits !== 16) return null
  let sum = 0
  let n = 0
  for (let i = 0; i + 1 < data.length; i += 2) {
    const s = data.readInt16LE(i) / 32768
    sum += s * s
    n++
  }
  if (!n) return null
  const rms = Math.sqrt(sum / n)
  return rms > 0 ? 20 * Math.log10(rms) : -120
}

const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'))
const root = path.join(HOME, 'whale-voice')
const packDir = path.join(root, 'packs', packId)

const entries = []
const problems = []
for (const j of jobs) {
  // 指纹依据 **widget_text（挂件显示原文）**，不是念出来的文本：
  // 挂件原文含「↓」「QAQ」这类符号，清单必须按原文算，挂件改字才会自然不播。
  const hashText = norm(j.widget_text != null ? j.widget_text : (j.text || ''))
  const text = norm(j.text || '')
  if (!hashText) { problems.push(`${j.out}: 无文本，跳过`); continue }
  if (!j.out || !fs.existsSync(j.out)) { problems.push(`${j.out}: 文件不存在，跳过`); continue }
  let info
  try { info = wavInfo(j.out) } catch (e) { problems.push(`${j.out}: ${e.message}`); continue }
  const h = hashOf(hashText)
  entries.push({ text: hashText, spoken: text, hash: h, src: j.out, info })
}
if (!entries.length) {
  console.error('没有任何可用语料，中止。\n' + problems.join('\n'))
  process.exit(1)
}
// 同一句话可以有多条录音（多变体）：指纹相同 → 归到同一条 utterance 的 variants 里，
// 运行时随机播其中一个。顺序即优先级：第一条是主版本（file），其余按 .v2/.v3 命名。
// （旧行为是"重复只保留一条"，会把同一句的不同版本静默丢掉——2026-09-19 改为归并。）
const byHash = new Map()
for (const e of entries) {
  const hit = byHash.get(e.hash)
  if (hit) {
    hit.variants.push(e)
    problems.push(`「${e.text}」变体 ${hit.variants.length}：${path.basename(e.src)}`)
  } else {
    byHash.set(e.hash, { ...e, variants: [e] })
  }
}
const uniq = [...byHash.values()]

const manifest = {
  schemaVersion: 1,
  packId,
  label: arg('label', voice || packId),
  voice,
  engine: arg('engine', ''),
  format: 'wav',
  sampleRate: uniq[0].info.sampleRate,
  channels: uniq[0].info.channels,
  generatedAt: new Date().toISOString(),
  utterances: uniq.map((e, i) => {
    const id = `quote.${String(i + 1).padStart(3, '0')}`
    const hash8 = e.hash.slice(0, 8)
    const variants = e.variants.map((v, k) => ({
      file: k === 0 ? `${id}.${hash8}.wav` : `${id}.${hash8}.v${k + 1}.wav`,
      durationMs: v.info.durationMs,
      bytes: v.info.bytes,
    }))
    return {
      id,
      text: e.text,
      textHash: e.hash,
      // 语音实际念的文本（可能与原文不同：符号/表情已清洗）——只在排查"念的和显示的不一样"时有用
      spoken: e.spoken === e.text ? undefined : e.spoken,
      file: variants[0].file,
      durationMs: variants[0].durationMs,
      bytes: variants[0].bytes,
      // 只有多版本时才写 variants：单版本清单形状与 v1 完全一致（旧宿主读 file 即可）
      variants: variants.length > 1 ? variants : undefined,
    }
  }),
}

console.log(`包 ${packId}（${manifest.label}）: ${manifest.utterances.length} 条，${uniq[0].info.sampleRate}Hz/${uniq[0].info.channels}ch`)
let totalMs = 0
for (const u of manifest.utterances) totalMs += u.durationMs || 0
const multi = manifest.utterances.filter((u) => u.variants)
if (multi.length) {
  console.log(`多版本语录 ${multi.length} 条：` + multi.map((u) => `${u.id}×${u.variants.length}`).join(' '))
}
// 变体之间响度必须接近：实测差 2~3dB 就会被听成"过低/发闷"（哪怕音高其实更高）。
// 这里只告警不拦截——响度对不对最终由耳朵定，但不该让人在不知情的情况下去听。
for (const u of multi) {
  const srcs = uniq[manifest.utterances.indexOf(u)].variants.map((v) => v.src)
  const db = srcs.map((s) => { try { return wavRmsDb(s) } catch (e) { return null } }).filter((x) => x !== null)
  if (db.length > 1) {
    const spread = Math.max(...db) - Math.min(...db)
    console.log(`  ${u.id}「${u.text.slice(0, 10)}」变体响度 ${db.map((x) => x.toFixed(1)).join(' / ')} dBFS（极差 ${spread.toFixed(1)}dB）`
      + (spread > 1.5 ? '  ⚠ 超过 1.5dB，听感会被判成"忽大忽小/过低"' : ''))
  }
}
console.log(`总时长 ${(totalMs / 1000).toFixed(1)}s，总字节 ${(manifest.utterances.reduce((a, u) => a + u.bytes, 0) / 1024).toFixed(0)}KB`)
if (problems.length) console.log('注意:\n  ' + problems.join('\n  '))
if (DRY) { console.log('--dry：未写盘'); process.exit(0) }

// 写盘：先写 wav，再写 manifest，最后更新 registry / config
fs.mkdirSync(packDir, { recursive: true })
const keep = new Set()
for (const u of manifest.utterances) {
  keep.add(u.file)
  if (u.variants) for (const v of u.variants) keep.add(v.file)
}
for (const old of fs.readdirSync(packDir)) {
  if (old === 'manifest.json' || keep.has(old)) continue
  if (/\.wav$/i.test(old)) { fs.rmSync(path.join(packDir, old), { force: true }); console.log(`  清理旧片段 ${old}`) }
}
manifest.utterances.forEach((u, i) => {
  const srcs = uniq[i].variants.map((v) => v.src)
  const outs = u.variants ? u.variants.map((v) => v.file) : [u.file]
  outs.forEach((f, k) => fs.copyFileSync(srcs[k], path.join(packDir, f)))
})
fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8')

const regFile = path.join(root, 'registry.json')
let reg = { schemaVersion: 1, defaultPackId: packId, packs: [] }
try { reg = JSON.parse(fs.readFileSync(regFile, 'utf8')) } catch (err) {}
if (!Array.isArray(reg.packs)) reg.packs = []
const entry = { id: packId, label: manifest.label, manifest: `packs/${packId}/manifest.json`, enabled: true }
const at = reg.packs.findIndex((p) => p && p.id === packId)
if (at >= 0) reg.packs[at] = entry
else reg.packs.push(entry)
if (SET_DEFAULT || !reg.defaultPackId) reg.defaultPackId = packId
fs.mkdirSync(root, { recursive: true })
fs.writeFileSync(regFile, JSON.stringify(reg, null, 1), 'utf8')

if (SET_DEFAULT) {
  let cfg = { enabled: true, packId }
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')) } } catch (err) {}
  cfg.packId = packId
  if (cfg.enabled !== false) cfg.enabled = true
  cfg.updatedAt = new Date().toISOString()
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 1), 'utf8')
}

console.log(`写入 ${packDir}`)
console.log(`写入 ${regFile}（现有 ${reg.packs.length} 个包，默认 ${reg.defaultPackId}）`)
console.log(`当前选中包: ${packId}`)
