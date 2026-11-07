// 0-dependency regression tests of the actual frontend helpers (no installed DSH is touched).
// Run from the repository root: node tools/role-lines-frontend-test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const filename = process.argv[2] || path.join(repo, 'assets', 'whale-widget.js')
const src = fs.readFileSync(filename, 'utf8')
const start = src.indexOf('// —— 角色独立台词：')
const end = src.indexOf('// —— 自定义角色：', start)
assert.ok(start >= 0 && end > start, 'The role-lines block must exist')
const roleBlock = src.slice(start, end)

// Extract function declarations while ignoring strings and comments. Targeted helpers
// contain no template-literal interpolation or regex braces, so no parser is required.
function extract(name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at >= 0, 'Missing frontend function: ' + name)
  let depth = 0
  let quote = ''
  let line = false
  let block = false
  const bodyAt = src.indexOf('{', at)
  for (let i = bodyAt; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (line) { if (c === '\n') line = false; continue }
    if (block) { if (c === '*' && n === '/') { block = false; i++ } continue }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue }
    if (c === '/' && n === '/') { line = true; i++; continue }
    if (c === '/' && n === '*') { block = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    if (c === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error('Unterminated function: ' + name)
}

const funcs = [
  'bubblePickLine', 'bubbleModuleText', 'bubbleRowContentOf',
  'bubbleCloneModule', 'bubbleDefaultSecondModules', 'applyRole', 'bubbleShowSeqNext',
].map(extract).join('\n')
const asPlain = value => JSON.parse(JSON.stringify(value))
const sampleRoles = () => ({
  version: 1, enabled: true, updatedAt: 0,
  roles: {
    A: { tag: 'test-A', lines: [{ text: '角色A句1' }, { text: '角色A句2' }] },
    B: { tag: 'test-B', lines: [{ text: '角色B句1' }, { text: '角色B句2' }] },
  },
})
const globalModule = source => ({
  type: 'random', ...(source === undefined ? {} : { randomSource: source }),
  lines: [
    { t: '全局句1', w: 1, color: '#123456', size: 6, bold: true, custom: { keep: true } },
    { t: '全局句2', w: 9, italic: true },
  ],
})
const roleOnlyModule = () => ({ type: 'random', randomSource: 'role', lines: [] })
function mixedCounts(box, rng, createModule, samples) {
  const counts = Object.create(null)
  for (let i = 0; i < samples; i++) {
    // A fresh module tests the initial equal-probability draw without last-line
    // exclusion. Stratify a single draw over the entire combined pool.
    rng.random = () => (i + 0.5) / samples
    const result = box.bubbleRandomContent(createModule())
    counts[result.txt] = (counts[result.txt] || 0) + 1
  }
  return { ...counts }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
function prepareEditor(box, value = '角色A新句', enabled = true) {
  box.roleLinesTextEl = { value, disabled: false }
  box.roleLinesEnabledEl = { checked: enabled, disabled: false }
  box.roleLinesStatusEl = { textContent: '', style: {} }
  box.roleLinesSaveBtn = { disabled: false }; box.roleLinesCancelBtn = { disabled: false }
  box.roleLinesMask = { style: { display: 'flex' } }; box.roleLinesEditorId = 'A'
}

function sandbox() {
  const storage = new Map([['dshw-role', 'A']])
  const listeners = new Map()
  const rng = Object.create(Math)
  rng.random = () => 0
  const box = {
    Math: rng, console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    window: { addEventListener: (type, fn) => {
      const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list)
    } },
    currentRole: { id: 'A', name: '角色A', url: '/A.png' },
    roleList: [{ id: 'A', name: '角色A', url: '/A.png' }, { id: 'B', name: '角色B', url: '/B.png' }],
    img: { src: '/A.png' }, setRoleBtnText() {}, setupHitTest() {}, closeRolePanel() {}, renderRolePanel() {},
    bubbleShown: true, bubbleScene: { kind: 'custom', ttlMs: 5000 }, bubbleLiveMods: [],
    bubbleSeqIdx: 2, bubbleSeq: [{ kind: 'normal' }, { kind: 'custom' }],
    bubbleTtlTimer: 77, bubbleTtlDeadline: 123456, bubbleRoundOn: true,
    rendered: [], renderCount: 0,
    BUBBLE_DEFAULT_ITEMS: [null, { options: [{ item: { modules: [globalModule()] } }] }],
    roleLinesTextEl: null,
    BUBBLE_MS: 5000,
    fetch: () => Promise.reject(new Error('Unexpected network request in test')),
    bubbleIsChoice: step => step.kind === 'choice',
    bubblePickChoiceStep: () => { throw new Error('Unexpected choice in test') },
    hideBubble: () => { throw new Error('Unexpected bubble hide in test') },
    bubbleRenderDefault() {},
    pickRandomLines: () => ['旧全局句1'],
    bubbleRenderRandom: lines => { box.legacyRendered = lines },
    sceneOpen: (kind, render, ttlMs) => { box.opened = { kind, ttlMs }; render() },
  }
  box.bubbleRenderModules = mods => {
    box.renderCount++
    box.bubbleLiveMods = mods.slice()
    box.rendered = mods.map(mod => box.bubbleRowContentOf(mod))
  }
  vm.createContext(box)
  vm.runInContext(roleBlock + '\n' + funcs, box, { filename })
  return { box, storage, listeners, rng }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('default configuration has no imported role lines and is disabled', () => {
  const { box } = sandbox()
  assert.equal(box.ROLE_LINES_REV_KEY, 'dshw-role-lines-revision')
  assert.equal(box.roleLinesCfg.enabled, false)
  assert.deepEqual(asPlain(box.roleLinesCfg.roles), {})
  assert.equal(box.roleLinesPool(), null)
})

test('read localStorage at every draw; role A/B takes effect immediately', () => {
  const { box, storage } = sandbox()
  box.roleLinesCfg = sampleRoles()
  const mod = roleOnlyModule()
  assert.equal(box.bubbleModuleText(mod), '角色A句1')
  storage.set('dshw-role', 'B')
  assert.equal(box.currentRole.id, 'A', 'Test keeps the cached role deliberately stale')
  assert.equal(box.bubbleRowContentOf(mod).txt, '角色B句1')
  storage.set('dshw-role', 'A')
  assert.equal(box.bubbleRowContentOf(mod).txt, '角色A句2')
})

test('missing and explicit global source preserve the weighted global pool', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = sampleRoles()
  for (const source of [undefined, 'global', 'invalid']) {
    const mod = globalModule(source)
    rng.random = () => 0.05
    assert.equal(box.bubbleRandomContent(mod).txt, '全局句1')
    rng.random = () => 0.2
    assert.equal(box.bubbleRandomContent(mod).txt, '全局句2')
  }
})

test('off, missing, empty, and invalid role pools fall back to global content', () => {
  const { box } = sandbox()
  for (const entry of [null, {}, { lines: [] }, { lines: 'bad' },
    { lines: [null, { text: 42 }, { text: '   ' }, { text: '超'.repeat(201) }] }]) {
    box.roleLinesCfg = { version: 1, enabled: true, roles: entry === null ? {} : { A: entry } }
    const mod = globalModule('role')
    const result = box.bubbleRandomContent(mod)
    assert.equal(result.txt, '全局句1')
    assert.strictEqual(result.line, mod.lines[0])
  }
  for (const enabled of [false, undefined, 'true']) {
    box.roleLinesCfg = sampleRoles(); box.roleLinesCfg.enabled = enabled
    assert.equal(box.bubbleRandomContent(globalModule('role')).txt, '全局句1')
  }
})

test('global fallback preserves line styles, extension metadata, and last pick', () => {
  const { box } = sandbox()
  const mod = globalModule('role')
  const expected = JSON.stringify(mod.lines)
  const result = box.bubbleRowContentOf(mod)
  assert.strictEqual(result.line, mod.lines[0])
  assert.equal(mod._lastPick, 0)
  assert.equal(JSON.stringify(mod.lines), expected)
  assert.equal(result.line.custom.keep, true)
})

test('empty and missing global arrays retain their original text fallback behavior', () => {
  const { box } = sandbox()
  for (const source of [undefined, 'global', 'role']) {
    const empty = { type: 'random', randomSource: source, lines: [], text: '旧文本' }
    const missing = { type: 'random', randomSource: source, text: '旧文本' }
    assert.equal(box.bubbleModuleText(empty), '')
    assert.equal(box.bubbleRowContentOf(empty).txt, '')
    assert.equal(box.bubbleModuleText(missing), '旧文本')
    assert.equal(box.bubbleRowContentOf(missing).txt, '旧文本')
  }
})

test('role text uses module style instead of an unrelated fallback line style', () => {
  const { box } = sandbox()
  box.roleLinesCfg = sampleRoles()
  const mod = roleOnlyModule()
  const result = box.bubbleRandomContent(mod)
  assert.equal(result.txt, '角色A句1')
  assert.equal(result.line, null)
  assert.equal(mod._lastPick, undefined)
})

test('every role and original global sentence has one unit of weight', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = sampleRoles()
  const counts = mixedCounts(box, rng, () => globalModule('role'), 120)
  assert.deepEqual(counts, { '角色A句1': 30, '角色A句2': 30, '全局句1': 30, '全局句2': 30 })
})

test('a new module using the actual shipped defaults can still draw a built-in global line', () => {
  const { box, rng } = sandbox()
  const defaultsAt = src.indexOf('var BUBBLE_DEFAULT_ITEMS = ')
  const defaultsEnd = src.indexOf('function bubbleParseDefaultItems(', defaultsAt)
  assert.ok(defaultsAt >= 0 && defaultsEnd > defaultsAt, 'Shipped defaults must be present')
  // Read only the plugin's own shipped defaults. This never imports conversation
  // text into a role pool and never reads or writes an installed plugin's data.
  vm.runInContext(src.slice(defaultsAt, defaultsEnd), box, { filename })
  box.roleLinesCfg = sampleRoles()
  const roleMod = box.bubbleNewRandomModule()
  assert.equal(roleMod.randomSource, 'role')
  assert.ok(roleMod.lines.length > 0)
  rng.random = () => 0
  assert.equal(box.bubbleRandomContent(roleMod).txt, '角色A句1')
  const globalMod = box.bubbleNewRandomModule()
  rng.random = () => 0.999999
  const result = box.bubbleRandomContent(globalMod)
  assert.ok(result.line, 'A shipped global sentence must remain reachable')
  assert.ok(globalMod.lines.includes(result.line))
  assert.equal(result.txt, result.line.t)
  assert.equal(globalMod._lastPick, globalMod.lines.indexOf(result.line))
  assert.deepEqual(asPlain(box.roleLinesCfg.roles.A.lines), [{ text: '角色A句1' }, { text: '角色A句2' }])
})

test('mixed draws retain every global style object while role-only draws use module styling', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = sampleRoles()
  const before = JSON.stringify(box.roleLinesCfg)
  const reached = new Set()
  for (const fraction of [0.125, 0.375, 0.625, 0.875]) {
    rng.random = () => fraction
    const mod = globalModule('role')
    mod.color = '#abcdef'; mod.size = 3
    const linesBefore = JSON.stringify(mod.lines)
    const result = box.bubbleRowContentOf(mod)
    reached.add(result.txt)
    if (result.txt.startsWith('全局')) {
      const index = mod.lines.findIndex(line => line.t === result.txt)
      assert.strictEqual(result.line, mod.lines[index])
      assert.equal(mod._lastPick, index)
    } else {
      assert.equal(result.line, null)
      assert.equal(mod._lastPick, undefined)
    }
    assert.equal(JSON.stringify(mod.lines), linesBefore)
    assert.equal(mod.color, '#abcdef')
    assert.equal(mod.size, 3)
  }
  assert.deepEqual([...reached].sort(), ['全局句1', '全局句2', '角色A句1', '角色A句2'].sort())
  assert.equal(JSON.stringify(box.roleLinesCfg), before)
})

test('mixed draws ignore saved negative, zero, numeric and fractional weights without rewriting them', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = { enabled: true, roles: { A: { lines: [{ text: '角色A句1', w: 999 }] } } }
  const create = () => ({ type: 'random', randomSource: 'role', lines: [
    { t: '全局负权重', w: -8 }, { t: '全局零权重', w: 0 },
    { t: '全局缺省权重' }, { t: '全局字符串权重', w: '3' }, { t: '全局小数权重', w: 2.5 },
  ] })
  assert.deepEqual(mixedCounts(box, rng, create, 120), {
    '角色A句1': 20, '全局负权重': 20, '全局零权重': 20,
    '全局缺省权重': 20, '全局字符串权重': 20, '全局小数权重': 20,
  })
  const mod = create(), before = JSON.stringify(mod.lines)
  box.bubbleRandomContent(mod)
  assert.equal(JSON.stringify(mod.lines), before)
})

test('cross-pool duplicate text gets one chance and retains its global style', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = { enabled: true, roles: { A: { lines: [
    { text: ' 共同测试句 ' }, { text: '角色A独有句' },
  ] } } }
  const create = () => ({ type: 'random', randomSource: 'role', lines: [
    { t: '共同测试句', w: 7, bold: false, color: '#234567', tags: ['global'] },
  ] })
  assert.deepEqual(mixedCounts(box, rng, create, 80), { '共同测试句': 40, '角色A独有句': 40 })
  for (let i = 0; i < 8; i++) {
    rng.random = () => (i + 0.5) / 8
    const mod = create(), result = box.roleLinesMixedContent(mod)
    if (result.txt === '共同测试句') {
      assert.strictEqual(result.line, mod.lines[0])
      assert.equal(result.line.bold, false)
      assert.deepEqual(result.line.tags, ['global'])
    }
  }
})

test('duplicate global text counts once and retains the first global style', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = { enabled: true, roles: { A: { lines: [{ text: '角色A独有句' }] } } }
  const create = () => ({ type: 'random', randomSource: 'role', lines: [
    { t: '全局重复句', w: 2, color: '#111111' },
    { t: ' 全局重复句 ', w: 200, color: '#222222' },
  ] })
  assert.deepEqual(mixedCounts(box, rng, create, 30), { '角色A独有句': 15, '全局重复句': 15 })
  rng.random = () => 0.99
  const mod = create(), result = box.bubbleRandomContent(mod)
  assert.strictEqual(result.line, mod.lines[0])
  assert.equal(result.line.color, '#111111')
})

test('mixed pools never repeat the same trimmed text consecutively under adversarial draws', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = { enabled: true, roles: { A: { lines: [
    { text: '共同测试句' }, { text: '角色A独有句' }, { text: ' 角色A独有句 ' },
  ] } } }
  const mod = { type: 'random', randomSource: 'role', lines: [
    { t: ' 共同测试句 ', w: 1000000000 },
    { t: '共同测试句', w: 1000000000 }, { t: '全局独有句', w: 1 },
  ] }
  for (const fraction of [0, 0.999999999]) {
    rng.random = () => fraction
    let last
    for (let i = 0; i < 1000; i++) {
      const result = box.bubbleRandomContent(mod, mod._lastPick)
      const text = result.txt.trim()
      assert.ok(['共同测试句', '角色A独有句', '全局独有句'].includes(text))
      assert.notEqual(text, last)
      last = text
    }
  }
})

test('a mixed pool with one distinct overlapping text remains usable repeatedly', () => {
  const { box } = sandbox()
  box.roleLinesCfg = { enabled: true, roles: { A: { lines: [
    { text: '单个共同测试句' }, { text: ' 单个共同测试句 ' },
  ] } } }
  const mod = { type: 'random', randomSource: 'role', lines: [
    { t: '单个共同测试句', w: 4, italic: true },
    { t: ' 单个共同测试句 ', w: 40, italic: false },
  ] }
  for (let i = 0; i < 100; i++) {
    const result = box.bubbleRandomContent(mod)
    assert.equal(result.txt, '单个共同测试句')
    assert.strictEqual(result.line, mod.lines[0])
  }
})

test('role changes immediately replace only the role portion of mixed eligibility', () => {
  const { box, storage, rng } = sandbox()
  box.roleLinesCfg = sampleRoles()
  for (const id of ['A', 'B', 'A']) {
    storage.set('dshw-role', id)
    const counts = mixedCounts(box, rng, () => globalModule('role'), 120)
    assert.deepEqual(counts, {
      ['角色' + id + '句1']: 30, ['角色' + id + '句2']: 30,
      '全局句1': 30, '全局句2': 30,
    })
  }
})

test('category weight equals sentence count for one, several and maximum-sized role pools', () => {
  const { box, rng } = sandbox()
  for (const size of [1, 2, 40, 500]) {
    box.roleLinesCfg = { enabled: true, roles: { A: { lines: Array.from({ length: size }, (_, i) => ({ text: '角色句' + i })) } } }
    const counts = mixedCounts(box, rng, () => ({ type: 'random', randomSource: 'role', lines: [
      { t: '全局句', w: 1000000 },
    ] }), (size + 1) * 4)
    assert.equal(counts['全局句'], 4)
    assert.equal(Object.entries(counts).filter(([text]) => text.startsWith('角色')).reduce((sum, [, count]) => sum + count, 0), size * 4)
    assert.ok(Object.values(counts).every(count => count === 4))
  }
})

test('two distinct sentences alternate rather than repeat a single-sentence category', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = { enabled: true, roles: { A: { lines: [{ text: '角色单句' }] } } }
  for (const fraction of [0.49, 0.5]) {
    const mod = { type: 'random', randomSource: 'role', lines: [{ t: '全局单句', w: 9 }] }
    rng.random = () => fraction
    const first = fraction < 0.5 ? '角色单句' : '全局单句'
    const second = fraction < 0.5 ? '全局单句' : '角色单句'
    for (let i = 0; i < 100; i++) assert.equal(box.bubbleRandomContent(mod).txt, i % 2 ? second : first)
  }
})

test('excluding the previous sentence leaves every remaining sentence equally likely', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = { enabled: true, roles: { A: { lines: [
    { text: '角色A上一句' }, { text: '角色A句2' }, { text: '角色A句3' },
  ] } } }
  const counts = {}
  for (let i = 0; i < 40; i++) {
    const mod = globalModule('role')
    rng.random = () => 0
    assert.equal(box.bubbleRandomContent(mod).txt, '角色A上一句')
    rng.random = () => (i + 0.5) / 40
    const text = box.bubbleRandomContent(mod).txt
    assert.notEqual(text, '角色A上一句')
    counts[text] = (counts[text] || 0) + 1
  }
  assert.deepEqual(counts, { '角色A句2': 10, '角色A句3': 10, '全局句1': 10, '全局句2': 10 })
})

test('no global sentences means all draws use the current role', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = sampleRoles()
  rng.random = () => 0.99
  const mod = roleOnlyModule()
  assert.equal(box.bubbleRandomContent(mod).txt, '角色A句2')
  assert.equal(box.bubbleRandomContent(mod).txt, '角色A句1')
})

test('disabled or invalid role pools bypass mixed content and keep the original fallback', () => {
  const { box } = sandbox()
  for (const cfg of [
    { enabled: false, roles: sampleRoles().roles },
    { enabled: true, roles: {} },
    { enabled: true, roles: { A: { lines: [{ text: '   ' }, { text: 3 }, { text: '超'.repeat(201) }] } } },
  ]) {
    box.roleLinesCfg = cfg
    const mod = globalModule('role')
    assert.equal(box.roleLinesMixedContent(mod), null)
    const result = box.bubbleRandomContent(mod)
    assert.equal(result.txt, '全局句1')
    assert.strictEqual(result.line, mod.lines[0])
  }
})

test('single sentence remains usable on every draw', () => {
  const { box } = sandbox()
  box.roleLinesCfg = { enabled: true, roles: { A: { lines: [{ text: '角色A单句' }] } } }
  const mod = roleOnlyModule()
  for (let i = 0; i < 100; i++) assert.equal(box.bubbleRandomContent(mod).txt, '角色A单句')
})

test('deduplicated multi-line pool cannot repeat consecutively even with a constant RNG', () => {
  const { box } = sandbox()
  box.roleLinesCfg = { enabled: true, roles: { A: { lines: [
    { text: '角色A句1' }, { text: ' 角色A句1 ' }, { text: '角色A句2' }, { text: '角色A句2' },
  ] } } }
  const mod = roleOnlyModule()
  let last
  for (let i = 0; i < 1000; i++) {
    const text = box.bubbleRandomContent(mod).txt
    assert.ok(['角色A句1', '角色A句2'].includes(text))
    assert.notEqual(text, last)
    last = text
  }
})

test('last-line memory is independent for each module and role', () => {
  const { box, storage } = sandbox()
  box.roleLinesCfg = sampleRoles()
  const one = roleOnlyModule(), two = roleOnlyModule()
  assert.equal(box.bubbleRandomContent(one).txt, '角色A句1')
  assert.equal(box.bubbleRandomContent(two).txt, '角色A句1')
  assert.equal(box.bubbleRandomContent(one).txt, '角色A句2')
  storage.set('dshw-role', 'B')
  assert.equal(box.bubbleRandomContent(one).txt, '角色B句1')
  storage.set('dshw-role', 'A')
  assert.equal(box.bubbleRandomContent(one).txt, '角色A句1')
  assert.equal(box.bubbleRandomContent(two).txt, '角色A句2')
})

test('role pools use equal intervals and do not mutate saved metadata', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = { enabled: true, roles: { A: { tag: '测试', lines: [
    { text: '角色A句1', weight: 1000, tags: ['test'], scene: 'A' },
    { text: '角色A句2', weight: 1, emotion: 'neutral' },
    { text: '角色A句3', w: 9999, extension: { keep: true } },
  ] } } }
  const before = JSON.stringify(box.roleLinesCfg)
  const counts = new Map()
  for (let i = 0; i < 300; i++) {
    rng.random = () => (i + 0.5) / 300
    const text = box.bubbleRandomContent(roleOnlyModule()).txt
    counts.set(text, (counts.get(text) || 0) + 1)
  }
  assert.deepEqual([...counts.values()], [100, 100, 100])
  assert.equal(JSON.stringify(box.roleLinesCfg), before)
})

test('localStorage failure falls back to currentRole and inherited entries are ignored', () => {
  const { box, storage } = sandbox()
  box.roleLinesCfg = sampleRoles()
  box.currentRole.id = 'B'
  box.localStorage.getItem = () => { throw new Error('storage unavailable') }
  assert.equal(box.bubbleRandomContent(roleOnlyModule()).txt, '角色B句1')
  box.localStorage.getItem = key => storage.get(key) ?? null
  box.roleLinesCfg.roles = Object.create({ A: { lines: [{ text: '不可继承句' }] } })
  assert.equal(box.roleLinesPool(), null)
})

test('new modules opt into role pools while existing defaults keep their source', () => {
  const { box } = sandbox()
  const old = box.bubbleDefaultSecondModules()[0]
  assert.equal(old.randomSource, undefined)
  const fresh = box.bubbleNewRandomModule()
  assert.equal(fresh.randomSource, 'role')
  assert.equal(JSON.stringify(fresh.lines), JSON.stringify(old.lines))
  assert.equal(box.bubbleDefaultSecondModules()[0].randomSource, undefined)
})

test('role editor preserves entry and line metadata when reordering or editing texts', () => {
  const { box } = sandbox()
  const entry = { title: '角色A', custom: { keep: true }, lines: [
    { text: '角色A句1', tags: ['test'], scene: 'first' },
    { text: '角色A句2', emotion: 'neutral', extension: { keep: true } },
  ] }
  const before = JSON.stringify(entry)
  const updated = asPlain(box.roleLinesEditedEntry(entry, ['角色A句2', '角色A新句']))
  assert.deepEqual(updated.custom, { keep: true })
  assert.equal(updated.title, '角色A')
  assert.equal(updated.lines[0].emotion, 'neutral')
  assert.deepEqual(updated.lines[0].extension, { keep: true })
  assert.equal(updated.lines[1].text, '角色A新句')
  assert.equal(JSON.stringify(entry), before)
})

test('applyRole immediately refreshes a visible role bubble without advancing or extending it', () => {
  const { box, storage } = sandbox()
  box.roleLinesCfg = sampleRoles()
  box.bubbleLiveMods = [roleOnlyModule()]
  const scene = box.bubbleScene, queue = box.bubbleSeq
  box.applyRole('B', '角色B', '/B.png')
  assert.equal(storage.get('dshw-role'), 'B')
  assert.equal(box.rendered[0].txt, '角色B句1')
  assert.equal(box.renderCount, 1)
  assert.strictEqual(box.bubbleScene, scene)
  assert.strictEqual(box.bubbleSeq, queue)
  assert.equal(box.bubbleSeqIdx, 2)
  assert.equal(box.bubbleTtlTimer, 77)
  assert.equal(box.bubbleTtlDeadline, 123456)
  assert.equal(box.bubbleRoundOn, true)
})

test('storage role changes refresh the visible bubble and role image once', () => {
  const { box, storage, listeners } = sandbox()
  box.roleLinesCfg = sampleRoles()
  box.bubbleLiveMods = [roleOnlyModule()]
  storage.set('dshw-role', 'B')
  for (const fn of listeners.get('storage')) fn({ key: 'dshw-role' })
  assert.equal(box.currentRole.id, 'B')
  assert.equal(box.img.src, '/B.png')
  assert.ok(box.rendered[0].txt.startsWith('角色B'))
  assert.equal(box.renderCount, 1, 'A single storage event should draw only once')
  assert.equal(box.bubbleSeqIdx, 2)
  assert.equal(box.bubbleTtlDeadline, 123456)
})

test('cross-tab revision events reload changed enabled flags and pools immediately', async () => {
  const { box, listeners } = sandbox()
  box.roleLinesCfg = sampleRoles()
  box.bubbleLiveMods = [roleOnlyModule()]
  box.bubbleRenderModules(box.bubbleLiveMods)
  assert.equal(box.rendered[0].txt, '角色A句1')
  let latest = sampleRoles(), gets = 0
  latest.enabled = false; latest.updatedAt = 10
  box.bubbleLiveMods[0].lines = globalModule().lines
  box.fetch = async (url, options) => {
    assert.equal(url, '/dsh-whale/role-lines.json')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.method, undefined)
    gets++
    return { json: async () => ({ ok: true, ...latest }) }
  }
  const emit = () => listeners.get('storage').forEach(fn => fn({ key: box.ROLE_LINES_REV_KEY }))
  emit(); await flush()
  assert.equal(box.roleLinesCfg.enabled, false)
  assert.equal(box.rendered[0].txt, '全局句1')
  latest = sampleRoles(); latest.updatedAt = 20
  latest.roles.A.lines = [{ text: '角色A跨窗口新句' }]
  box.bubbleLiveMods[0].lines = []
  emit(); await flush()
  assert.equal(box.roleLinesCfg.enabled, true)
  assert.equal(box.roleLinesCfg.updatedAt, 20)
  assert.equal(box.rendered[0].txt, '角色A跨窗口新句')
  assert.equal(gets, 2)
  assert.equal(box.currentRole.id, 'A')
  assert.equal(box.bubbleSeqIdx, 2)
  assert.equal(box.bubbleTtlDeadline, 123456)
})

test('cross-tab revision refresh does not overwrite unsaved editor text or checkbox', async () => {
  const { box, listeners } = sandbox()
  box.roleLinesCfg = sampleRoles()
  box.bubbleLiveMods = [roleOnlyModule()]
  const draft = '角色A尚未保存\n角色A编辑句'
  prepareEditor(box, draft, false)
  box.roleLinesStatusEl.textContent = '编辑中'
  const latest = sampleRoles()
  latest.roles.A.lines = [{ text: '角色A另一窗口保存句' }]
  box.fetch = async () => ({ json: async () => ({ ok: true, ...latest }) })
  listeners.get('storage').forEach(fn => fn({ key: box.ROLE_LINES_REV_KEY }))
  await flush()
  assert.equal(box.rendered[0].txt, '角色A另一窗口保存句')
  assert.equal(box.roleLinesCfg.enabled, true)
  assert.equal(box.roleLinesTextEl.value, draft)
  assert.equal(box.roleLinesEnabledEl.checked, false)
  assert.equal(box.roleLinesStatusEl.textContent, '编辑中')
  assert.equal(box.roleLinesMask.style.display, 'flex')
  assert.equal(box.roleLinesSaveBtn.disabled, false)
})

test('unrelated storage events, hidden bubbles, and global-only bubbles are left alone', () => {
  const { box, listeners } = sandbox()
  box.roleLinesCfg = sampleRoles()
  box.bubbleLiveMods = [globalModule('role')]
  for (const fn of listeners.get('storage')) fn({ key: 'unrelated-setting' })
  assert.equal(box.renderCount, 0)
  box.bubbleShown = false; box.roleLinesRefreshVisible(true)
  assert.equal(box.renderCount, 0)
  box.bubbleShown = true; box.bubbleLiveMods = [globalModule('global')]
  box.roleLinesRefreshVisible(true)
  assert.equal(box.renderCount, 0)
})

test('saving a disabled role setting refreshes the visible bubble back to global', () => {
  const { box } = sandbox()
  box.roleLinesCfg = sampleRoles()
  box.bubbleLiveMods = [globalModule('role')]
  box.roleLinesRefreshVisible()
  assert.ok(['角色A句1', '角色A句2', '全局句1', '全局句2'].includes(box.rendered[0].txt))
  box.roleLinesCfg.enabled = false
  box.roleLinesRefreshVisible(true)
  assert.equal(box.rendered[0].txt, '全局句1')
  assert.equal(box.bubbleTtlDeadline, 123456)
})

test('role refresh retains the existing global draw in mixed bubbles', () => {
  const { box, rng } = sandbox()
  box.roleLinesCfg = sampleRoles()
  const role = roleOnlyModule(), oldGlobal = globalModule(), explicitGlobal = globalModule('global')
  box.bubbleLiveMods = [role, oldGlobal, explicitGlobal]
  box.bubbleRenderModules(box.bubbleLiveMods)
  assert.equal(box.rendered[1].txt, '全局句1')
  assert.equal(box.rendered[2].txt, '全局句1')
  rng.random = () => 0.99
  box.applyRole('B', '角色B', '/B.png')
  assert.ok(box.rendered[0].txt.startsWith('角色B'))
  assert.equal(box.rendered[1].txt, '全局句1')
  assert.equal(box.rendered[2].txt, '全局句1')
  assert.equal(oldGlobal._lastPick, 0)
  assert.equal(explicitGlobal._lastPick, 0)
  assert.equal(box.roleLinesPreserveGlobal, false)
})

test('role refresh keeps an existing random image and resumes ordinary image draws afterward', () => {
  const { box, rng } = sandbox()
  vm.runInContext(extract('bubbleRowsTo') + '\n' + extract('bubbleIsImgMod'), box, { filename })
  box.bubbleRowsOf = mods => mods.map(mod => [mod])
  box.document = { createElement: tag => ({ tagName: tag, style: {} }) }
  const parent = {
    children: [], querySelectorAll() { return this.children.slice() },
    appendChild(child) { this.children.push(child) },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1) },
  }
  const mod = { type: 'randimg', imgs: [{ imgId: '测试图片A', w: 1 }, { imgId: '测试图片B', w: 9 }] }
  box.bubbleRowsTo(parent, [mod])
  assert.equal(mod._lastPickImg, 0)
  assert.ok(parent.children[0].src.includes(encodeURIComponent('测试图片A')))
  rng.random = () => 0.99
  box.roleLinesPreserveGlobal = true
  box.bubbleRowsTo(parent, [mod])
  assert.equal(mod._lastPickImg, 0)
  assert.ok(parent.children[0].src.includes(encodeURIComponent('测试图片A')))
  box.roleLinesPreserveGlobal = false
  box.bubbleRowsTo(parent, [mod])
  assert.equal(mod._lastPickImg, 1)
  assert.ok(parent.children[0].src.includes(encodeURIComponent('测试图片B')))
})

test('sceneOpen discards stale modules before normal and legacy scenes can receive a role refresh', () => {
  const { box } = sandbox()
  vm.runInContext(extract('sceneOpen'), box, { filename })
  box.roleLinesCfg = sampleRoles()
  box.bubbleClearAll = () => {}
  box.bubbleClearModuleRows = () => {}
  box.bubbleTtlClear = () => { box.bubbleTtlDeadline = 0 }
  box.gifEl = { style: {} }; box.textBox = { style: {} }
  box.bubbleBox = { classList: { add() {} } }
  box.setTimeout = () => 88
  for (const kind of ['normal', 'random']) {
    box.bubbleLiveMods = [globalModule('role')]
    box.bubbleShown = false
    box.sceneOpen(kind, () => {}, 0)
    assert.equal(box.bubbleLiveMods, null)
    box.roleLinesRefreshVisible(true)
    assert.equal(box.renderCount, 0)
    assert.equal(box.bubbleScene.kind, kind)
  }
})

test('temporary global-preservation state resets even if rendering fails', () => {
  const { box } = sandbox()
  box.roleLinesCfg = sampleRoles()
  box.bubbleLiveMods = [globalModule('role')]
  box.bubbleRenderModules = () => { throw new Error('render failed') }
  assert.throws(() => box.roleLinesRefreshVisible(), /render failed/)
  assert.equal(box.roleLinesPreserveGlobal, false)
})

test('legacy kind=random scenes keep their original global path', () => {
  const { box } = sandbox()
  box.roleLinesCfg = sampleRoles()
  box.bubbleSeq = [{ kind: 'random' }]; box.bubbleSeqIdx = 0
  box.bubbleShowSeqNext()
  assert.deepEqual(box.legacyRendered, ['旧全局句1'])
  assert.deepEqual(asPlain(box.opened), { kind: 'random', ttlMs: 5000 })
  assert.equal(box.bubbleSeqIdx, 1)
})

test('editor saves actual CRLF/LF lines and retains the latest other-role metadata', async () => {
  const { box } = sandbox()
  prepareEditor(box, '角色A句1\r\n角色A句2\n\n  角色A句3  ')
  const latest = sampleRoles()
  latest.roles.B.extension = { concurrent: true }
  latest.roles.A.lines[0].tags = ['test']
  let put
  box.fetch = async (url, options = {}) => {
    assert.equal(url, '/dsh-whale/role-lines.json')
    if (options.method === 'PUT') {
      put = JSON.parse(options.body)
      return { json: async () => ({ ok: true, ...put }) }
    }
    return { json: async () => ({ ok: true, ...latest }) }
  }
  box.roleLinesSaveEditor()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(put, 'Must submit the configuration')
  assert.deepEqual(put.roles.A.lines.map(line => line.text), ['角色A句1', '角色A句2', '角色A句3'])
  assert.deepEqual(put.roles.A.lines[0].tags, ['test'])
  assert.deepEqual(put.roles.B.extension, { concurrent: true })
  assert.equal(put.enabled, true)
  assert.equal(box.roleLinesMask.style.display, 'none')
  assert.equal(box.roleLinesSaveBtn.disabled, false)
})

test('successful editor PUT publishes a revision only after the save has completed', async () => {
  const { box, storage } = sandbox()
  prepareEditor(box)
  const latest = sampleRoles()
  let resolvePut, saved
  box.fetch = async (url, options = {}) => {
    if (options.method === 'PUT') {
      saved = JSON.parse(options.body)
      return await new Promise(resolve => { resolvePut = resolve })
    }
    return { json: async () => ({ ok: true, ...latest }) }
  }
  box.roleLinesSaveEditor()
  await flush()
  assert.ok(resolvePut, 'The save request should be pending')
  assert.equal(storage.has(box.ROLE_LINES_REV_KEY), false)
  assert.equal(box.roleLinesSaveBtn.disabled, true)
  resolvePut({ json: async () => ({ ok: true, ...saved, updatedAt: 12345 }) })
  await flush()
  assert.equal(storage.get(box.ROLE_LINES_REV_KEY), '12345-0')
  assert.equal(box.roleLinesCfg.updatedAt, 12345)
  assert.equal(box.roleLinesMask.style.display, 'none')
  assert.equal(box.roleLinesSaveBtn.disabled, false)
})

test('invalid or unreadable GET blocks every PUT and preserves the editor draft', async () => {
  for (const failure of ['invalid-file', 'invalid-json', 'network-error']) {
    const { box, storage } = sandbox()
    box.roleLinesCfg = sampleRoles()
    const originalCfg = box.roleLinesCfg
    const draft = '角色A未保存测试句'
    prepareEditor(box, draft)
    const methods = []
    box.fetch = async (url, options = {}) => {
      methods.push(options.method || 'GET')
      if (options.method === 'PUT') throw new Error('Invalid GET must block PUT')
      if (failure === 'network-error') throw new Error('测试读取网络错误')
      return { json: async () => {
        if (failure === 'invalid-json') throw new SyntaxError('测试损坏JSON')
        return { ok: false, error: '测试损坏角色配置' }
      } }
    }
    box.roleLinesSaveEditor()
    await flush()
    assert.deepEqual(methods, ['GET'])
    assert.strictEqual(box.roleLinesCfg, originalCfg)
    assert.equal(box.roleLinesTextEl.value, draft)
    assert.equal(box.roleLinesMask.style.display, 'flex')
    assert.equal(box.roleLinesSaveBtn.disabled, false)
    assert.equal(box.roleLinesCancelBtn.disabled, false)
    assert.equal(box.roleLinesStatusEl.style.color, '#b42318')
    assert.ok(box.roleLinesStatusEl.textContent.includes('测试'))
    assert.equal(storage.has(box.ROLE_LINES_REV_KEY), false)
  }
})

test('editor rejects excessive line counts and codepoint lengths before sending', () => {
  const { box } = sandbox()
  box.roleLinesEnabledEl = { checked: true }
  box.roleLinesStatusEl = { textContent: '', style: {} }
  box.roleLinesSaveBtn = {}; box.roleLinesCancelBtn = {}
  let requested = false
  box.fetch = async () => { requested = true; throw new Error('Must not send') }
  for (const value of [Array(501).fill('角色A测试句').join('\n'), '🐋'.repeat(201)]) {
    box.roleLinesTextEl = { value }
    box.roleLinesSaveEditor()
    assert.equal(requested, false)
    assert.ok(box.roleLinesStatusEl.textContent.includes('500'))
  }
})

let failed = 0
for (const { name, fn } of tests) {
  try { await fn(); console.log('ok ' + name) }
  catch (err) { failed++; console.error('FAIL ' + name + '\n' + (err.stack || err)) }
}
console.log('\nRole-lines frontend: ' + (tests.length - failed) + '/' + tests.length + ' passed')
if (failed) process.exitCode = 1
