// 打包「可分发的鲸鱼挂件」：生成两个形态的 zip
//
//   full 版：插件 + 语音包（给朋友私下用；语音权利状态见 NOTICE-VOICE.md）
//   code 版：只有插件（可公开分发；语音由使用者自行准备）
//
// 用法（在插件仓库根执行）：
//   node tools/dist/build_dist.mjs                       # 两个形态都出
//   node tools/dist/build_dist.mjs --flavor full         # 只出 full
//   node tools/dist/build_dist.mjs --pack <语音包目录>   # 换一个语音包源（默认取 DSH_HOME 里的 diona-v1）
// 产出：
//   tools/dist/out/dsh-whale-widget-<ver>-<flavor>.zip
//   tools/dist/out/SHA256SUMS.txt
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const PAYLOAD = path.join(HERE, 'payload')
const OUT = path.join(HERE, 'out')
// staging 放系统临时目录：**不要**放在被复制进分发包的目录里
// （tools/ 是打包内容，staging 放里面就会"自己装自己"，第一次跑就是这么炸的）
const STAGING = path.join(os.tmpdir(), 'dsh-whale-widget-dist')
const argv = process.argv.slice(2)
const val = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const FLAVOR = val('flavor', 'all')
const HOME = path.resolve(val('home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')))
const DEFAULT_PACK = path.join(HOME, 'whale-voice', 'packs', 'diona-v1')
const PACK_SRC = path.resolve(val('pack', DEFAULT_PACK))
const PACK_ID = path.basename(PACK_SRC)

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
const VERSION = pkg.version
const DATE = new Date().toISOString().slice(0, 10)

const sha256 = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })

// 必须在**复制时**跳过构建产物目录：staging 就在 tools/dist/out 里面，而 tools 又是要被打包的内容，
// 不跳过就会把 staging 复制进它自己（第一次跑就是这么炸的：ENAMETOOLONG，路径无限嵌套）。
// 教训：排除规则要作用在"复制动作"上，不能等复制完再清理。
const SKIP_DIRS = new Set([
  path.join(HERE, 'out'),
  path.join(HERE, 'staging'),
  path.join(REPO, '.git'),
  path.join(REPO, 'node_modules'),
])
const skip = (p) => SKIP_DIRS.has(p) || p.split(path.sep).some((seg) => seg === 'node_modules' || seg === '.git')

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (skip(s)) continue
    if (e.isDirectory()) copyDir(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}
function walk(dir, base = dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, base))
    else if (e.isFile()) out.push(path.relative(base, p).replace(/\\/g, '/'))
  }
  return out
}

// —— 语音包：补一份 PROVENANCE.json 与逐文件 SHA256SUMS（进包，收件人可自证完整性）——
function voiceProvenance(packDir) {
  const man = JSON.parse(fs.readFileSync(path.join(packDir, 'manifest.json'), 'utf8'))
  const files = Object.keys(man.utterances.reduce((a, u) => {
    a[u.file] = 1
    for (const v of u.variants || []) a[v.file] = 1
    return a
  }, {}))
  fs.writeFileSync(path.join(packDir, 'SHA256SUMS'),
    files.map((f) => `${sha256(path.join(packDir, f))}  ${f}`).join('\n') + '\n', 'utf8')
  const prov = {
    packId: man.packId,
    label: man.label,
    voice: man.voice,
    engine: man.engine,
    generatedAt: man.generatedAt,
    distributedAt: new Date().toISOString(),
    utterances: man.utterances.length,
    fragments: files.length,
    format: `${man.sampleRate}Hz ${man.channels}ch ${man.format}`,
    provenance: {
      character: '迪奥娜（原神 / Genshin Impact）',
      referenceSource: '第三方粉丝中文语音素材包（社区俗称 AI Hobbyist 中文语音包），非官方发行物',
      method: 'IndexTTS2 零样本音色克隆（本机生成，未使用官方音源文件）',
      rights: '角色与声音权利属版权方；本语音包仅供个人私下使用，未获授权，禁止商业使用与公开再分发',
    },
  }
  fs.writeFileSync(path.join(packDir, 'PROVENANCE.json'), JSON.stringify(prov, null, 2) + '\n', 'utf8')
  return { files: files.length, utterances: man.utterances.length }
}

// —— 组装一个形态 ——
function stage(flavor) {
  const withVoice = flavor === 'full'
  const name = `${pkg.name}-${VERSION}-${flavor}`
  const root = path.join(STAGING, name)
  rmrf(root)
  fs.mkdirSync(root, { recursive: true })

  // 1. 插件本体：按 package.json 的 files 清单（白名单，避免把开发垃圾打进去）
  const pluginDst = path.join(root, 'plugin')
  for (const rel of pkg.files) {
    const s = path.join(REPO, rel)
    if (!fs.existsSync(s)) { console.log(`    ! 跳过不存在的 ${rel}`); continue }
    const d = path.join(pluginDst, rel)
    if (fs.statSync(s).isDirectory()) copyDir(s, d)
    else { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d) }
  }
  for (const extra of ['package.json', 'LICENSE', 'PROVENANCE.md']) {
    fs.copyFileSync(path.join(REPO, extra), path.join(pluginDst, extra))
  }

  // 2. 安装器与顶层文档
  fs.mkdirSync(path.join(root, 'installer'), { recursive: true })
  fs.copyFileSync(path.join(PAYLOAD, 'installer', 'install.mjs'), path.join(root, 'installer', 'install.mjs'))
  fs.copyFileSync(path.join(PAYLOAD, 'install.cmd'), path.join(root, 'install.cmd'))
  fs.copyFileSync(path.join(PAYLOAD, 'install.sh'), path.join(root, 'install.sh'))
  fs.chmodSync(path.join(root, 'install.sh'), 0o755)
  fs.copyFileSync(path.join(PAYLOAD, 'NOTICE-VOICE.md'), path.join(root, 'NOTICE-VOICE.md'))
  fs.copyFileSync(path.join(REPO, 'LICENSE'), path.join(root, 'LICENSE'))
  fs.copyFileSync(path.join(REPO, 'PROVENANCE.md'), path.join(root, 'PROVENANCE.md'))

  // 3. INSTALL.md（模板替换）
  const guide = fs.readFileSync(path.join(PAYLOAD, 'INSTALL.md'), 'utf8')
    .replaceAll('{{VERSION}}', VERSION)
    .replaceAll('{{DATE}}', DATE)
    .replaceAll('{{FLAVOR_LABEL}}', withVoice ? '完整版（含语音包）' : '仅代码版（不含语音包）')
    .replaceAll('{{VOICE_SELFTEST}}', withVoice
      ? '应能看到 `diona-v1` 与 47 条语录；看不到说明语音包没装上或没重启。'
      : '这里会显示一个空列表——本包不含语音包，属正常。挂件本身照常工作。')
    .replaceAll('{{VOICE_LICENSE_LINE}}', withVoice
      ? '**本包含语音包**，仅限个人私下使用，请先读 `NOTICE-VOICE.md`。'
      : '本包**不含**语音包，因此可以随代码一起自由分发。')
  fs.writeFileSync(path.join(root, 'INSTALL.md'), guide, 'utf8')

  // 4. 语音包（只 full 版）
  let voice = null
  if (withVoice) {
    if (!fs.existsSync(path.join(PACK_SRC, 'manifest.json'))) {
      throw new Error(`找不到语音包：${PACK_SRC}\n  用 --pack <目录> 指定，或先构建语音包。`)
    }
    const vdst = path.join(root, 'voicepacks', PACK_ID)
    copyDir(PACK_SRC, vdst)
    voice = voiceProvenance(vdst)
  }

  // 5. SHA256SUMS（相对分发包根，安装器按它自检）
  const files = walk(root).filter((f) => f !== 'SHA256SUMS')
  fs.writeFileSync(path.join(root, 'SHA256SUMS'),
    files.map((f) => `${sha256(path.join(root, f))}  ${f}`).join('\n') + '\n', 'utf8')

  // 6. 打 zip：**连最外层文件夹一起打**（收件人解压出来是一个干净的目录，
  //    而不是一堆散文件倒进当前文件夹——`Compress-Archive -Path <root>\*` 就会那样）
  fs.mkdirSync(OUT, { recursive: true })
  const zip = path.join(OUT, `${name}.zip`)
  rmrf(zip)
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command',
        `Compress-Archive -Path '${root}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`],
        { stdio: 'pipe', encoding: 'utf8' })
    : spawnSync('zip', ['-qr', zip, name], { cwd: STAGING, stdio: 'pipe', encoding: 'utf8' })
  if (!fs.existsSync(zip)) throw new Error(`打包失败：${r.stderr || r.stdout || r.error}`)

  return {
    flavor, zip, root, bytes: fs.statSync(zip).size,
    files: files.length + 1, voice,
    fragments: voice ? voice.files : 0,
  }
}

// —— 主流程 ——
const flavors = FLAVOR === 'all' ? ['full', 'code'] : [FLAVOR]
if (flavors.some((f) => f !== 'full' && f !== 'code')) throw new Error('--flavor 只能是 full | code | all')
console.log(`打包 dsh-whale-widget ${VERSION}（形态：${flavors.join(' + ')}）`)
const results = []
for (const f of flavors) {
  console.log(`\n[${f}]`)
  const r = stage(f)
  results.push(r)
  console.log(`    ✓ ${path.basename(r.zip)}  ${(r.bytes / 1048576).toFixed(2)} MB  文件 ${r.files} 个`
    + (r.voice ? `  语音包 ${PACK_ID}（${r.voice.utterances} 条语录 / ${r.fragments} 个片段）` : '  （不含语音包）'))
}
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'),
  results.map((r) => `${sha256(r.zip)}  ${path.basename(r.zip)}`).join('\n') + '\n', 'utf8')
console.log(`\n校验和：${path.join(OUT, 'SHA256SUMS.txt')}`)
for (const l of fs.readFileSync(path.join(OUT, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')) console.log('  ' + l)
console.log(`\n产出目录：${OUT}`)
