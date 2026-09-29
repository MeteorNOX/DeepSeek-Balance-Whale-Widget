// tools/ci-audit.mjs —— 核心不变量自检（0 依赖，Node 直接跑；退出码非 0 即不通过）
//
// 定位：与 tools/z-layer-audit.mjs 同一形状。那个脚本钉「浮层层级」一条不变量，
// 本脚本钉「这个仓库最容易静默失效、又真的能自动查」的五条，覆盖从源码到发布产物。
//
// 为什么是这五条（每条都对应这个仓库真实发生过、或结构上必然会发生的事故）：
//   ① 检查所有后台接口必须走统一安全入口 —— 新增路由绕过 requestRejection（凭据外带 / 内网可达；
//                                            安全修复 S1、issue #136 fail-open）
//   ② 检查后端提供了所有前端调用的接口   —— 前端 fetch 了后端没注册的路径（两个巨石文件各改一半
//                                            → 点了没反应、静默 404）
//   ③ 检查打包后是否可以运行             —— 装出来的包里缺 assets/ 或 dsh.bundle.patch 指错文件（插件整包起不来）
//   ④ 检查日常ci与发版ci流程是否一致     —— 只改了 ci.yml 忘了 publish.yml（发布路径上某个检查被悄悄摘掉）
//   ⑤ 检查页面动态内容是否写清来源       —— innerHTML 接了变量（issue #143；新增未转义入口要有人看见）
//
// 设计原则：
//   · 零依赖（只用 node: 内置模块），不引 ESLint / jsdom / 测试框架——本仓库零依赖零构建是根本前提；
//   · 只做「能自动查的」，查不了的行为风险（并发竞态 / 点击命中 / 记账口径）不假装能查；
//   · 每条检查只认「结构事实」，尽量不认行号：行号会漂移，会逼着以后每个 PR 都来改这个文件；
//   · 注释里的路径不算引用（本文件前端就有历史注释写着 /dsh-whale/sound/*.mp3）。
//
// 用法：
//   node tools/ci-audit.mjs              # 静态四查 + 发布产物检查（会跑一次 npm pack）
//   node tools/ci-audit.mjs --no-pack    # 只跑静态四查（CI 日常用；不需要 npm）
//   node tools/ci-audit.mjs --only=1,2   # 只跑指定编号的检查（调试用）
//   node tools/ci-audit.mjs --root=<目录> # 在别的目录上跑同一套检查（自检脚本用）
//
// 配套文件：
//   tools/ci-audit.allowlist.json   第 ⑤ 项的允许清单（仓库自己的文件，不是脚本里的常量）
//   tools/ci-audit-selftest.mjs     本脚本的自检（先干净样本全绿，再逐项证明写坏必红）
// 门禁挂载：.github/workflows/ci.yml 用 `--no-pack`（日常），publish.yml 用完整版（发布前）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, execSync } from 'node:child_process'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const noPack = argv.includes('--no-pack')
const onlyArg = argv.find((a) => a.startsWith('--only='))
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim())) : null
// --root=<目录>：在别处跑同一套检查（自检脚本用它把「故意写坏」的样本喂进来）
const rootArg = argv.find((a) => a.startsWith('--root='))
const ROOT = rootArg ? path.resolve(rootArg.slice('--root='.length)) : DEFAULT_ROOT
const HOST_FILE = 'lib/index.js'
const FRONT_FILE = 'assets/whale-widget.js'
const HOST_PREFIX = '/dsh-whale/'

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const has = (rel) => fs.existsSync(path.join(ROOT, rel))

// ---------------------------------------------------------------------------
// 工具：按括号配对取出从 at 处开始的整段调用实参
// （用「从头数到配对」而不是非贪婪正则：后者会在嵌套对象/数组时截错位置）
// ---------------------------------------------------------------------------
function balanced(src, at) {
  const open = src[at] === '(' ? at : src.indexOf('(', at)
  if (open < 0) return null
  let depth = 0
  let inStr = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (!depth) return src.slice(open, i + 1) }
  }
  return null
}

// 工具：定位一行里的 HTML 赋值点 —— 取最后一次出现的 .innerHTML/.outerHTML（被赋值的那个）
function htmlAssign(line) {
  const re = /\.(inner|outer)HTML\s*=/g
  let m
  let last = null
  while ((m = re.exec(line)) !== null) last = m
  if (!last) return null
  const before = line.slice(0, last.index)
  const stem = before.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/)
  if (!stem) return null
  let rhs = line.slice(last.index).replace(/^.*?\.(?:inner|outer)HTML\s*=\s*/, '')
  rhs = rhs.replace(/\/\/.*$/, '').trim().replace(/[;,]+$/, '').trim()
  return { key: stem[1] + '.' + last[1] + 'HTML = ' + rhs, rhs }
}

// 工具：取从 at 处开始的整个块（花括号配对，同样跳过字符串）
function balancedBlock(src, at) {
  const open = src[at] === '{' ? at : src.indexOf('{', at)
  if (open < 0) return null
  let depth = 0
  let inStr = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (!depth) return src.slice(open, i + 1) }
  }
  return null
}

// 读一个字符串字面量：完整返回 {value,end}；到本行结束还没收尾（跨行拼接）返回 null
function readStringLiteral(s, i) {
  const q = s[i]
  let out = ''
  for (let k = i + 1; k < s.length; k++) {
    const c = s[k]
    if (c === '\\') { out += s[k + 1] || ''; k++; continue }
    if (c === q) return { value: out, end: k }
    out += c
  }
  return null
}

// 工具：右侧是不是「静态可证的常量 HTML」。
// 判据只有一条：右侧里存在一个**完整、且不含 ${} 插值**的字符串字面量。
//   · 为什么不用管尾随代码（如 `'<div/>' })`）：一个字面量就足以证明动态数据不在这个位置 ——
//     注入的风险是"变量被塞进 HTML"，而 `${x}` 插值会被下面判掉；
//   · 跨行拼接（`'<svg ...>' +` 换行 `'...'`）也放过：这类串本来就是这个仓库的写法。
// 返回一个完整字面量的第一个 token 为假（变量 / 拼接里带变量 / 函数调用）→ 交给 REVIEWED 表。
function isStaticHtml(rhs, lines, idx) {
  let i = 0
  while (i < rhs.length && /\s/.test(rhs[i])) i++
  if (i >= rhs.length) return false
  if (rhs[i] === '+') return false // 以 + 开头说明左侧是变量参与拼接，不是常量
  const c = rhs[i]
  if (c !== "'" && c !== '"' && c !== '`') return false
  let lit = readStringLiteral(rhs, i)
  if (lit === null) {
    if (!lines || idx === undefined) return false
    let rest = ''
    const tail = rhs.slice(i)
    for (let n = idx + 1; n < lines.length; n++) {
      rest += ' ' + lines[n]
      lit = readStringLiteral(tail + rest, 0)
      if (lit !== null) break
    }
    if (lit === null) return false
  }
  return !lit.value.includes('${')
}

// 工具：把注释替换成等长空格（保留行列位置），这样「注释里的路径不算引用」不需要额外状态机
function stripComments(src) {
  const out = src.split('')
  let q = null
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) {
      if (c === '\\') i++
      else if (c === q) q = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { q = c; continue }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++ }
      i--
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++ }
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i++ }
    }
  }
  return out.join('')
}

const results = []
const run = (id, title, fn) => {
  if (only && !only.has(id)) return
  const problems = []
  const notes = []
  try { fn(problems, notes) } catch (err) {
    problems.push('检查自身抛错（脚本 bug，不是仓库问题）：' + String((err && err.message) || err))
  }
  results.push({ id, title, problems, notes })
}

// ---------------------------------------------------------------------------
// ① 栅栏不变量：所有路由必须经唯一的 registerRoute() 包装，包装器内只允许一次裸 register
// ---------------------------------------------------------------------------
run('1', '检查所有后台接口必须走统一安全入口', (problems, notes) => {
  const src = read(HOST_FILE)

  // 裸 webServer.register 只允许 1 处：就在 registerRoute() 包装器内部
  const bare = [...src.matchAll(/\bctx\.webServer\.register\s*\(/g)]
  if (bare.length !== 1) {
    problems.push('ctx.webServer.register 出现 ' + bare.length + ' 次（应为 1 次：只在 registerRoute() 包装器内部）'
      + ' —— 新增的裸注册会绕过 requestRejection 栅栏（安全修复 S1 / issue #136）')
  } else {
    const at = bare[0].index
    const wrapper = src.indexOf('function registerRoute(')
    const wrapperEnd = src.indexOf('\n    }', wrapper)
    if (wrapper < 0 || at < wrapper || (wrapperEnd > 0 && at > wrapperEnd)) {
      problems.push('唯一的 ctx.webServer.register 不在 registerRoute() 函数体内 —— 栅栏被绕开了')
    }
  }

  // 每次 registerRoute({...}) 调用都必须显式给出 path 字面量。
  // 只认实参是对象字面量的调用（函数定义后面跟的是参数表 `(route)`，用这个形状差异排除）。
  const calls = [...src.matchAll(/registerRoute\s*\(\s*\{/g)]
  const paths = []
  let missing = 0
  for (const c of calls) {
    const block = balancedBlock(src, c.index + c[0].length - 1)
    if (block === null) { missing++; continue }
    const m = block.match(/\bpath\s*:\s*(['"])([^'"]+)\1/)
    if (m) paths.push(m[2])
    else missing++
  }
  if (missing) problems.push('有 ' + missing + ' 处 registerRoute({...}) 没给出 path 字面量（动态路径无法做路由对等检查）')

  // 路由条数应与 README 对外声明的条数一致（README 里「N 个 /dsh-whale/* 路由」是公开契约）
  const uniq = [...new Set(paths)]
  if (uniq.length !== paths.length) problems.push('registerRoute 的 path 有重复：' + paths.filter((p, i) => paths.indexOf(p) !== i).join(', '))
  // README 里「N 个 /dsh-whale/* 路由」是公开契约；允许中间夹杂 ** 加粗、` 反引号等标记
  const readme = read('README.md')
  const claim = readme.match(/(\d+)\s*个[^\d]{0,6}\/dsh-whale\/\*/)
  if (claim && Number(claim[1]) !== uniq.length) {
    problems.push('README 声明 ' + claim[1] + ' 个 /dsh-whale/* 路由，实际注册 ' + uniq.length + ' 条 —— 对外文档与代码不一致')
  }
  notes.push('注册路由 ' + uniq.length + ' 条；裸 register 1 处（在包装器内）；README 声明 '
    + (claim ? claim[1] + ' 条 ✓' : '未找到条数声明'))
  run.hostRoutes = uniq
})

// ---------------------------------------------------------------------------
// ② 路由对等：前端引用的 /dsh-whale/* 必须在宿主注册表里
// ---------------------------------------------------------------------------
run('2', '检查后端提供了所有前端调用的接口', (problems, notes) => {
  const hostRoutes = results.find((r) => r.id === '1') ? run.hostRoutes : null
  const src = read(HOST_FILE)
  const paths = hostRoutes || [...new Set([...src.matchAll(/registerRoute\s*\(\s*\{/g)]
    .map((c) => balancedBlock(src, c.index + c[0].length - 1))
    .filter(Boolean)
    .map((a) => (a.match(/\bpath\s*:\s*(['"])([^'"]+)\1/) || [])[2])
    .filter(Boolean))]
  const hostSet = new Set(paths)

  // 前端引用：在剥离注释后的代码上取字面量（注释里写的历史路由不算引用）
  const front = stripComments(read(FRONT_FILE)).split(/\r?\n/)
  const refs = new Map() // 路径 -> 行号
  for (let i = 0; i < front.length; i++) {
    for (const m of front[i].matchAll(new RegExp("(['\"`])(" + HOST_PREFIX.replace(/\//g, '\\/') + "[^'\"`]*)\\1", 'g'))) {
      const p = m[2].split('?')[0]
      if (p === HOST_PREFIX) continue
      if (!refs.has(p)) refs.set(p, i + 1)
    }
  }

  const dead = []
  const viaPrefix = []
  for (const [p, line] of refs) {
    if (hostSet.has(p)) continue
    // 动态前缀拼接（如 '/dsh-whale/sound/' + slot + '.mp3'）：能落在已注册路径下就算合法
    const covered = p.endsWith('/') && paths.some((h) => h.startsWith(p))
    if (covered) viaPrefix.push(p + '（前缀命中 L' + line + '）')
    else dead.push(p + '（L' + line + '）')
  }
  if (dead.length) {
    problems.push('前端引用了宿主未注册的路径（运行时静默 404，用户只看到「点了没反应」）：' + dead.join(', '))
  }
  notes.push('前端引用 ' + refs.size + ' 条；前缀命中 ' + (viaPrefix.length ? viaPrefix.join(', ') : '无') + '；宿主注册 ' + hostSet.size + ' 条')
})

// ---------------------------------------------------------------------------
// ③ 发布产物自洽：在真正的 npm 产物上验（这是「验证部署」而不是「验证源码」）
// ---------------------------------------------------------------------------
run('3', '检查打包后是否可以运行', (problems, notes) => {
  if (noPack) { notes.push('已跳过（--no-pack）'); return }
  const pkg = JSON.parse(read('package.json'))

  // files 白名单必须显式收进运行期必需的三样
  const files = Array.isArray(pkg.files) ? pkg.files : null
  if (!files) problems.push('package.json 没有 files 白名单 —— 发布内容不受控')
  else {
    for (const need of ['lib', 'assets']) {
      if (!files.includes(need)) problems.push('files 白名单缺少 "' + need + '"（发布包里会没有运行期文件）')
    }
  }
  if (pkg.main && !has(pkg.main)) problems.push('package.json 的 main 指向不存在的文件：' + pkg.main)
  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  if (!patch) problems.push('package.json 缺少 dsh.bundle.patch —— DSH 找不到挂载声明')
  else {
    const rel = patch.replace(/^\.\//, '')
    if (!has(rel)) problems.push('dsh.bundle.patch 指向不存在的文件：' + patch)
    else if (files && !files.includes(rel) && !files.some((f) => rel.startsWith(f.replace(/\/$/, '') + '/'))) {
      problems.push('dsh.bundle.patch 指向的 ' + rel + ' 不在 files 白名单里（装出来没有这个文件）')
    } else {
      // 挂载声明里的插件名应与包名一致，否则 patch 挂的不是这个包
      const yml = read(rel)
      const nm = yml.match(/^\s*name:\s*(.+)$/m)
      const declared = nm ? nm[1].trim() : null
      if (declared && declared !== pkg.name) {
        problems.push(rel + ' 里声明的 name (' + declared + ') 与 package.json 的 name (' + pkg.name + ') 不一致')
      }
    }
  }

  // WIDGET_FILE_CANDIDATES 的候选顺序（宿主按这个顺序找前端单文件，装到 npm 后必须命中）
  const host = read(HOST_FILE)
  const arrM = host.match(/const WIDGET_FILE_CANDIDATES = \[([\s\S]*?)\]/)
  const cands = arrM
    ? [...arrM[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] || m[2]).filter((s) => /\.js$/.test(s))
    : []
  if (!cands.length) problems.push('解析不到 WIDGET_FILE_CANDIDATES —— 宿主如何找前端单文件无法核验')

  // 真正打包，看产物里到底有什么
  // （Windows 上 npm 是 npm.cmd，直接 spawn 'npm' 会 ENOENT；CI 在 Linux 上没这个问题，
  //   但本脚本要能在开发机上跑，所以按平台选可执行名）
  let tarball = ''
  try {
    // Windows 上 npm 实际是 npm.cmd，Node 不会自动走 PATHEXT：借 shell 执行。
    // 刻意用「单条命令串」而不是「shell:true + 参数数组」——后者会触发 Node 的 DEP0190 警告。
    const out = process.platform === 'win32'
      ? execSync('npm pack --json --ignore-scripts', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      : execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const info = JSON.parse(out)[0]
    tarball = path.join(ROOT, info.filename)
    const inPack = new Set(info.files.map((f) => f.path))

    for (const need of ['lib/index.js', 'lib/accounting.mjs', FRONT_FILE, 'package.json']) {
      if (!inPack.has(need)) problems.push('发布包里缺少 ' + need)
    }
    if (patch) {
      const rel = patch.replace(/^\.\//, '')
      if (!inPack.has(rel)) problems.push('发布包里缺少 dsh.bundle.patch 指向的 ' + rel)
    }
    // 候选是三个「安装后可能的相对位置」：lib/（被拆包时）、包根、assets/。
    // 三个都是同一个文件名 whale-widget.js，所以只要包里有任一处即可被 loadWidgetJs() 命中。
    const hit = cands.find((c) => {
      const base = path.posix.basename(c)
      return inPack.has(path.posix.join('lib', base))
        || inPack.has(base)
        || inPack.has(path.posix.join('assets', base))
    })
    if (!hit) problems.push('发布包里没有任何 WIDGET_FILE_CANDIDATES 候选（宿主 loadWidgetJs() 会返回空串 → 挂件不出现）')

    // 发布副本不得含开发机路径：在打包白名单涉及的三个源文件上静态确认
    const devHit = [HOST_FILE, 'lib/accounting.mjs', FRONT_FILE]
      .filter((f) => has(f))
      .filter((f) => /TestBox/.test(read(f)))
    if (devHit.length) {
      problems.push('这些发布文件里出现开发机路径 TestBox（必须先跑 _strip-dev-paths.mjs --apply）：' + devHit.join(', '))
    }

    notes.push('包 ' + pkg.name + '@' + pkg.version + '：' + info.files.length + ' 个文件 / '
      + (info.size / 1024).toFixed(0) + ' KB；候选命中 ' + (hit || '无'))
  } catch (err) {
    problems.push('npm pack 失败（无法验证发布产物）：' + String((err && err.message) || err))
  } finally {
    if (tarball && fs.existsSync(tarball)) { try { fs.unlinkSync(tarball) } catch (e) { void e } }
  }
})

// ---------------------------------------------------------------------------
// ④ 门禁一致性：日常检查(ci.yml) 与 发布前门禁(publish.yml) 必须覆盖同一组关键检查
// ---------------------------------------------------------------------------
run('4', '检查日常ci与发版ci流程是否一致', (problems, notes) => {
  const REQUIRED = [
    { name: '图层审计', re: /z-layer-audit\.mjs/ },
    { name: '语法检查', re: /node\s+--check\s+lib\/index\.js/ },
    { name: '开发机路径扫描', re: /TestBox/ },
  ]
  const wf = (rel) => (has(rel) ? read(rel) : null)
  const ciy = wf('.github/workflows/ci.yml')
  const pub = wf('.github/workflows/publish.yml')
  if (!ciy) problems.push('缺少 .github/workflows/ci.yml')
  if (!pub) problems.push('缺少 .github/workflows/publish.yml')
  for (const r of REQUIRED) {
    if (ciy && !r.re.test(ciy)) problems.push('ci.yml 缺少「' + r.name + '」—— 日常 push/PR 挡不住这类问题')
    if (pub && !r.re.test(pub)) problems.push('publish.yml 缺少「' + r.name + '」—— 审计不过也会发布')
  }
  if (ciy && pub) {
    const ciHasAudit = /ci-audit\.mjs/.test(ciy)
    const pubHasAudit = /ci-audit\.mjs/.test(pub)
    if (ciHasAudit !== pubHasAudit) {
      problems.push('ci-audit.mjs 只挂在一边（ci.yml=' + ciHasAudit + ' / publish.yml=' + pubHasAudit + '）—— 两处门禁必须同一份')
    }
    if (!ciHasAudit && !pubHasAudit) notes.push('提示：本脚本还没挂进任何 workflow（仅本地可跑）')
  }
  notes.push('两份 workflow 的关键检查覆盖一致')
})

// ---------------------------------------------------------------------------
// ⑤ 注入面：innerHTML/outerHTML 右侧必须静态可证，或落在已审阅清单内
// ---------------------------------------------------------------------------
run('5', '检查页面动态内容是否写清来源', (problems, notes) => {
  // 允许清单外置在 tools/ci-audit.allowlist.json —— 它是仓库自己的文件，不是脚本里的常量。
  // 这样脚本可以拿到任何仓库跑（自检脚本会喂一个写了 allowlist 的样本进来）。
  const allowFile = 'tools/ci-audit.allowlist.json'
  let allow = new Set()
  if (has(allowFile)) {
    const cfg = JSON.parse(read(allowFile))
    allow = new Set((cfg.allow || []).map((a) => a.key))
  } else {
    notes.push('提示：没有 ' + allowFile + '，所有非静态 HTML 写入都会被要求登记')
  }

  const seen = new Map()
  for (const rel of [HOST_FILE, FRONT_FILE]) {
    const lines = stripComments(read(rel)).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const a = htmlAssign(lines[i])
      if (!a || isStaticHtml(a.rhs, lines, i)) continue
      // 键里带文件路径：同一句写法出现在别的文件里必须重新登记（防止"换个文件就悄悄放过"）
      seen.set(rel + ' :: ' + a.key, rel + ':' + (i + 1))
    }
  }
  const unknown = [...seen.keys()].filter((k) => !allow.has(k))
  if (unknown.length) {
    problems.push('发现未登记的动态 HTML 写入（可能是 issue #143 同类注入，也可能只是需要一次审阅）：'
      + unknown.map((k) => k + '  @ ' + seen.get(k)).join('；')
      + ' —— 转义它，或把它登记进 ' + allowFile + ' 并写明数据来源')
  }
  const stale = [...allow].filter((k) => !seen.has(k))
  if (stale.length) {
    problems.push('允许清单里有已不存在的条目（清单会腐烂，请删掉）：' + stale.join('；'))
  }
  notes.push('非静态 HTML 写入 ' + seen.size + ' 处，全部在允许清单内；清单共 ' + allow.size + ' 条')
})

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
let failed = 0
console.log('核心不变量自检（tools/ci-audit.mjs）' + (noPack ? '  [--no-pack]' : ''))
for (const r of results) {
  if (r.problems.length) failed++
  console.log('')
  console.log((r.problems.length ? '× ' : '√ ') + '[' + r.id + '] ' + r.title)
  for (const n of r.notes) console.log('    · ' + n)
  for (const p of r.problems) console.log('    × ' + p)
}
console.log('')
if (failed) {
  console.log('结果：' + failed + '/' + results.length + ' 项不通过')
  process.exit(1)
}
console.log('结果：' + results.length + '/' + results.length + ' 项全部通过')
