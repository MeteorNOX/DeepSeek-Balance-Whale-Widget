// tools/z-layer-audit.mjs —— 浮层层级自检（0 依赖，Node 直接跑；退出码非 0 即不通过）
//
// 由来：issue #131（候选表里写了不存在的 `usageMask`，整条层级链静默失效 → 自绘下拉被父窗口盖住）
// 与 issue #142（第三方新增的 body 级浮层没登记进候选表 → 两个窗口互相盖，且谁都不报错）。
// 本脚本钉两件事：
//   ① `visibleTopZ()` 候选表里的标识符必须都在本文件里声明过（否则调用即抛、被空 catch 吞掉）；
//   ② 名字里带 `Mask`、又被挂到 `document.body` 上的浮层，必须出现在候选表里（含运行时登记口
//      `window.dshwRegisterMask` 的说明）。
//
// 用法：node tools/z-layer-audit.mjs [assets/whale-widget.js]
import fs from 'node:fs'

const FILE = process.argv[2] || 'assets/whale-widget.js'
const src = fs.readFileSync(FILE, 'utf8')

function braceBlock(at) {
  const i = src.indexOf('{', at)
  if (i < 0) return null
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(i, j + 1) }
  }
  return null
}

const bodyAt = src.indexOf('function visibleTopZ(')
if (bodyAt < 0) { console.log('FAIL 找不到 visibleTopZ()：' + FILE); process.exit(1) }
const body = braceBlock(bodyAt)

const ids = new Set()
for (const m of body.matchAll(/function\s*\(\s*\)\s*\{\s*return\s+([A-Za-z_$][\w$.]*)/g)) ids.add(m[1])
const arr = body.match(/var\s+cand\s*=\s*\[([\s\S]*?)\]/)
if (arr) for (const m of arr[1].matchAll(/([A-Za-z_$][\w$.]*)/g)) ids.add(m[1])
ids.delete('function'); ids.delete('return'); ids.delete('window')

const names = new Set()
for (const re of [/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g, /\bfunction\s+([A-Za-z_$][\w$]*)/g, /\bclass\s+([A-Za-z_$][\w$]*)/g]) {
  for (const m of src.matchAll(re)) names.add(m[1])
}
const undeclared = [...ids].filter((id) => (id.indexOf('.') < 0 ? !names.has(id) : false))

const masks = new Set()
for (const m of src.matchAll(/([A-Za-z_$][\w$]*[Mm]ask[A-Za-z_$]*)\s*=\s*document\.createElement\(/g)) masks.add(m[1])
const bodyAppended = new Set()
for (const m of src.matchAll(/document\.body\.appendChild\(\s*([A-Za-z_$][\w$.]*)\b/g)) bodyAppended.add(m[1])
for (const m of src.matchAll(/dshwBodyAppend\(\s*([A-Za-z_$][\w$.]*)\b/g)) bodyAppended.add(m[1])
const hungOnBody = [...masks].filter((n) => bodyAppended.has(n))
const untracked = hungOnBody.filter((n) => body.indexOf(n) < 0)

let rc = 0
console.log('z 层级自检：' + FILE)
console.log('  候选表标识符 ' + ids.size + ' 个；body 级 *Mask 浮层 ' + hungOnBody.length + ' 个')
if (undeclared.length) { rc = 1; console.log('  FAIL 候选表里有未声明的名字（调用即抛、被空 catch 吞掉）：' + undeclared.join(', ')) }
else console.log('  ok 候选表全部已声明')
if (untracked.length) { rc = 1; console.log('  FAIL 这些 body 级浮层没进候选表（会与其它窗口互相盖住）：' + untracked.join(', ')) }
else console.log('  ok body 级 *Mask 浮层全部已登记')
console.log('  （第三方新增的浮层可以不改上游源码，改用运行时登记：window.dshwRegisterMask(el)）')
process.exit(rc)
