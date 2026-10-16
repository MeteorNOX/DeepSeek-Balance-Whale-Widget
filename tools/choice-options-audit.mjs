#!/usr/bin/env node
// tools/choice-options-audit.mjs —— 「并列步骤的候选不许被静默裁掉」行为回归（0 依赖，Node 直接跑）
//
// 背景：issue #263。手写 ~/.dsh/.dshw-bubble.json 把并列(choice)写成 3 个以上候选时，
//   运行期只用了前 2 个，第 3 个及以后的台词**永远不出现**，控制台与界面都没有任何提示；
//   同一类裁剪还藏在编辑器读配置那一趟（打开一次再保存 = 从配置里抹掉这些候选）。
//   这类问题的共同形态是：**配置合法、被静默丢弃、报错点离根因很远** —— 用户只能靠反复抽样
//   才发现"某句台词一次都不出现"，排查成本全在用户这边。
//
// 本脚本钉的是"行为"，不是"某一行长什么样"：它从 assets/whale-widget.js 里**逐字抽出真函数**
// （大括号配对，跳过字符串与注释），在 new Function 沙箱里用固定种子的 Math.random 跑：
//   ① 运行期映射（真 applyBubbleCfgSeq）：4 个候选 → 运行序列里就得有 4 个，权重与内容原样。
//   ② 可达性（把①的**映射产物**喂给真 bubblePickChoiceStep，抽两万次）：每个候选都必须出现过。
//      这就是 issue #263 的症状本身（"第 3 个一次都不出现"）。
//   ③ 权重（同样走真源码）：C 的 w=8 时被抽中次数必须远多于 A(w=1)。
//   ④ 编辑器"读配置→保存"整趟：把真源码里从 bubbleEditItems = [] 到 bubbleEditorSnap = … 那一段
//      逐字抽出来跑（它内联在两百行函数里，抽出来时套一层一次性 for 让 continue 合法），再把结果
//      喂给真 bubbleStepToSaved —— 2/3/4/5 个候选**逐个规模**都要求进出一致、权重不变，且只在
//      多于两个候选时 warn 一次。按规模参数化是必要的：只测 3 个的话，一个"裁到 3 个"的
//      退化写法会绿着过。
//   ⑤ 编辑动作不丢候选（会被本 PR 变成可达路径的四个动作）：真 bubbleSideSplitDrop 的
//      "拖到别的行"与"拖回本行"、真 bubbleUnpairStep（拆开）、真 bubbleDropToEnd —— 2/3/4/5 个
//      候选的行做完这些动作后，每个候选都必须还在（只允许换成单行/换次序，不允许消失）；
//      同时钉住 A/B 两候选行仍然"拖出即拆成两个单行"的设计没被带跑。
//   ⑥ 保存路径的组装循环（真 bubbleEditorSave 里那几行）也跑一遍，同样按 2/3/4/5 参数化：
//      有人把裁剪挪到调用处（而不是函数里）同样会被抓到。
//
// 抽取边界（说清哪里没盖到）：④ 的抽取端到 bubbleEditorSnap 那一行为止 —— 在读配置**之后**、
//   快照**之前**塞一段裁剪会被抓到，但塞在快照之后、或整体重写这一段（抽取锚点消失）则是
//   "脚本红着报抽取失败"，需要人来更新锚点。
//
// 为什么用行为断言而不是正则钉循环头：正则既脆（把循环变量 ci 改名成 idx 就误报）又漏
//   （循环头不动、身体里写 if (oi >= 2) break 就静默通过）。上面 ④⑤ 都是真跑那段代码，
//   两种写法都会被抓到。
//
// 已知边界（别当完备性证明）：
//   · 编辑器**只呈现** A/B 两侧是设计（bubbleChoiceRowUI 只渲染 s < 2 两组，bubbleEditSide
//     只在 0/1 取值）。本脚本不要求 UI 支持 N 个候选，只要求"不丢、不静默"。
//   · 函数/代码块靠名字与锚点文本抽取：改名会让本脚本红 —— 这是有意的，那时需要有人来更新
//     抽取规则，而不是让它悄悄放行。
//   · 覆盖不到：宿主侧 lib/index.js 对 .dshw-bubble.json 的读写、真实浏览器里的渲染与手势
//     （本脚本只跑前端挂件里的这些纯逻辑函数）。
//
// 用法：
//   node tools/choice-options-audit.mjs
//   node tools/choice-options-audit.mjs --root=<目录>   # 在别的检出上跑同一套（自证/复现用）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const rootArg = argv.find((a) => a.startsWith('--root='))
const ROOT = rootArg
  ? path.resolve(rootArg.slice('--root='.length))
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FRONT = 'assets/whale-widget.js'
const DRAWS = 20000
const READ_START = 'bubbleEditItems = []'
const READ_END = 'bubbleEditorSnap = JSON.stringify('
const SIZES = [2, 3, 4, 5, 6, 8]

// 抽取区段一旦引用到"本脚本没抽也没打桩"的标识符，报出来的会是 Node 的 "X is not defined" ——
// 那读起来像产品缺陷，其实是**审计脚本要更新**。这里把那类错误翻译成可执行的提示。
const explain = (e) => {
  const msg = String((e && e.message) || e)
  const m = /^([A-Za-z_$][A-Za-z0-9_$]*) is not defined$/.exec(msg)
  if (!m) return msg
  return msg + ' —— 抽取出来的那段代码引用了 ' + m[1] + '，而本脚本既没有抽它也没有打桩：'
    + '这是**审计脚本需要更新**（不是产品缺陷），把 ' + m[1] + ' 加进 NEEDED 列表或沙箱桩即可'
}
const fails = []
const pass = (m) => console.log('  \u2713 ' + m)
const fail = (m) => { fails.push(m); console.log('  \u2717 ' + m) }
const tagOfModule = (mods) => (mods && mods[0] && (mods[0].rows || [])[0]) || ''
const tagOfItem = (it) => tagOfModule(it && it.modules)
const tagOfBubble = (b) => tagOfModule(b && b.modules)
const tagsOfStep = (step) => (step && step.kind === 'choice' && Array.isArray(step.options))
  ? step.options.map((o) => tagOfItem(o && o.item))
  : [tagOfBubble(step)]

const file = path.join(ROOT, FRONT)
let text = ''
try {
  text = fs.readFileSync(file, 'utf8')
} catch (e) {
  console.log('读取失败：' + file + '（--root 指错了？）')
  process.exit(1)
}

// —— 抽函数：缩进感知，不认行号（行号会漂移，会逼着以后每个 PR 都来改这个文件）——
function funcSource(src, name) {
  const W = src.split('\n')
  const i = W.findIndex((l) => new RegExp('^[ \\t]*function ' + name + '\\s*\\(').test(l))
  if (i < 0) return null
  const opens = (W[i].match(/\{/g) || []).length
  const closes = (W[i].match(/\}/g) || []).length
  if (opens > 0 && opens === closes) return W[i] // 单行函数:别把后面的邻居一起吞进来
  const indent = (W[i].match(/^[ \t]*/) || [''])[0].length
  for (let k = i + 1; k < W.length; k++) {
    if (W[k].trim() === '}' && (W[k].match(/^[ \t]*/) || [''])[0].length <= indent) return W.slice(i, k + 1).join('\n')
  }
  return null
}

// —— 抽代码块：从锚点行起大括号配对，跳过字符串与注释（JS 里 { } 会出现在字符串/模板里）——
function blockSource(src, anchor) {
  const W = src.split('\n')
  const i = W.findIndex((l) => l.includes(anchor))
  if (i < 0) return null
  const body = W.slice(i).join('\n')
  let depth = 0, started = false, mode = 'code'
  for (let k = 0; k < body.length; k++) {
    const ch = body.charAt(k), nx = body.charAt(k + 1)
    if (mode === 'code') {
      if (ch === '/' && nx === '*') { mode = 'block'; k++; continue }
      if (ch === '/' && nx === '/') { mode = 'line'; k++; continue }
      if (ch === '"') { mode = 'dq'; continue }
      if (ch === "'") { mode = 'sq'; continue }
      if (ch === '\u0060') { mode = 'tpl'; continue }
      if (ch === '{') { depth++; started = true; continue }
      if (ch === '}') { depth--; if (started && depth === 0) return body.slice(0, k + 1); continue }
      continue
    }
    if (mode === 'block') { if (ch === '*' && nx === '/') { mode = 'code'; k++ } continue }
    if (mode === 'line') { if (ch === '\n') mode = 'code'; continue }
    if (mode === 'dq' || mode === 'sq' || mode === 'tpl') {
      const q = mode === 'dq' ? '"' : (mode === 'sq' ? "'" : '\u0060')
      if (ch === '\\') { k++; continue }
      if (ch === q) mode = 'code'
      continue
    }
  }
  return null
}

// —— 抽"读配置"整段：从 bubbleEditItems = [] 到 bubbleEditorSnap = JSON.stringify( 为止，括号配平 ——
//    （按规模参数化的断言就架在这一段上;锚点消失会红着报"抽取失败",不会静默放行）
function readRegionSource(src) {
  const W = src.split('\n')
  const starts = W.map((l, i) => (l.trim() === READ_START ? i : -1)).filter((i) => i >= 0)
  for (const s of starts) {
    let e = -1
    for (let k = s; k < Math.min(s + 120, W.length); k++) {
      if (W[k].includes(READ_END)) { e = k; break }
    }
    if (e < 0) continue
    const braces = (line) => (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
    let depth = 0
    for (let k = s; k < Math.min(e + 6, W.length); k++) {
      depth += braces(W[k])
      if (k >= e && depth <= 0) return W.slice(s, k + 1).join('\n')
    }
  }
  return null
}

const NEEDED = ['bubbleIsChoice', 'bubbleChoiceOptions', 'bubbleChoiceWeight', 'bubbleSingleFromItem', 'frameFieldsOf',
  'bubbleStepToBubble', 'applyBubbleCfgSeq', 'bubblePickChoiceStep', 'bubbleStepToSaved', 'bubbleSideSplitDrop',
  'bubbleUnpairStep', 'bubbleDropToEnd']
const fn = {}
for (const name of NEEDED) fn[name] = funcSource(text, name)
const readRegion = readRegionSource(text)
const saveLoop = saveLoopSource(text)
const missing = NEEDED.filter((n) => !fn[n])
if (missing.length) {
  for (const n of missing) fail('抽取失败：' + FRONT + ' 里找不到 function ' + n + '()（改名了？请更新本脚本，别放行）')
  console.log('\nchoice-options audit: ' + fails.length + ' 项不通过')
  process.exit(1)
}
if (!saveLoop) {
  fail('抽取失败：找不到保存时组装 payload 的那两行（var items = [] / items.push(bubbleStepToSaved(...))）—— 请更新本脚本，别放行')
  console.log('\nchoice-options audit: ' + fails.length + ' 项不通过')
  process.exit(1)
}
if (!readRegion) {
  fail('抽取失败：找不到编辑器读配置的那一段（锚点：' + READ_START + ' … ' + READ_END + '）—— 请更新本脚本，别放行')
  console.log('\nchoice-options audit: ' + fails.length + ' 项不通过')
  process.exit(1)
}

// 沙箱：只用真源码 + 显式桩。Math 换成固定种子，让本审计确定性（不 flaky）——
// 注意用 globalThis.Math 取原值：var Math 会提升，直接写 Math.max 会踩到自己的 undefined。
const PRELUDE = [
  'var __max = globalThis.Math.max, __round = globalThis.Math.round, __seed = 20261017',
  'var Math = { max: __max, round: __round, random: function () { __seed = (__seed * 1103515245 + 12345) % 2147483648; return __seed / 2147483648 } }',
].join('\n')

function buildRuntime() {
  return new Function([
    PRELUDE,
    'var bubbleSeq = null',
    'var bubbleCfg = null',
    'function syncFramesFromCfg() {}',
    fn.bubbleChoiceWeight,
    fn.applyBubbleCfgSeq,
    'return { setCfg: function (c) { bubbleCfg = c }, run: applyBubbleCfgSeq, seq: function () { return bubbleSeq } }',
  ].join('\n'))()
}

function buildPicker() {
  return new Function([PRELUDE, fn.bubbleChoiceOptions, fn.bubbleChoiceWeight, fn.bubblePickChoiceStep, 'return bubblePickChoiceStep'].join('\n'))()
}

function buildEditorRead() {
  return new Function([
    'var bubbleEditItems = []',
    'var bubbleEditorSnap = \'\'',
    'var bubbleLib = []',
    'var bubbleTapAdvChk = { checked: false }',
    'var __warns = []',
    'var console = { warn: function (m) { __warns.push(String(m)) } }',
    'function bubbleDefaultSecondModules() { return [] }',
    'function framesNow() { return { frames: [], defaultFrameId: \'\' } }',
    'function renderBubbleEditor() {}',
    fn.frameFieldsOf, fn.bubbleSingleFromItem, fn.bubbleChoiceWeight, fn.bubbleIsChoice, fn.bubbleChoiceOptions,
    'return function (list) {',
    '  __warns.length = 0',
    readRegion,
    '  return { items: bubbleEditItems, warns: __warns }',
    '}',
  ].join('\n'))()
}

function buildSaver() {
  return new Function([
    'function bubbleDefaultModules() { return [] }',
    'function bubbleRowsCanon() {}',
    fn.bubbleIsChoice, fn.bubbleChoiceOptions, fn.bubbleChoiceWeight, fn.bubbleStepToSaved,
    'return bubbleStepToSaved',
  ].join('\n'))()
}

function saveLoopSource(src) {
  const W = src.split('\n')
  const e = W.findIndex((l) => l.includes('items.push(bubbleStepToSaved(bubbleEditItems[i]))'))
  if (e < 0) return null
  let s = -1
  for (let k = e; k >= Math.max(0, e - 6); k--) {
    if (W[k].includes('var items = []')) { s = k; break }
  }
  if (s < 0) return null
  // 取到"这一段的括号重新配平"为止,所以把循环展开成 { … } 块(或有人在里面加行)也抽得完整
  const braces = (line) => (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
  let depth = 0
  for (let k = s; k < Math.min(s + 16, W.length); k++) {
    depth += braces(W[k])
    if (k >= e && depth <= 0) return W.slice(s, k + 1).join('\n')
  }
  return null
}

function buildSaveLoop() {
  return new Function([
    'var bubbleEditItems = []',
    'function bubbleDefaultModules() { return [] }',
    'function bubbleRowsCanon() {}',
    fn.bubbleIsChoice, fn.bubbleChoiceOptions, fn.bubbleChoiceWeight, fn.bubbleStepToSaved,
    'return function (editItems) {',
    '  bubbleEditItems = editItems',
    saveLoop,
    '  return items',
    '}',
  ].join('\n'))()
}

function buildEditActions() {
  return new Function([
    'var bubbleEditItems = []',
    'var bubbleMainDragIdx = null',
    'var bubbleMainDragSide = -1',
    'var bubbleDropZone = \'\'',
    'function renderBubbleMore() {}',
    'function bubbleDefaultModules() { return [] }',
    fn.bubbleIsChoice, fn.bubbleChoiceOptions, fn.bubbleSingleFromItem, fn.bubbleStepToBubble,
    fn.bubbleSideSplitDrop, fn.bubbleUnpairStep, fn.bubbleDropToEnd,
    'return {',
    '  set: function (items) { bubbleEditItems = items },',
    '  items: function () { return bubbleEditItems },',
    '  split: bubbleSideSplitDrop,',
    '  unpair: bubbleUnpairStep,',
    '  drag: function (i, s) { bubbleMainDragIdx = i; bubbleMainDragSide = s; bubbleDropZone = \'\' },',
    '  toEnd: bubbleDropToEnd',
    '}',
  ].join('\n'))()
}

const candidate = (tag, w) => ({ w: w, item: { kind: 'custom', modules: [{ type: 'text', rows: [tag] }] } })
const single = (tag) => ({ kind: 'custom', modules: [{ rows: [tag] }] })
const TAG = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
const expectedTags = (n) => TAG.slice(0, n).join(',')
const expectedWeights = (n) => Array.from({ length: n }, (_, i) => i + 1).join(',')
const makeOpts = (n) => Array.from({ length: n }, (_, i) => candidate(TAG[i], i + 1))
const mapThroughRuntime = (options) => {
  const rt = buildRuntime()
  rt.setCfg({ items: [{ kind: 'choice', options }] })
  rt.run()
  const seq = rt.seq()
  return (seq && seq[0]) || null
}
const tally = (tags) => {
  const counts = {}
  for (const t of tags) if (t) counts[t] = (counts[t] || 0) + 1
  return counts
}

console.log('choice-options audit (issue #263) against ' + FRONT)

// ① 运行期映射：几个候选就留几个，权重与内容原样
try {
  const mapped = mapThroughRuntime([candidate('A', 1), candidate('B', 1), candidate('C', 1), candidate('D', 1)])
  if (!mapped || mapped.kind !== 'choice') {
    fail('运行期映射：配置项没有变成 choice 步骤（拿到 ' + JSON.stringify(mapped) + '）')
  } else {
    if (mapped.options.length === 4) pass('运行期映射保留全部 4 个候选')
    else fail('运行期映射只保留 ' + mapped.options.length + ' / 4 个候选 —— 配置里写了却用不上')
    const tags = mapped.options.map((o) => tagOfItem(o.item)).join(',')
    if (tags === 'A,B,C,D') pass('每个候选的内容原样带过（A,B,C,D）')
    else fail('候选内容在映射中丢失/错位：期望 A,B,C,D，实际 ' + tags)
  }
  const weighted = mapThroughRuntime([candidate('A', 1), candidate('B', 1), candidate('C', 8), candidate('D', 2)])
  const weights = weighted ? weighted.options.map((o) => o.w).join(',') : '(无)'
  if (weights === '1,1,8,2') pass('每个候选的权重原样带过（1,1,8,2）')
  else fail('候选权重在映射中被改动：期望 1,1,8,2，实际 ' + weights)
} catch (e) {
  fail('运行期映射检查抛错：' + explain(e))
}

// ② 可达性：把①的映射产物喂给真 picker，等权 3 个候选抽两万次 —— 每个都必须出现过
try {
  const pick = buildPicker()
  const step = mapThroughRuntime([candidate('A', 1), candidate('B', 1), candidate('C', 1)])
  const seen = { A: 0, B: 0, C: 0 }
  for (let i = 0; i < DRAWS; i++) {
    const tag = tagOfModule(pick(step) && pick(step).modules)
    if (tag && seen[tag] !== undefined) seen[tag]++
  }
  const dead = ['A', 'B', 'C'].filter((k) => seen[k] === 0)
  if (!dead.length) pass('抽 ' + DRAWS + ' 次，3 个候选全部可达（A=' + seen.A + ' B=' + seen.B + ' C=' + seen.C + '）')
  else fail('抽 ' + DRAWS + ' 次后仍有候选一次都不出现：' + dead.join(',') + ' —— 这就是 issue #263 的症状')
} catch (e) {
  fail('可达性检查抛错：' + explain(e))
}

// ③ 权重仍然生效：C(w=8) 必须远多于 A(w=1)（走同一条真源码路径）
try {
  const pick = buildPicker()
  const step = mapThroughRuntime([candidate('A', 1), candidate('B', 1), candidate('C', 8)])
  if (!step) {
    fail('权重检查跳过：映射没有产出 choice 步骤')
  } else {
    let a = 0, c = 0
    for (let i = 0; i < DRAWS; i++) {
      const tag = tagOfModule(pick(step).modules)
      if (tag === 'C') c++
      else if (tag === 'A') a++
    }
    if (c > a * 3) pass('权重仍然生效（C(w=8)=' + c + ' 次 vs A(w=1)=' + a + ' 次）')
    else fail('权重没有生效：C(w=8)=' + c + ' 次，A(w=1)=' + a + ' 次')
  }
} catch (e) {
  fail('权重检查抛错：' + explain(e))
}

// ④ 编辑器"读配置 → 保存"整趟（按 2/3/4/5 个候选逐个规模 —— 只测一个规模会漏掉"裁到 3 个"这种退化）
try {
  const read = buildEditorRead()
  const save = buildSaver()
  const bad = []
  for (const n of SIZES) {
    const out = read([{ kind: 'choice', options: makeOpts(n) }])
    const row = out.items && out.items[0]
    const readKept = row && row.kind === 'choice' && Array.isArray(row.options) ? row.options.length : -1
    const saved = row ? save(row) : null
    const savedKept = saved && Array.isArray(saved.options) ? saved.options.length : -1
    const savedTags = saved && Array.isArray(saved.options) ? saved.options.map((o) => tagOfItem(o.item)).join(',') : ''
    const savedWeights = saved && Array.isArray(saved.options) ? saved.options.map((o) => o.w).join(',') : ''
    const warnCount = (out.warns || []).length
    const ok = readKept === n && savedKept === n && savedTags === expectedTags(n) && savedWeights === expectedWeights(n) && warnCount === (n > 2 ? 1 : 0)
    if (!ok) bad.push(n + ' 个: 读=' + readKept + ' 存=' + savedKept + ' 内容[' + savedTags + '] 权重[' + savedWeights + '] warn=' + warnCount)
  }
  if (!bad.length) pass('读配置 → 保存：' + SIZES.join('/') + ' 个候选各自进出一致（内容与权重原样，warn 只在多于两个时打一次）')
  else fail('读 → 存往返在这些规模出问题：' + bad.join('；'))
} catch (e) {
  fail('编辑器往返检查抛错：' + explain(e))
}

// ⑤ 编辑动作不丢候选（四个动作 × 2/3/4/5 个候选）
try {
  const a = buildEditActions()
  const flatTags = (items) => items.reduce((acc, it) => acc.concat(tagsOfStep(it)), [])
  const runAction = (items, act) => { a.set(items); act(); return a.items() }
  const loses = []
  for (const n of SIZES) {
    const wantWithX = expectedTags(n).split(',').concat(['X'])
    const wantSolo = expectedTags(n).split(',')
    const check = (label, after, want) => {
      const counts = tally(flatTags(after))
      const missing = want.filter((tag) => counts[tag] !== 1)
      if (missing.length) loses.push(n + ' 个候选 · ' + label + ' 丢了 ' + missing.join(','))
    }
    check('拖到别的行(A 侧)', runAction([{ kind: 'choice', options: makeOpts(n) }, single('X')], () => a.split(0, 0, 1, 'before')), wantWithX)
    check('拖到别的行(末侧)', runAction([{ kind: 'choice', options: makeOpts(n) }, single('X')], () => a.split(0, n - 1, 1, 'before')), wantWithX)
    check('拖回本行', runAction([{ kind: 'choice', options: makeOpts(n) }], () => a.split(0, Math.min(1, n - 1), 0, 'before')), wantSolo)
    check('拆开', runAction([{ kind: 'choice', options: makeOpts(n) }], () => a.unpair(0)), wantSolo)
    check('拖到队列末尾', runAction([single('X'), { kind: 'choice', options: makeOpts(n) }], () => { a.drag(1, 0); a.toEnd() }), wantWithX)
  }
  if (!loses.length) pass('四个编辑动作 × ' + SIZES.join('/') + ' 个候选：一个候选都没丢（拖到别的行两种侧 / 拖回本行 / 拆开 / 拖到队列末尾）')
  else fail('编辑动作丢候选：' + loses.join('；'))

  // 设计不变:A/B 两候选行拖到别的行 → 仍然拆成两个单行
  const ab = runAction([{ kind: 'choice', options: makeOpts(2) }, single('X')], () => a.split(0, 0, 1, 'before'))
  const counts = tally(flatTags(ab))
  const stillChoice = ab.some((it) => it.kind === 'choice')
  if (['A', 'B', 'X'].every((tag) => counts[tag] === 1) && !stillChoice) pass('A/B 两候选行拖出 → 仍是拆成两个单行（设计未变）')
  else fail('A/B 语义被改动：候选 ' + JSON.stringify(counts) + '，仍存在并列行=' + stillChoice)
} catch (e) {
  fail('编辑动作检查抛错：' + explain(e))
}

// ⑥ 保存路径的组装循环（真代码）也按规模跑
try {
  const read = buildEditorRead()
  const assemble = buildSaveLoop()
  const bad = []
  for (const n of SIZES) {
    const row = read([{ kind: 'choice', options: makeOpts(n) }]).items[0]
    const payloadItems = assemble([row])
    const kept = payloadItems && payloadItems[0] && Array.isArray(payloadItems[0].options) ? payloadItems[0].options.length : -1
    if (kept !== n) bad.push(n + ' 个 → payload 里 ' + kept + ' 个')
  }
  if (!bad.length) pass('保存时组装的 payload：' + SIZES.join('/') + ' 个候选各自原样进 payload（真循环）')
  else fail('保存路径丢候选：' + bad.join('；'))
} catch (e) {
  fail('保存路径检查抛错：' + explain(e))
}

console.log('\nchoice-options audit: ' + (fails.length ? fails.length + ' 项不通过' : '全部通过'))
process.exit(fails.length ? 1 : 0)
