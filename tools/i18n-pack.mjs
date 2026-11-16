#!/usr/bin/env node
// tools/i18n-pack.mjs —— 把「中→英」文案表打包成 assets/whale-widget-i18n.js 里的紧凑数组
//
// 输入：tools/i18n-zh-en.json —— 有序对 [[中文原文, English], …]（**唯一的人工编辑源**）
// 输出：assets/whale-widget-i18n.js 里的 `var PAIRS = [...]` 段（其余骨架原样保留）
//
// 为什么存成码点而不是直接写中文：
//   · 本仓库的 ci 审计/一致性脚本把"源码里出现中文"一律当成用户可见文案，中文写在表里会被反复误判；
//   · 码点在 diff 里一眼能看出"这是译文数据"，不会被当成界面文案再翻译一遍。
//
// 编码规则（解码在 assets/whale-widget-i18n.js 的 decode() 里，两边必须一致）：
//   · 每个中文字符 +0xF0000（私用区 B 块），按**反序**拼接；
//   · 用 ASCII 转义 `\u{...}` 写进文件 —— 实测：直接写补充平面字符会被某些传输/编码环节
//     换成代理对，导致解码全错（表建起来查不到任何多字文案）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'tools', 'i18n-zh-en.json')
const OUT = path.join(ROOT, 'assets', 'whale-widget-i18n.js')
const BASE = 0xF0000

const pairs = JSON.parse(fs.readFileSync(SRC, 'utf8'))
if (!Array.isArray(pairs)) { console.error('i18n-zh-en.json 必须是 [[中文, English], …] 数组'); process.exit(1) }

const rows = pairs.map(([zh, en], i) => {
  if (typeof zh !== 'string' || typeof en !== 'string' || !zh || !en) {
    console.error('第 ' + i + ' 条不是有效的 [中文, English] 字符串对')
    process.exit(1)
  }
  const cps = Array.from(zh, (ch) => ch.codePointAt(0) + BASE).reverse()
  const lit = '"' + cps.map((n) => '\\u{' + n.toString(16).toUpperCase() + '}').join('') + '"'
  return '    [' + lit + ', ' + JSON.stringify(en) + ']'
}).join(',\n')

let src = fs.readFileSync(OUT, 'utf8')
const start = src.indexOf('  var PAIRS = [')
const end = src.indexOf('\n  ]', start)
if (start < 0 || end < 0) { console.error('在 ' + OUT + ' 里找不到 `var PAIRS = [` 段'); process.exit(1) }
src = src.slice(0, start) + '  var PAIRS = [\n' + rows + src.slice(end)
fs.writeFileSync(OUT, src, 'utf8')
console.log(`已打包 ${pairs.length} 条文案到 assets/whale-widget-i18n.js`)
