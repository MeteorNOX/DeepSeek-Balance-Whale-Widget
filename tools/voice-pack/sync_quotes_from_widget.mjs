// 从挂件源码同步权威语录清单。
//
// 为什么必须有这步（真实事故）：语音包漏配 8 条语录、还有 1 条少抄了结尾的"..."，
// 结果是弹出语录没声音，而"自己验自己"的测试全绿。根因是**语录清单靠手工转录**，
// 且各处写死"40 条"这个数字。语录的真正来源是挂件源码里的 BUBBLE_DEFAULT_ITEMS——
// 本脚本把它当唯一事实来源抠出来（含嵌套 choice 结构），以后改语录只需重跑本脚本。
//
// 用法:
//   node sync_quotes_from_widget.mjs [--widget <whale-widget.js>] [--carry <旧清单.json>] [-o 输出.json]
//   --carry 传上一版清单（含 bucket/vec）时，按文本沿用已有档位与情绪向量，只把新条目列为待归类。
// 退出码非 0 = 有条目尚未归类（需要人工填 bucket/vec），或一条都没解析出来。
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : def
}
const WIDGET = arg('--widget', path.resolve(HERE, '..', '..', 'assets', 'whale-widget.js'))
const CARRY = arg('--carry', '')
const OUT = arg('-o', path.join(process.cwd(), 'quotes_from_widget.json'))

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

// 递归收集：choice 项的候选在 options[].item 里，random 模块的行在 modules[].lines[].t
const raw = []
;(function collect(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(collect); return }
  if (node.kind === 'choice' && Array.isArray(node.options)) node.options.forEach((o) => collect(o && o.item))
  if (Array.isArray(node.modules)) {
    for (const m of node.modules) {
      if (m && m.type === 'random' && Array.isArray(m.lines)) {
        for (const ln of m.lines) if (ln && typeof ln.t === 'string' && ln.t.trim()) raw.push({ t: ln.t, w: Number(ln.w) || 10 })
      }
    }
  }
})(items)

// 去重：同一句话可能被写在多处，指纹按文本算，只需一条语音
const seen = new Map()
for (const r of raw) if (!seen.has(r.t)) seen.set(r.t, r)
const lines = [...seen.values()]

// 从上一版清单沿用档位/情绪向量（按精确文本；再去掉结尾符号兜底"少抄了…"的旧条目）
const carry = CARRY && fs.existsSync(CARRY) ? JSON.parse(fs.readFileSync(CARRY, 'utf8')) : null
const carryQuotes = carry ? carry.quotes || carry : []
const strip = (t) => String(t).replace(/[\s…。！？~～,.!?、；;：:]+$/g, '')
const byText = new Map(carryQuotes.map((q) => [q.t, q]))
const byStrip = new Map()
for (const q of carryQuotes) if (!byStrip.has(strip(q.t))) byStrip.set(strip(q.t), q)

const out = []
const pending = []
lines.forEach((ln, idx) => {
  const src2 = byText.get(ln.t) || byStrip.get(strip(ln.t))
  const rec = { i: idx + 1, t: ln.t, w: ln.w }
  if (src2) { rec.bucket = src2.bucket; rec.vec = src2.vec; rec.carried = true } else { rec.carried = false; pending.push(ln.t) }
  out.push(rec)
})

const byBucket = {}
for (const q of out) if (q.bucket) byBucket[q.bucket] = (byBucket[q.bucket] || 0) + 1
fs.writeFileSync(OUT, JSON.stringify({
  _note: '权威清单：直接取自挂件源码 BUBBLE_DEFAULT_ITEMS（去重后）。改语录后重跑 sync_quotes_from_widget.mjs。',
  _source: WIDGET,
  _vec_dims: ['happy', 'angry', 'sad', 'fear', 'disgust', 'depressed', 'surprise', 'calm'],
  _bucket_count: byBucket,
  quotes: out,
}, null, 1), 'utf8')

console.log(`挂件内置 ${raw.length} 行 → 去重 ${lines.length} 条 → ${OUT}`)
console.log(`沿用档位 ${out.filter((q) => q.carried).length} 条；已归类 ${out.filter((q) => q.bucket).length} 条`)
if (pending.length) {
  console.error(`\n以下 ${pending.length} 条还没有档位/情绪向量，请补进清单后重跑（否则语音会缺这几条）：`)
  for (const t of pending) console.error('  ' + t)
  process.exit(1)
}
if (!out.length) { console.error('一条都没解析出来'); process.exit(1) }
console.log('档位分布:', JSON.stringify(byBucket))
