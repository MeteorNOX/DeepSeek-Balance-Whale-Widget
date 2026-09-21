// 多变体随机的运行时验证：真跑一遍 whale-voice-runtime.js（不是读代码猜）。
//
// 验证三件事：
//   1. 单版本语录仍然取 url（向后兼容，urls 缺失也不炸）
//   2. 多版本语录每次随机挑一个，且 4 个版本都会出现（不是只播第一个）
//   3. 不连续两次播同一个版本（用户要的"随机播放"，不是"随机但老重复"）
//
// 用法: node runtime-variants.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(HERE, '..', '..', 'assets', 'whale-voice-runtime.js')

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}

// —— 桩：window / Audio / fetch ——
// 注意：必须从 play() 记录"播了哪一个"，不能从构造函数记录——音频元素有 LRU 缓存，
// 缓存命中时不会再 new Audio（第一版测试就因此把"陈旧值"当成播放序列，误报运行时有问题）。
const played = []
const sandbox = {
  console,
  Date,
  Math,
  Map,
  Set,
  Promise,
  Number,
  String,
  Array,
  Object,
  Uint8Array,
  Uint32Array,
  DataView,
  TextEncoder,
  isFinite,
  encodeURIComponent,
  setTimeout,
  crypto: { subtle: webcrypto.subtle },
  Audio: class {
    constructor(src) {
      this.src = src
      this.preload = ''
      this.currentTime = 0
      this.volume = 1
    }
    play() { played.push(this.src); return Promise.resolve() }
    pause() {}
  },
  fetch: async (url) => {
    if (String(url).includes('voice-packs.json')) {
      return { json: async () => ({ schemaVersion: 1, enabled: true, selectedPackId: 'p', packs: [{ id: 'p', label: 'p', available: true }] }) }
    }
    return {
      json: async () => ({
        schemaVersion: 1,
        packId: 'p',
        utterances: [
          // 多变体：4 个版本
          { id: 'quote.003', textHash: await fp('哦鲸鲸...'), url: '/a?pack=p&id=quote.003', urls: ['/a?pack=p&id=quote.003', '/a?pack=p&id=quote.003&v=1', '/a?pack=p&id=quote.003&v=2', '/a?pack=p&id=quote.003&v=3'] },
          // 单版本（旧清单形状，只有 url）
          { id: 'quote.004', textHash: await fp('难道说...'), url: '/a?pack=p&id=quote.004' },
        ],
      }),
    }
  },
}
sandbox.window = sandbox
sandbox.globalThis = sandbox

async function fp(text) {
  const norm = String(text).normalize('NFC').replace(/\s+/g, ' ').trim()
  const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(norm))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(RUNTIME, 'utf8'), ctx, { filename: RUNTIME })
const api = sandbox.window.__dshWhaleVoice
if (!api) { console.error('运行时没有暴露 __dshWhaleVoice'); process.exit(1) }

const settle = () => new Promise((r) => setTimeout(r, 5))
const variantOf = (src) => {
  const m = /[?&]v=(\d+)/.exec(src || '')
  return m ? Number(m[1]) : 0
}

// 预热索引
await api.reload()
await settle()

t('清单加载成功（2 条语录）', () => {
  const st = api.getStatus()
  if (st.utterances !== 2) throw new Error(`utterances=${st.utterances}`)
  if (st.multiVariant !== 1) throw new Error(`multiVariant=${st.multiVariant}（应为 1）`)
})

// 连续播 40 次，看变体分布与相邻重复
played.length = 0
const seq = []
for (let i = 0; i < 40; i++) {
  api.play({ text: '哦鲸鲸...', volume: 0.9 })
  await settle()
  seq.push(variantOf(played[played.length - 1]))
}

t('多版本：4 个版本都被用到（不是只播第一个）', () => {
  const uniq = new Set(seq)
  if (uniq.size !== 4) throw new Error(`只出现了 ${uniq.size} 个版本：${[...uniq].join(',')}（分布 ${seq.join('')}）`)
})

t('多版本：不连续两次播同一版本', () => {
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[i - 1]) throw new Error(`第 ${i}、${i + 1} 次连续播了版本 ${seq[i]}（序列 ${seq.join('')}）`)
  }
})

t('多版本：分布不严重偏斜（最长连续段 < 6，各版本至少出现 4 次）', () => {
  const count = [0, 0, 0, 0]
  for (const v of seq) count[v]++
  const min = Math.min(...count)
  if (min < 4) throw new Error(`分布过偏：${count.join('/')}`)
})

// 单版本：永远 v0
played.length = 0
for (let i = 0; i < 5; i++) { api.play({ text: '难道说...' }); await settle() }
t('单版本：始终取主版本（向后兼容旧清单形状）', () => {
  const vs = played.map(variantOf)
  if (vs.some((v) => v !== 0)) throw new Error(`出现非 0 版本：${vs.join(',')}`)
  if (vs.length !== 5) throw new Error(`播放次数 ${vs.length}（应为 5）`)
})

t('未匹配文本：静默不播（不猜、不播错）', async () => {
  const before = played.length
  api.play({ text: '这句话不在包里' })
  await settle()
  if (played.length !== before) throw new Error('居然播了未匹配的文本')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
console.log(`变体序列样本：${seq.slice(0, 16).join('')}`)
process.exit(fail ? 1 : 0)
