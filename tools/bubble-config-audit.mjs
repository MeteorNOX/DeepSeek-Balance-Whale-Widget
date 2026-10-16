#!/usr/bin/env node
// tools/bubble-config-audit.mjs —— 「泡泡配置文件被静默误用」行为回归（0 依赖，Node 直接跑）
//
// 背景：issue #258。`~/.dsh/.dshw-bubble.json` 是**全量替换**语义：文件里的 items 就是整条序列，
//   出厂快照只在读不到文件时兜底。从外部手写这个文件的人（照源码拼一份"最小配置"）会把出厂序列
//   整体替换掉 —— 出厂第 1 项的 5 个模块里有两个 peak（峰谷状态 + 谷价倒计时）、第 2 项是整个
//   choice 步骤，全都没了；而客户端的 applyBubbleCfgSeq() 会把**不认识的 kind 静默渲染成普通泡**
//   （else 分支），所以症状是"看起来还行、只是少了东西"，用户只能靠现象发现（报告者的原话：
//   "我是靠峰谷不见了才发现的"）。
//
// 本脚本钉两件事：
//   ① 宿主侧的语义校验（lib/index.js 里**逐字抽出**的真 bubbleConfigProblem + loadBubbleConfig）：
//      只拒绝"写下来就一定不是本意"的形态 —— items 不是数组 / 项不是对象 / kind 不认识 /
//      modules 不是数组 / 并列步骤没有候选；被拒绝的文件**不采用**（读不到有效配置时客户端继续用
//      出厂快照）、**不修改**，并且必须有一条点名文件与原因的 console.warn。
//      同时钉住**不许误伤**的形态：面板「新建自定义泡」产出的 custom + modules: []、老配置的
//      无 kind 项、以及报告者那份语法合法的文件（它是合法的，靠 README 拦住，不是靠拒绝）。
//   ② README 的文档契约：必须写明"全量替换"、给出恢复办法，并点名 items。
//
// 为什么抽真源码而不是钉字符串：钉字符串既脆（变量改名就误报）又漏（校验还在、但被挪到调用之后
//   就静默放行）。这里跑的是文件里那段真实的代码。
//
// 自证（negative controls）：脚本自己证明"断言是有区分度的" —— 把抽出来的校验函数里那道
//   kind 白名单判断删掉再跑一遍，第 ③ 组用例必须由绿转红；否则本脚本就是在空转。
//
// 已知边界（别当完备性证明）：
//   · 只覆盖宿主侧读取路径（lib/index.js）。真实浏览器里的渲染、面板保存路径不在这里。
//   · 抽取靠函数名与锚点：改名会让本脚本红（有意如此 —— 那时需要人更新抽取规则，而不是悄悄放行）。
//
// 用法：
//   node tools/bubble-config-audit.mjs
//   node tools/bubble-config-audit.mjs --root=<目录>   # 在别的检出上跑同一套（自证/复现用）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const rootArg = argv.find((a) => a.startsWith('--root='))
const ROOT = rootArg
  ? path.resolve(rootArg.slice('--root='.length))
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'lib/index.js'
const README = 'README.md'
const CANDIDATES = ['/home/u/.dsh/.dshw-bubble.json', '/home/u/.dsh/profiles/web/.dshw-bubble.json']
/** Every write the extracted loader attempted (must stay empty). */
const writeCalls = []

const failures = []
function check(label, ok, detail) {
  if (ok) { console.log('  ok   ' + label); return }
  failures.push(label + (detail ? ' —— ' + detail : ''))
  console.log('  FAIL ' + label + (detail ? ' —— ' + detail : ''))
}

/** 从源码里按大括号配对抽出一段（跳过字符串与注释，避免配对被字面量里的括号带偏）。 */
function sliceBraced(source, anchor) {
  const start = source.indexOf(anchor)
  if (start < 0) throw new Error('抽取锚点缺失：' + anchor.slice(0, 60))
  let depth = 0
  let i = start
  let quote = ''
  let lineComment = false
  let blockComment = false
  for (; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (lineComment) { if (ch === '\n') lineComment = false; continue }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1 } continue }
    if (quote) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '{') { depth += 1; continue }
    if (ch === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error('抽取失败（大括号不配对）：' + anchor.slice(0, 60))
}

const hostSource = fs.readFileSync(path.join(ROOT, HOST), 'utf8')
const kindsLine = hostSource.split('\n').find((l) => /const BUBBLE_ITEM_KINDS = \[/.test(l))
if (!kindsLine) throw new Error('找不到 BUBBLE_ITEM_KINDS 声明')
const problemSource = sliceBraced(hostSource, 'function bubbleConfigProblem(cfg) {')
const loaderSource = sliceBraced(hostSource, 'function loadBubbleConfig() {')

/** 用真源码建一个沙箱：fs/BUBBLE_FILE_CANDIDATES/console 都是注入的桩。 */
function buildLoader(problemCode) {
  const factory = new Function('fs', 'BUBBLE_FILE_CANDIDATES', 'console',
    kindsLine + '\n' + problemCode + '\n' + loaderSource + '\nreturn { loadBubbleConfig: loadBubbleConfig, bubbleConfigProblem: bubbleConfigProblem }')
  return (files, warnings) => factory({
    readFileSync(p) {
      if (!(p in files)) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err }
      return files[p]
    },
    // 写接口全部登记：commit 声称「一个字节都不改」，这条断言就是它的证据。
    writeFileSync(p) { writeCalls.push({ method: 'writeFileSync', path: p }) },
    appendFileSync(p) { writeCalls.push({ method: 'appendFileSync', path: p }) },
    unlinkSync(p) { writeCalls.push({ method: 'unlinkSync', path: p }) },
    renameSync(a, b) { writeCalls.push({ method: 'renameSync', path: String(a) + ' -> ' + String(b) }) },
    mkdirSync(p) { writeCalls.push({ method: 'mkdirSync', path: p }) },
  }, CANDIDATES, { warn: (m) => warnings.push(String(m)) })
}

const runLoader = (files, problemCode = problemSource) => {
  const warnings = []
  const api = buildLoader(problemCode)(files, warnings)
  return { config: api.loadBubbleConfig(), warnings, problem: api.bubbleConfigProblem }
}
const asFile = (cfg) => JSON.stringify(cfg)

const FACTORY_LIKE = { v: 1, items: [{ kind: 'custom', modules: [{ type: 'text', text: 'DeepSeek 余额' }, { type: 'peak' }] }, { kind: 'choice', options: [{ w: 1, item: { kind: 'custom', modules: [] } }] }], lib: [], tapAdvance: false }

console.log('bubble config audit（root=' + ROOT + '）')

console.log('① 合法配置照旧通过（不许误伤）')
{
  const r = runLoader({ [CANDIDATES[0]]: asFile(FACTORY_LIKE) })
  check('出厂形状的配置被采用', r.config !== null && r.config.items.length === 2)
  check('合法配置不产生告警', r.warnings.length === 0, r.warnings.join(' / '))
}
{
  // 面板「新建自定义泡」= custom + modules: []
  const panel = { v: 1, items: [{ kind: 'custom', modules: [] }], lib: [], tapAdvance: false }
  const r = runLoader({ [CANDIDATES[0]]: asFile(panel) })
  check('面板产出的 custom + modules: [] 仍然被采用（关键不回归）', r.config !== null && r.config.items.length === 1)
  check('它也不该产生告警', r.warnings.length === 0, r.warnings.join(' / '))
}
{
  const legacy = { v: 1, items: [{ modules: [{ type: 'text', text: '老配置没有 kind' }] }], lib: [] }
  const r = runLoader({ [CANDIDATES[0]]: asFile(legacy) })
  check('老配置（项里没有 kind）被采用', r.config !== null)
}
{
  // 报告者那份文件：语法合法 ⇒ 会被采用 —— 这是**设计**，靠 README 拦住而不是靠拒绝。
  const reporter = { v: 1, items: [{ kind: 'normal' }, { kind: 'random', modules: [{ type: 'random', lines: [] }] }], lib: [], tapAdvance: false }
  const r = runLoader({ [CANDIDATES[0]]: asFile(reporter) })
  check('语法合法（但语义是全量替换）的文件仍被采用', r.config !== null && r.config.items.length === 2)
  check('它同样不产生告警（拒绝不是这次的手段）', r.warnings.length === 0)
}

console.log('② 被拒绝的形态：不采用 + 点名文件与原因')
const rejected = [
  ['kind 不认识（客户端的 else 会静默渲染成普通泡）', { v: 1, items: [{ kind: 'peak', modules: [] }], lib: [] }, 'items[0]'],
  ['并列步骤没有候选', { v: 1, items: [{ kind: 'choice', options: [] }], lib: [] }, 'items[0]'],
  ['modules 不是数组', { v: 1, items: [{ kind: 'custom', modules: {} }], lib: [] }, 'items[0]'],
  ['items 不是数组', { v: 1, items: {}, lib: [] }, 'items'],
  ['项不是对象', { v: 1, items: [null], lib: [] }, 'items[0]'],
]
for (const [label, cfg, expected] of rejected) {
  const r = runLoader({ [CANDIDATES[0]]: asFile(cfg) })
  check('拒绝：' + label, r.config === null, r.config === null ? '' : '却采用了它')
  check('  并告警（点名文件 + 原因）', r.warnings.length === 1 && r.warnings[0].includes(CANDIDATES[0]) && r.warnings[0].includes(expected.replace('[0]', '[0]')), r.warnings.join(' / ') || '没有告警')
}


console.log('②b 坏项不在最后也必须被拦住（只看最后一项的退化写法别想绿着过）')
const multi = [
  ['坏项在第一位', { v: 1, items: [{ kind: 'peak', modules: [] }, { kind: 'normal' }], lib: [] }, "items[0]"],
  ['坏项在中间', { v: 1, items: [{ kind: 'normal' }, { kind: 'choice', options: [] }, { kind: 'random' }], lib: [] }, "items[1]"],
  ['坏项在最后', { v: 1, items: [{ kind: 'normal' }, { kind: 'custom', modules: {} }], lib: [] }, "items[1]"],
  ['lib 不是数组', { v: 1, items: [{ kind: 'normal' }], lib: {} }, 'lib'],
]
for (const [label, cfg, expected] of multi) {
  const r = runLoader({ [CANDIDATES[0]]: asFile(cfg) })
  check('拒绝：' + label, r.config === null, r.config === null ? '' : '却采用了它')
  check('  并点名位置 ' + expected, r.warnings.length === 1 && r.warnings[0].includes(expected), r.warnings.join(' / ') || '没有告警')
}
{
  // 空 items 是合法的「什么都不改」：客户端 applyBubbleCfgSeq 在 seq 为空时直接 return，
  // 继续用出厂序列 —— 所以它必须被采纳，而不是被当成坏配置。
  const r = runLoader({ [CANDIDATES[0]]: asFile({ v: 1, items: [], lib: [] }) })
  check('空 items 数组照旧被采纳（客户端自己保持出厂序列）', r.config !== null && r.warnings.length === 0)
}
console.log('②a 递归：并列分支里的同类错误也必须拦（客户端的 else 降级在 item 上同样成立）')
const nested = [
  ['候选的 item.kind 不认识', { v: 1, items: [{ kind: 'choice', options: [{ w: 1, item: { kind: 'peak' } }] }], lib: [] }, '.options[0].item.kind 不认识'],
  ['候选本身不是对象', { v: 1, items: [{ kind: 'choice', options: [null] }], lib: [] }, '.options[0] 不是对象'],
  ['候选的 item.modules 不是数组', { v: 1, items: [{ kind: 'choice', options: [{ w: 1, item: { kind: 'custom', modules: {} } }] }], lib: [] }, '.options[0].item.modules 不是数组'],
]
for (const [label, cfg, expected] of nested) {
  const r = runLoader({ [CANDIDATES[0]]: asFile(cfg) })
  check('拒绝：' + label, r.config === null, r.config === null ? '' : '却采用了它')
  check('  并点名 ' + expected, r.warnings.length === 1 && r.warnings[0].includes(expected), r.warnings.join(' / ') || '没有告警')
}
{
  const okChoice = { v: 1, items: [{ kind: 'choice', options: [{ w: 1, item: { kind: 'custom', modules: [] } }, { w: 2 }] }], lib: [] }
  const r = runLoader({ [CANDIDATES[0]]: asFile(okChoice) })
  check('非回归：候选里正常的 item、只带权重的候选项照旧被采纳', r.config !== null && r.warnings.length === 0)
}
console.log('③ 候选回退：坏文件被跳过，后面的好文件照旧生效')
{
  const r = runLoader({ [CANDIDATES[0]]: asFile({ v: 1, items: [{ kind: 'nope' }], lib: [] }), [CANDIDATES[1]]: asFile(FACTORY_LIKE) })
  check('第一个候选坏 ⇒ 采用第二个候选', r.config !== null && r.config.items.length === 2)
  check('只告警一次（针对坏的那份）', r.warnings.length === 1, String(r.warnings.length))
}
{
  const r = runLoader({ [CANDIDATES[0]]: '{ this is not json', [CANDIDATES[1]]: asFile(FACTORY_LIKE) })
  check('解析失败仍按老行为回退（不新增告警）', r.config !== null && r.warnings.length === 0)
}
{
  const r = runLoader({})
  check('都读不到 ⇒ null（客户端继续用出厂快照）', r.config === null && r.warnings.length === 0)
}
{
  const r = runLoader({ [CANDIDATES[0]]: asFile({ v: 2, items: [{ kind: 'nope' }], lib: [] }) })
  check('v !== 1 直接跳过（老行为，不告警）', r.config === null && r.warnings.length === 0)
}

console.log('④ README 文档契约（这次的外部用户就是栽在没有这句话上）')
{
  const readme = fs.readFileSync(path.join(ROOT, README), 'utf8')
  check('README 提到 .dshw-bubble.json', readme.includes('.dshw-bubble.json'))
  check('README 写明「全量替换」语义', /全量替换|整条序列都会|full replacement/i.test(readme))
  check('README 提到 items', readme.includes('items'))
  check('README 给出恢复办法（删掉该文件）', /删掉|删除该文件|delete .*dshw-bubble/i.test(readme))
}

console.log('④ README 文档契约（这次的外部用户就是栽在没有这句话上）')
{
  const readme = fs.readFileSync(path.join(ROOT, README), 'utf8')
  check('README 提到 .dshw-bubble.json', readme.includes('.dshw-bubble.json'))
  check('README 写明「全量替换」语义', /全量替换|整条序列都会|full replacement/i.test(readme))
  check('README 提到 items', readme.includes('items'))
  check('README 给出恢复办法（删掉该文件）', /删掉|删除该文件|delete .*dshw-bubble/i.test(readme))
}

{
  // 别只守第一个候选：坏文件落在靠后的候选上同样要被拒。
  const r = runLoader({ [CANDIDATES[1]]: asFile({ v: 1, items: [{ kind: 'peak' }], lib: [] }) })
  check('坏文件在靠后的候选上也被拒绝', r.config === null, r.config === null ? '' : '却采用了它')
  check('  告警点名的是那一份', r.warnings.length === 1 && r.warnings[0].includes(CANDIDATES[1]), r.warnings.join(' / ') || '没有告警')
}

console.log('⑥ 「不采用、不改文件」，且拒绝要能被上层看到')
check('抽出的 loader + 校验函数一次都没调用写接口', writeCalls.length === 0, JSON.stringify(writeCalls.slice(0, 4)))
{
  const host = fs.readFileSync(path.join(ROOT, HOST), 'utf8')
  // 接线断言（文本级）：路由与诊断行必须把被忽略的那份文件带出去 ——
  // 没有宿主进程就没法在沙箱里跑这条路由，所以这里只钉接线，行为由上面的读取断言覆盖。
  check('路由把被忽略的文件带出去（ignored: bubbleConfigIgnored）', /ignored:\s*bubbleConfigIgnored/.test(host))
  check('诊断行也带上被忽略的原因', /被忽略：/.test(host))
}
console.log('⑤ 自证：把 kind 白名单那道判断删掉，② 的第一组必须由绿转红')
{
  const crippled = problemSource.replace(/if \(BUBBLE_ITEM_KINDS\.indexOf\(it\.kind\) < 0\)[^\n]*\n/, '')
  check('抽取到的校验函数里确实有那道判断', crippled !== problemSource)
  const r = runLoader({ [CANDIDATES[0]]: asFile({ v: 1, items: [{ kind: 'peak', modules: [] }], lib: [] }) }, crippled)
  check('删掉判断后，坏配置就会被采用（说明上面的用例是有区分度的）', r.config !== null)
}

if (failures.length) {
  console.error('\nbubble config audit 失败（' + failures.length + ' 项）：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('\nbubble config audit 通过：语义校验、候选回退与 README 契约都在。')
