#!/usr/bin/env node
// dsh-whale-widget 安装器（跨平台，零依赖，Node 18+）
//
// 设计原则（都是踩过或想清楚的点）：
// 1. **走官方登记入口**：DSH 的 `dsh plugin --profile <name> <pnpm args>` 是"在 profile 目录里转发 pnpm
//    并自动对账 dsh.profile.bundles"的官方命令。安装器优先调它，绝不自己手改 profile 的 package.json
//    （手改要处理依赖树与 bundles 两处一致，容易做成半截状态）。
// 2. **插件装到版本目录 + 稳定链接**：`~/.dsh/dev/dsh-whale-widget-<ver>/` 是真身，
//    `~/.dsh/dev/dsh-whale-widget` 是指向它的 junction/symlink。升级＝换链接，回滚＝换回旧链接。
// 3. **不静默写用户数据**：语音包"缺则装、有则不动"；`config.json` 已存在就绝不覆盖（用户选中的音色是用户的）。
// 4. **幂等**：重复运行结果一致；`--dry-run` 只打印将做什么。
// 5. **只删自己装的**：卸载只动登记、链接与安装器拥有的版本目录；用户数据（.dshw-*.json、
//    whale-roles/、whale-audio/、whale-voice/）默认保留，要清得显式 `--purge-data`。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')            // 解压后的分发包根
const PLUGIN_SRC = path.join(ROOT, 'plugin')
const VOICE_SRC = path.join(ROOT, 'voicepacks')
const PKG = JSON.parse(fs.readFileSync(path.join(PLUGIN_SRC, 'package.json'), 'utf8'))
const PLUGIN_NAME = PKG.name
const VERSION = PKG.version

// —— 参数 ——
const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const val = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const PROFILE = val('profile', 'web')
const HOME = path.resolve(val('home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')))
const DRY = has('dry-run')
const COPY = has('copy')                          // 不建链接，直接复制到 dev/（某些环境不允许链接）
const FORCE = has('force')
const NO_VOICE = has('no-voice')
const SKIP_REGISTER = has('no-register')          // 供沙箱测试/手工登记
const UNINSTALL = has('uninstall')
const PURGE = has('purge-data')
const DEV_DIR = path.join(HOME, 'dev')
const LINK = path.join(DEV_DIR, PLUGIN_NAME)
const VER_DIR = path.join(DEV_DIR, `${PLUGIN_NAME}-${VERSION}`)
const STATE_DIR = path.join(HOME, 'install-state')
const STATE = path.join(STATE_DIR, `${PLUGIN_NAME}.json`)
const PROFILE_DIR = path.join(HOME, 'profiles', PROFILE)

let step = 0
const log = (m) => console.log(m)
const head = (m) => console.log(`\n[${++step}] ${m}`)
const ok = (m) => console.log(`    ✓ ${m}`)
const warn = (m) => console.log(`    ! ${m}`)
const die = (m) => { console.error(`\n✗ ${m}`); process.exit(1) }

if (has('help') || has('h')) {
  console.log(`dsh-whale-widget ${VERSION} 安装器

用法：node installer/install.mjs [选项]

  --dry-run        只打印将做什么，不改动任何文件
  --no-voice       只装插件，不装语音包（挂件可用，语录静默）
  --no-register    只铺文件，不调用 dsh plugin 登记（手工登记时用）
  --profile <名>   目标 profile（默认 web）
  --home <目录>    目标 DSH_HOME（默认 ~/.dsh，或环境变量 DSH_HOME）
  --copy           不建目录链接，直接复制到 dev/（环境不允许链接时用）
  --force          目标路径已存在且不是链接时，备份后继续
  --uninstall      卸载（注销登记 + 移除链接，保留用户数据）
  --purge-data     与 --uninstall 连用：连语音包一起删

示例：
  node installer/install.mjs --dry-run
  node installer/install.mjs
  node installer/install.mjs --uninstall --purge-data
`)
  process.exit(0)
}

// 跑外部命令（需要 dsh 时用）。
// Windows 上 dsh 是 .cmd 垫片：Node 24 直接 spawn('dsh.cmd') 会 EINVAL，必须借 shell；
// 而给 `shell: true` 传 **args 数组**会触发 DEP0190（参数不转义、只做字符串拼接），
// 传**一整条字符串**才是安全且正确的做法（实测：含空格/&/^/|/中文的参数都能完整送达）。
// cmd 的引号语义：双引号内 `& ^ ( ) | < >` 都是字面量，所以只需外层包裹双引号；
// 真正无法安全表达的是 `"` 与 `%`（后者会做变量展开）——安装器启动时会直接拒绝这种 HOME。
function quoteWin(s) {
  return '"' + String(s) + '"'
}
function run(cmd, args) {
  let r
  if (process.platform === 'win32') {
    r = spawnSync([cmd, ...args].map(quoteWin).join(' '), { stdio: 'pipe', encoding: 'utf8', shell: true })
  } else {
    r = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8' })
  }
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), err: r.error }
}
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
// 复制目录（保留相对结构）；不跟随源里的链接
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }) }
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink() } catch { return false } }
function exists(p) { try { fs.lstatSync(p); return true } catch { return false } }
// 建"目录链接"：Windows 用 junction（不需要管理员），其它平台用目录符号链接
function makeLink(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  fs.symlinkSync(target, linkPath, type)
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

// ————————————————————————————————— 卸载 —————————————————————————————————
if (UNINSTALL) {
  head(`卸载 ${PLUGIN_NAME}`)
  if (!SKIP_REGISTER) {
    const r = run('dsh', ['plugin', '--profile', PROFILE, 'remove', PLUGIN_NAME])
    if (r.code === 0) ok(`已从 profile「${PROFILE}」注销`)
    else warn(`注销失败（可手动执行）：dsh plugin --profile ${PROFILE} remove ${PLUGIN_NAME}\n      ${r.out.trim().split('\n')[0]}`)
  }
  if (DRY) log(`    （--dry-run）将移除链接 ${LINK}`)
  else if (isLink(LINK)) { fs.unlinkSync(LINK); ok(`已移除链接 ${LINK}`) }
  else if (exists(LINK)) warn(`${LINK} 不是链接（可能是手工复制的目录），未删除`)
  const state = readJson(STATE)
  if (state && Array.isArray(state.voicePacks) && PURGE) {
    for (const id of state.voicePacks) {
      const p = path.join(HOME, 'whale-voice', 'packs', id)
      if (exists(p)) { rmrf(p); ok(`已删除语音包 ${id}（--purge-data）`) }
    }
  } else if (state && state.voicePacks && state.voicePacks.length && !PURGE) {
    log(`    保留语音包 ${state.voicePacks.join(', ')}（要一并删除用 --purge-data）`)
  }
  log(`\n提示：用户数据（余额记录/角色/音效/语音包）默认保留在 ${HOME}`)
  log(`      安装的版本目录 ${VER_DIR} 未删除，确认新版本可用后可手动清理`)
  process.exit(0)
}

// ————————————————————————————————— 安装 —————————————————————————————————
log(`dsh-whale-widget ${VERSION} 安装器`)
log(`  分发包: ${ROOT}`)
log(`  DSH_HOME: ${HOME}`)
log(`  profile : ${PROFILE}${DRY ? '   [--dry-run 只演示]' : ''}`)

if (!exists(PLUGIN_SRC)) die(`分发包不完整：找不到 ${PLUGIN_SRC}`)
// HOME 里出现 `"` 或 `%` 时，命令行没法安全表达（`%` 会被 cmd 做变量展开）——
// 与其塞一条可能被展开/截断的命令，不如直接说清楚怎么绕开。
if (process.platform === 'win32' && /["%]/.test(HOME)) {
  die(`DSH_HOME 路径含 cmd 无法安全转义的字符（" 或 %）：\n  ${HOME}\n  请把 DSH_HOME 换到不含这两个字符的目录，或手工执行登记命令。`)
}

head('校验分发包完整性（SHA256SUMS）')
const sumsFile = path.join(ROOT, 'SHA256SUMS')
if (fs.existsSync(sumsFile)) {
  let bad = 0
  let n = 0
  for (const line of fs.readFileSync(sumsFile, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim())
    if (!m) continue
    const f = path.join(ROOT, m[2])
    if (!fs.existsSync(f)) { warn(`缺文件 ${m[2]}`); bad++; continue }
    if (sha256(f) !== m[1]) { warn(`校验不符 ${m[2]}`); bad++ }
    n++
  }
  if (bad) warn(`${bad}/${n} 个文件校验异常（可能损坏或被杀软改动，继续但请留意）`)
  else ok(`${n} 个文件校验通过`)
} else {
  warn('未找到 SHA256SUMS，跳过校验')
}

head('安装插件本体')
if (DRY) {
  log(`    将复制 ${PLUGIN_SRC} → ${VER_DIR}`)
  log(`    将建立链接 ${LINK} → ${VER_DIR}`)
} else {
  rmrf(VER_DIR + '.tmp')
  copyDir(PLUGIN_SRC, VER_DIR + '.tmp')
  fs.rmSync(VER_DIR, { recursive: true, force: true })
  fs.renameSync(VER_DIR + '.tmp', VER_DIR)
  ok(`已解出 ${VER_DIR}`)

  if (exists(LINK) && !isLink(LINK)) {
    if (!FORCE) die(`${LINK} 已存在且不是链接（可能是手工复制的安装）。\n  请先自行处理，或加 --force 把它改名为 .bak-<时间戳> 后继续。`)
    const bak = `${LINK}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.renameSync(LINK, bak)
    warn(`原目录已改名为 ${bak}`)
  }
  if (isLink(LINK)) fs.unlinkSync(LINK)
  if (COPY) {
    copyDir(VER_DIR, LINK)
    ok(`已复制到 ${LINK}（--copy 模式，无链接）`)
  } else {
    makeLink(VER_DIR, LINK)
    ok(`已链接 ${LINK} → ${VER_DIR}`)
  }
}

head(`登记到 profile「${PROFILE}」`)
const addSpec = `link:${LINK.replace(/\\/g, '/')}`
if (SKIP_REGISTER) {
  warn(`已跳过（--no-register）。手工执行：dsh plugin --profile ${PROFILE} add "${addSpec}"`)
} else if (DRY) {
  log(`    将执行：dsh plugin --profile ${PROFILE} add "${addSpec}"`)
} else {
  const r = run('dsh', ['plugin', '--profile', PROFILE, 'add', addSpec])
  if (r.code === 0) {
    ok(`已登记（dsh 会自动把 ${PLUGIN_NAME} 加进 dsh.profile.bundles）`)
    const tail = r.out.trim().split('\n').filter((l) => l.trim()).slice(-3)
    for (const l of tail) log(`      ${l}`)
  } else {
    warn('登记失败。请在终端手工执行下面这条命令：')
    log(`      dsh plugin --profile ${PROFILE} add "${addSpec}"`)
    log(`      原始输出：${r.out.trim().split('\n').slice(-2).join(' | ')}`)
  }
}

head('安装语音包')
const installedPacks = []
if (NO_VOICE) {
  warn('已跳过（--no-voice）：挂件可用，但语录不会出声')
} else if (!exists(VOICE_SRC)) {
  warn('这个分发包不含语音包（code 版）：挂件可用，语录静默')
} else {
  const packs = fs.readdirSync(VOICE_SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  if (!packs.length) warn('voicepacks/ 是空的')
  const voiceRoot = path.join(HOME, 'whale-voice')
  const regFile = path.join(voiceRoot, 'registry.json')
  const cfgFile = path.join(voiceRoot, 'config.json')
  for (const id of packs) {
    const src = path.join(VOICE_SRC, id)
    const dst = path.join(voiceRoot, 'packs', id)
    if (exists(dst)) {
      warn(`语音包 ${id} 已存在，保持不动（要替换请先手动移走 ${dst}）`)
      installedPacks.push(id)
      continue
    }
    if (DRY) { log(`    将安装语音包 ${id} → ${dst}`); installedPacks.push(id); continue }
    // 逐文件校验（若带 SHA256SUMS）
    const sums = path.join(src, 'SHA256SUMS')
    if (fs.existsSync(sums)) {
      let bad = 0
      for (const line of fs.readFileSync(sums, 'utf8').split('\n')) {
        const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim())
        if (!m) continue
        const f = path.join(src, m[2])
        if (!fs.existsSync(f) || sha256(f) !== m[1]) bad++
      }
      if (bad) warn(`语音包 ${id} 有 ${bad} 个文件校验不符`)
    }
    rmrf(dst + '.tmp')
    copyDir(src, dst + '.tmp')
    rmrf(dst)
    fs.renameSync(dst + '.tmp', dst)
    const man = readJson(path.join(dst, 'manifest.json'))
    ok(`语音包 ${id} 已安装（${man ? man.utterances.length : '?'} 条语录）`)
    installedPacks.push(id)
    // 注册表只补缺失项；默认包只在没有默认包时才设置
    const reg = readJson(regFile) || { schemaVersion: 1, defaultPackId: null, packs: [] }
    if (!Array.isArray(reg.packs)) reg.packs = []
    const entry = { id, label: (man && man.label) || id, manifest: `packs/${id}/manifest.json`, enabled: true }
    const at = reg.packs.findIndex((p) => p && p.id === id)
    if (at >= 0) reg.packs[at] = entry
    else reg.packs.push(entry)
    if (!reg.defaultPackId) reg.defaultPackId = id
    writeJson(regFile, reg)
    ok(`已登记到 registry.json（默认包：${reg.defaultPackId}）`)
    // config.json：**已存在就不动**（用户选中的音色是用户的）
    if (exists(cfgFile)) {
      const cfg = readJson(cfgFile) || {}
      log(`    config.json 已存在，保持不变（当前包：${cfg.packId || '(未设置)'}）`)
      if (!cfg.packId) { cfg.packId = id; cfg.enabled = cfg.enabled !== false; writeJson(cfgFile, cfg); ok(`原配置没有选中包，已设为 ${id}`) }
    } else {
      writeJson(cfgFile, { enabled: true, packId: id, updatedAt: new Date().toISOString() })
      ok('已写入 config.json（启用语音 + 选中该包）')
    }
  }
}

head('记录安装状态')
if (!DRY) {
  writeJson(STATE, {
    plugin: PLUGIN_NAME, version: VERSION, profile: PROFILE,
    link: LINK, target: VER_DIR, voicePacks: installedPacks,
    installedAt: new Date().toISOString(), mode: COPY ? 'copy' : 'link',
  })
  ok(`已写入 ${STATE}`)
  if (exists(PROFILE_DIR)) ok(`profile 目录：${PROFILE_DIR}`)
  else warn(`profile 目录尚不存在（${PROFILE_DIR}）——首次启动 dsh 时会自动创建`)
}

console.log(`
————————————————————————————————————————————
安装完成${DRY ? '（这是 --dry-run，什么都没改）' : ''}

接下来：
  1. 重启 DSH Web：关掉正在跑的 dsh web，再执行   dsh web
  2. 打开界面右下角的鲸鱼挂件${installedPacks.length ? '，点泡泡就会听到配音' : ''}
  3. 自检（可选）：浏览器打开  http://127.0.0.1:3080/dsh-whale/voice-packs.json
     ${installedPacks.length ? '应能看到 diona-v1 与 47 条语录' : '（未装语音包，此处会显示空列表，属正常）'}

卸载：node installer/install.mjs --uninstall          （保留你的数据）
全清：node installer/install.mjs --uninstall --purge-data
`)
