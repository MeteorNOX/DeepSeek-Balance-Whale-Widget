// tools/ci-audit-selftest.mjs —— ci-audit 的自检（0 依赖，node 直接跑）
//
// 为什么需要它：ci-audit 是门禁，而门禁有两种坏法 ——
//   ① 误判：把合法代码判死 → 维护者嫌烦，最后把整条检查删掉；
//   ② 漏判：看着是绿的其实什么都没拦 → 比没有更糟，因为它给人虚假的安全感。
// 这个自检就钉这两种坏法：先证明「干净样本全绿」，再**逐项**证明「写坏必红」。
// 每个用例都造一个独立样本仓库，用 --only=<编号> 只跑被测的那一项，互不干扰。
//
// 用法：node tools/ci-audit-selftest.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AUDIT = path.join(HERE, 'ci-audit.mjs')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-audit-selftest-'))

const WF = [
  'name: Workflow',
  'on:',
  '  push:',
  '    branches: [main]',
  '  pull_request:',
  '    branches: [main]',
  'jobs:',
  '  audit:',
  '    steps:',
  '      - run: node tools/z-layer-audit.mjs assets/whale-widget.js',
  '      - run: node --check lib/index.js',
  '      - run: grep -n "TestBox" lib/index.js lib/accounting.mjs assets/whale-widget.js',
  '',
].join('\n')

const HOST = [
  'const WIDGET_FILE_CANDIDATES = [',
  "  path.join(path.dirname(fileURLToPath(import.meta.url)), 'whale-widget.js'),",
  "  path.join(PACKAGE_ROOT, 'assets', 'whale-widget.js'),",
  ']',
  'function registerRoute(route) {',
  '  return ctx.webServer.register(route)',
  '}',
  "registerRoute({ kind: 'exact', path: '/dsh-whale/balance.json', handler: (q, s) => s.end() })",
  "registerRoute({ kind: 'exact', path: '/dsh-whale/widget.js', handler: (q, s) => s.end() })",
  '',
].join('\n')

const FRONT = [
  "var BALANCE_URL = '/dsh-whale/balance.json'",
  "el.innerHTML = ''",
  "el.innerHTML = '<div>static</div>'",
  'toast.innerHTML = msg',
  '',
].join('\n')

const BASE = {
  'package.json': JSON.stringify({
    name: 'dsh-whale-widget',
    version: '0.0.0',
    type: 'module',
    main: 'lib/index.js',
    files: ['lib', 'assets', 'cordis.patch.yml', 'README.md'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2),
  'cordis.patch.yml': '- insert:\n    - id: dsh-whale-widget\n      name: dsh-whale-widget\n',
  'README.md': '全部 **2 个** `/dsh-whale/*` 路由都已接入信任栅栏。\n',
  'lib/accounting.mjs': 'export const ok = true\n',
  'lib/index.js': HOST,
  'assets/whale-widget.js': FRONT,
  '.github/workflows/ci.yml': WF,
  '.github/workflows/publish.yml': WF,
  'tools/ci-audit.allowlist.json': JSON.stringify({
    allow: [{ key: 'assets/whale-widget.js :: toast.innerHTML = msg', why: '样本用：已知动态入口' }],
  }, null, 2),
}

function writeFixture(name, overrides = {}) {
  const dir = path.join(tmpRoot, name)
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [rel, body] of Object.entries({ ...BASE, ...overrides })) {
    if (body === null) continue // null = 故意不写这个文件
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body, 'utf8')
  }
  return dir
}

function runAudit(dir, only) {
  const args = [AUDIT, `--root=${dir}`, '--no-pack']
  if (only) args.push(`--only=${only}`)
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const results = []
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }) } catch (err) {
    results.push({ name, ok: false, why: String((err && err.message) || err) })
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const green = (dir, only, label) => {
  const r = runAudit(dir, only)
  assert(r.code === 0, (label || '干净样本') + ' 应该全绿，实际退出码 ' + r.code + '\n' + r.out)
}
const red = (dir, only, label) => {
  const r = runAudit(dir, only)
  assert(r.code !== 0, (label || '写坏的样本') + ' 应该报错，实际却全绿（门禁失效）\n' + r.out)
  assert(r.out.includes('[' + only + ']'), '输出里没看到第 ' + only + ' 项的结果\n' + r.out)
}

// --- 基线 --------------------------------------------------------------------
check('基线：干净样本必须全绿（五项一起跑，标题即 ci-audit 的五项检查名）', () => {
  green(writeFixture('clean'), null)
})

// --- ① 栅栏不变量 ------------------------------------------------------------
check('① 多出一处绕过 registerRoute 的裸注册 → 必红', () => {
  const dir = writeFixture('c1-bare', {
    'lib/index.js': HOST.replace(
      "registerRoute({ kind: 'exact', path: '/dsh-whale/widget.js', handler: (q, s) => s.end() })",
      "ctx.webServer.register({ kind: 'exact', path: '/dsh-whale/widget.js', handler: (q, s) => s.end() })",
    ),
  })
  red(dir, '1', '绕过栅栏的裸注册')
})

check('① README 声明的路由条数与实际不符 → 必红', () => {
  const dir = writeFixture('c1-count', { 'README.md': '全部 **9 个** `/dsh-whale/*` 路由都已接入信任栅栏。\n' })
  red(dir, '1', 'README 条数漂移')
})

// --- ② 路由对等 --------------------------------------------------------------
check('② 前端引用了宿主未注册的路径 → 必红', () => {
  const dir = writeFixture('c2-parity', {
    'assets/whale-widget.js': FRONT + "var TYPO_URL = '/dsh-whale/balanc.json'\n",
  })
  red(dir, '2', '前端引用不存在的路由')
})

check('② 只有注释提到不存在的路径 → 必须绿（注释不算引用）', () => {
  const dir = writeFixture('c2-comment', {
    'assets/whale-widget.js': '// 历史注释：老路由 /dsh-whale/legacy.json 已废弃\n' + FRONT,
  })
  green(dir, '2', '注释里提到不存在的路由')
})

check('② 动态前缀拼接（能落在已注册路径下）→ 必须绿', () => {
  const dir = writeFixture('c2-prefix', {
    'lib/index.js': HOST.replace(
      "registerRoute({ kind: 'exact', path: '/dsh-whale/widget.js', handler: (q, s) => s.end() })",
      "registerRoute({ kind: 'exact', path: '/dsh-whale/sound/press.mp3', handler: (q, s) => s.end() })",
    ),
    'assets/whale-widget.js': FRONT + "var legacy = '/dsh-whale/sound/' + slot + '.mp3'\n",
  })
  green(dir, '2', '前缀拼接的动态路径')
})

// --- ⑤ 注入面 ---------------------------------------------------------------
check('⑤ innerHTML 接上变量 → 必红', () => {
  const dir = writeFixture('c5-inject', {
    'assets/whale-widget.js': FRONT + 'panel.innerHTML = serverMsg\n',
  })
  red(dir, '5', '未登记的动态写入')
})

check('⑤ 模板串带 ${} 插值 → 必红', () => {
  const dir = writeFixture('c5-template', {
    'assets/whale-widget.js': FRONT + 'box.innerHTML = `<b>${name}</b>`\n',
  })
  red(dir, '5', '模板串插值')
})

check('⑤ 登记过、但写法改了（换成别的变量）→ 必红', () => {
  const dir = writeFixture('c5-rekey', {
    'assets/whale-widget.js': FRONT.replace('toast.innerHTML = msg', 'toast.innerHTML = other'),
  })
  red(dir, '5', '允许清单只认精确写法')
})

check('⑤ 允许清单里有已不存在的条目 → 必红（防清单腐烂）', () => {
  const dir = writeFixture('c5-stale', { 'assets/whale-widget.js': FRONT.replace('toast.innerHTML = msg\n', '') })
  red(dir, '5', '清单过期条目')
})

check('⑤ 跨行拼接的静态 SVG → 必须绿（真实写法，不能误判）', () => {
  const dir = writeFixture('c5-multiline', {
    'assets/whale-widget.js': FRONT + "box.innerHTML = '<svg viewBox=\"0 0 10 10\">' +\n  '<path d=\"M0 0\"/>' +\n  '</svg>'\n",
  })
  green(dir, '5', '跨行静态字面量')
})

check('⑤ 字面量后面还有尾随代码 → 必须绿（.catch(function(){…}) 的真实写法）', () => {
  const dir = writeFixture('c5-tail', {
    'assets/whale-widget.js': FRONT + "p.then(function () { card.innerHTML = '<div>ok</div>' })\n",
  })
  green(dir, '5', '字面量 + 尾随代码')
})

// --- ④ 门禁一致性 ------------------------------------------------------------
check('④ publish.yml 被摘掉语法检查 → 必红', () => {
  const dir = writeFixture('c4-gate', {
    '.github/workflows/publish.yml': WF.replace('      - run: node --check lib/index.js\n', ''),
  })
  red(dir, '4', '发布前门禁少一项')
})

check('④ 两份 workflow 覆盖一致 → 必须绿', () => {
  green(writeFixture('c4-ok'), '4', '两份 workflow 一致')
})

// --- 汇总 -------------------------------------------------------------------
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('ci-audit 自检（tools/ci-audit-selftest.mjs）')
for (const r of results) console.log((r.ok ? '  √ ' : '  × ') + r.name + (r.ok ? '' : '\n      ' + r.why))
const bad = results.filter((r) => !r.ok).length
console.log('')
console.log(bad
  ? '结果：' + bad + '/' + results.length + ' 个用例失败'
  : '结果：' + results.length + '/' + results.length + ' 个用例通过')
process.exit(bad ? 1 : 0)
