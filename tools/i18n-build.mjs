#!/usr/bin/env node
// tools/i18n-build.mjs —— 把中文字面量包成 dshwT('原文') 的**构建期生成器**（不进运行时）
//
// 背景：界面文案分布在 2 万多行的单文件里，共 1650 个中文字面量（去重后 1060 条）。逐条手改既不可能，
//   也必然改坏。本脚本用 acorn 拿到**精确的 AST 位置**，只替换字面量本身为 `dshwT('原文')`，
//   运行时由 assets/whale-widget-i18n.js 查表：英文用户看到译文，中文用户拿到原文（零行为变化）。
//
// ⚠️ 为什么不用正则词法器：本文件的注释/正则里出现过反引号与带引号的正则（如 /<circle r="30"\/>/），
//   纯正则扫描会把注释里的引号当成字符串开头，后面整片错位（实测踩过三次）。
//
// 用法（改过 assets/whale-widget.js 的中文文案后跑一次）：
//   node tools/i18n-build.mjs           # 原地替换（幂等：已包过的不会重复包）
//   node tools/i18n-build.mjs --check   # 只检查：是否还有漏包的中文字面量
//
// 该脚本依赖 acorn（devDependency，只在开发机用；CI 只用生成后的产物 + test/i18n.test.mjs）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(ROOT, 'assets', 'whale-widget.js')
const CJK = /[\u4e00-\u9fff]/
// 不包的字面量：含 HTML/SVG 标记的（innerHTML 必须保持静态）、纯 URL、以及已经包过的
const SKIP = [/<\/?[a-zA-Z][^>]*>/, /^(https?:\/\/|mailto:)/]

async function main() {
  let acorn
  try {
    acorn = await import('acorn')
  } catch (err) {
    console.error('缺少 acorn：请在仓库根目录执行 `npm i -D acorn`（或 pnpm add -D acorn）')
    process.exit(2)
  }
  const check = process.argv.includes('--check')
  const src = fs.readFileSync(TARGET, 'utf8')
  const ast = (acorn.parse || acorn.default.parse)(src, { ecmaVersion: 'latest', locations: true })

  const edits = []
  const missing = new Set()
  let skipped = 0

  // 已经包过的字面量：它的父节点就是 dshwT(...) 调用 —— 必须跳过，否则每次跑都会多包一层
  // （实测：不加这条，第二次运行会把 dshwT('x') 变成 dshwT(dshwT('x'))，文件每次都被改写）。
  const isWrapped = (parent) => parent && parent.type === 'CallExpression'
    && parent.callee && parent.callee.type === 'Identifier' && parent.callee.name === 'dshwT'

  const visit = (n, parent) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'Literal' && typeof n.value === 'string' && CJK.test(n.value)) {
      if (isWrapped(parent)) { skipped++; return }
      const raw = src.slice(n.start, n.end)
      if (SKIP.some((re) => re.test(n.value))) { skipped++; return }
      // obj['中文键']：本身就是"按原文查表"的用法，保持原样
      if (parent && parent.type === 'MemberExpression' && parent.property === n) { skipped++; return }
      // 对象键 { '中文键': v } → 计算键 ['中文键']，键值仍是中文原文（多处代码按中文名回查）
      if (parent && parent.type === 'Property' && parent.key === n) {
        edits.push({ start: n.start, end: n.end, text: '[' + raw + ']' })
        return
      }
      missing.add(n.value)
      edits.push({ start: n.start, end: n.end, text: 'dshwT(' + raw + ')' })
      return
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue
      const v = n[k]
      if (Array.isArray(v)) v.forEach((x) => visit(x, n))
      else if (v && typeof v === 'object' && v.type) visit(v, n)
    }
  }
  visit(ast, null)

  if (check) {
    if (edits.length) {
      console.log(`还有 ${edits.length} 个中文字面量没有包 dshwT()；请跑一次 node tools/i18n-build.mjs`)
      process.exit(1)
    }
    console.log(`√ 全部中文字面量都已接入 dshwT（跳过 ${skipped} 个：HTML/URL/计算成员）`)
    return
  }
  // 从后往前替换，避免偏移错位
  edits.sort((a, b) => b.start - a.start)
  let out = src
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  if (out !== src) fs.writeFileSync(TARGET, out, 'utf8')
  console.log(`已处理 ${edits.length} 处（跳过 ${skipped} 处），涉及 ${missing.size} 条不同文案`)
  if (missing.size) {
    console.log('\n以下文案需要补英文（补到 assets/whale-widget-i18n.js 的 DICT 源，再跑 tools/i18n-pack.mjs）：')
    for (const s of [...missing].sort()) console.log('  ' + JSON.stringify(s))
  }
}

main()
