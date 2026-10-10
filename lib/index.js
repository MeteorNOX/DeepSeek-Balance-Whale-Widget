import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dns from 'node:dns'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  preciseMoney, addMoney, sumMoney, beijingDay, dayOffset,
  observeBalance, balanceSummary, daySummary, accountingDays, reconcileBalance,
} from './accounting.mjs'

// Node 的 fetch(undici) 可能优先 IPv6：个别域名(如 open.bigmodel.cn)有 AAAA 记录但本机 IPv6 不通，
// 会直接报 "fetch failed"（curl 会自动回退 IPv4，所以看起来正常）。统一改为 IPv4 优先。
try { dns.setDefaultResultOrder('ipv4first') } catch (err) {}

// Package root: lib/index.js -> package root. Keeps the bundle relocatable
// when installed as a normal DSH npm plugin (node_modules or a local link).
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// DSH home: used for the widget memory/role/audio files, since node_modules may
// be read-only or cleaned on update.
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// Whale image: package-relative first (ship DSniang1/DSniang02.png in assets/),
// legacy absolute paths as fallback.
const IMAGE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'DSniang1.png'),
  path.join(PACKAGE_ROOT, 'assets', 'DSniang02.png'),
]
// 自定义角色图片存放目录（第一个可写的会被使用；roles.json 存角色元数据）
// ⭐ 2026-10-02（用户要求"并成一份"）：**用户数据的候选表一律 $DSH_HOME 优先**，开发机路径降级为兜底。
//   原因：桌面客户端加载的是 strip 过的发布副本（只认 $DSH_HOME），而开发版宿主原先把开发机路径排在第一位
//   ⇒ 本机上网页端与桌面端**各写各的**（实测两端同时各写一份 .dshw-usage.json / .dshw-bubble.json），
//   互相看不到对方的改动 —— 表现就是"删掉的模块又冒出来""记账数对不上"。
//   ⚠️ 这个常量必须在**所有**用到它的候选表之前定义（const 有 TDZ），所以放在最前面。
//   ⚠️ `_strip-dev-paths.mjs` 会把发布副本里含开发机路径的行删掉，发布版只剩前两条 $DSH_HOME ✓
const DATA_CANDIDATES_TAIL = [
]
// ⭐ 2026-10-02（用户要求"并成一份"）：**角色图库目录也 $DSH_HOME 优先**（开发机路径降级为兜底）。
const ROLE_DIR_CANDIDATES = [
  path.join(DSH_HOME, 'whale-roles'),
  path.join(DSH_HOME, 'profiles', 'web', 'whale-roles'),
  DATA_CANDIDATES_TAIL[0] + 'whale-roles/',
  DATA_CANDIDATES_TAIL[1] + 'whale-roles/',
]
const ROLE_INDEX_NAME = 'roles.json'
const ROLE_DEFAULT_ID = 'default'
// 自定义音频片段存放目录（每个片段一个 <id>.wav + audio.json 索引）
const AUDIO_DIR_CANDIDATES = [
  path.join(DSH_HOME, 'whale-audio'),
  path.join(DSH_HOME, 'profiles', 'web', 'whale-audio'),
  DATA_CANDIDATES_TAIL[0] + 'whale-audio/',
  DATA_CANDIDATES_TAIL[1] + 'whale-audio/',
]
const AUDIO_INDEX_NAME = 'audio.json'
// —— 音乐播放器：托管目录 $DSH_HOME/whale-music/ + 状态文件 $DSH_HOME/.dshw-music.json ——
// 为什么和 whale-audio/（音效库）分成两套：音效是"插件自己导入的片段"，要维护 audio.json 索引；
// 音乐是"用户自己丢进来的歌"，插件**只读不写、不建索引** —— 用户用资源管理器往目录里拷歌，
// 下一次扫描就出现，不需要经过插件的导入流程（也因此不需要"清理空索引"这种维护动作）。
// 候选表只放 $DSH_HOME（含 profiles/web 兜底）：DATA_CANDIDATES_TAIL 是空的，拼出来的
// "undefinedwhale-music/" 是相对路径，mkdirSync 会在宿主工作目录里建出一个垃圾目录。
const MUSIC_DIR_CANDIDATES = [
  path.join(DSH_HOME, 'whale-music'),
  path.join(DSH_HOME, 'profiles', 'web', 'whale-music'),
]
const MUSIC_STATE_NAME = '.dshw-music.json'
const MUSIC_FILE_CANDIDATES = [
  path.join(DSH_HOME, MUSIC_STATE_NAME),
  path.join(DSH_HOME, 'profiles', 'web', MUSIC_STATE_NAME),
]
// 扫描与上传共用的扩展名白名单（一律小写比较）：少写一个都表现为"歌单里少了文件"，
// 所以只留这一张表，扫描、上传校验、music.json 的 supported 字段全从它取。
const MUSIC_EXTS = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac']
// 扩展名 → Content-Type（music-file 按它下发）。MIME 与字节不符会让浏览器解码路径异常。
const MUSIC_MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
}
// dataURL 的 mime 子类型 → 扩展名：上传时 name 的后缀优先，后缀不在白名单才按它推断。
// 这张表同时就是"允许上传的 mime 白名单"（键之外的 mime 一律 400）。
const MUSIC_EXT_BY_MIME = {
  mpeg: 'mp3', mp3: 'mp3',
  mp4: 'm4a', m4a: 'm4a', 'x-m4a': 'm4a',
  aac: 'aac',
  ogg: 'ogg', opus: 'ogg',
  wav: 'wav', 'x-wav': 'wav', wave: 'wav',
  flac: 'flac', 'x-flac': 'flac',
}
// 单文件**解码后**上限。为什么是 48MB 而不是 64MB：
//   上传体是 base64 的 dataURL（`data:audio/…;base64,<…>`），相对原始字节膨胀 4/3 ≈ 1.33 倍，
//   而 music.json 的 body 上限是 64MB ⇒ 64MB 的 body 最多只能装 64 ÷ 1.33 ≈ 48MB 音频。
//   所以"解码后 ≤ 64MB"这条判断**永远走不到**（body 会先被 readBodyMax 以 body too large 拒掉），
//   名义上限大于可达上限会让人以为"64MB 以内都能传" ⇒ 直接把**真正可达**的值写成常量。
//   ⚠️ 改这里必须同步改 body 上限（music.json 里的 readBodyMax 64MB）：两者要满足
//      body 上限 ≥ MUSIC_MAX_BYTES × 4/3 才自洽（48 × 1.33 = 64）。
const MUSIC_MAX_BYTES = 48 * 1024 * 1024
// 上传超限的提示文案：数字从常量算，避免"改了上限忘了改文案"（前端直接把这句话显示给用户）
const MUSIC_MAX_MB = Math.round(MUSIC_MAX_BYTES / 1024 / 1024)

// —— 在线电台（Radio Browser / SomaFM）——
// 上游环境变量（进程启动时读一次即固定；**离线端到端验证就是靠把上游指向本地桩服务器**）：
//   · DSHW_RADIO_BROWSER_BASE：显式指定 Radio Browser 的 API 根（**优先**用；默认见下面镜像表）
//   · DSHW_RADIO_BROWSER_MIRRORS：镜像候选表（逗号分隔），默认 de1,all,api —— 见下面的实测注释
//   · DSHW_SOMAFM_URL：SomaFM 频道表 JSON 的完整地址，默认 https://somafm.com/channels.json
//   · DSHW_RADIO_UA：请求上游时带的 User-Agent，默认带项目主页（Radio Browser **明确要求**带一个
//     可识别的 UA；空 UA / 通用脚本 UA 会被它限流甚至直接拒绝，表现为"搜索永远 502"）
//   · DSHW_RADIO_ALLOW_HOSTS：SSRF 防护的窄口径逃生口（语义见它自己的注释）
const RADIO_BROWSER_EXPLICIT = String(process.env.DSHW_RADIO_BROWSER_BASE || '').trim().replace(/\/+$/, '')
// Radio Browser 的镜像表：**默认必须把 de1 排第一**。实测（2026-10，本机/用户所在网络）：
//   de1.api.radio-browser.info   200 + application/json ✓（冷启动首次请求 3.5s，之后 ~1.2s）
//   de2.api.radio-browser.info   200 + application/json ✓（~1.2s，最稳）—— 官方列表里它常被漏掉
//   all.api.radio-browser.info   ECONNRESET
//   api.radio-browser.info       HTTP 404 + text/html（根本不是 API 响应）
//   nl1 / at1 / fi1.api...       官方已下线（ENOTFOUND，失败很快，留着只为将来可能恢复）
// 所以这里按"实测可用"排序；运行时会**自动回退**（显式 BASE 若设了则优先），并把第一个真正
// 可用的镜像记住（radioRbBase），后续搜索不再去重试坏镜像。判"可用"的判据刻意严，见 radioFetchRbJson。
// DSHW_RADIO_BROWSER_MIRRORS 同时也是离线测试钩子：把它指向桩就能离线验证回退逻辑。
const RADIO_BROWSER_MIRRORS = String(process.env.DSHW_RADIO_BROWSER_MIRRORS
  || 'https://de1.api.radio-browser.info,https://de2.api.radio-browser.info,https://all.api.radio-browser.info,'
    + 'https://api.radio-browser.info,https://nl1.api.radio-browser.info,https://at1.api.radio-browser.info,'
    + 'https://fi1.api.radio-browser.info')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
const SOMAFM_URL = String(process.env.DSHW_SOMAFM_URL || 'https://somafm.com/channels.json')
const RADIO_UA = String(process.env.DSHW_RADIO_UA
  || 'dsh-whale-widget-radio/1.0 (+https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)')
// 状态文件：**刻意另开一个**，不塞进 .dshw-size.json / .dshw-usage.json ——
// 那两张表的每个键都必须有运行时消费方（tools/check-dead-settings.mjs 会审计，见它的文件头），
// 而电台收藏是"在线数据"、与挂件外观/记账无关，混进去只会让两边的键审计互相污染。
const RADIO_STATE_NAME = '.dshw-radio.json'
const RADIO_FILE_CANDIDATES = [
  path.join(DSH_HOME, RADIO_STATE_NAME),
  path.join(DSH_HOME, 'profiles', 'web', RADIO_STATE_NAME),
]
// 两个上游的稳定标识（前端也按这两个字符串传 source / 记 lastSource）
const RADIO_SOURCE_LABELS = { rb: 'Radio Browser', somafm: 'SomaFM' }
const RADIO_MAX_FAVORITES = 100
const RADIO_MAX_STREAMS = 4
const RADIO_SEARCH_DEFAULT_LIMIT = 30
const RADIO_SEARCH_MAX_LIMIT = 50
// 上游 JSON（搜索 / 频道表）的整请求超时；音频代理另有一套"连接 + 首字节"超时（见下），
// 因为电台是**无限流**，给它一个总超时等于到点就掐断正在听的台。
const RADIO_JSON_TIMEOUT_MS = 10000
// Radio Browser **单个镜像**的尝试超时：实测 de1 的**冷启动首次**请求要 3.5s（之后 ~1.2s），
// 所以卡在 4s 会让健康镜像被误判为坏镜像、白白回退（真发生过）。取 6s 兼顾"坏镜像让位"与
// "冷启动不误杀"；总预算再压一层（见 RADIO_BROWSER_TOTAL_BUDGET_MS），避免最坏情况把前端拖死。
const RADIO_BROWSER_PROBE_TIMEOUT_MS = 6000
// 一次搜索在**所有镜像**上花的总预算上限：到点就不再试后面的镜像，直接回 502 可读文案。
// 没有它的话"7 个候选 × 6s"最坏能到 40s+，前端的加载态会一直转。
const RADIO_BROWSER_TOTAL_BUDGET_MS = 12000
const RADIO_STREAM_TIMEOUT_MS = 15000
const RADIO_STREAM_MAX_HOPS = 5
// 播放列表（.pls / .m3u）解引用：**SomaFM 给的就是 .pls**（playlists[].url 形如
// https://api.somafm.com/groovesalad256.pls），所以代理必须先把它解析成真正的音频流地址。
// 深度上限 2：防 A→B→A 循环或无限套娃（每层都要过一遍 SSRF 检查，深度不设限等于放大攻击面）。
const RADIO_PLAYLIST_MAX_DEPTH = 2
// 播放列表文件很小（几百字节），但仍然限长：别让一个恶意/异常的上游用它把内存灌满。
const RADIO_PLAYLIST_MAX_BYTES = 64 * 1024
// 播放列表类 Content-Type。**必须在"是不是音频"之前判定**（先解析、解析不出来再拒）：
// 注意 audio/x-scpls 与 audio/x-mpegurl **也以 audio/ 开头**，靠白名单拦不住 ——
// 曾经因此把 .pls 文本原样流给了 `<audio>`：用户看到"正在播放"却一点声音都没有（静默无声）。
const RADIO_PLAYLIST_MIMES = [
  'audio/x-scpls', 'audio/scpls',
  'audio/x-mpegurl', 'audio/mpegurl',
  'application/vnd.apple.mpegurl',
  'text/uri-list', 'text/plain',
]
// 代理**只**转发下面这几类响应：否则这条路由就是一个"通用网页代理"，
// 任何能打开本机页面的人都能借宿主的网络身份去读任意 http 服务的响应体。
// 注意 audio/ 是**前缀**匹配（audio/mpeg、audio/aac、audio/ogg… 几十种），其余按全等匹配。
const RADIO_STREAM_MIMES = [
  'application/ogg',
  'application/octet-stream',
  'video/mp4',
  'video/webm',
  'application/vnd.apple.mpegurl',
]
// DSHW_RADIO_ALLOW_HOSTS：SSRF 防护的**显式窄口径逃生口**（默认空 = 只允许公网地址）。
// 为什么需要它：用户在**自己局域网**里跑 Icecast / 自建电台（或本机测试）时，私网地址会被
// SSRF 防护拒掉；没有这个开关，用户唯一的选择就是"关掉整个防护"，那是更糟的结果。
// 语义刻意做窄 —— **精确匹配** `host` 或 `host:port`，不支持通配符 / 前缀 / CIDR：
// 它必须能"放行某一台"，而不能变成"一键关掉 SSRF 防护"。
// 命中名单**只**跳过"私网 / 回环 / 链路本地"那一段判定；协议白名单、URL 不许带用户名密码、
// 逐跳重定向检查、Content-Type 白名单照旧**全部**执行（所以第一跳放行、第二跳跳到 127.0.0.1
// 且不在名单里时，仍然会被拒）。
// 解析失败 / 空值一律按"空名单"处理（fail-closed）。
function parseRadioAllowHosts(raw) {
  const hosts = new Set()
  const hostPorts = new Set()
  const add = (host, port) => {
    const h = String(host || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (!h) return
    if (port) hostPorts.add(h + ':' + String(port))
    else hosts.add(h)
  }
  for (const item of String(raw || '').split(',')) {
    const entry = item.trim().toLowerCase()
    if (!entry) continue
    const br = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(entry) // [::1]:8080 / [::1]
    if (br) { add(br[1], br[2]); continue }
    const hp = /^([^:]+):(\d{1,5})$/.exec(entry) // host:port（主机名或 IPv4）
    if (hp) { add(hp[1], hp[2]); continue }
    add(entry, null) // 纯 host（也涵盖不带端口的 IPv6 字面量）
  }
  return { hosts, hostPorts }
}
const RADIO_ALLOW_HOSTS = parseRadioAllowHosts(process.env.DSHW_RADIO_ALLOW_HOSTS)
// 取 URL 的主机名（去掉 IPv6 的方括号 —— WHATWG URL 的 hostname 对 IPv6 会**带**方括号）
function radioHostOf(target) {
  try {
    const u = target instanceof URL ? target : new URL(String(target))
    return String(u.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  } catch (err) { return '' }
}
// 名单命中判定：先看 `host:port` 全等，再看"只写了 host"的任意端口条目。
// 端口取 URL 里的显式端口，缺省时按协议的默认端口（80/443）—— 否则 `host:80` 这种写法
// 在 `http://host/`（无端口）上永远匹配不上，用户会以为开关坏了。
function radioAllowHit(host, port) {
  try {
    if (RADIO_ALLOW_HOSTS.hosts.has(host)) return true
    return !!port && RADIO_ALLOW_HOSTS.hostPorts.has(host + ':' + String(port))
  } catch (err) { return false }
}
// 主机名后缀：这些名字按约定指向本机/内网，**即使现在解析到公网地址也不可信**
//（`x.local` / `x.internal` / `x.home.arpa` 都是"本地解析"保留域）。
function radioHostnameSuffixRejection(host) {
  const h = String(host || '').toLowerCase()
  if (!h) return '地址缺少主机名'
  if (h === 'localhost' || h.endsWith('.localhost')) return '拒绝内网地址（localhost）'
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) {
    return '拒绝内网地址（本地解析域名）'
  }
  return null
}
// IPv4 字面量 → 是否落在"私网 / 保留 / 组播"范围。返回 null = 放行，否则是拒绝原因（中文）。
// ⚠️ 无法识别的一律**拒绝**（fail-closed）：这个函数只被"已经解析出来的地址"调用，
// 出现不认识的形状说明上游换了解析器，宁可拒绝也不要放过。
function radioIpv4Rejection(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim())
  if (!m) return '拒绝无法识别的目标地址'
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (o.some((x) => x > 255)) return '拒绝无法识别的目标地址'
  const a = o[0]
  const b = o[1]
  if (a === 0) return '拒绝内网地址（0.0.0.0/8）'
  if (a === 127) return '拒绝内网地址（回环 127.0.0.0/8）'
  if (a === 10) return '拒绝内网地址（10.0.0.0/8）'
  if (a === 172 && b >= 16 && b <= 31) return '拒绝内网地址（172.16.0.0/12）'
  if (a === 192 && b === 168) return '拒绝内网地址（192.168.0.0/16）'
  if (a === 169 && b === 254) return '拒绝内网地址（链路本地 169.254.0.0/16）'
  if (a === 100 && b >= 64 && b <= 127) return '拒绝内网地址（CGNAT 100.64.0.0/10）'
  if (a === 192 && b === 0 && o[2] === 0) return '拒绝保留地址（192.0.0.0/24）'
  if (a === 198 && (b === 18 || b === 19)) return '拒绝保留地址（198.18.0.0/15）'
  if (a >= 224 && a <= 239) return '拒绝组播地址（224.0.0.0/4）'
  if (a >= 240) return '拒绝保留地址（240.0.0.0/4）'
  return null
}
// IPv6 字面量 → 同一套判断。支持压缩写法、带 zone（fe80::1%eth0）、以及内嵌 IPv4 的三种形式。
// 为什么非要自己解析：`::ffff:127.0.0.1` 这类 IPv4 映射地址能**绕过**只查 IPv4 的防护
//（URL 还会把它规范化成 `::ffff:7f00:1`，字符串比较更认不出来），必须解出内嵌地址再按 IPv4 判。
function radioIpv6Rejection(ip) {
  let s = String(ip || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (s.indexOf(':') < 0) return '拒绝无法识别的目标地址'
  const v4tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s)
  if (v4tail) {
    const quad = v4tail[2].split('.').map(Number)
    if (quad.some((x) => x > 255)) return '拒绝无法识别的目标地址'
    s = v4tail[1] + ((quad[0] << 8) | quad[1]).toString(16) + ':' + ((quad[2] << 8) | quad[3]).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return '拒绝无法识别的目标地址'
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1) { if (head.length !== 8) return '拒绝无法识别的目标地址' }
  else if (missing < 1) return '拒绝无法识别的目标地址'
  const groups = halves.length === 2 ? head.concat(new Array(missing).fill('0')).concat(tail) : head
  if (groups.length !== 8) return '拒绝无法识别的目标地址'
  const h = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return '拒绝无法识别的目标地址'
    h.push(parseInt(g, 16))
  }
  const v4Of = (hi, lo) => [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.')
  if (h.every((v) => v === 0)) return '拒绝保留地址（::）'
  if (h.slice(0, 7).every((v) => v === 0) && h[7] === 1) return '拒绝内网地址（回环 ::1）'
  // IPv4 映射（::ffff:a.b.c.d）与 IPv4 兼容（::a.b.c.d）：解出内嵌地址，交给 IPv4 那套规则
  if (h.slice(0, 6).every((v) => v === 0)) return radioIpv4Rejection(v4Of(h[6], h[7]))
  if (h.slice(0, 5).every((v) => v === 0) && h[5] === 0xffff) return radioIpv4Rejection(v4Of(h[6], h[7]))
  // NAT64 映射 64:ff9b::/96：末 32 位是 IPv4（公网地址照常放行，私网地址照旧拒绝）
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return radioIpv4Rejection(v4Of(h[6], h[7]))
  }
  if ((h[0] & 0xfe00) === 0xfc00) return '拒绝内网地址（fc00::/7 唯一本地）'
  if ((h[0] & 0xffc0) === 0xfe80) return '拒绝内网地址（fe80::/10 链路本地）'
  return null
}
// 上游响应的 Content-Type 白名单。返回 null = 放行，否则是拒绝原因（中文）。
// 缺 Content-Type 时按 application/octet-stream 放行（不少 Icecast 就是不带头，这是正常情况）；
// text/* / JSON / XML 一律拒 —— 放过去这条路由就成了通用网页代理。
// ⚠️ 播放列表类（audio/x-scpls 等）在这里**必须**先被拒：它们也以 `audio/` 开头，
//    光靠前缀匹配会漏过去（历史上正是这样把 .pls 文本流给了 `<audio>` ⇒ 静默无声）。
//    正常路径上不会走到这里 —— radioProxyStream 会先把播放列表解引用成真流；
//    这里只是**兜底 fail-closed**：万一解引用失败/类型没识别出来，也绝不把它当音频下发。
function radioStreamTypeRejection(contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (!mime) return null
  if (RADIO_PLAYLIST_MIMES.indexOf(mime) >= 0) return '上游返回的是播放列表而不是音频流（' + mime + '）'
  if (mime.startsWith('audio/')) return null
  if (RADIO_STREAM_MIMES.indexOf(mime) >= 0) return null
  return '上游返回的不是音频（' + mime + '）'
}
// 目标地址看起来是不是播放列表（只看路径后缀）。用于**发请求前**决定"这次要不要带 Range"：
// 播放列表是个小文本文件，带 Range 只会让它被截断，对后面的解引用没有好处。
function radioPlaylistPathOf(target) {
  let p = ''
  try { p = new URL(String(target)).pathname.toLowerCase() } catch (err) { return '' }
  if (p.endsWith('.pls')) return 'pls'
  if (p.endsWith('.m3u') || p.endsWith('.m3u8')) return 'm3u'
  return ''
}
// 这个响应是不是播放列表？返回 'pls' / 'm3u' / ''（不是）。
// 两条判据取并集：**路径后缀**（.pls/.m3u/.m3u8）与 **Content-Type**
//（SomaFM 给 .pls 时是 audio/x-scpls；有些站给 .m3u 时干脆是 text/plain）。
// Content-Type 优先决定格式：m3u 家族的 mime 配 .pls 路径时按路径算（避免把 pls 当 m3u 解析）。
function radioPlaylistKind(target, contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase()
  const byPath = radioPlaylistPathOf(target)
  if (mime === 'audio/x-scpls' || mime === 'audio/scpls') return 'pls'
  if (mime === 'audio/x-mpegurl' || mime === 'audio/mpegurl'
    || mime === 'application/vnd.apple.mpegurl' || mime === 'text/uri-list' || mime === 'text/plain') {
    return byPath === 'pls' ? 'pls' : 'm3u'
  }
  return byPath
}
// 把播放列表里的一行/一个值解析成绝对 http(s) 地址（相对地址按播放列表自身的位置解析）。
function radioAbsoluteUrl(raw, base) {
  try {
    const u = new URL(String(raw || '').trim(), base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.toString()
  } catch (err) { return '' }
}
// 从播放列表文本里取**第一个可用地址**：
//   .pls（INI 风格）→ 任一存在的 `FileN=`（File1 优先，按文件里的顺序）
//   .m3u/.m3u8      → 第一条非 `#` 非空行
// 解析不出来返回 ''（调用方据此回 502 可读文案），**绝不**把播放列表原样下发给前端。
function radioParsePlaylist(text, base, kind) {
  const lines = String(text || '').split(/\r?\n/)
  if (kind === 'pls') {
    for (const line of lines) {
      const m = /^\s*file\d*\s*=\s*(.+)$/i.exec(line)
      if (!m) continue
      const abs = radioAbsoluteUrl(m[1], base)
      if (abs) return abs
    }
    return ''
  }
  for (const line of lines) {
    const s = line.trim()
    if (!s || s.charAt(0) === '#') continue
    // 只认"像地址"的行（`http(s)://…`、绝对路径 `/…`、或 `host:port/…`）。为什么不一概交给
    // URL 解析器：一段随手的文本（比如 `text/plain` 的错误页 `<html>…`）会被解析成
    // `http://host/<html>` 这种**看起来合法**的相对地址，白白再打一次上游、还绕一层深度。
    if (!/^(https?:\/\/|\/|[a-z0-9.-]+:\d{2,5}\/)/i.test(s)) continue
    const abs = radioAbsoluteUrl(s, base)
    if (abs) return abs
  }
  return ''
}

// 内置预设音效组（不可删、不可改），对应 assets 里的 Ya/D 系列
const PRESET_GROUPS = {
  duck: { id: 'duck', name: '小黄鸭', press: 'ya1', release: 'ya2', preset: true },
  fx1: { id: 'fx1', name: '音效1', press: 'd1', release: 'd2', preset: true },
}
// 内置预设片段（不可删）：传统 4 个映射到 SOUND_SETS 的 mp3，exp_orb / end_a 映射到随包发布的 wav。
// mime 必须与文件字节一致（音频路由按它下发 Content-Type，不匹配会导致解码/听感异常）。
const PRESET_FRAGMENTS = {
  ya1: { id: 'ya1', name: '小黄鸭·按下', preset: true, mime: 'audio/mpeg' },
  ya2: { id: 'ya2', name: '小黄鸭·松开', preset: true, mime: 'audio/mpeg' },
  d1: { id: 'd1', name: '音效1·按下', preset: true, mime: 'audio/mpeg' },
  d2: { id: 'd2', name: '音效1·松开', preset: true, mime: 'audio/mpeg' },
  // 任务结束音的内置默认音效(随包资源,用户库缺失时回退内置文件)
  exp_orb: { id: 'exp_orb', name: 'Minecraft·经验球', preset: true, mime: 'audio/wav' },
  // 任务结束音 A(随包资源):原为用户音效库里的自导入片段，现作为内置预设随包发布。
  // 显示名与用户库里同名片段一致时，前端下拉按显示名去重（内置与前端的同名条目只出现一条）。
  end_a: { id: 'end_a', name: 'A', preset: true, mime: 'audio/wav' },
}
// 内置片段的音频文件：包内 assets 优先，开发环境回退到 skin 目录
const BUILTIN_FRAGMENT_FILES = {
  exp_orb: [
    path.join(PACKAGE_ROOT, 'assets', 'minecraft-exp-orb.wav'),
  ],
  // 任务结束音 A：随包发布 assets/task-end-a.wav（1.81s / 48kHz / 立体声 / 16bit PCM）
  end_a: [
    path.join(PACKAGE_ROOT, 'assets', 'task-end-a.wav'),
  ],
}
// —— 自定义 API 模型（v655）：非 DeepSeek 厂商的余额 / 用量 / 提醒 ——
// 注册表落在 $DSH_HOME/.dshw-api.json；密钥走 DSH 官方凭据（ctx.credentials），本文件不存明文。
// ⭐ 2026-10-02（用户要求"并成一份"）：$DSH_HOME 优先（自定义 API 模型清单也属于用户数据，原先两端各存一份）。
const API_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-api.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-api.json'),
  DATA_CANDIDATES_TAIL[0] + '.dshw-api.json',
  DATA_CANDIDATES_TAIL[1] + '.dshw-api.json',
]
const API_BUILTIN_ID = 'deepseek'
// 「充值 / 余额校正」只属于固定的 DeepSeek（内置）：模型条目下发 canAdjustBalance，路由层再校验一次。
// 新增厂商模板 / 手动新增的同名模型 / Kimi 等其它厂商都不会继承这个能力。
function canAdjustBuiltinBalance(model) {
  return !!(model && model.id === API_BUILTIN_ID && model.builtin === true && model.provider === 'deepseek')
}
// 内置厂商模板：balance 描述「怎么取余额」。json 路径支持 a.b[0].c；scale 为取值后的乘数。
// 余额接口已按官方文档 / 社区参考核对（DeepSeek、OpenRouter、Kimi、阶跃、Novita、OpenAI 兼容中转站）；
// 硅基流动的余额接口已官方下线（410），故改为「无余额接口 + /v1/models 探活」；
// 火山方舟同理（余额/用量属火山引擎 AK/SK 签名的 OpenAPI）。其余厂商可选用 custom 手填 URL 与字段路径。
// 厂商模板下拉的排序键（v726）：英文名直接用；中文名取首字的拼音，让中英文按 A→Z **混排**。
// 为什么不用 localeCompare：ICU 默认把汉字排到拉丁字母之后，中文厂商会被整段甩到列表末尾。
// 新增中文厂商时在下面补一行（键 = 厂商名首字）。
const TPL_PINYIN_INITIAL = { 阿: 'a', 百: 'bai', 本: 'ben', 硅: 'gui', 火: 'huo', 阶: 'jie', 魔: 'mo', 腾: 'teng', 讯: 'xun', 智: 'zhi', 自: 'zi' }
function tplSortKey(name) {
  const s = String(name || '').trim()
  if (!s) return ''
  const py = TPL_PINYIN_INITIAL[s.slice(0, 1)]
  return py || s.toLowerCase()
}
const API_TEMPLATES = {
  deepseek: {
    name: 'DeepSeek', currency: 'CNY', keyRef: 'DEEPSEEK_API_KEY', builtin: true,
    balance: { url: 'https://api.deepseek.com/user/balance', auth: 'Bearer {key}', json: { remaining: 'balance_infos[0].total_balance' } },
  },
  openrouter: {
    name: 'OpenRouter', currency: 'USD', keyRef: 'OPENROUTER_API_KEY',
    balance: { url: 'https://openrouter.ai/api/v1/credits', auth: 'Bearer {key}', json: { total: 'data.total_credits', used: 'data.total_usage' } },
  },
  siliconflow_cn: {
    name: '硅基流动（CN）', currency: 'CNY', keyRef: 'SILICONFLOW_API_KEY', noBalanceApi: true,
    // ⚠️ 官方已下线余额接口（不是"暂时故障"）——2026-08-11 更新公告《【接口服务调整】/user/info 接口将停止服务》：
    //   「/user/info 已无法适配平台用户账户体系，该 API 将于 2026-08-14 正式停止服务，届时接口将不再可用」，
    //   并称「后续将适时提供账户层面的替代 API，新接口上线后将在本页面另行通知」。
    //   截至 2026-09-14，公告页最新条目（2026.09.09）**仍未见替代 API**；CN 文档「平台系列」也只剩「获取用户模型列表」。
    //   v724 路由实测：/v1 下未知路径 404、而 /v1/user/info 仍返 401（鉴权层）→ 路由没被摘掉，但按公告已不可用。
    //   → 日后官方恢复或上线替代接口：把 url 与 json 字段路径填回来即可（模板只是默认值，用户可覆盖）。
    apiNote: '官方已下线 /user/info 余额接口（2026-08-14 起停止服务；公告称后续会提供替代 API，暂未上线）→ 余额显示「—」，今日已用按会话事件估算；「测试连通性」用 /v1/models 验证 key',
    matchIds: ['siliconflow', 'Qwen', 'deepseek-ai'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
    probeUrl: 'https://api.siliconflow.cn/v1/models',
  },
  siliconflow_en: {
    name: '硅基流动（EN）', currency: 'USD', keyRef: 'SILICONFLOW_API_KEY', noBalanceApi: true,
    // 同国内站：余额接口已停止服务。注意国际站文档 docs.siliconflow.com 至今仍挂着 Retrieve user info 页
    //（文档未同步），不能据此认为接口可用 —— 以国内官方公告为准。
    apiNote: '同国内站：/user/info 余额接口已停止服务（国际站文档尚未同步）→ 余额「—」，今日已用按会话事件估算',
    matchIds: ['siliconflow', 'Qwen', 'deepseek-ai'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
    probeUrl: 'https://api.siliconflow.com/v1/models',
  },
  moonshot: {
    // 大陆站：api.moonshot.cn，余额为人民币（充值 + 代金券合计）。v724 实测：200 且字段命中 ✓
    name: 'Kimi / Moonshot（CN）', currency: 'CNY', keyRef: 'MOONSHOT_API_KEY', matchIds: ['moonshot', 'kimi'],
    balance: { url: 'https://api.moonshot.cn/v1/users/me/balance', auth: 'Bearer {key}', json: { remaining: 'data.available_balance' } },
    probeUrl: 'https://api.moonshot.cn/v1/models',
  },
  moonshot_intl: {
    // 国际站是独立账号体系（key 不通用），余额按美元计
    name: 'Kimi / Moonshot（国际）', currency: 'USD', keyRef: 'MOONSHOT_INTL_API_KEY',
    balance: { url: 'https://api.moonshot.ai/v1/users/me/balance', auth: 'Bearer {key}', json: { remaining: 'data.available_balance' } },
    probeUrl: 'https://api.moonshot.ai/v1/models',
  },
  stepfun: {
    name: '阶跃星辰 StepFun', currency: 'CNY', keyRef: 'STEPFUN_API_KEY', matchIds: ['stepfun', 'step-'],
    balance: { url: 'https://api.stepfun.com/v1/accounts', auth: 'Bearer {key}', json: { remaining: 'balance' } },
  },
  novita: {
    name: 'Novita AI', currency: 'USD', keyRef: 'NOVITA_API_KEY', matchIds: ['novita'],
    balance: { url: 'https://api.novita.ai/v3/user/balance', auth: 'Bearer {key}', json: { remaining: 'availableBalance', scale: 0.0001 } },
  },
  volcengine_ark: {
    name: '火山方舟 Ark', currency: 'CNY', keyRef: 'ARK_API_KEY', noBalanceApi: true,
    // 方舟没有「用 API key 查余额」的接口（余额/用量属于火山引擎 AK/SK 签名的 OpenAPI）。
    // v724 实测：/api/v3/models → 200（探活可用）；/api/v3/balance → 404（无余额接口，确认）。
    apiNote: '余额/用量需火山引擎 AK/SK 签名的 OpenAPI（或控制台）→ 余额「—」，今日已用按会话事件估算；探活用 /api/v3/models（实测可用）',
    matchIds: ['doubao', 'ep-'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
    probeUrl: 'https://ark.cn-beijing.volces.com/api/v3/models',
  },
  // —— 订阅额度（Coding Plan）模板：kind='quota'，语义是"窗口用量% + 重置时间"，不是钱 ——
  // 注意：这些接口只对「订阅套餐」账号有效。买 Token 包（资源包）的账号查不到额度
  // （智谱会返回「当前用户不存在coding plan」），那种情况用模型菜单里的
  // 「额度（订阅/资源包）」按会话 token 自动统计。
  zhipu_glm_coding: {
    name: '智谱 GLM Coding Plan（订阅）', currency: 'CNY', keyRef: 'ZHIPU_API_KEY', kind: 'quota',
    quota: {
      url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      auth: '{key}', // 智谱此接口不带 Bearer
      // v789（issue #180/#181 修）：`data.limits[]` 是扁平条目数组，`TOKENS_LIMIT` 是条目的 `type` **值**，
      //   且 5h 窗口不保证排在 [0]（pro 账号 [0] 是 TIME_LIMIT、max 账号 [0] 才是 TOKENS_LIMIT）
      //   ⇒ 一律按 type(+unit) 选条目：unit=3 = 5 小时窗口、unit=6 = 周窗口；
      //   新注册/credit 制账号的 type 是 CREDIT_LIMIT ⇒ 一并兼容。
      json: {
        level: 'data.level',
        windows: [
          { key: 'rolling', label: '5h', pick: { list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 3 }, percent: 'percentage', resetAt: 'nextResetTime' },
          { key: 'weekly', label: '周', pick: { list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 6 }, percent: 'percentage', resetAt: 'nextResetTime' },
        ],
      },
    },
    probeUrl: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  },
  kimi_coding: {
    name: 'Kimi Coding（订阅）', currency: 'CNY', keyRef: 'KIMI_CODING_KEY', kind: 'quota',
    quota: {
      url: 'https://api.kimi.com/coding/v1/usages',
      auth: 'Bearer {key}',
      json: { remain: 'usage.remaining', total: 'usage.limit', resetAt: 'usage.resetTime' },
    },
    probeUrl: 'https://api.kimi.com/coding/v1/usages',
  },
  minimax_coding: {
    name: 'MiniMax Coding（订阅）', currency: 'CNY', keyRef: 'MINIMAX_API_KEY', kind: 'quota',
    quota: {
      url: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
      auth: 'Bearer {key}',
      json: {
        remainPct: 'model_remains[0].current_interval_remaining_percent',
        weeklyRemainPct: 'model_remains[0].current_weekly_remaining_percent',
        resetAtMs: 'model_remains[0].end_time',
      },
    },
    probeUrl: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  },
  // OpenCode Go（订阅）：一次返回 rolling / weekly / monthly 三个窗口，值为「已用% + 重置时间」
  // （usage.rolling|weekly|monthly.{percent,resetsAt}）。走多窗口路径 json.windows，见 fetchModelQuota。
  // 鉴权只需 Authorization: Bearer <key>（2026-09 实测：x-api-key 单独使用返回 401，无需额外请求头）。
  opencode_go: {
    name: 'OpenCode Go（订阅）', currency: 'USD', keyRef: 'OPENCODE_GO_API_KEY', kind: 'quota',
    quota: {
      url: 'https://opencode.ai/zen/go/v1/usage',
      auth: 'Bearer {key}',
      json: {
        windows: [
          { key: 'rolling', label: '5h', percent: 'usage.rolling.percent', resetAt: 'usage.rolling.resetsAt' },
          { key: 'weekly', label: '周', percent: 'usage.weekly.percent', resetAt: 'usage.weekly.resetsAt' },
          { key: 'monthly', label: '月', percent: 'usage.monthly.percent', resetAt: 'usage.monthly.resetsAt' },
        ],
      },
    },
    probeUrl: 'https://opencode.ai/zen/go/v1/usage',
  },
  openai_compat: {
    name: 'OpenAI 兼容中转站', currency: 'USD', keyRef: 'CUSTOM_API_KEY', needsBaseUrl: true,
    // OneAPI / New API 一类网关的经典账单接口：额度(美元) + 已用(美分)
    balance: {
      url: '{base}/v1/dashboard/billing/subscription', auth: 'Bearer {key}', json: { total: 'hard_limit_usd' },
      usage: { url: '{base}/v1/dashboard/billing/usage', auth: 'Bearer {key}', json: { used: 'total_usage', scale: 0.01 } },
    },
  },
  custom: {
    name: '自定义 HTTP', currency: 'CNY', keyRef: 'CUSTOM_API_KEY',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  // —— Codex 模式（第一期：本地会话统计）——
  // 不查余额、不联网、不用凭据：直接读 ~/.codex/sessions 的 rollout-*.jsonl 统计 token。
  // 好处：能覆盖「不在 DSH 里跑」的 Codex 使用；坏处：只有 token，没有金额（费用另由余额/额度口径处理）。
  codex: {
    name: 'Codex（本地会话）', currency: 'CNY', keyRef: '', kind: 'codex',
    balance: { url: '', auth: '', json: { remaining: '' } },
  },
  // ================= v724：补齐「官方没有用 API key 查余额的接口」的常用厂商 =================
  // 作用：① 选完自动填好 凭据名 / 币种 / 事件匹配(matchIds) / 探活地址 ②「测试连通性」可验证 key
  // ③ 余额显示「—」，今日已用按本机会话事件估算（noBalanceApi + apiNote 会显示在面板提示里）。
  // 说明：probeUrl 一律用各家的 OpenAI 兼容 /v1/models（官方文档形态，能否通过取决于 key 权限）。
  openai: {
    name: 'OpenAI', currency: 'USD', keyRef: 'OPENAI_API_KEY', noBalanceApi: true,
    apiNote: '官方已下线 billing 余额接口，没有「用 API key 查余额」的公开接口（只能看控制台）→ 余额「—」，今日已用按会话事件估算',
    matchIds: ['gpt', 'o1-', 'o3-', 'o4-', 'chatgpt'],
    probeUrl: 'https://api.openai.com/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  anthropic: {
    name: 'Anthropic Claude', currency: 'USD', keyRef: 'ANTHROPIC_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口；用量要走 Admin API（需 admin key）或控制台。注意其探活需要 x-api-key + anthropic-version 两个请求头，本挂件暂不支持 → 不提供探活',
    matchIds: ['claude'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  gemini: {
    name: 'Google Gemini', currency: 'USD', keyRef: 'GEMINI_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口（配额只在 AI Studio / Cloud 控制台）→ 余额「—」，今日已用按会话事件估算；探活用 ?key= 形式',
    matchIds: ['gemini'],
    probeUrl: 'https://generativelanguage.googleapis.com/v1beta/models?key={key}',
    balance: { url: '', auth: '', json: { remaining: '' } },
  },
  xai: {
    name: 'xAI Grok', currency: 'USD', keyRef: 'XAI_API_KEY', noBalanceApi: true,
    apiNote: '官方无公开的余额查询接口（额度在 console.x.ai）→ 余额「—」，今日已用按会话事件估算',
    matchIds: ['grok'],
    probeUrl: 'https://api.x.ai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  groq: {
    name: 'Groq', currency: 'USD', keyRef: 'GROQ_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口（免费额度/速率在控制台看）→ 余额「—」，今日已用按会话事件估算',
    matchIds: ['llama', 'mixtral', 'qwen', 'deepseek', 'gemma', 'whisper'],
    probeUrl: 'https://api.groq.com/openai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  mistral: {
    name: 'Mistral AI', currency: 'USD', keyRef: 'MISTRAL_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['mistral', 'codestral', 'magistral', 'pixtral', 'ministral'],
    probeUrl: 'https://api.mistral.ai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  together: {
    name: 'Together AI', currency: 'USD', keyRef: 'TOGETHER_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['meta-llama', 'Qwen', 'deepseek', 'mistralai', 'nvidia'],
    probeUrl: 'https://api.together.xyz/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  fireworks: {
    name: 'Fireworks AI', currency: 'USD', keyRef: 'FIREWORKS_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['accounts/fireworks', 'llama-v3', 'qwen'],
    probeUrl: 'https://api.fireworks.ai/inference/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  deepinfra: {
    name: 'DeepInfra', currency: 'USD', keyRef: 'DEEPINFRA_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['meta-llama', 'Qwen', 'deepseek'],
    probeUrl: 'https://api.deepinfra.com/v1/openai/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  cerebras: {
    name: 'Cerebras', currency: 'USD', keyRef: 'CEREBRAS_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['llama', 'qwen'],
    probeUrl: 'https://api.cerebras.ai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  dashscope: {
    name: '阿里云百炼（通义千问）', currency: 'CNY', keyRef: 'DASHSCOPE_API_KEY', noBalanceApi: true,
    apiNote: '云厂商：余额/账单要走阿里云 AK/SK 的 OpenAPI（或控制台），API key 查不到 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['qwen', 'qwq', 'qvq'],
    probeUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  qianfan: {
    name: '百度千帆（文心）', currency: 'CNY', keyRef: 'QIANFAN_API_KEY', noBalanceApi: true,
    apiNote: '云厂商：余额/账单要走百度云 AK/SK（或控制台），API key 查不到 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['ernie'],
    probeUrl: 'https://qianfan.baidubce.com/v2/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  hunyuan: {
    name: '腾讯混元', currency: 'CNY', keyRef: 'HUNYUAN_API_KEY', noBalanceApi: true,
    apiNote: '云厂商：余额/账单要走腾讯云 SecretId/Key（或控制台），API key 查不到 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['hunyuan'],
    probeUrl: 'https://api.hunyuan.cloud.tencent.com/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  spark: {
    name: '讯飞星火', currency: 'CNY', keyRef: 'SPARK_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口（额度在控制台）→ 余额「—」，今日已用按会话事件估算',
    matchIds: ['spark', 'generalv', '4.0ultra'],
    probeUrl: 'https://spark-api-open.xf-yun.com/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  modelscope: {
    name: '魔搭 ModelScope', currency: 'CNY', keyRef: 'MODELSCOPE_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['Qwen', 'deepseek', 'MiniMax', 'glm'],
    probeUrl: 'https://api-inference.modelscope.cn/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  ollama: {
    name: '本地模型（Ollama / LM Studio）', currency: 'CNY', keyRef: '', noBalanceApi: true, needsBaseUrl: true,
    apiNote: '本地推理没有余额概念 → 余额「—」；填好 Base URL（如 http://127.0.0.1:11434/v1）后按会话事件统计 token',
    matchIds: ['llama', 'qwen', 'gemma', 'deepseek', 'mistral', 'phi'],
    probeUrl: '{base}/v1/models',
    balance: { url: '', auth: '', json: { remaining: '' } },
  },
  zhipu_glm_coding_intl: {
    name: '智谱 GLM Coding Plan（国际 z.ai）', currency: 'USD', keyRef: 'ZHIPU_INTL_API_KEY', kind: 'quota',
    quota: {
      url: 'https://api.z.ai/api/monitor/usage/quota/limit',
      auth: '{key}', // 与国内站一样不带 Bearer
      // v789：与国内站同一套 `data.limits[]` 结构（见 zhipu_glm_coding 的注释），一并按 type+unit 选条目
      json: {
        level: 'data.level',
        windows: [
          { key: 'rolling', label: '5h', pick: { list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 3 }, percent: 'percentage', resetAt: 'nextResetTime' },
          { key: 'weekly', label: '周', pick: { list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 6 }, percent: 'percentage', resetAt: 'nextResetTime' },
        ],
      },
    },
    probeUrl: 'https://api.z.ai/api/monitor/usage/quota/limit',
  },
  minimax_coding_intl: {
    name: 'MiniMax Coding（国际）', currency: 'USD', keyRef: 'MINIMAX_INTL_API_KEY', kind: 'quota',
    quota: {
      url: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
      auth: 'Bearer {key}',
      json: {
        remainPct: 'model_remains[0].current_interval_remaining_percent',
        weeklyRemainPct: 'model_remains[0].current_weekly_remaining_percent',
        resetAtMs: 'model_remains[0].end_time',
      },
    },
    probeUrl: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  },
}

// ⭐ 2026-10-02（用户要求"并成一份"）：这些**用户数据文件一律 $DSH_HOME 优先**，开发机路径降级为只读兜底。
//   原因见上方 AUDIO_DIR_CANDIDATES 的说明（桌面端只认 $DSH_HOME，两端原先各写各的）。
// Size memory file: prefer writable DSH home locations, then legacy fallbacks.
const SIZE_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-size.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-size.json'),
  DATA_CANDIDATES_TAIL[0] + '.dshw-size.json',
  DATA_CANDIDATES_TAIL[1] + '.dshw-size.json',
]
// Usage ledger file (小鲸鱼记账 mode): same policy as the size file.
const USAGE_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-usage.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-usage.json'),
  DATA_CANDIDATES_TAIL[0] + '.dshw-usage.json',
  DATA_CANDIDATES_TAIL[1] + '.dshw-usage.json',
]
// 每轮消耗 seq 持久化文件：避免插件热重载后 seq 归零导致页面把新轮次误判为旧轮次吞掉
const TURN_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-turn.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-turn.json'),
  DATA_CANDIDATES_TAIL[0] + '.dshw-turn.json',
  DATA_CANDIDATES_TAIL[1] + '.dshw-turn.json',
]
// Sound assets: package-relative first (ship Ya1/Ya2/D1/D2.mp3 in assets/),
// legacy absolute paths as fallback.
const BUBBLE_FILE_CANDIDATES = [
  // v728：发布版会删掉开发机路径（§9.4），所以这里必须有 $DSH_HOME 兜底 ——
  // 否则清完这个数组会变成空的：泡泡配置读不了也存不了（自定义泡泡整体失效）。
  path.join(DSH_HOME, '.dshw-bubble.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-bubble.json'),
  DATA_CANDIDATES_TAIL[0] + '.dshw-bubble.json',
  DATA_CANDIDATES_TAIL[1] + '.dshw-bubble.json',
]
// 泡泡图库(独立于角色图库):图片文件目录 + 索引
const BUBBLE_IMG_DIR_CANDIDATES = [
  // v728：同理必须有 $DSH_HOME 兜底 —— pickBubbleImgDir() 遍历失败还会取 [0]，
  // 空数组会让图库上传直接报错。
  path.join(DSH_HOME, 'whale-bubble-imgs'),
  path.join(DSH_HOME, 'profiles', 'web', 'whale-bubble-imgs'),
  DATA_CANDIDATES_TAIL[0] + 'whale-bubble-imgs/',
  DATA_CANDIDATES_TAIL[1] + 'whale-bubble-imgs/',
]
const BUBBLE_IMG_INDEX_NAME = 'bubble-imgs.json'
// 内置默认泡泡图(语义 id → assets 文件):面板常驻可选;全新安装无用户图库时
// bubble-img.png 从内置清单回退加载。文件同时位于 package assets/ 与开发回退目录。
const DEFAULT_BUBBLE_IMGS = [
  { id: 'bimg_petpet', name: 'petpet', file: 'bubble-petpet.gif', format: 'gif' },
  { id: 'bimg_money1', name: 'money1', file: 'bubble-money1.gif', format: 'gif' },
]
function bubbleImgFileCandidates(file) {
  return [
    path.join(PACKAGE_ROOT, 'assets', file),
  ]
}
function loadBuiltinBubbleImgBytes(def) {
  if (!def || !def.file) return null
  for (const p of bubbleImgFileCandidates(def.file)) {
    try {
      const bytes = fs.readFileSync(p)
      if (bytes && bytes.length > 0) return bytes
    } catch (err) {}
  }
  return null
}
const SOUND_SETS = {
  duck: { press: [path.join(PACKAGE_ROOT, 'assets', 'Ya1.mp3')], release: [path.join(PACKAGE_ROOT, 'assets', 'Ya2.mp3')] },
  fx1: { press: [path.join(PACKAGE_ROOT, 'assets', 'D1.mp3')], release: [path.join(PACKAGE_ROOT, 'assets', 'D2.mp3')] },
}
function soundSetFromUrl(url) {
  try {
    const q = String(url || '').split('?')[1] || ''
    const m = /(?:^|&)set=([^&]+)/.exec(q)
    return m ? decodeURIComponent(m[1]) : ''
  } catch (err) { return '' }
}
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 25000
// v781：账号登录路的兜底超时（毫秒）。DSH 账号服务自身默认 30s，太长会把前端 FETCH_TIMEOUT_MS(25s) 先耗掉。
const ACCOUNT_FALLBACK_MS = 5000
const RUA_GIF_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'rua.gif'),
]
// DeepSeek CNY prices per million tokens: [空闲时段价, 高峰时段价].
// 高峰时段（官方 2026-09-19 说明，见 docs 脚注 (2)）：**北京时间周一至周五（不含中国法定节假日）
// 9:00–12:00、14:00–18:00**；其余时段 —— 包括**周末、调休上班的周末、以及中国法定节假日全天** ——
// 一律按空闲时段计费。
//   时间线：2026-08-17 峰谷定价正式实施 → 2026-08-23 00:00 起周末全天谷价 →
//           2026-09-19 明确「调休上班的周末 + 法定节假日全天」也按空闲计。
// 价格来源：官方 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 2026-09-10 起 Flash 系列降价：缓存命中 0.05→0.02、未命中 1.5→1、输出 4.5→4（高峰=空闲×2）。
// 2026-09-19 复核：价格数字与上表一致（Flash 0.02/1/4 与 0.04/2/8；Pro 0.15/4.5/13.5 与 0.30/9/27），
//           峰谷规则新增「法定节假日全天谷价」这一条，见下方 HOLIDAY_VALLEY。
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]
// Flash（正式模型名 deepseek-flash = DeepSeek-V4.1-Flash）
const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
// Pro 为 Flash 的 3 倍价（官方 2026-08-17 生效）。官方 2026-09-14 公告：V4 Pro 继续提供 API 服务、
// 计费方式保持不变——此前"9/14 12:00 起 pro 请求路由到 V4.1 Flash 并按 Flash 价计费"的安排已取消，
// 因此这里不做按日期的降级切换。
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-flash': BASE_PRICE,
  'deepseek-v4-flash-vision-exp': BASE_PRICE, // 旧名已下线,请求由 V4.1-Flash 提供,按 Flash 价计费
  'deepseek-v4-flash': BASE_PRICE, // 同上
  'deepseek-v4-pro': PRO_PRICE,
  _default: BASE_PRICE,
}
// 用户自定义单价（自定义 API 模型面板里填的「元/百万 token」），按 matchIds 子串匹配，优先于内置价目表
let CUSTOM_PRICES = {}
// 自定义单价的币种/汇率（与 CUSTOM_PRICES 同键）：单价若按美元填写，记账时按用户填的汇率换算成人民币
let CUSTOM_PRICE_META = {}
function customPriceMetaFor(model) {
  const m = String(model || '').toLowerCase()
  // 按键长降序：最长命中优先，避免短关键字（如 pro）误伤别的模型
  for (const key of Object.keys(CUSTOM_PRICE_META).sort((a, b) => b.length - a.length)) {
    if (key && m.indexOf(key) !== -1) return CUSTOM_PRICE_META[key]
  }
  return null
}
function priceFor(model) {
  const m = String(model || '').toLowerCase()
  // 自定义单价同样按键长降序匹配（与 customPriceMetaFor 保持一致）
  for (const key of Object.keys(CUSTOM_PRICES).sort((a, b) => b.length - a.length)) {
    if (key && m.indexOf(key) !== -1) return CUSTOM_PRICES[key]
  }
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}
// bucket time is an epoch second; derive the Beijing local hour to pick peak vs off-peak price.
// 2026-08-23 起（北京时间）周末（周六/周日）全天按谷价；生效时刻之前的历史
// 分桶仍按旧规则计价，所以周末判定带生效分界。
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // = 北京时间 2026-08-23 00:00
// ===== 法定节假日全天谷价（官方 2026-09-19 说明）=====
// 依据：《国务院办公厅关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号，2025-11-04）
//       + DeepSeek API 官方计费脚注「周一至周五（不含中国法定节假日）…其余时段，包括周末及
//       中国法定节假日全天均为空闲时段」。
// 只需列**放假**的日期：调休上班日全部落在周末（2026 年为 1/4、2/14、2/28、5/9、9/20、10/10），
// 按"周末也算谷价"的规则本来就是谷价，无需单列。
// ⚠️ **每年 11 月国务院发布次年安排后，必须在这里补下一年的日期**（探针 `_peak-holiday-check.mjs`
// 会检查当年是否已覆盖并给出提醒）。
const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1, // 元旦 1/1–1/3（1/4 周日上班）
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1, // 春节 2/15–2/23（9 天）
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1, // 清明 4/4–4/6
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1, // 劳动节 5/1–5/5（5/9 周六上班）
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1, // 端午 6/19–6/21
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1, // 中秋 9/25–9/27
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1, // 国庆 10/1–10/7（9/20 周日、10/10 周六上班）
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
}
// 这条规则自 2026-09-19 起生效（此前历史分桶按旧规则计价）。2026 年内落在 8/17（峰谷机制实施）
// 与 9/19 之间没有任何"工作日的法定节假日"，所以对 2026 年的账目没有影响；次年（2027）之后
// 整年的节假日都会走到这个分支。
const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000) // = 北京时间 2026-09-19 00:00
// 下发给前端（挂件）的节假日清单：前端「时段倒计时」也要按节假日算下一切换点，
// 而前端无法自己知道法定安排，所以由宿主单一来源下发。每次 /dsh-whale/balance 都会带上。
const HOLIDAY_VALLEY_LIST = Object.keys(HOLIDAY_VALLEY).sort()
function isHolidayValley(bjDate) {
  try {
    return !!HOLIDAY_VALLEY[bjDate.toISOString().slice(0, 10)]
  } catch (err) { return false }
}
function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay() // 0=周日 6=周六（bj 按 UTC 读即为北京日历日）
    if (dow === 0 || dow === 6) return false
  }
  // 法定节假日全天谷价（含调休放假的工作日）
  if (n >= HOLIDAY_VALLEY_FROM_SEC && isHolidayValley(bj)) return false
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}
// 下一个峰谷切换时刻（epoch 秒）：与 isPeakTime 完全同源（含周末 + 法定节假日规则）。
// 只需扫北京时间的小时边界 0/9/12/14/18 点；最长假期（春节 9 天）也只到第 9 天，
// 这里扫 12 天留足余量。返回 null 表示 12 天内没有切换点（当前规则下不会发生），
// 由前端回退到自己的本地推算。
function nextPeakChangeAt(timeSec) {
  const n = Number(timeSec)
  if (!isFinite(n)) return null
  const cur = isPeakTime(n)
  const day0 = Math.floor((n + 8 * 3600) / 86400) * 86400 // 北京当日 00:00（在 +8h 平移坐标系里）
  for (let d = 0; d <= 12; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const cand = day0 + d * 86400 + edge * 3600 - 8 * 3600
      if (cand <= n + 1) continue
      if (isPeakTime(cand) !== cur) return cand
    }
  }
  return null
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

// 浏览器端挂件代码已拆分为独立文件 whale-widget.js(与本文件同目录),
// 不再内嵌模板字面量:可直接 node --check / IDE 高亮,改 widget 后硬刷新页面即生效(无需重启 DSH)。
// 每次请求按 mtime 判断是否需要重读,避免常驻缓存导致改了不生效。
const WIDGET_FILE_CANDIDATES = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'whale-widget.js'),
  path.join(PACKAGE_ROOT, 'whale-widget.js'),
  path.join(PACKAGE_ROOT, 'assets', 'whale-widget.js'),
]
let widgetJsCache = null // { text, mtimeMs }
function loadWidgetJs() {
  for (const p of WIDGET_FILE_CANDIDATES) {
    try {
      const st = fs.statSync(p)
      if (widgetJsCache && widgetJsCache.mtimeMs === st.mtimeMs) return widgetJsCache.text
      const text = fs.readFileSync(p, 'utf8')
      widgetJsCache = { text, mtimeMs: st.mtimeMs }
      return text
    } catch (err) {}
  }
  return widgetJsCache ? widgetJsCache.text : ''
}

// —— 桌面端（Electron）结构化注入行：**内联 script 行**，不是 script-src 行（issue #154）——
// 桌面壳的 index.html 从安装包静态 dist 直出，`tapIndex`（函数变换）永远过不去；唯一通道是
// `webserver/index-inject` 推的结构化行，经 IPC 交给页面侧解释器逐行应用。
// 但解释器对两种 script 行的处理**不对称**（desktop 前端 `web-boot`）：
//   case "script":     createElement + textContent + append   —— 没有 await，**不可能"加载失败"**
//   case "script-src": await loadScript(src)                   —— 失败即 reject，而那个 reject 会
//                                                                reject 掉 __DSH_BOOT_READY__ ⇒ **应用起不来**
// 再加一层：外壳把这张表在**宿主启动时收集一次**后缓存，**没有任何刷新路径** ⇒ 插件在运行期被关掉时，
// 表里仍留着这一行，而 `/dsh-whale/*` 路由已注销 ⇒ 加载 404 ⇒ 就是 issue #154 那个
// "desktop web: failed to load /dsh-whale/widget.js" 致命错误。
// 所以改成内联行：由**我们自己**建 `<script src=…>` 并**吞掉** onerror —— 路由在就正常加载，
// 路由不在就静默失败，宿主永远不会因为我们起不来。
const DESKTOP_WIDGET_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="/dsh-whale/widget.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export default {
  name: 'whale-balance-widget',
  // v758：**有意去掉对象级 `inject: ['webServer','credentials','connection']`**（issue #154 的隐患面）。
  // 对象级 inject 会把整个 apply() 推迟到三个服务就绪之后；而桌面端的注入表是**宿主启动时一次性
  // 收集**的（`dsh-desktop-host`：`collectIndexInjections()` → IPC → 渲染层），订阅一旦晚于那次收集，
  // 这一行就永远进不了表 = 桌面端挂件完全不出现（#152/#153 那位报告人无法稳定复现的正是这个竞态）。
  // 现在 apply() 立刻执行、**第一件事就是注册注入行**（它不依赖任何服务），其余逻辑原样放进
  // `root.inject([...], cb)` 局部等待 —— 语义与原来的对象级 inject 等价，但行的注册不再被推迟。
  apply(root) {
    const rowDisposers = []
    root.effect(() => () => { for (const d of rowDisposers) { try { d() } catch (err) {} } })
    // ① 结构化注入行：桌面端唯一能生效的通道（web 形态另有 tapIndex，两条并存、各自去重）
    rowDisposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === '/dsh-whale/widget.js') return // 旧版本推过 → 不重复
          if (row.kind === 'script' && typeof row.text === 'string'
            && row.text.indexOf('/dsh-whale/widget.js') >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: DESKTOP_WIDGET_ROW_TEXT })
      } catch (err) {}
    }))

    // ② 其余逻辑：等齐三个服务后再跑（等价于原来的对象级 inject，但不再挡住 ①）
    root.inject(['webServer', 'credentials', 'connection'], (ctx) => {
    // —— 浏览器信任栅栏（issue #92 建立，issue #136 补 fail-closed）——
    // dsh 的 connection 服务提供 requestRejection(req)：Host/Origin 被伪造（DNS 重绑定）或未认证的
    // 请求必须被拒。**但这个方法在较老的 dsh 上不存在**（#136 实测：0.1.5-rc.2/rc.3 有、0.1.0-rc.3 没有），
    // 而旧实现在"服务缺失"与"栅栏自己抛异常"两条路径上都是 fail-open（放行）—— 于是 22 条 /dsh-whale/*
    // 路由会**集体**失去校验：伪造 Host 可读写、普通跨站 POST 可直接写配置，而 api-models.json 还连着
    // ctx.credentials（可 set/delete key）。现在改成三层：
    //   ① **插件自己的轻量校验**（永远先跑；正常浏览器与本地脚本都不受影响）：
    //      Host 必须是回环权威或 DSHW_TRUSTED_HOSTS 里显式声明的，`Sec-Fetch-Site: cross-site` 一律拒，
    //      带 Origin 时必须与 Host 同源；
    //   ② 宿主栅栏可用 → **委托**它（不重写它的语义：它里面还有一层浏览器鉴权 401），返回码照用；
    //      **它抛异常则按拒绝处理**（旧实现这条路径静默放行，且连 warn 都没有）；
    //   ③ 宿主栅栏不可用 → 只靠 ①，并在**插件加载时**就打一条醒目 warn（不是等第一次请求才打）。
    const TRUSTED_AUTHORITIES = String(process.env.DSHW_TRUSTED_HOSTS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    // 只认回环：localhost / *.localhost / 127.0.0.0/8（逐段校验，防 `127.0.0.1.evil.com` 这类相似域名）/ ::1
    function isLoopbackHostname(hn) {
      const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
      if (!h) return false
      if (h === 'localhost' || h.endsWith('.localhost')) return true
      if (h === '::1') return true
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
      if (!m) return false
      if (Number(m[1]) !== 127) return false
      return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
    }
    // 通过 → null；否则返回应当拒绝的状态码。
    // opts.fenceAvailable：宿主栅栏此刻可用时，**非回环 Host 交给它判** —— 它知道 dsh 自己的
    // `--trusted-host` 声明了谁；我们只在"确实没有栅栏"时才回落到 DSHW_TRUSTED_HOSTS。
    // （0.3.11 把自校验放在委托之前，导致宿主已信任的权威在插件这边被 403，见 issue #136 后续的 A/B。）
    function selfRejection(req, opts) {
      try {
        const headers = (req && req.headers) || {}
        let hostUrl = null
        try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 } // 缺 Host / 畸形 → 拒
        const hostname = hostUrl.hostname
        const authority = hostUrl.host
        if (!isLoopbackHostname(hostname)) {
          const listed = TRUSTED_AUTHORITIES.some((e) => (e.indexOf(':') >= 0 ? e === authority.toLowerCase() : e === hostname.toLowerCase()))
          const fenceAvailable = !!(opts && opts.fenceAvailable)
          if (!listed && !fenceAvailable) return 403
        }
        // 下面两条与"信任列表"无关，任何情况下都执行：跨站标记、Origin 与 Host 不同源。
        const site = String(headers['sec-fetch-site'] || '').toLowerCase()
        if (site === 'cross-site') return 403
        const origin = headers.origin
        if (typeof origin === 'string' && origin && origin !== 'null') {
          let originUrl = null
          try { originUrl = new URL(origin) } catch (err) { return 403 }
          if (originUrl.host.toLowerCase() !== authority.toLowerCase()) return 403
        }
        return null
      } catch (err) { return 403 } // 校验器自身出错 → 拒绝（fail-closed）
    }
    function connectionFence() {
      try {
        const conn = ctx.get('connection') || ctx.connection
        return conn && typeof conn.requestRejection === 'function' ? conn : null
      } catch (err) { return null }
    }
    if (!connectionFence()) {
      try {
        console.warn('[whale-balance] 宿主信任栅栏不可用（connection.requestRejection 缺失）：已启用插件自带的回环/同源校验，'
          + '所有路由（含写接口）仍受它保护；若本机 dsh 部署在非回环地址（反代/局域网），请用环境变量 '
          + 'DSHW_TRUSTED_HOSTS 声明允许的 Host（逗号分隔，可带端口）。')
      } catch (err) {}
    }
    // v761（安全修复 S1）：**写请求（POST/PUT/PATCH/DELETE）必须来自本机（回环）**。
    // 为什么：任意持有 DSH Web 会话的人都能 `POST /dsh-whale/api-models.json` 写一个自定义模型，
    // 而余额 / 探活 / 额度会**带着解析出来的真实凭据**去请求模型里那个 URL ⇒ 凭据外带。
    // 「改配置」等于「决定把凭据发往哪里」，所以它必须与"坐在这台机器前"绑定；
    // **只读接口不受影响**（局域网里仍能正常看挂件）。
    // 运维若确实需要远端管理，显式声明 DSHW_ADMIN_HOSTS（逗号分隔，可带端口），默认为空。
    const ADMIN_AUTHORITIES = String(process.env.DSHW_ADMIN_HOSTS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
    function writeRejection(req) {
      try {
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (!WRITE_METHODS.has(method)) return null
        const headers = (req && req.headers) || {}
        let hostUrl = null
        try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 }
        if (isLoopbackHostname(hostUrl.hostname)) return null
        const authority = hostUrl.host.toLowerCase()
        const hostname = hostUrl.hostname.toLowerCase()
        if (ADMIN_AUTHORITIES.some((e) => (e.indexOf(':') >= 0 ? e === authority : e === hostname))) return null
        if (!writeRejection.warned) {
          writeRejection.warned = true
          try {
            console.warn('[whale-balance] 已拒绝一个来自非本机的**写请求**（Host=' + authority + '）。'
              + '自 0.3.15 起，配置与凭据的改动只能在**本机**（回环地址）打开界面进行 —— '
              + '否则任何拿到 Web 会话的人都能把凭据改指向自己的服务器，从而把真实 API key 带走。'
              + '确需远端管理，请用环境变量 DSHW_ADMIN_HOSTS 声明允许的管理主机。')
          } catch (err) {}
        }
        return 403
      } catch (err) { return 403 } // 自身出错 → 拒绝（fail-closed）
    }
    function rejected(req, res) {
      const deny = (code) => {
        try { res.statusCode = code || 403; res.end() } catch (err) {}
        return true
      }
      const conn = connectionFence()
      // 先算栅栏可用性，再自校验：非回环 Host 在"栅栏可用"时交给栅栏判（它知道 --trusted-host）
      const self = selfRejection(req, { fenceAvailable: !!conn })
      if (self !== null) return deny(self)
      // v761（安全修复 S1）：写完再放行 —— 读请求不受影响
      const write = writeRejection(req)
      if (write !== null) return deny(write)
      if (!conn) return false // 已通过自校验；此刻没有宿主栅栏可委托（加载时已 warn）
      let code
      try {
        code = conn.requestRejection(req)
      } catch (err) {
        // 旧实现这里是 `return false`：栅栏自己抛异常被当成"没被拒"而静默放行（#136 的第二条路径）
        if (!rejected.warned) {
          rejected.warned = true
          try { console.warn('[whale-balance] 信任栅栏抛异常，已按拒绝处理：' + String((err && err.message) || err)) } catch (e2) {}
        }
        return deny(403)
      }
      if (code === undefined || code === null || code === false) return false
      return deny(typeof code === 'number' ? code : 403)
    }
    // 统一注册入口：所有路由自动套上信任栅栏
    function registerRoute(route) {
      const inner = route && route.handler
      const wrapped = Object.assign({}, route, {
        handler: async (req, res) => {
          if (rejected(req, res)) return
          return inner(req, res)
        },
      })
      return ctx.webServer.register(wrapped)
    }
    let imageBytes = null
    let balanceCache = null
    let balanceInFlight = null
    let gifBytes = null
    // 每轮对话消耗统计：按 (session.id, turn) 分桶聚合，完成后写入 lastTurn。
    // 用 Map 分桶避免主会话与子代理（spawn/fork）并行时串账。
    let turnAggs = new Map() // sessionId -> { turn, cost, tokens, byModel, byModelTokens, lastTs }
    let lastTurn = null // { turn, amount, tokens, ts }
    let lastTurnSeq = 0
    const disposers = []

    // 持久化 seq：热重载/重启后 seq 继续递增，前端不会把新轮次误判为旧轮次
    function readTurnSeq() {
      for (const p of TURN_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && typeof parsed.seq === 'number' && parsed.seq >= 0) return parsed.seq
        } catch (err) {}
      }
      return 0
    }
    function writeTurnSeq(seq) {
      const body = JSON.stringify({ seq, updatedAt: new Date().toISOString() })
      for (const p of TURN_FILE_CANDIDATES) {
        try { fs.writeFileSync(p, body, 'utf8'); return } catch (err) {}
      }
    }
    lastTurnSeq = readTurnSeq()

    function finalizeTurn(sessionId) {
      const agg = turnAggs.get(sessionId)
      if (agg && agg.cost > 0) {
        lastTurn = { turn: agg.turn, amount: agg.cost, tokens: agg.tokens, ts: agg.lastTs }
        lastTurnSeq++
        writeTurnSeq(lastTurnSeq)
        // 按模型拆分写入用量事件(模型明细的唯一来源)
        const byModel = agg.byModel || {}
        const byModelTokens = agg.byModelTokens || {}
        const modelNames = Object.keys(byModel)
        if (modelNames.length) {
          for (const mname of modelNames) {
            appendUsageEvent({ ts: agg.lastTs, model: mname, cost: byModel[mname], tokens: byModelTokens[mname] || 0 })
            // 自定义模型：按 matchIds 归属到注册表里的模型（余额差不可用时作为该模型的今日已用兜底）
            apiAttributeEvent(mname, byModel[mname], byModelTokens[mname] || 0)
          }
        } else {
          appendUsageEvent({ ts: agg.lastTs, model: '未知', cost: agg.cost, tokens: agg.tokens })
        }
      }
      turnAggs.delete(sessionId)
    }
    // 监听会话事件流：assistant/message 携带每步真实 usage，按 (session,turn) 聚合；
    // turn/end 时结算该会话本轮并写入 lastTurn
    function handleSessionEvent(sessionId, event) {
      try {
        const type = event && event.type
        const d = event && event.data
        if (!d || typeof d !== 'object') return
        if (type === 'turn/end') {
          finalizeTurn(sessionId)
          return
        }
        if (type !== 'assistant/message') return
        const turn = Number(d.turn)
        const usage = d.usage
        if (!usage || typeof usage !== 'object' || !isFinite(turn)) return
        let agg = turnAggs.get(sessionId)
        if (!agg || agg.turn !== turn) {
          if (agg) finalizeTurn(sessionId)
          agg = { turn, cost: 0, tokens: 0, byModel: {}, byModelTokens: {}, lastTs: Date.now() }
          turnAggs.set(sessionId, agg)
        }
        const input = Number(usage.inputTokens) || 0
        const cache = Number(usage.cacheReadTokens) || 0
        const output = Number(usage.outputTokens) || 0
        // 口径修正（issue #89 / PR #83）：dsh 保证 reasoningTokens ⊆ outputTokens
        // （见 dsh-token-meter 的校验 reasoningTokens > outputTokens 即判非法），
        // 所以 reasoning 不能再单独累加 —— 否则输出侧按输出价被重复计费（实测偏高约一倍）。
        const outputBilled = output // DSH outputTokens already includes reasoningTokens.
        const toks = input + cache + outputBilled
        agg.tokens += toks
        // 定价换算（CNY/百万 token；缓存命中=输入价，其余按各自档位），并按模型拆分
        const model = d.message && d.message.source ? d.message.source.model : ''
        // 每轮结算前刷新一次自定义单价（10 秒节流），让自定义 API 模型用用户填的价格计费
        try { refreshCustomPrices() } catch (err) {}
        const p = priceFor(model)
        const off = isPeakTime(Math.floor(Date.now() / 1000)) ? 1 : 0
        let costMsg = (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (outputBilled / 1e6) * p.out[off]
        // 自定义单价若按美元填写，按用户填的汇率换算成人民币（账本统一按 CNY 记账）
        try {
          const meta = customPriceMetaFor(model)
          if (meta && meta.cur === 'USD' && Number(meta.rate) > 0) costMsg = costMsg * Number(meta.rate)
        } catch (err) {}
        agg.cost = addMoney(agg.cost, costMsg)
        if (model) {
          agg.byModel[model] = addMoney(agg.byModel[model] || 0, costMsg)
          agg.byModelTokens[model] = (agg.byModelTokens[model] || 0) + toks
        }
        agg.lastTs = Date.now()
      } catch (err) {}
    }

    // v761（issue #161 / 全局音效设置）：**等待用户交互**的挂起状态。
    // 为什么需要它：`ask_user_question` 是一次**挂起**的工具调用 —— 模型发出后 DSH 追加 `tool/call`
    // 然后等你点，等待期间 `last-turn.json` 的 `seq` 不变、`turn/end` 也不会来，所以「任务结束音」
    // 覆盖不到这两个时刻；`turn/end.reason` 里也没有可用信号（`blocked` 是 agent-loop preStep 被 reject，
    // 与用户提问无关）。只保留**最新**一条挂起，不做多会话队列（子代理不允许提问，授权并发极少）。
    const waitState = { pending: null, sessionName: "" }
    const WAIT_QUESTION_TOOL = 'ask_user_question'
    // v761：对话名的**权威来源** —— DSH 的 `sessionTitle` 服务。
    // `sessionTitle.get(session)` 是「折叠会话日志」得来的（其文档原话：Read the latest folded title
    // from one live or replayed session）⇒ **对本插件启动之前就已写入的标题同样有效**，
    // 而只监听 `session/title` 事件只能拿到"启动之后新增/更新"的标题。
    // 全程判空 + try/catch：老宿主没有这个服务时静默回落，绝不因此影响挂起跟踪。
    function titleFromService(session) {
      try {
        const svc = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null
        if (!svc || typeof svc.get !== 'function' || !session) return ''
        const snap = svc.get(session)
        const ti = typeof snap === 'string' ? snap : (snap && (snap.title || snap.text))
        return String(ti == null ? '' : ti).trim().slice(0, 120)
      } catch (err) { return '' }
    }

    function pickSessionName(session) {
      try {
        if (!session || typeof session !== 'object') return ''
        const cands = [session.name, session.title, session.label,
          session.summary && session.summary.title, session.summary && session.summary.name,
          session.meta && session.meta.title, session.meta && session.meta.name]
        for (const c of cands) { const s = String(c == null ? '' : c).trim(); if (s) return s.slice(0, 120) }
      } catch (err) {}
      return ''
    }
    // 提取 callId / approval id（字段位置随 DSH 版本略有差异，全都兜一遍）
    function eventCallId(event) {
      try {
        const d = (event && event.data) || {}
        const msg = d.message || {}
        const list = Array.isArray(msg.content) ? msg.content : []
        for (const c of list) if (c && (c.toolCallId || c.tool_call_id)) return String(c.toolCallId || c.tool_call_id)
        // DSH 实际把 callId 放在 event.data.message.callId 上（tool/result 的 payload 是 {turn,step,message}）。
        // 读出它能让「按 callId 精确解除」生效；读不到时下面的兜底逻辑仍会清空挂起
        // （挂起期间那一轮正卡在等用户回答，不会有别的 tool/result）。
        if (msg && (msg.callId || msg.toolCallId || msg.tool_call_id)) return String(msg.callId || msg.toolCallId || msg.tool_call_id)
        return String(d.callId || d.call_id || d.toolCallId || d.id || '')
      } catch (err) { return '' }
    }
    function notePendingEvent(sid, event, session) {
      try {
        const type = String((event && event.type) || '')
        const data = (event && event.data) || {}
        const now = Date.now()
        // v761：**对话名**有两个来源 —— ① `session/title` 事件（DSH 会话标题本身就是一条日志事件：
        //   `session.append("session/title", { title, messageSeqs, source })`，投影键 title 由它折叠而来；
        //   本插件已监听 session/event ⇒ 直接取 event.data.title，不需要任何新服务）；
        //   ② `session` 对象上的 name/title 等字段（不同 DSH 版本可能有、也可能没有）。
        //   ⚠️ 必须放在 type/data 声明**之后** —— 放前面会撞 const 的暂时性死区（TDZ），
        //   抛 ReferenceError 后被外层 try/catch 静默吞掉 ⇒ 整个挂起跟踪失效（本批真踩过）。
        if (type === 'session/title') {
          const ti = String(data.title == null ? '' : data.title).trim()
          if (ti) waitState.sessionName = ti.slice(0, 120)
          return
        }
        // 三个来源，按可靠性排序：① sessionTitle 服务（可折叠日志，含启动前的标题）
        // ② session/title 事件（启动后新增/更新）③ session 对象字段（版本相关，兜底）
        const svcName = titleFromService(session)
        if (svcName) waitState.sessionName = svcName
        else {
          const name = pickSessionName(session)
          if (name) waitState.sessionName = name
        }
        if (type === 'tool/call' && String(data.name || data.toolName || '') === WAIT_QUESTION_TOOL) {
          waitState.pending = { kind: 'question', id: eventCallId(event) || ('q' + now), ts: now, session: sid }
          return
        }
        if (type === 'tool/result') {
          if (waitState.pending && waitState.pending.kind === 'question') {
            const cid = eventCallId(event)
            if (!cid || cid === waitState.pending.id) waitState.pending = null
          }
          return
        }
        if (type === 'approval/asked') {
          waitState.pending = { kind: 'approval', id: String(data.id || ('a' + now)), ts: now, session: sid }
          return
        }
        if (type.indexOf('approval/') === 0) {
          if (waitState.pending && waitState.pending.kind === 'approval') {
            const id2 = String(data.id || '')
            if (!id2 || id2 === waitState.pending.id) waitState.pending = null
          }
          return
        }
        if (type === 'turn/end' || type === 'turn/start') waitState.pending = null
      } catch (err) {}
    }

    // 监听所有会话的追加事件；按会话 id 分桶，turn/end 时结算该会话本轮
    disposers.push(ctx.on('session/event', (session, event) => {
      const sid = session && session.id ? session.id : 'default'
      handleSessionEvent(sid, event)
      notePendingEvent(sid, event, session)
    }))
    // 会话销毁时清理残留聚合，避免内存泄漏
    disposers.push(ctx.on('session/disposed', (session) => {
      if (session && session.id) turnAggs.delete(session.id)
    }))

    function loadGif() {
      if (gifBytes) return gifBytes
      for (const p of RUA_GIF_CANDIDATES) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) {
            gifBytes = bytes
            return bytes
          }
        } catch (err) {}
      }
      throw new Error('rua gif not found')
    }

    function loadImage() {
      if (imageBytes) return imageBytes
      for (const p of IMAGE_CANDIDATES) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) {
            imageBytes = bytes
            return bytes
          }
        } catch (err) {}
      }
      throw new Error('whale image not found')
    }

    function pickBalanceInfo(infos) {
      if (!Array.isArray(infos) || infos.length === 0) return null
      const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
      return (
        infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
        infos.find((x) => num(x) > 0) ||
        infos.find((x) => x && x.currency === 'CNY') ||
        infos[0]
      )
    }

    // v759（issue #157）：**DSH 账号登录态**的余额路径。
    // 只通过 DSH 账号登录的用户没有 API key，余额在 DeepSeek 平台的账号接口上。
    // **不要自己拼 HTTP**：token 注入、5 个 `x-client-*` 头、401/`40003` 失效清理全部由 DSH 的
    // `deepseekAccount` 服务负责（DSH 自己的「账号与余额」设置卡片就是 `ctx.deepseekAccount.getBalance(client)`）。
    // ⚠️ 必须用 `ctx.get('deepseekAccount')` 读**可选服务**，**绝不能写进 inject** —— 老宿主根本没有这个服务，
    //    一旦进 inject，整个插件会永远等不到服务而**完全不 apply**（比没有这个功能严重得多）。
    // ⚠️ 与 API key 路径**互不干扰**（API key 永远优先；DSH 自己的注释也是 "Neither route falls back to the other"）。
    // v781：账号余额路的失败原因（只用于错误文案，不参与任何判定）。fetchAccountBalance 每次开头清空。
    let accountDiag = ''
    async function fetchAccountBalance() {
      let account = null
      accountDiag = ''
      try { account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null } catch (err) { account = null }
      if (!account || typeof account.getBalance !== 'function') { accountDiag = '当前 DSH 没有账号服务'; return null }
      // 账户标识：优先用账号服务给的稳定 id（不同账号 → 不同账本 scope）；取不到就退回固定标识。
      // 一律 sha256[:24] 十六进制 —— accounting.mjs 校验 scope 必须匹配 /^[a-zA-Z0-9_-]{1,80}$/
      // （带冒号这种可读写法会直接抛「账户标识无效」，见 issue #157 报告人踩的坑 1）。
      let accountId = null
      try {
        const state = typeof account.getState === 'function' ? account.getState() : null
        accountId = (state && (state.userId || (state.profile && state.profile.userId))) || null
      } catch (err) { accountId = null }
      let result
      try {
        result = await account.getBalance({
          version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
          locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60, // 东为正的整秒
        })
      } catch (err) {
        accountDiag = '账号余额接口调用失败: ' + String((err && err.message) || err).slice(0, 120)
        return null
      }
      // 未登录 / 没有 grant / 平台失败 → 一律返回 null，让调用方退回原来的文案（**不缓存错误**）
      // v781：失败时记下**原因**（accountDiag），供 fetchBalance 把两条路的原因一起报给界面 ——
      //   以前只有一个笼统的"账号余额不可用"，用户/支持方分不清"没登录"和"接口失败"。
      if (!result) { accountDiag = '未登录 DeepSeek 账号（没有账号凭据）'; return null }
      if (result.status !== 'ready') { accountDiag = '账号余额接口未就绪（' + String(result.status || 'unknown') + '）'; return null }
      const accNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
      // v781：**"充值钱包为空、只有赠金"必须算成功** —— 这是"只登录客户端读不到余额"的主因。
      //   平台把钱包拆成 `normal_wallets`（充值）与 `bonus_wallets`（赠金）；新用户/没充过值的用户
      //   常常**只有赠金**（甚至 normal_wallets 是空数组）⇒ 旧代码要求 `result.value` 非空，
      //   直接把这类账号判成"没有余额钱包"，界面就只显示"读取不到余额"。
      //   判据对齐 DSH 自己的账号卡片（dsh-client-ui-settings-account）：
      //     `[...balance.value, ...balance.bonusWallets].some(w => new Big(w.balance).gt(0))`
      //   —— 两个钱包一起看，不再单看充值钱包。
      const normRaw = Array.isArray(result.value) ? result.value : []
      const bonusRaw = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
      const usable = (list) => list.filter((w) => w && accNum(w.balance) !== null)
      const normWallets = usable(normRaw)
      const bonusWallets = usable(bonusRaw)
      const allWallets = normWallets.concat(bonusWallets)
      if (allWallets.length === 0) {
        // 两边都没有可用钱包 = 真的没有数据（未激活/账号没有任何钱包），不是"余额 0"
        accountDiag = normRaw.length || bonusRaw.length ? '钱包字段不可用' : '账号没有余额钱包'
        return null
      }
      // 币种：优先「有余额的那个钱包」的币种（CNY 优先），其次任何 CNY 钱包，最后第一个
      const curOf = (w) => String((w && w.currency) || 'CNY').toUpperCase()
      const nonzero = allWallets.filter((w) => Number(w.balance) > 0)
      const curPick = nonzero.find((w) => curOf(w) === 'CNY') || nonzero[0]
        || allWallets.find((w) => curOf(w) === 'CNY') || allWallets[0]
      const currency = curOf(curPick)
      const sumOf = (list) => list
        .filter((w) => w && curOf(w) === currency && accNum(w.balance) !== null)
        .reduce((s, w) => s + Number(w.balance), 0)
      const recharge = sumOf(normWallets)
      const bonus = sumOf(bonusWallets)
      accountDiag = ''
      return {
        ok: true,
        // 充值 + 赠金：与 API key 路径的 `total_balance` 同口径（那个字段本身也是两者相加），
        // 否则"按余额差"推算的今日已用会偏小（issue #157 报告人的坑 2）。
        totalBalance: Number((recharge + bonus).toFixed(6)),
        // v781：两个分量单独下发，供「赠金 / 账户余额」两个自定义模块使用（见 SPEC §25）
        rechargeBalance: Number(recharge.toFixed(6)),
        bonusBalance: Number(bonus.toFixed(6)),
        currency,
        balanceSource: 'account',
        accountTag: createHash('sha256').update('dsh-account:' + (accountId === null ? 'default' : String(accountId))).digest('hex').slice(0, 24),
        updatedAt: new Date().toISOString(),
      }
    }

    // v781：账号路的兜底（**两条路都失败才报错，并把两条路的原因都带上**）。
    //   为什么需要它：旧实现只在"完全没有 API key"时才试账号路 ⇒ 曾经配过 key（过期/写错/被删）
    //   但现在只用客户端登录的用户，余额**永远读不到**（"只登录客户端读不到余额"报告里的另一大类）。
    //   ⚠️ 超时上限：账号路走 DSH 自己的服务（默认 30s）⇒ 我们用 ACCOUNT_FALLBACK_MS 截断，
    //   保证"API key 两次 8s + 退避"之后仍在**前端的 25s** 之内回来，不让界面先 abort。
    async function accountFallback(keyErr) {
      let acc = null
      try {
        acc = await Promise.race([
          fetchAccountBalance(),
          new Promise((r) => setTimeout(() => { accountDiag = '账号余额请求超时'; r(null) }, ACCOUNT_FALLBACK_MS)),
        ])
      } catch (err) {
        acc = null
        accountDiag = accountDiag || ('账号余额异常: ' + String((err && err.message) || err).slice(0, 120))
      }
      if (acc) return acc
      const keyPart = keyErr
        ? ('API key 路：' + String((keyErr.error || keyErr.code || '失败')).slice(0, 160))
        : '未配置 DEEPSEEK_API_KEY'
      return {
        ok: false,
        code: keyErr ? 'BOTH_FAILED' : 'NO_KEY',
        error: keyPart + '；账号登录路：' + (accountDiag || '拿不到余额'),
      }
    }
    async function fetchBalance() {
      // v739（用户反馈「每次新实例的第一次余额请求都失败」）：
      // ① 冷启动时凭据服务可能尚未就绪（resolve 抛错），这与「确实没配置」不同 → 短延迟重试一次；
      // ② 单次超时从 20s 收到 8s，保证「2 次尝试 + 退避」明显短于前端 FETCH_TIMEOUT_MS(25s) ——
      //    否则前端先 abort，用户看到的永远是「第一次失败」，只能干等 60 秒后的下一轮。
      let cred = null
      let credErr = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
          credErr = null
          break
        } catch (err) {
          credErr = err
          if (attempt === 0) { await new Promise((r) => setTimeout(r, 700)); continue }
          // v781：凭据服务报错时**也要试账号路**（以前直接 return，登录态用户就被这条挡住）
          return await accountFallback({ code: 'NO_KEY', error: '凭据读取失败: ' + String((err && err.message) || err).slice(0, 160) })
        }
      }
      if (!cred) {
        // v759（issue #157）：没有 API key 时退回 DSH 账号登录态；两条路互不干扰，API key 始终第一优先。
        return await accountFallback(null)
      }
      const apiFail = await fetchApiKeyBalance(cred)
      if (apiFail.ok) return apiFail
      // v781：key 路**任何**失败都再试一次账号路（401/结构异常/超时都算）
      void credErr
      return await accountFallback(apiFail)
    }

    // API key 路（原 fetchBalance 的主体，v781 抽出来以便"失败后回退账号路"）
    async function fetchApiKeyBalance(cred) {
      let lastErr = null
      for (let attempt = 0; attempt < 2; attempt++) {
        let res
        try {
          res = await fetch(BALANCE_URL, {
            headers: { Authorization: 'Bearer ' + cred.value },
            signal: AbortSignal.timeout(8000),
          })
        } catch (err) {
          lastErr = err
          if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
          continue
        }
        if (!res.ok) {
          lastErr = new Error('HTTP ' + res.status)
          if (res.status < 500) break
          if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
          continue
        }
        let data
        try {
          data = await res.json()
        } catch (err) {
          return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
        }
        const info = pickBalanceInfo(data && data.balance_infos)
        if (!info || info.total_balance === undefined || !Number.isFinite(Number(info.total_balance))) {
          return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
        }
        const numOr = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null }
        return {
          ok: true,
          totalBalance: Number(info.total_balance),
          // v781：官方 /user/balance 除 total_balance 外还给了 granted_balance（**未过期**赠金）与
          //   topped_up_balance（充值）。取不到就是 null（界面显示 —，**不臆造 0** —— 0 会被记账
          //   当成"余额真的见底"，那是另一种语义）。两个分量供自定义模块里的「赠金 / 账户余额」使用。
          bonusBalance: numOr(info.granted_balance),
          rechargeBalance: numOr(info.topped_up_balance),
          accountTag: createHash('sha256').update(String(cred.value)).digest('hex').slice(0, 24),
          currency: String(info.currency || 'CNY'),
          balanceSource: 'apikey',
          updatedAt: new Date().toISOString(),
        }
      }
      const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
      return {
        ok: false,
        code: 'HTTP',
        transient: transient,
        error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
      }
    }

    function todayKey() { return beijingDay() }
    // Windows indexers can briefly hold a just-written file. Retry sharing
    // conflicts; never treat an unreadable existing ledger as an empty ledger.
    function ledgerIo(operation) {
      for (let attempt = 0; ; attempt++) {
        try { return operation() } catch (err) {
          if (attempt >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))
        }
      }
    }
    function readUsageLedger() {
      for (const p of USAGE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(ledgerIo(() => fs.readFileSync(p, 'utf8')))
          if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') return parsed
          throw new Error('账本结构异常，已停止写入以保护原记录')
        } catch (err) { if (err.code !== 'ENOENT') throw err }
      }
      return { date: todayKey(), lastBalance: null, todayUsage: 0, history: {} }
    }
    function writeUsageLedger(led) {
      const body = JSON.stringify(led)
      for (const p of USAGE_FILE_CANDIDATES) {
        const temp = p + '.tmp-' + process.pid
        try {
          if (fs.existsSync(p)) {
            const existing = JSON.parse(ledgerIo(() => fs.readFileSync(p, 'utf8')))
            if (!existing.accounting || existing.accounting.version !== 1) {
              try { ledgerIo(() => fs.copyFileSync(p, p + '.before-recharge-fix.bak', fs.constants.COPYFILE_EXCL)) }
              catch (err) { if (err.code !== 'EEXIST') throw err }
            }
          }
          ledgerIo(() => fs.writeFileSync(temp, body, 'utf8'))
          ledgerIo(() => fs.renameSync(temp, p))
          return true
        } catch (err) {
          try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch (cleanupErr) {}
          if (err.code !== 'ENOENT') console.error('[whale-ledger] 账本保存失败:', err.code || err.message)
        }
      }
      return false
    }
    // —— 账本保留策略（v700）：events 保留 90 天或最多 2 万条；history 保留 365 天；
    //    超期部分归档到 .dshw-usage-archive.json（不丢历史，只是移出主账本，避免账本无限膨胀）——
    function usageArchivePath() {
      for (const p of USAGE_FILE_CANDIDATES) {
        try {
          fs.accessSync(path.dirname(p), fs.constants.W_OK)
          return path.join(path.dirname(p), '.dshw-usage-archive.json')
        } catch (err) {}
      }
      return path.join(DSH_HOME, '.dshw-usage-archive.json')
    }
    function readUsageArchive() {
      try {
        const j = JSON.parse(fs.readFileSync(usageArchivePath(), 'utf8'))
        if (j && typeof j === 'object') return j
      } catch (err) {}
      return { version: 1, events: [], history: {} }
    }
    // 返回 true 表示账本被裁剪过（调用方随后写盘即可）
    function pruneLedgerUsage(led) {
      try {
        const ev = Array.isArray(led.events) ? led.events : []
        const hist = (led.history && typeof led.history === 'object') ? led.history : {}
        const dateCut90 = dayAdd(todayKey(), -90)
        const dateCut365 = dayAdd(todayKey(), -365)
        const keepEv = []
        const dropEv = []
        for (const e of ev) {
          const day = String((e && e.day) || '')
          if (day && day < dateCut90) dropEv.push(e)
          else keepEv.push(e)
        }
        if (keepEv.length > 20000) {
          const extra = keepEv.length - 20000
          for (const e of keepEv.splice(0, extra)) dropEv.push(e)
        }
        const dropHist = {}
        let histDropped = 0
        for (const day of Object.keys(hist)) {
          if (String(day) < dateCut365) {
            dropHist[day] = hist[day]
            delete hist[day]
            histDropped++
          }
        }
        if (!dropEv.length && !histDropped) return false
        const ar = readUsageArchive()
        ar.events = Array.isArray(ar.events) ? ar.events : []
        for (const e of dropEv) ar.events.push(e)
        if (ar.events.length > 200000) ar.events.splice(0, ar.events.length - 200000)
        ar.history = Object.assign({}, ar.history || {}, dropHist)
        ar.updatedAt = new Date().toISOString()
        ar.note = '小鲸鱼记账归档：events 超 90 天或超 2 万条、history 超 365 天的部分'
        try { fs.writeFileSync(usageArchivePath(), JSON.stringify(ar), 'utf8') } catch (err) { return false }
        led.events = keepEv
        led.history = hist
        return true
      } catch (err) { return false }
    }
    function dayKeyOfDate(d) { return beijingDay(d.getTime()) }
    function dayKeyFromTs(ts) { return beijingDay(Number(ts)) }
    function dayAdd(baseDayStr, delta) { return dayOffset(baseDayStr, delta) }
    // 每轮结算后追加一条用量事件(模型明细/7天/全部记录的来源;上限 8000 条)
    function appendUsageEvent(ev) {
      const led = readUsageLedger()
      led.events = Array.isArray(led.events) ? led.events : []
      led.events.push({
        ts: Number(ev.ts) || Date.now(),
        day: dayKeyFromTs(Number(ev.ts) || Date.now()),
        model: String(ev.model || '未知'),
        cost: preciseMoney(Number(ev.cost) || 0),
        tokens: Math.round(Number(ev.tokens) || 0),
      })
      // 保留策略：events 90 天 / 最多 2 万条（超期或超量归档到 .dshw-usage-archive.json）
      pruneLedgerUsage(led)
      writeUsageLedger(led)
    }
    // 供面板/窗口使用的汇总:今日(按模型降序)、近7天、7天合计、全部记录
    function usageRecordsPayload() {
      const led = readUsageLedger()
      const events = Array.isArray(led.events) ? led.events : []
      const today = todayKey()
      function modelsFor(day) {
        const map = new Map()
        for (const e of events) {
          if (e.day !== day) continue
          const name = String(e.model || '未知')
          map.set(name, addMoney(map.get(name) || 0, Number(e.cost) || 0))
        }
        return Array.from(map, ([model, cost]) => ({ model, cost, source: 'events', currency: 'CNY' }))
          .sort((a, b) => b.cost - a.cost)
      }
      function forDay(date) {
        const summary = daySummary(led, date)
        const models = modelsFor(date)
        return {
          ...summary, date, total: summary.amount, models,
          modelTotal: sumMoney(models.map(m => m.cost)), modelCurrency: 'CNY',
        }
      }
      const todayData = forDay(today)
      const days7 = Array.from({ length: 7 }, (_, i) => forDay(dayAdd(today, -i)))
      const total7ByCurrency = {}
      for (const d of days7) total7ByCurrency[d.currency] = addMoney(total7ByCurrency[d.currency] || 0, d.total)
      const days = new Set([today, ...Object.keys(led.history || {}), ...accountingDays(led)])
      for (const e of events) if (/^\d{4}-\d{2}-\d{2}$/.test(e.day)) days.add(e.day)
      return {
        ok: true, version: '0.3.18', today: todayData, days7,
        total7: total7ByCurrency[todayData.currency] || 0, total7Currency: todayData.currency, total7ByCurrency,
        all: {
          days: Array.from(days).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().map(forDay),
          events: events.slice().sort((a, b) => b.ts - a.ts).slice(0, 500),
        },
        settings: readUsageSettings(),
      }
    }
    // 用量相关设置(任务结束音 / 余额预警 / 今日预算)存于用量账本 settings
    // v761（全局音效设置面板 / issue #161）：每个事件的音效 + 冒泡配置。
    // 命名沿用既有约定：`sel` 音效绑定（'' = 静音）、`lines` 泡泡内容模块列表（与 alert / turnCost 同构）、
    // `bubbleOn` 是否冒泡、`vol` 该事件独立音量；提问/授权另有 `autoClose` + `ttlSec`（与 alert 同名）。
    // ⚠️ v764：`events.turnCost` **不再有** `autoClose`/`ttlSec` —— 它们从来没有消费方，② 区「自动关闭」
    //    的真实落点是 `.dshw-size.json` 的 `turnCostCloseMs`（默认 5000ms，见 readSizeConfig）。
    // ⚠️ 这里的 question/approval 默认内容与前端 `usageWaitDefaultLines()` **必须逐字段一致**
    //    （同 alert/turnCost 的既有约定：host = 新用户默认；前端 = 编辑器「恢复默认」的目标）。
    function waitDefaultLines(kind) {
      // v774：出厂默认内容 = 作者当前实际使用的那一套（对话名模块 + 一句提示语，都带跑马灯配色）。
      // ⚠️ 必须与前端 whale-widget.js 的 usageWaitDefaultLines() 逐字段一致（有跨端一致性探针钉住）。
      const isApproval = kind === 'approval'
      return [
        { type: 'session', size: 10, bold: true, tpl: '[ {session} ]', len: 5, rgb: 'champagne', color: '' },
        { type: 'text', text: isApproval ? '正在等待老大授权' : '正在等待老大回答', size: 7, bold: true, bgRgb: '', bg: '', rgb: 'indigo', color: '' },
      ]
    }
    function soundEventsDefaults() {
      return {
        // 按压音效（按压 + 松开）：音量与音效组仍在 .dshw-size.json（vol / soundSet），
        // 这里只占位，便于面板把四个事件写成同一结构。
        press: { vol: 1 },
        // ⚠️ turnCost **不带** soundOn：它的"这个音效播不播"就是既有的 `taskEnd.on`。
        //    提问/授权用 soundOn；v774 起它俩的出厂默认 = 作者当前用法：事件**开**着、但音效**不响**
        //    （只冒泡）—— 要响就把音效行的 [✓] 勾上。
        // v764：turnCost **刻意不带** autoClose / ttlSec —— 自动关闭的真实来源是 .dshw-size.json 的
        //    turnCostCloseMs，留着这两个键会让同一个设置有两个来源（其中一个永远是假的）。
        // v778：`volSet` = 用户**显式**调过②区「提示音量」没有（默认 false = 跟随①区按压音量）。
        //    没有它就无法区分"默认 100%"与"用户设了 100%"，前端 soundVolumeOf() 靠它决定优先级。
        //    ⚠️ 与前端 soundEventDefaults().turnCost **必须逐字段一致**（探针 §⑥ 跨端一致钉住）。
        turnCost: { vol: 1, volSet: false, bubbleOn: true },
        question: { on: true, soundOn: false, sel: 'frag:exp_orb', vol: 1, autoClose: true, ttlSec: 180, bubbleOn: true, lines: waitDefaultLines('question') },
        approval: { on: true, soundOn: false, sel: 'frag:exp_orb', vol: 1, autoClose: true, ttlSec: 180, bubbleOn: true, lines: waitDefaultLines('approval') },
      }
    }
    function usageSettingsDefaults() {
      return {        // 任务结束音：v774 起出厂默认 = **开**（作者当前用法），默认音 = 内置 A（end_a）
        taskEnd: { on: true, sel: 'frag:end_a' },
        // v777：「等待交互提示」的交互开关（用户 2026-09-26 要求）
        //   charClose=false（出厂默认）＝ 只有**点泡泡**能收起等待提示；true ＝ **点角色**也能收起。
        //   两种情况下"点掉的那条挂起"都不会再被每秒轮询自动弹回（前端 waitDismissedId）。
        wait: { charClose: false },
        // v761：四个事件的音效/自动关闭/冒泡配置（面板「全局音效设置」）
        events: soundEventsDefaults(),
        // 默认固化自开发环境当前 usage.json 设置(全新安装即此体验)
        // ⚠️ 这里的 alert / budget / turnCost 内容与前端 whale-widget.js 的
        //    usageRemindDefaultLines() / usageTurnCostDefaultLines() **必须逐字段一致**
        //    (host = 新用户默认内容；前端 = 编辑器里「恢复默认」的目标内容)。改一处必须同步另一处。
        alert: {
          on: true, below: 5,
          msg: '余额预警:当前余额已低于设定值 {below}',
          lines: [
            { type: 'text', text: '老大~你的DS余额', size: 5, bold: true },
            { type: 'text', text: '已经不足', size: 5, bold: true, row: 2 },
            { type: 'text', text: '¥{below}', size: 5, bold: true, rgb: 'rouge', color: '', bgRgb: '', bg: '', row: 2 },
            { type: 'text', text: '啦~', size: 5, bold: true, row: 2 },
            { type: 'image', imgId: 'bimg_money1', size: 6, imgScale: 0.4 },
            { type: 'link', text: '>> 喂 点 米 <<', url: 'https://platform.deepseek.com/top_up', size: 1, color: '#ffffff', rgb: '', bgRgb: 'indigo', bg: '', bold: true, ul: false },
          ],
          autoClose: false, ttlSec: 6,
        },
        budget: {
          on: true, amount: 10,
          msg: '今日已用已达预算 ¥{amount}',
          lines: [
            { type: 'text', text: '老大，今天花销已经超过', size: 6, bold: true, row: 1 },
            { type: 'text', text: '¥{amount}', size: 7, bold: true, row: 1, rgb: 'rouge', color: '', italic: false, bgRgb: '', bg: '' },
            { type: 'text', text: '啦，再花要变成穷光蛋啦...', size: 6, bold: true, row: 1 },
          ],
          autoClose: false, ttlSec: 6,
        },
        // 每轮消耗提示内容(自定义提示窗口):与预警/预算同一套模块化内容,{cost} = 本轮消耗金额。
        // 内容 = 冻结的当前生效快照(与前端 usageTurnCostDefaultLines() 一致)；
        // 开关/自动关闭秒数仍存 .dshw-size.json(不迁移),这里只放内容。
        turnCost: {
          lines: [
            { type: 'text', text: '上一轮对话消耗:', size: 8, bold: true },
            { type: 'text', text: '¥ {cost}', size: 24, bold: true, color: '#e0433f' },
            { type: 'today', size: 2, tpl: '今日已用 {expense_ds}', bold: false, rgb: '', color: '#ffffff', bgRgb: 'indigo', bg: '' },
          ],
        },
      }
    }
    function readUsageSettings() {
      const led = readUsageLedger()
      const d = usageSettingsDefaults()
      const s = led && led.settings && typeof led.settings === 'object' ? led.settings : {}
      if (s.taskEnd && typeof s.taskEnd === 'object') d.taskEnd = Object.assign({}, d.taskEnd, s.taskEnd)
      if (s.alert && typeof s.alert === 'object') d.alert = Object.assign({}, d.alert, s.alert)
      if (s.budget && typeof s.budget === 'object') d.budget = Object.assign({}, d.budget, s.budget)
      if (s.turnCost && typeof s.turnCost === 'object') d.turnCost = Object.assign({}, d.turnCost, s.turnCost)
      // v761（全局音效设置）：四个事件逐个合并（缺字段回落到默认，不整块替换）
      if (s.events && typeof s.events === 'object') {
        for (const k of Object.keys(d.events)) {
          if (s.events[k] && typeof s.events[k] === 'object') d.events[k] = Object.assign({}, d.events[k], s.events[k])
        }
        // v764：老数据里若还留着 events.turnCost.autoClose / ttlSec（已摘除的死键），读的时候就丢掉，
        // 免得它们继续随 settings 下发给前端（真实来源是 .dshw-size.json 的 turnCostCloseMs）。
        if (d.events.turnCost) { delete d.events.turnCost.autoClose; delete d.events.turnCost.ttlSec }
      }      // 每个模型各自的提醒/预算：内置 DeepSeek 沿用顶层 alert/budget（旧配置零迁移）
      const byModel = s.models && typeof s.models === 'object' ? s.models : {}
      // 手动额度默认值：资源包/订阅制厂商没有额度接口时，总量与已用由用户在面板里手填
      const qDef = () => ({ on: false, mode: 'auto', total: 0, unit: 'tokens', used: 0, reset: 'none', baseAt: 0 })
      d.models = { [API_BUILTIN_ID]: { alert: d.alert, budget: d.budget, quota: Object.assign(qDef(), (byModel[API_BUILTIN_ID] && byModel[API_BUILTIN_ID].quota) || {}) } }
      for (const m of readApiRegistry().models) {
        if (!m || !m.id || m.id === API_BUILTIN_ID) continue
        const st = byModel[m.id] && typeof byModel[m.id] === 'object' ? byModel[m.id] : {}
        d.models[m.id] = {
          alert: Object.assign({}, usageSettingsDefaults().alert, st.alert || {}),
          budget: Object.assign({}, usageSettingsDefaults().budget, st.budget || {}),
          quota: Object.assign(qDef(), st.quota || {}),
        }
      }
      return d
    }
    function writeUsageSettings(patch) {
      const led = readUsageLedger()
      led.settings = led.settings && typeof led.settings === 'object' ? led.settings : {}
      const p = patch || {}
      if (p.taskEnd && typeof p.taskEnd === 'object') led.settings.taskEnd = Object.assign({}, led.settings.taskEnd || {}, p.taskEnd)
      if (p.alert && typeof p.alert === 'object') led.settings.alert = Object.assign({}, led.settings.alert || {}, p.alert)
      if (p.budget && typeof p.budget === 'object') led.settings.budget = Object.assign({}, led.settings.budget || {}, p.budget)
      // 每轮消耗提示内容(自定义提示窗口)
      if (p.turnCost && typeof p.turnCost === 'object') led.settings.turnCost = Object.assign({}, led.settings.turnCost || {}, p.turnCost)
      // v777：「等待交互提示」的交互开关（点角色是否也能关闭等待提示气泡）
      if (p.wait && typeof p.wait === 'object') led.settings.wait = Object.assign({}, led.settings.wait || {}, p.wait)
      // v761（全局音效设置）：events 补丁逐事件合并（前端只发改动的那几个字段）
      if (p.events && typeof p.events === 'object') {
        led.settings.events = led.settings.events && typeof led.settings.events === 'object' ? led.settings.events : {}
        for (const k of Object.keys(p.events)) {
          if (!p.events[k] || typeof p.events[k] !== 'object') continue
          led.settings.events[k] = Object.assign({}, led.settings.events[k] || {}, p.events[k])
        }
        // v764：events.turnCost 的 autoClose / ttlSec 已摘除（真实来源是 .dshw-size.json 的
        // turnCostCloseMs）—— 老数据里若还留着，借着这次保存删掉；老前端若还发这两个键也一并丢掉。
        const tcEv = led.settings.events.turnCost
        if (tcEv && typeof tcEv === 'object') { delete tcEv.autoClose; delete tcEv.ttlSec }
      }
      // 「恢复默认」：只重置音效/提示类键（不动外观、位置、账本、角色与泡泡自定义）
      if (p.resetEvents === true) {
        led.settings.events = soundEventsDefaults()
        // v777：等待提示的交互开关也属于"提示类键" ⇒ 一起恢复出厂默认（charClose=false）
        led.settings.wait = { charClose: false }
        // 任务结束音也属于「音效类键」：宿主重置与面板显示必须口径一致（否则面板显示与真实状态撕裂）
        // v774：重置目标 = 新的出厂默认（开 + 内置 A）
        led.settings.taskEnd = { on: true, sel: 'frag:end_a' }
      }      // 按模型保存提醒/预算：{ modelId, alert?, budget? }
      if (p.modelSettings && p.modelSettings.id) {
        const mid = String(p.modelSettings.id)
        led.settings.models = led.settings.models && typeof led.settings.models === 'object' ? led.settings.models : {}
        const cur = led.settings.models[mid] && typeof led.settings.models[mid] === 'object' ? led.settings.models[mid] : {}
        if (p.modelSettings.alert && typeof p.modelSettings.alert === 'object') cur.alert = Object.assign({}, cur.alert || {}, p.modelSettings.alert)
        if (p.modelSettings.budget && typeof p.modelSettings.budget === 'object') cur.budget = Object.assign({}, cur.budget || {}, p.modelSettings.budget)
        // 手动额度：整体覆盖（总量/单位/已用/重置周期/统计模式/开关）
        if (p.modelSettings.quota && typeof p.modelSettings.quota === 'object') {
          const q = Object.assign({}, p.modelSettings.quota)
          const wantReset = !!q.resetBase
          delete q.resetBase
          // 「重置基准」：把累计 token 的基准点设为当前值 → 已用从 0 重新计
          if (wantReset) {
            const u = apiUsageRaw(mid)
            q.baseAt = Number(u && u.tokensTotal) || 0
          }
          cur.quota = Object.assign({}, cur.quota || {}, q)
        }
        led.settings.models[mid] = cur
        // 内置 DeepSeek：同步回写顶层字段，旧读取方（泡泡提醒）不受影响
        if (mid === API_BUILTIN_ID) {
          if (cur.alert) led.settings.alert = cur.alert
          if (cur.budget) led.settings.budget = cur.budget
        }
      }
      if (!writeUsageLedger(led)) return { ok: false, error: '保存失败' }
      return { ok: true, settings: readUsageSettings() }
    }
    // ===== Codex 本地会话统计（Codex 适配 · 第一期）=====
    // 数据源：$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl 与 archived_sessions/*.jsonl（明文 JSONL）
    //   每行：{ type, timestamp, ordinal, payload }
    //   逐轮用量：type=token_count 的 payload.info.last_token_usage / total_token_usage
    //   模型归属：type=turn_context 的 payload.model
    // 口径：优先用「累计量的差值」（total_token_usage 单调递增，天然免疫一次轮次多条 token_count 的重复），
    //       用量拆分按该事件的 last_token_usage 比例缩放；累计缺失时退回 last_token_usage。
    // 缓存：$DSH_HOME/.dshw-codex.json（只存各文件聚合与 size/mtime，不存任何凭据，也不写 ~/.codex）
    function codexHome() {
      const env = String(process.env.CODEX_HOME || '').trim()
      for (const c of [env, path.join(os.homedir(), '.codex')]) {
        try { if (c && fs.existsSync(c)) return c } catch (err) {}
      }
      return ''
    }
    function readCodexCache() {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DSH_HOME, '.dshw-codex.json'), 'utf8'))
        if (j && j.files && typeof j.files === 'object') return j
      } catch (err) {}
      return { version: 1, files: {} }
    }
    function writeCodexCache(c) {
      try { fs.writeFileSync(path.join(DSH_HOME, '.dshw-codex.json'), JSON.stringify(c), 'utf8'); return true } catch (err) { return false }
    }
    function listCodexSessionFiles(root) {
      const out = []
      const walk = (dir, depth) => {
        if (depth > 6) return
        let ents = []
        try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) { return }
        for (const e of ents) {
          const p = path.join(dir, e.name)
          if (e.isDirectory()) walk(p, depth + 1)
          else if (/^rollout-.*\.jsonl$/i.test(e.name)) out.push(p)
        }
      }
      walk(path.join(root, 'sessions'), 0)
      walk(path.join(root, 'archived_sessions'), 0)
      return out
    }
    // 解析单个会话文件的**文本** → { days, rl, rlTs }
    // issue #116：读取改由调用方异步完成（先判大小、读完让出事件循环），这里只做纯解析。
    function parseCodexFileText(text) {
      const days = {}
      let model = 'codex'
      let prevTotal = null
      let lastRl = null, rlTs = 0
      if (typeof text !== 'string' || !text) return { days, rl: null, rlTs: 0 }
      const bump = (day, mk, v) => {
        days[day] = days[day] || {}
        const cur = days[day][mk] || { in: 0, cached: 0, cwrite: 0, out: 0, reason: 0, total: 0, turns: 0 }
        cur.in += v.in; cur.cached += v.cached; cur.cwrite += v.cwrite
        cur.out += v.out; cur.reason += v.reason; cur.total += v.total; cur.turns += v.turns
        days[day][mk] = cur
      }
      for (const line of text.split('\n')) {
        if (!line || line.charCodeAt(0) !== 123) continue // 只处理 '{' 开头的行
        let o = null
        try { o = JSON.parse(line) } catch (err) { continue }
        const p = o && o.payload
        if (!p) continue
        if (o.type === 'turn_context') {
          if (p.model) model = String(p.model)
          continue
        }
        if (o.type !== 'event_msg' || p.type !== 'token_count') continue
        const info = p.info
        if (!info || typeof info !== 'object') continue
        const last = info.last_token_usage || null
        const tot = info.total_token_usage || null
        const ts = Date.parse(String(o.timestamp || '')) || 0
        if (!ts) continue
        const day = dayKeyFromTs(ts)
        // 该次增量
        let delta = null
        const totAll = tot ? Number(tot.total_tokens) || 0 : 0
        if (totAll > 0) {
          if (prevTotal === null || totAll < prevTotal) delta = totAll
          else delta = totAll - prevTotal
          prevTotal = totAll
        }
        if (delta === null || delta <= 0) {
          if (!last) continue
          delta = Number(last.total_tokens) || 0
        }
        if (delta <= 0) continue
        // 拆分：按 last_token_usage 的比例缩放到 delta
        const lTotal = last ? Number(last.total_tokens) || 0 : 0
        const k = (lTotal > 0 && last) ? delta / lTotal : 0
        const v = last && k > 0
          ? {
            in: Math.round((Number(last.input_tokens) || 0) * k),
            cached: Math.round((Number(last.cached_input_tokens) || 0) * k),
            cwrite: Math.round((Number(last.cache_write_input_tokens) || 0) * k),
            out: Math.round((Number(last.output_tokens) || 0) * k),
            reason: Math.round((Number(last.reasoning_output_tokens) || 0) * k),
          }
          : { in: 0, cached: 0, cwrite: 0, out: 0, reason: 0 }
        bump(day, model, { in: v.in, cached: v.cached, cwrite: v.cwrite, out: v.out, reason: v.reason, total: delta, turns: 1 })
        // 订阅窗口快照：Codex 在 token_count 事件里带 rate_limits（ChatGPT 订阅 provider 才有值，
        // DeepSeek 这类 API-key provider 是 null）。保留最新的非空快照，供第二期展示。
        const rl = p.rate_limits
        if (rl && typeof rl === 'object' && (rl.primary || rl.secondary || rl.plan_type || rl.credits)) {
          if (ts >= rlTs) { lastRl = rl; rlTs = ts }
        }
      }
      return { days, rl: lastRl, rlTs }
    }
    // rate_limits 字段名在不同 Codex 版本里不一致 → 多候选键容错，换算成「已用% + 重置时间戳」
    function normalizeCodexWindow(w) {
      if (!w || typeof w !== 'object') return null
      const pick = (keys) => {
        for (const k of keys) {
          const raw = w[k]
          if (raw === null || raw === undefined || raw === '') continue
          const n = Number(raw)
          if (isFinite(n)) return n
        }
        return null
      }
      let usedPct = pick(['used_percent', 'usedPercent', 'percent', 'used_pct', 'usage_percent', 'usagePercent'])
      const remainPct = pick(['remaining_percent', 'remainingPercent', 'left_percent', 'remaining_pct'])
      if (usedPct === null && remainPct !== null) usedPct = Math.max(0, 100 - remainPct)
      let resetAt = null
      const secs = pick(['resets_in_seconds', 'resetsInSeconds', 'reset_after_seconds', 'reset_in_seconds', 'seconds_until_reset'])
      if (secs !== null && secs >= 0) resetAt = Date.now() + secs * 1000
      else {
        const abs = w.resets_at || w.reset_at || w.reset_time || w.next_reset || w.resetAt || w.nextResetTime
        if (typeof abs === 'number' && isFinite(abs)) resetAt = abs < 1e12 ? abs * 1000 : abs
        else if (typeof abs === 'string' && abs) { const t = Date.parse(abs); if (isFinite(t)) resetAt = t }
      }
      const windowMinutes = pick(['window_minutes', 'windowMinutes', 'window', 'period_minutes'])
      const label = String(w.limit_name || w.name || w.label || w.window_name || '')
      if (usedPct === null && resetAt === null) return null
      return { usedPct, resetAt, windowMinutes, label }
    }
    function normalizeCodexRateLimits(rl) {
      if (!rl || typeof rl !== 'object') return null
      const primary = normalizeCodexWindow(rl.primary)
      const secondary = normalizeCodexWindow(rl.secondary)
      if (!primary && !secondary) return null
      return {
        primary, secondary,
        planType: rl.plan_type ? String(rl.plan_type) : '',
        limitName: rl.limit_name ? String(rl.limit_name) : (rl.limit_id ? String(rl.limit_id) : ''),
        reached: rl.rate_limit_reached_type ? String(rl.rate_limit_reached_type) : '',
      }
    }
    // 汇总（带增量缓存：只有变化的文件才重新解析）
    // ===== issue #116：Codex 本地统计的护栏 =====
    // 旧实现是「启动 1.5s + 每 5 分钟」在事件循环上做**同步**全量扫描：递归遍历
    // ~/.codex/sessions，对每个过期文件 readFileSync + split('\n') + 逐行 JSON.parse。
    // 会话攒多之后，一轮扫描能冻结事件循环数分钟（整个 dsh web 不响应、满核 CPU），
    // 而且单个超过 V8 字符串上限（约 512MB）的 rollout 会抛 ERR_STRING_TOO_LONG ——
    // 由于是在写缓存之前就抛出，那个文件每轮都会被重读，size/mtime 又一直在变，永久复发。
    // 现在三条护栏：
    //   ① 单文件上限：超过 CODEX_MAX_FILE_BYTES 直接跳过（结果记进缓存，不再重读），
    //      并在汇总里报 skipped / skippedBytes，界面上能看出"有文件被跳过"；
    //   ② 单轮预算：一轮最多读 CODEX_BUDGET_FILES 个 / CODEX_BUDGET_BYTES 字节，超了就
    //      带 deferred 出结果，本轮立刻返回、稍后再刷新 —— 绝不长时间占住事件循环；
    //   ③ 全程异步（fs.promises）＋ 每个文件处理后让出一次事件循环（await setImmediate）。
    const CODEX_MAX_FILE_BYTES = 32 * 1024 * 1024
    const CODEX_BUDGET_FILES = 400
    const CODEX_BUDGET_BYTES = 96 * 1024 * 1024
    const CODEX_SNAP_TTL = 60 * 1000
    const yieldLoop = () => new Promise((r) => setImmediate(r))

    // 汇总（带增量缓存：只有变化的文件才重新解析）。异步、受预算约束。
    async function codexScan() {
      const home = codexHome()
      if (!home) return { ok: false, error: '未找到 Codex 目录（$CODEX_HOME 或 ~/.codex）' }
      const cache = readCodexCache()
      const files = listCodexSessionFiles(home)
      const keep = {}
      let changed = 0, skipped = 0, skippedBytes = 0, deferred = 0, readBytes = 0, parsedCount = 0
      for (const f of files) {
        let st = null
        try { st = await fs.promises.stat(f) } catch (err) { continue }
        const prev = cache.files[f]
        if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.days) {
          keep[f] = prev
          if (prev.skip === 'too-big') { skipped++; skippedBytes += Number(st.size) || 0 }
          continue
        }
        // ① 单文件上限：跳过超大文件（errno 不再产生，也不再每轮重读）
        if (st.size > CODEX_MAX_FILE_BYTES) {
          keep[f] = { size: st.size, mtimeMs: st.mtimeMs, days: {}, rl: null, rlTs: 0, skip: 'too-big' }
          skipped++; skippedBytes += st.size; changed++
          continue
        }
        // ② 单轮预算：本轮读够了就停，剩下的留到下一次刷新
        if (readBytes + st.size > CODEX_BUDGET_BYTES || parsedCount >= CODEX_BUDGET_FILES) { deferred++; continue }
        let text = ''
        try { text = await fs.promises.readFile(f, 'utf8') } catch (err) { text = '' }
        readBytes += st.size
        const parsed = parseCodexFileText(text)
        keep[f] = { size: st.size, mtimeMs: st.mtimeMs, days: parsed.days, rl: parsed.rl || null, rlTs: parsed.rlTs || 0 }
        changed++
        parsedCount++
        await yieldLoop() // ③ 每个文件让出一次，HTTP 请求不会被整轮扫描堵住
      }
      if (changed > 0 || Object.keys(cache.files).length !== Object.keys(keep).length) {
        writeCodexCache({ version: 1, files: keep, builtAt: Date.now() })
      }
      const today = dayKeyFromTs(Date.now())
      const month = today.slice(0, 7)
      const byDay = {}
      const byModel = {}
      let totalTokens = 0, todayTokens = 0, monthTokens = 0, outTokens = 0, reasonTokens = 0, cachedTokens = 0
      let bestRl = null, bestRlTs = -1
      for (const f of Object.keys(keep)) {
        if (keep[f].rl && (keep[f].rlTs || 0) >= bestRlTs) { bestRl = keep[f].rl; bestRlTs = keep[f].rlTs || 0 }
        const days = keep[f].days || {}
        for (const d of Object.keys(days)) {
          const day0 = byDay[d] || (byDay[d] = { tokens: 0, turns: 0, models: {} })
          for (const m of Object.keys(days[d])) {
            const v = days[d][m] || {}
            day0.tokens += Number(v.total) || 0
            day0.turns += Number(v.turns) || 0
            day0.models[m] = (day0.models[m] || 0) + (Number(v.total) || 0)
            const bm = byModel[m] || (byModel[m] = { tokens: 0, out: 0, reason: 0, cached: 0, turns: 0 })
            bm.tokens += Number(v.total) || 0
            bm.out += Number(v.out) || 0
            bm.reason += Number(v.reason) || 0
            bm.cached += Number(v.cached) || 0
            bm.turns += Number(v.turns) || 0
            totalTokens += Number(v.total) || 0
            outTokens += Number(v.out) || 0
            reasonTokens += Number(v.reason) || 0
            cachedTokens += Number(v.cached) || 0
            if (d === today) todayTokens += Number(v.total) || 0
            if (d.slice(0, 7) === month) monthTokens += Number(v.total) || 0
          }
        }
      }
      const days7 = []
      for (let i = 0; i < 7; i++) {
        const d = dayAdd(today, -i)
        days7.push({ date: d, tokens: (byDay[d] && byDay[d].tokens) || 0, turns: (byDay[d] && byDay[d].turns) || 0 })
      }
      return {
        ok: true, home, sessions: files.length, changed,
        // issue #116：把护栏的实际情况报出来，界面/日志能看出"有文件被跳过或本轮没扫完"
        skipped, skippedBytes, deferred, readBytes,
        maxFileBytes: CODEX_MAX_FILE_BYTES,
        todayTokens, monthTokens, totalTokens,
        outTokens, reasonTokens, cachedTokens,
        days7, byModel,
        // 第二期：订阅窗口（5h / 周）。仅当日志里带着带值的 rate_limits（ChatGPT 订阅 provider）时才有内容
        rateLimits: bestRl,
        windows: normalizeCodexRateLimits(bestRl),
        rateLimitsTs: bestRlTs > 0 ? bestRlTs : 0,
      }
    }
    // ===== 汇总快照（issue #116）=====
    // 关键变化：**任何调用方都不会再触发同步扫描**。
    //   · codexSummaryCached()：同步、永不阻塞 —— 直接返回上一次快照；快照过期时
    //     「顺手发起」一次后台刷新（不等待），所以同步调用点（额度计算）也一样安全；
    //   · codexSummaryEnsured(ms)：需要尽量新的地方（探活 / 模型列表）用，等在途扫描，
    //     最多等 ms 毫秒，超时就用当前快照，绝不无限等；
    //   · 同一时刻只允许一次扫描在跑（去重），预算用完时安排一次稍后的补扫。
    let codexSnap = null
    let codexSnapAt = 0
    let codexScanP = null
    let codexCatchupT = null
    // 配置变更（例如用户在设置里关掉 Codex 统计）后必须让快照失效，
    // 否则下一次请求还会命中关闭前的旧快照、开关看起来"没生效"。
    function codexInvalidate() { codexSnap = null; codexSnapAt = 0; codexStatsOnV = null; codexStatsOnAt = 0 }
    // 开关读取加 2 秒缓存：codexBackgroundRefresh 可能被高频调用（快照过期时每次 payload
    // 构建都会试一次），而 readSizeConfig() 是同步文件读 —— 不能放在热路径上。
    // 用户改设置时 codexInvalidate() 会清掉缓存，所以开关仍然是"立刻生效"。
    let codexStatsOnV = null, codexStatsOnAt = 0
    // v748：**没配置 Codex 模型时「本机统计」默认不启用** —— 完全不去读 ~/.codex/sessions
    // （用户没加 Codex 模型时那些日志与他无关，白扫一遍既费磁盘又占事件循环）。
    // 判定按模板 kind === 'codex'（与模型列表里"Codex 用量"那一行的判定同源）。
    function hasCodexModel() {
      try {
        for (const m of readApiRegistry().models) {
          const tpl = apiTemplateOf(m && m.provider)
          if (tpl && tpl.kind === 'codex') return true
        }
      } catch (err) {}
      return false
    }
    function codexStatsOn() {
      const now = Date.now()
      if (codexStatsOnV !== null && now - codexStatsOnAt < 2000) return codexStatsOnV
      let v = true
      try {
        if (!hasCodexModel()) {
          v = false // 没有 Codex 模型 → 默认关闭（不是"用户关掉的"，见下面的提示文案）
        } else {
          const cfg = readSizeConfig()
          v = !cfg || cfg.codexStatsOn !== false
        }
      } catch (err) { v = true }
      codexStatsOnV = v
      codexStatsOnAt = now
      return v
    }
    // 关闭原因的文案：区分「用户自己关的」与「压根没配 Codex 模型（默认关）」
    function codexDisabledReason() {
      try { return hasCodexModel() ? 'Codex 统计已在设置里关闭' : '未添加 Codex 模型，本机统计默认关闭' } catch (err) { return 'Codex 统计已关闭' }
    }
    function codexBackgroundRefresh(delayMs) {
      if (codexScanP) return codexScanP // 已在扫：先返回，避免重复读配置/重复排队
      if (!codexStatsOn()) {
        codexSnap = { ok: false, disabled: true, error: codexDisabledReason() }
        codexSnapAt = Date.now()
        return null
      }
      if (delayMs > 0) {
        if (codexCatchupT) return null
        codexCatchupT = setTimeout(() => { codexCatchupT = null; codexBackgroundRefresh(0) }, delayMs)
        try { if (codexCatchupT.unref) codexCatchupT.unref() } catch (err) {}
        return null
      }
      codexScanP = codexScan()
        .then((s) => {
          codexSnap = s
          codexSnapAt = Date.now()
          // 本轮没扫完（预算用尽）→ 稍后补扫，逐步把统计补齐，而不是一次占满事件循环
          if (s && s.ok && s.deferred > 0) codexBackgroundRefresh(5000)
        })
        .catch((err) => {
          codexSnap = { ok: false, error: String((err && err.message) || err) }
          codexSnapAt = Date.now()
        })
        .finally(() => { codexScanP = null })
      return codexScanP
    }
    function codexSummaryCached() {
      const now = Date.now()
      if (!codexSnap || now - codexSnapAt > CODEX_SNAP_TTL) codexBackgroundRefresh(0)
      return codexSnap
    }
    async function codexSummaryEnsured(maxWaitMs) {
      const stale = !codexSnap || Date.now() - codexSnapAt > CODEX_SNAP_TTL
      const p = codexScanP || (stale ? codexBackgroundRefresh(0) : null)
      if (!p) return codexSnap
      try { await Promise.race([p, new Promise((r) => setTimeout(r, Math.max(200, maxWaitMs || 2500)))]) } catch (err) {}
      return codexSnap
    }
    // 后台预热：启动后预热一次，并每 5 分钟刷新一次缓存（现在都是异步 + 有预算的，不再阻塞）。
    let codexPrewarmT = null, codexPrewarmI = null
    try {
      codexPrewarmT = setTimeout(function () { try { codexBackgroundRefresh(0) } catch (err) {} }, 1500)
      codexPrewarmI = setInterval(function () { try { codexBackgroundRefresh(0) } catch (err) {} }, 5 * 60 * 1000)
      // issue #109：这两个定时器原先不存句柄、也不进 disposers，插件树 dispose 之后
      // 事件循环里仍有一个被引用的 interval → 用户退出 dsh 时进程不结束（只能 Ctrl+C）。
      // 存句柄并纳入 disposers，卸载时一并清掉；unref 作为兜底（正常运行时由 HTTP 服务维持事件循环）。
      try { if (codexPrewarmT && codexPrewarmT.unref) codexPrewarmT.unref() } catch (err) {}
      try { if (codexPrewarmI && codexPrewarmI.unref) codexPrewarmI.unref() } catch (err) {}
      disposers.push(function () {
        if (codexPrewarmT !== null) { clearTimeout(codexPrewarmT); codexPrewarmT = null }
        if (codexPrewarmI !== null) { clearInterval(codexPrewarmI); codexPrewarmI = null }
        if (codexCatchupT !== null) { clearTimeout(codexCatchupT); codexCatchupT = null }
      })
    } catch (err) {}
    // ===== 自定义 API 模型注册表（v655）=====
    // 文件：$DSH_HOME/.dshw-api.json → { version, models:[…], usage:{ [id]:{day,dayStart,lastBalance,delta,eventCost} } }
    // 密钥不落此文件：写入 DSH 官方凭据（ctx.credentials.set），读取走 credentials.resolve(keyRef)。
    function defaultApiRegistry() { return { version: 1, models: [], usage: {} } }
    function readApiRegistry() {
      for (const p of API_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && Array.isArray(parsed.models)) {
            if (!parsed.usage || typeof parsed.usage !== 'object') parsed.usage = {}
            return parsed
          }
        } catch (err) {}
      }
      return defaultApiRegistry()
    }
    function writeApiRegistry(reg) {
      const body = JSON.stringify(reg, null, 2)
      for (const p of API_FILE_CANDIDATES) {
        try { fs.writeFileSync(p, body, 'utf8'); return true } catch (err) {}
      }
      return false
    }
    function apiTemplateOf(provider) {
      return API_TEMPLATES[String(provider || '')] || null
    }
    // 内置 DeepSeek 永远存在（不进注册表文件），其余来自注册表
    function apiBuiltinModel() {
      const t = API_TEMPLATES.deepseek
      return { id: API_BUILTIN_ID, name: t.name, provider: 'deepseek', currency: t.currency, keyRef: t.keyRef, builtin: true, matchIds: ['deepseek'] }
    }
    function apiAllModels() {
      const custom = readApiRegistry().models.filter((m) => m && m.id && m.id !== API_BUILTIN_ID)
      return [apiBuiltinModel()].concat(custom)
    }
    function apiModelById(id) {
      if (String(id || '') === API_BUILTIN_ID) return apiBuiltinModel()
      return readApiRegistry().models.find((m) => m && m.id === id) || null
    }
    // JSON 取值：支持 a.b[0].c
    function pickJsonPath(obj, pathStr) {
      try {
        const parts = String(pathStr || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x.length > 0)
        let cur = obj
        for (const p of parts) {
          if (cur === null || cur === undefined) return undefined
          cur = cur[p]
        }
        return cur
      } catch (err) { return undefined }
    }
    function apiNum(v, scale) {
      const n = Number(v)
      if (!isFinite(n)) return null
      const s = isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1
      return n * s
    }
    // v724 非空合并：over 里的空串 / undefined / null **不覆盖** base。
    // 为什么需要：新建模型时表单里没填的字段会存成空串，若直接 Object.assign，
    // 空串会把模板自带的接口地址 / 字段路径"盖掉"，余额就永远查不到（会报「未配置余额接口地址」）。
    function mergeNonEmpty(base, over) {
      const out = Object.assign({}, base || {})
      const o = over && typeof over === 'object' ? over : {}
      for (const k of Object.keys(o)) {
        const v = o[k]
        if (v === undefined || v === null || v === '') continue
        if (v && typeof v === 'object' && !Array.isArray(v)) { out[k] = mergeNonEmpty(out[k], v); continue }
        out[k] = v
      }
      return out
    }
    // v724 递归去空：写注册表时用。让"没填的字段"根本不存在 → 模板默认值继续生效（配合 mergeNonEmpty）
    function stripEmptyDeep(o) {
      if (Array.isArray(o)) return o
      if (!o || typeof o !== 'object') return o
      const out = {}
      for (const k of Object.keys(o)) {
        const v = stripEmptyDeep(o[k])
        if (v === undefined || v === null || v === '') continue
        if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue
        out[k] = v
      }
      return out
    }
    // PR #104（收窄版）：只放行 http/https，并挡掉云厂商元数据与 link-local 地址。
    // 关键取舍：**不拦回环与内网** —— 我们内置的 ollama 模板就推荐用户填
    // http://127.0.0.1:11434/v1（本地 Ollama / LM Studio），自建网关（New API 之类，
    // 见 issue #53）也跑在本机；拦掉它们会把正当用法一起打死。接口地址由用户自己在面板/
    // 注册表里填写，且所有 /dsh-whale/* 路由都在受信任栅栏之后 —— 真正要挡的是
    // 「被诱导去读云元数据把凭据带出来」，而不是「访问本机服务」。
    // decimal / octal / hex 形式的 IPv4 已由 WHATWG URL 规范化成点分十进制，这里只按规范化结果判定。
    function assertSafeApiUrl(u) {
      let parsed
      try { parsed = new URL(u) } catch { throw new Error('无效的接口地址') }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('不支持的协议: ' + parsed.protocol)
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
      if (host === 'metadata.google.internal' || host === 'metadata.goog' || host === '100.100.100.200') throw new Error('禁止访问云元数据地址')
      const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
      if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])]
        if (a === 169 && b === 254) throw new Error('禁止访问 link-local 地址')
        if (a === 0) throw new Error('禁止访问该地址')
      }
      if (/^fe[89ab][0-9a-f]:/i.test(host)) throw new Error('禁止访问 link-local 地址')
      // v761（安全修复 S1）：URL 里不允许带 userinfo（`https://user:pass@host/`）——
      // 它是把凭据塞进 URL 的另一种写法，也会让日志/报错里出现凭据
      if (parsed.username || parsed.password) throw new Error('接口地址不允许携带用户名/密码')
    }
    // —— v761（安全修复 S1）：**凭据目的地白名单** ——
    // 规则：只有当目标 origin **恰好等于该厂商内置模板里写死的端点**时，才允许携带凭据；
    // 其它地址（用户自定义 URL、以及由 `{base}` 展开出来的地址）都必须带 `model.allowCustomHost === true`
    // 才放行 —— 而该标志**只能由本机（回环）来源的写请求设置**（见 writeRejection），
    // 因此远端会话即使改了配置，也拿不到凭据。
    // 注意：**含 `{base}` 的模板 URL 不算可信**（base 是用户可填字段），一律按自定义地址处理。
    function originOfUrl(u) {
      try {
        const p = new URL(String(u))
        if (p.protocol !== 'http:' && p.protocol !== 'https:') return ''
        return p.origin.toLowerCase()
      } catch (err) { return '' }
    }
    function templateOrigins(tpl) {
      const out = new Set()
      const add = (u) => {
        const s = String(u == null ? '' : u)
        if (!s || s.indexOf('{base}') >= 0) return
        const o = originOfUrl(s.replace('{key}', 'placeholder'))
        if (o) out.add(o)
      }
      add(tpl && tpl.probeUrl)
      add(tpl && tpl.balance && tpl.balance.url)
      add(tpl && tpl.balance && tpl.balance.usage && tpl.balance.usage.url)
      add(tpl && tpl.quota && tpl.quota.url)
      return out
    }
    function credentialMayGoTo(model, tpl, url) {
      const o = originOfUrl(url)
      if (!o) return false
      if (templateOrigins(tpl).has(o)) return true
      return !!(model && model.allowCustomHost === true)
    }
    function warnCredDestinationOnce(url) {
      try {
        const o = originOfUrl(url) || '(无效地址)'
        if (!warnCredDestinationOnce.seen) warnCredDestinationOnce.seen = new Set()
        if (warnCredDestinationOnce.seen.has(o)) return
        warnCredDestinationOnce.seen.add(o)
        console.warn('[whale-balance] 已拒绝把凭据发送到非内置端点：' + o
          + '（若这是你自建/自托管的网关，请在**本机**打开插件面板，对该模型勾选「允许把凭据发送到自定义地址」）')
      } catch (err) {}
    }
    // 解析凭据 + 目的地校验：所有"带凭据发请求"的地方都必须走这里
    async function keyForDestination(model, tpl, url) {
      let key = ''
      try {
        const cred = await ctx.credentials.resolve(model.keyRef || tpl.keyRef || '')
        key = cred && cred.value ? String(cred.value) : ''
      } catch (err) { key = '' }
      if (!key) return { key: '', code: 'NO_KEY', error: '未配置 ' + (model.keyRef || tpl.keyRef || 'API key') }
      if (!credentialMayGoTo(model, tpl, url)) {
        warnCredDestinationOnce(url)
        return {
          key: '', code: 'DEST_NOT_ALLOWED',
          error: '该地址不是 ' + String((tpl && tpl.name) || model.provider || '该厂商') + ' 的内置端点，'
            + '已拒绝把凭据发出去。若这是你自建/自托管的网关，请**在本机**打开插件面板，'
            + '对该模型勾选「允许把凭据发送到自定义地址」后重试。',
        }
      }
      return { key, code: '', error: '' }
    }
    // v789（issue #190）：余额/额度接口不再局限于 GET —— 模板或模型条目可声明 method / body。
    //   ① method 默认 GET；非 GET 时带 `Content-Type: application/json` 并把 body 发出去；
    //   ② body 支持占位符：`{key}`（凭据）、`{base}`（Base URL）、以及 `model.params` 里的任意键（如 `{uuid}`）
    //      —— 这样"POST /v1/enterprise/account {"uuid":"…"}" 这类自建网关不需要再额外挂一层转换服务；
    //   ③ 安全边界不变：body 只来自配置（不接受请求方传入），目的地仍走 credentialMayGoTo() 白名单，
    //      URL 仍过 assertSafeApiUrl()。
    function bodyWithPlaceholders(body, key, base, params) {
      let s = String(body == null ? '' : body)
      s = s.split('{key}').join(String(key == null ? '' : key))
      s = s.split('{base}').join(String(base == null ? '' : base))
      if (params && typeof params === 'object') {
        for (const k of Object.keys(params)) {
          const v = params[k]
          if (v === undefined || v === null || typeof v === 'object') continue
          s = s.split('{' + k + '}').join(String(v))
        }
      }
      return s
    }
    function httpMethodOf(cfg) {
      const m = String((cfg && cfg.method) || 'GET').trim().toUpperCase()
      return /^[A-Z]{3,7}$/.test(m) ? m : 'GET'
    }
    async function apiFetchJson(url, auth, key, opts) {
      const o = opts || {}
      const headers = {}
      const a = String(auth == null ? 'Bearer {key}' : auth)
      if (a) headers.Authorization = a.replace('{key}', key)
      // v724：URL 里也支持 {key}（如 Gemini 的 ?key=… 形式；auth 传空串时不带 Authorization 头）
      const u = String(url).replace('{key}', key)
      assertSafeApiUrl(u)
      const init = { headers, signal: AbortSignal.timeout(15000) }
      const method = httpMethodOf(o)
      if (method !== 'GET') {
        init.method = method
        const raw = o.body
        if (raw !== undefined && raw !== null && String(raw).length) {
          headers['Content-Type'] = 'application/json'
          init.body = bodyWithPlaceholders(raw, key, o.base, o.params)
        }
      }
      const res = await fetch(u, init)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    }
    // 测试连通性：优先模板的 probeUrl（如方舟 /api/v3/models），否则用余额接口/Base URL
    // 从响应体里提炼「业务层错误」：有些接口（如智谱额度）key 不对也返回 HTTP 200，
    // 真正的问题在 body 的 code/msg（例如「当前用户不存在coding plan」），必须报出来
    function apiBusinessError(data) {
      if (!data || typeof data !== 'object') return ''
      if (data.success === false || data.ok === false) {
        return String(data.msg || data.message || data.error || 'success=false').slice(0, 120)
      }
      const code = Number(data.code)
      if (isFinite(code) && code !== 0 && code !== 200 && data.msg) return String(data.msg).slice(0, 120)
      if (typeof data.error === 'string' && data.error) return data.error.slice(0, 120)
      if (data.error && typeof data.error === 'object' && data.error.message) return String(data.error.message).slice(0, 120)
      return ''
    }
    async function apiProbeModel(model) {
      if (!model) return { ok: false, error: '模型不存在' }
      const tpl = apiTemplateOf(model.provider) || {}
      if (model.id === API_BUILTIN_ID) {
        const r = await fetchBalance()
        return r.ok ? { ok: true, detail: '余额 ' + r.totalBalance + ' ' + (r.currency || 'CNY') } : { ok: false, error: r.error || r.code }
      }
      // Codex 模式：本地会话统计即「探活结果」，不需要网络与密钥
      if (tpl.kind === 'codex') {
        const cs = await codexSummaryEnsured(2500)
        const f = (n) => (n >= 100000000 ? (n / 100000000).toFixed(2) + '亿' : (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(Math.round(Number(n) || 0))))
        if (cs && cs.ok) {
          return { ok: true, detail: 'Codex 本地会话：今日 ' + f(cs.todayTokens) + ' · 本月 ' + f(cs.monthTokens) + ' · 累计 ' + f(cs.totalTokens) + ' tokens（' + cs.sessions + ' 个会话文件）' }
        }
        return { ok: false, error: (cs && cs.error) || '未找到 Codex 会话目录' }
      }
      const b = mergeNonEmpty(tpl.balance, model.balance) // v724：模型侧空串不再覆盖模板
      const base = String(model.baseUrl || '').replace(/\/+$/, '')
      // v789（issue #190）：声明了 POST 等非 GET 方法时，测试就直接打**用户配置的余额接口**（带同一个 body）——
      // 否则会拿 GET 去打一个只支持 POST 的地址、误报"测试失败"（probeUrl 多是 models 列表，body 不通用）。
      const nonGet = httpMethodOf(b) !== 'GET'
      const url = String(nonGet ? (b.url || tpl.probeUrl || '') : (tpl.probeUrl || b.url || (base ? base + '/v1/models' : ''))).replace('{base}', base)
      if (!url) return { ok: false, error: '没有可测试的接口（请填余额接口或 Base URL）' }
      // v761（安全修复 S1）：只在目的地可信时才带上凭据
      const k = await keyForDestination(model, tpl, url)
      if (!k.key) return { ok: false, code: k.code, error: k.error }
      const key = k.key
      try {
        const data = await apiFetchJson(url, b.auth, key, { method: b.method, body: b.body, base: base, params: model.params })
        const bizErr = apiBusinessError(data)
        if (bizErr) return { ok: false, error: '测试失败: ' + bizErr }
        let detail = 'HTTP 200'
        if (data && Array.isArray(data.data)) detail = '可用模型 ' + data.data.length + ' 个'
        else if (data && data.data && Array.isArray(data.data.models)) detail = '可用模型 ' + data.data.models.length + ' 个'
        return { ok: true, detail: detail }
      } catch (err) {
        return { ok: false, error: '测试失败: ' + String((err && err.message) || err).slice(0, 140) }
      }
    }
    // v789（issue #180/#181）：额度接口里"多窗口 + 数组顺序不保证"的通用取数。
    //   智谱 `GET /api/monitor/usage/quota/limit` 返回的 `data.limits[]` 是**扁平条目数组**：
    //   `TOKENS_LIMIT` 是每条的 `type` 字段值（不是 `limits[0]` 的子对象），5h 窗口不保证排在 `[0]`
    //   （实测：pro 账号 `limits[0]` 是 TIME_LIMIT，max 账号 `limits[0]` 是 TOKENS_LIMIT ⇒ 按位置取数必然出错过），
    //   而且新注册/credit 制账号把 `type` 改成了 `CREDIT_LIMIT`。
    //   所以模板可以声明 `pick: { list, type/types, unit, number }`：先选中**那一条**，再把它的字段当作取数根。
    function pickQuotaEntry(data, pick) {
      try {
        if (!pick || !pick.list) return null
        const arr = pickJsonPath(data, pick.list)
        if (!Array.isArray(arr)) return null
        const types = []
        if (pick.type) types.push(String(pick.type))
        if (Array.isArray(pick.types)) for (const t of pick.types) types.push(String(t))
        const unit = (pick.unit === undefined || pick.unit === null) ? null : Number(pick.unit)
        const number = (pick.number === undefined || pick.number === null) ? null : Number(pick.number)
        for (const it of arr) {
          if (!it || typeof it !== 'object') continue
          if (types.length && types.indexOf(String(it.type)) < 0) continue
          if (unit !== null && Number(it.unit) !== unit) continue
          if (number !== null && Number(it.number) !== number) continue
          return it
        }
        return null
      } catch (err) { return null }
    }
    // 订阅额度（Coding Plan）解析：各厂商字段不同，统一归一成「已用% + 重置时间 + 档位」
    //   zhipu:    data.limits[] 里 type=TOKENS_LIMIT/CREDIT_LIMIT + unit=3(5h)/6(周) 的条目（v789 起按 pick 选）
    //   kimi:     usage.remaining / usage.limit（剩余/总量）
    //   minimax:  model_remains[0].current_interval_remaining_percent（剩余%）+ end_time(ms)
    async function fetchModelQuota(model) {
      if (!model) return { ok: false, error: '模型不存在' }
      const tpl = apiTemplateOf(model.provider) || {}
      // v789（issue #180 建议 3）：模型条目也能覆盖额度配置 —— 厂商接口变动时用户可自救（不留空即覆盖）
      const q = mergeNonEmpty(tpl.quota, model.quota)
      if (!q || !q.url) return { ok: false, code: 'NO_QUOTA', error: '该厂商没有订阅额度接口' }
      const base = String(model.baseUrl || '').replace(/\/+$/, '')
      const url = String(q.url).replace('{base}', base)
      // v761（安全修复 S1）：额度 URL 虽来自模板，但 `{base}` 会被用户字段改写，同样要校验目的地
      const k = await keyForDestination(model, tpl, url)
      if (!k.key) return { ok: false, code: k.code, error: k.error }
      const key = k.key
      try {
        const data = await apiFetchJson(url, q.auth, key, { method: q.method, body: q.body, base: base, params: model.params })
        const bizErr = apiBusinessError(data)
        if (bizErr) return { ok: false, code: 'BIZ', error: bizErr }
        const j = q.json || {}
        const num = (v) => { const n = Number(v); return isFinite(n) ? n : null }
        // v789：若模板声明了顶层 pick（单窗口 + 数组筛选），先把取数根换成选中的那条
        const jroot = j.pick ? (pickQuotaEntry(data, j.pick) || {}) : data
        let usedPct = null, remainPct = null, resetAt = null, level = '', weeklyUsedPct = null
        if (j.percent) { const p = num(pickJsonPath(jroot, j.percent)); if (p !== null) usedPct = p }
        if (j.remainPct) {
          const p = num(pickJsonPath(jroot, j.remainPct))
          if (p !== null) { remainPct = p; if (usedPct === null) usedPct = Math.max(0, 100 - p) }
        }
        if (j.weeklyRemainPct) {
          const p = num(pickJsonPath(jroot, j.weeklyRemainPct))
          if (p !== null) weeklyUsedPct = Math.max(0, 100 - p)
        }
        if (j.remain && j.total) {
          const r0 = num(pickJsonPath(jroot, j.remain))
          const t0 = num(pickJsonPath(jroot, j.total))
          if (r0 !== null && t0) {
            remainPct = Math.max(0, Math.min(100, r0 / t0 * 100))
            usedPct = Math.max(0, 100 - remainPct)
          }
        }
        if (j.resetAt) resetAt = pickJsonPath(jroot, j.resetAt)
        if (j.resetAtMs) { const ms = num(pickJsonPath(jroot, j.resetAtMs)); if (ms !== null) resetAt = ms }
        if (j.level) level = String(pickJsonPath(data, j.level) || '')
        // v0.3.1：多窗口额度 —— 有些订阅额度接口一次返回多个窗口（如 OpenCode Go 的
        // rolling / weekly / monthly），每个窗口各有「已用% + 重置时间」。模板用
        // json.windows: [{ key, label, percent, resetAt }] 描述；这里归一成 windows 数组，
        // 并把第一个窗口回填成主窗口 usedPct / resetAt，保持原有单窗口链路的兼容。
        let windows = null
        if (Array.isArray(j.windows)) {
          const list = []
          for (const w of j.windows) {
            if (!w) continue
            // v789：每个窗口可以各自 pick 一条（智谱 5h=unit3 / 周=unit6），选中后以该条为取数根
            const wroot = w.pick ? (pickQuotaEntry(data, w.pick) || {}) : data
            let wp = w.percent ? num(pickJsonPath(wroot, w.percent)) : null
            if (wp !== null) wp = Math.max(0, Math.min(100, wp))
            let wr = null
            if (w.resetAt) {
              const rv = pickJsonPath(wroot, w.resetAt)
              if (rv !== undefined && rv !== null && rv !== '') wr = rv
            }
            if (wp === null && wr === null) continue
            list.push({ key: String(w.key || ''), label: String(w.label || ''), usedPct: wp, resetAt: wr })
          }
          if (list.length) windows = list
        }
        if (windows) {
          const w0 = windows[0]
          if (usedPct === null && w0.usedPct !== null) usedPct = w0.usedPct
          if (!resetAt && w0.resetAt !== null) resetAt = w0.resetAt
          if (weeklyUsedPct === null) {
            for (const w of windows) {
              if ((w.key === 'weekly' || w.label === '周') && w.usedPct !== null) { weeklyUsedPct = w.usedPct; break }
            }
          }
        }
        if (usedPct === null && remainPct === null && !resetAt && !windows) {
          return { ok: false, code: 'PARSE', error: '额度接口返回无法解析（字段路径不匹配）' }
        }
        return { ok: true, usedPct, remainPct, resetAt, level, weeklyUsedPct, windows }
      } catch (err) {
        return { ok: false, code: 'HTTP', error: '额度接口请求失败: ' + String((err && err.message) || err).slice(0, 140) }
      }
    }
    // 厂商回报「账号没有该订阅套餐」（如智谱的「当前用户不存在coding plan」）：
    // 对没订阅的用户这行没意义，标记 hide 让前端不显示（真正的网络/密钥错误不隐藏）
    function apiPlanNoPlan(msg) {
      const s = String(msg || '').toLowerCase()
      if (!s) return false
      return s.indexOf('coding plan') >= 0 || s.indexOf('不存在') >= 0 || s.indexOf('未订阅') >= 0 ||
        s.indexOf('not subscribed') >= 0 || s.indexOf('no plan') >= 0 || s.indexOf('no active') >= 0 ||
        s.indexOf('subscription') >= 0
    }
    // 取某模型余额：DeepSeek 复用既有官方链路；其余按模板/自定义描述请求并解析
    async function fetchModelBalance(model) {
      if (!model) return { ok: false, code: 'NO_MODEL', error: '模型不存在' }
      if (model.id === API_BUILTIN_ID) {
        const r = await fetchBalance()
        if (!r.ok) return r
        return { ok: true, remaining: Number(r.totalBalance), currency: r.currency || 'CNY' }
      }
      const tpl = apiTemplateOf(model.provider) || {}
      const b = mergeNonEmpty(tpl.balance, model.balance) // v724：模型侧空串不再覆盖模板
      if (!b.url) return { ok: false, code: 'NO_URL', error: '未配置余额接口地址' }
      const base = String(model.baseUrl || '').replace(/\/+$/, '')
      const url = String(b.url).replace('{base}', base)
      // v761（安全修复 S1）：凭据只在目的地可信（厂商内置端点 / 本机确认过的自定义地址）时才带上
      const k = await keyForDestination(model, tpl, url)
      if (!k.key) return { ok: false, code: k.code, error: k.error }
      const key = k.key
      try {
        // v789（issue #190）：把 method / body / params 一并交给取数层（默认 GET，与以前完全一致）
        const data = await apiFetchJson(url, b.auth, key, { method: b.method, body: b.body, base: base, params: model.params })
        const j = b.json || {}
        let remaining = null
        let total = null
        let used = 0
        if (j.remaining) { const v = apiNum(pickJsonPath(data, j.remaining), j.scale); if (v !== null) remaining = v }
        if (j.total) { const v = apiNum(pickJsonPath(data, j.total), j.scale); if (v !== null) total = v }
        if (j.used) { const v = apiNum(pickJsonPath(data, j.used), j.scale); if (v !== null) used += v }
        if (b.usage && b.usage.url) {
          const u = b.usage
          // v761（安全修复 S1）：usage 是可选增强 —— 目的地不可信就跳过，绝不把凭据发出去
          const usageUrl = String(u.url).replace('{base}', base)
          if (credentialMayGoTo(model, tpl, usageUrl)) {
          const d2 = await apiFetchJson(usageUrl, u.auth || b.auth, key)
          const j2 = u.json || {}
          if (j2.used) { const v = apiNum(pickJsonPath(d2, j2.used), j2.scale); if (v !== null) used += v }
          } else { warnCredDestinationOnce(usageUrl) }
        }
        if (remaining === null && total !== null) remaining = total - used
        if (remaining === null) return { ok: false, code: 'SHAPE', error: '接口返回里没找到配置的字段（检查 JSON 路径）' }
        return { ok: true, remaining, total, used, currency: model.currency || tpl.currency || 'CNY' }
      } catch (err) {
        return { ok: false, code: 'HTTP', error: '余额接口请求失败: ' + String((err && err.message) || err).slice(0, 160) }
      }
    }
    // 逐模型记录的骨架：跨天只重置「当日」字段，累计量（tokensTotal/tokensMonth）保留
    function apiUsageNewDay(cur, day, dayKey) {
      const prev = cur && typeof cur === 'object' ? cur : {}
      const mk = String(dayKey || '').slice(0, 7)
      return {
        day: day, dayStart: null, lastBalance: null, delta: 0, eventCost: 0, eventTokens: 0, currency: '',
        tokensTotal: Number(prev.tokensTotal) || 0,
        month: mk,
        tokensMonth: prev.month === mk ? (Number(prev.tokensMonth) || 0) : 0,
      }
    }
    // 逐模型余额差记账（与 DeepSeek 账本同口径：当天首次观测为基准，之后累加下降额）
    function apiRecordBalance(id, remaining) {
      try {
        const reg = readApiRegistry()
        reg.usage = reg.usage && typeof reg.usage === 'object' ? reg.usage : {}
        const day = todayKey()
        let cur = reg.usage[id]
        if (!cur || cur.day !== day) cur = apiUsageNewDay(cur, day, todayKey())
        if (typeof remaining === 'number' && isFinite(remaining)) {
          if (cur.dayStart === null || cur.dayStart === undefined) cur.dayStart = remaining
          if (typeof cur.lastBalance === 'number' && remaining < cur.lastBalance) cur.delta = addMoney(cur.delta, cur.lastBalance - remaining)
          cur.lastBalance = remaining
        }
        reg.usage[id] = cur
        writeApiRegistry(reg)
        return cur
      } catch (err) { return null }
    }
    // 今日已用：来源可能是「余额差」（厂商币种）或「会话事件金额」（已按自定义单价折算成人民币）。
    // 两种来源币种不同 → 返回值必须带上 currency，前端显示与阈值比较都按它走，
    // 否则 USD 单价的模型会把人民币数额渲染成 $、或拿两种单位直接比大小。
    function apiTodayUsage(id, modelCurrency) {
      const mcur = String(modelCurrency || 'CNY').toUpperCase() || 'CNY'
      try {
        const reg = readApiRegistry()
        const cur = reg.usage && reg.usage[id]
        if (!cur || cur.day !== todayKey()) return { amount: 0, source: 'none', currency: mcur }
        if (typeof cur.lastBalance === 'number' && isFinite(cur.lastBalance)) return { amount: preciseMoney(cur.delta || 0), source: 'balance', currency: mcur }
        return { amount: preciseMoney(Number(cur.eventCost) || 0), source: 'events', currency: 'CNY' }
      } catch (err) { return { amount: 0, source: 'none', currency: mcur } }
    }
    function apiUsageRaw(id) {
      try {
        const reg = readApiRegistry()
        return (reg.usage && reg.usage[id]) || null
      } catch (err) { return null }
    }
    // 额度「已用」：自动模式用会话 token 统计（不重置=累计-基准，每日=今日，每月=本月）
    function apiQuotaAutoUsed(id, q) {
      const u = apiUsageRaw(id) || {}
      const reset = (q && q.reset) || 'none'
      // 单位是「金额（元）」时自动统计意义不成立：自动累计的是 token，不是钱。
      // 这里直接回退成手动值（q.used），避免把 token 数当金额显示；界面上也约束为只能手动填写。
      if (q && q.unit === 'money' && (q.mode === 'auto' || q.mode === 'codex')) {
        return Math.round(Number(q.used) || 0)
      }
      // Codex 模式：已用 = Codex 本地会话统计的 token（按重置口径取今日/本月/累计）
      if (q && q.mode === 'codex') {
        const cs = codexSummaryCached()
        const base = Number(q.used) || 0
        if (!cs || !cs.ok) return base
        if (reset === 'daily') return Math.round(Number(cs.todayTokens) || 0)
        if (reset === 'monthly') return Math.round(Number(cs.monthTokens) || 0)
        const baseAt = Number(q.baseAt) || 0
        return Math.round(base + Math.max(0, (Number(cs.totalTokens) || 0) - baseAt))
      }
      if (reset === 'daily') return Math.round(Number(u.eventTokens) || 0)
      if (reset === 'monthly') return Math.round(Number(u.tokensMonth) || 0)
      const total = Number(u.tokensTotal) || 0
      const baseAt = Number(q && q.baseAt) || 0
      // used 在自动模式下表示「起始已用」（装机前已经用掉的部分）
      return Math.round((Number(q && q.used) || 0) + Math.max(0, total - baseAt))
    }
    // 会话事件归属：把某模型的 token 花费累加到注册表里匹配的模型（matchIds 子串匹配）
    function apiAttributeEvent(modelName, cost, tokens) {
      try {
        const name = String(modelName || '').toLowerCase()
        if (!name) return false
        const reg = readApiRegistry()
        let hit = null
        for (const m of reg.models) {
          if (!m || !m.id) continue
          const ids = Array.isArray(m.matchIds) && m.matchIds.length ? m.matchIds : [m.name, m.id]
          for (const s of ids) {
            const k = String(s || '').toLowerCase().trim()
            if (k && name.indexOf(k) >= 0) { hit = m; break }
          }
          if (hit) break
        }
        if (!hit) return false
        reg.usage = reg.usage && typeof reg.usage === 'object' ? reg.usage : {}
        const day = todayKey()
        let cur = reg.usage[hit.id]
        if (!cur || cur.day !== day) cur = apiUsageNewDay(cur, day, todayKey())
        cur.eventCost = addMoney(Number(cur.eventCost) || 0, Number(cost) || 0)
        cur.eventTokens = (Number(cur.eventTokens) || 0) + (Number(tokens) || 0)
        // 累计量：额度（资源包/订阅）按它算已用；跨天不清零
        const tk = Number(tokens) || 0
        cur.tokensTotal = (Number(cur.tokensTotal) || 0) + tk
        const mk = todayKey().slice(0, 7)
        if (cur.month !== mk) { cur.month = mk; cur.tokensMonth = 0 }
        cur.tokensMonth = (Number(cur.tokensMonth) || 0) + tk
        reg.usage[hit.id] = cur
        writeApiRegistry(reg)
        return true
      } catch (err) { return false }
    }
    // 删除模型：注册表 + 逐模型设置 + 所有泡泡里引用该模型的模块（含并列 A/B 与模块库）
    function apiDeleteModel(id) {
      const mid = String(id || '')
      if (!mid || mid === API_BUILTIN_ID) return { ok: false, error: '内置模型不可删除' }
      const reg = readApiRegistry()
      reg.models = reg.models.filter((m) => !(m && m.id === mid))
      if (reg.usage) delete reg.usage[mid]
      writeApiRegistry(reg)
      // 删除模型后同样失效单价缓存（它可能带着自定义单价）
      customPriceAt = 0
      let removed = 0
      try {
        const led = readUsageLedger()
        if (led.settings && led.settings.models && led.settings.models[mid]) {
          delete led.settings.models[mid]
          writeUsageLedger(led)
        }
      } catch (err) {}
      try {
        const cfg = loadBubbleConfig()
        let changed = false
        const stripItem = (obj) => {
          if (!obj || typeof obj !== 'object') return
          if (Array.isArray(obj.modules)) {
            const before = obj.modules.length
            obj.modules = obj.modules.filter((m) => !(m && m.modelId === mid))
            removed += before - obj.modules.length
            if (obj.modules.length !== before) changed = true
          }
          if (Array.isArray(obj.options)) {
            for (const o of obj.options) if (o && o.item) stripItem(o.item)
          }
        }
        // 泡泡步骤（含并列 A/B）
        if (Array.isArray(cfg.items)) for (const it of cfg.items) stripItem(it)
        // 模块库条目形态为 {id,name,module}
        if (Array.isArray(cfg.lib)) {
          for (let i = cfg.lib.length - 1; i >= 0; i--) {
            const lb = cfg.lib[i]
            if (lb && lb.module && lb.module.modelId === mid) { cfg.lib.splice(i, 1); changed = true; removed++; continue }
            if (lb && lb.module) stripItem(lb.module)
          }
        }
        if (changed) writeBubbleConfig(cfg)
      } catch (err) {}
      // v748：删掉的可能是最后一个 Codex 模型 → 立即重算「本机统计」是否启用（含清掉 2s 开关缓存）
      try { codexInvalidate() } catch (err) {}
      return { ok: true, removedModules: removed }
    }
    // 新增/更新模型；密钥（keyValue）若提供则写入 DSH 官方凭据
    // 自定义单价表刷新：把每个自定义 API 模型的 matchIds → 价格表映射进来，供 module 级 priceFor 使用
    // （priceFor 在模块作用域，读不到插件内的注册表，所以这里把结果写进 CUSTOM_PRICES）
    let customPriceAt = 0
    function refreshCustomPrices() {
      const now = Date.now()
      if (now - customPriceAt < 10000) return
      customPriceAt = now
      try {
        const map = {}
        const metaMap = {}
        for (const m of readApiRegistry().models) {
          // 内置模型（DeepSeek）跳过：它有自己的峰谷价表，不能被自定义单价覆盖
          if (!m || m.id === API_BUILTIN_ID) continue
          const pr = m && m.price
          if (!pr) continue
          const hit = Number(pr.hit), miss = Number(pr.miss), out = Number(pr.out)
          const ok = (v) => (isFinite(v) ? v : 0)
          if (!isFinite(hit) && !isFinite(miss) && !isFinite(out)) continue
          const table = { hit: [ok(hit), ok(hit)], miss: [ok(miss), ok(miss)], out: [ok(out), ok(out)] }
          const meta = { cur: String(pr.cur || 'CNY').toUpperCase(), rate: isFinite(Number(pr.rate)) ? Number(pr.rate) : 0 }
          const ids = Array.isArray(m.matchIds) && m.matchIds.length ? m.matchIds : [m.name, m.id]
          for (const s of ids) {
            const k = String(s || '').toLowerCase().trim()
            // 关键字过短（< 3 字符，如 pro/flash）极易误伤其它模型，直接忽略
            if (k && k.length >= 3) { map[k] = table; metaMap[k] = meta }
          }
        }
        CUSTOM_PRICES = map
        CUSTOM_PRICE_META = metaMap
      } catch (err) {}
    }
    async function apiSaveModel(input) {
      const p = input || {}
      const tpl = apiTemplateOf(p.provider)
      if (!tpl) return { ok: false, error: '未知的厂商模板' }
      const name = String(p.name || '').trim().slice(0, 30) || tpl.name
      const keyRef = String(p.keyRef || tpl.keyRef || '').trim().slice(0, 64) || tpl.keyRef
      // v761（安全修复 S1）：凭据名加白名单 —— 原实现接受任意字符串，理论上能写到别的键名上
      if (!/^[A-Za-z0-9_]{1,64}$/.test(keyRef)) return { ok: false, error: '凭据名只能包含字母、数字与下划线（≤64 字符）' }
      const id = p.id ? String(p.id) : ('api_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7))
      const reg = readApiRegistry()
      let model = reg.models.find((m) => m && m.id === id)
      if (!model) {
        model = { id, createdAt: Date.now() }
        reg.models.push(model)
      }
      model.name = name
      model.provider = p.provider
      model.currency = String(p.currency || tpl.currency || 'CNY').toUpperCase().slice(0, 8)
      model.keyRef = keyRef
      // v761（安全修复 S1）：**允许把凭据发往自定义地址**（自建/自托管网关需要）。
      // 该标志是"凭据目的地白名单"的唯一例外，而所有写请求都被限制为**本机来源**（见 writeRejection），
      // 所以远端会话即使能改配置，也无法给自己开这个口子。缺省不动（前端局部更新不会误抹）。
      if (p.allowCustomHost === true) model.allowCustomHost = true
      else if (p.allowCustomHost === false) delete model.allowCustomHost
      if (p.baseUrl !== undefined) model.baseUrl = String(p.baseUrl || '').slice(0, 300)
      // v789（issue #190）：请求体里可用的 `{占位符}`（如 {uuid}）—— 只允许标量，键名受限
      if (p.params && typeof p.params === 'object') {
        const pr = {}
        for (const k of Object.keys(p.params)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(k)) continue
          const v = p.params[k]
          if (v === undefined || v === null || typeof v === 'object') continue
          pr[k] = String(v).slice(0, 300)
        }
        if (Object.keys(pr).length) model.params = pr
        else delete model.params
      }
      if (p.quota && typeof p.quota === 'object' && p.quota.json && typeof p.quota.json === 'object') {
        // v789（issue #180 建议 3）：允许模型条目覆盖额度配置（厂商接口变动时用户可自救）。
        // 只收 JSON-safe 的形状，且路径字符串限长 —— 与模板同构，不做二次校验的滥用面。
        const qj = {}
        const pathOf = (v) => String(v || '').slice(0, 200)
        if (p.quota.url) qj.url = String(p.quota.url).slice(0, 500)
        if (p.quota.auth !== undefined) qj.auth = String(p.quota.auth || '').slice(0, 200)
        const jin = p.quota.json
        for (const k of ['percent', 'remainPct', 'weeklyRemainPct', 'remain', 'total', 'resetAt', 'resetAtMs', 'level']) {
          if (jin[k]) qj[k] = pathOf(jin[k])
        }
        if (Array.isArray(jin.windows)) {
          qj.windows = jin.windows.slice(0, 6).map((w) => {
            const o = { key: String((w && w.key) || '').slice(0, 20), label: String((w && w.label) || '').slice(0, 20) }
            if (w && w.percent) o.percent = pathOf(w.percent)
            if (w && w.resetAt) o.resetAt = pathOf(w.resetAt)
            if (w && w.pick && typeof w.pick === 'object') {
              const pk = { list: pathOf(w.pick.list) }
              if (w.pick.type) pk.type = String(w.pick.type).slice(0, 40)
              if (Array.isArray(w.pick.types)) pk.types = w.pick.types.slice(0, 4).map((t) => String(t).slice(0, 40))
              if (w.pick.unit !== undefined) pk.unit = Number(w.pick.unit)
              if (w.pick.number !== undefined) pk.number = Number(w.pick.number)
              o.pick = pk
            }
            return o
          })
        }
        if (qj.url && (Object.keys(qj).length > 1)) model.quota = qj
      }
      if (p.balance && typeof p.balance === 'object') {
        // v724：空字段不写入（stripEmptyDeep）→ 模板默认值继续生效；
        // 全部为空时直接删掉 model.balance，等于"完全用模板"
        const balIn = stripEmptyDeep({
          url: String(p.balance.url || '').slice(0, 500),
          auth: String(p.balance.auth || '').slice(0, 200),
          // v789（issue #190）：可选的请求方法与请求体（留空 ⇒ 沿用模板/GET）
          method: String(p.balance.method || '').slice(0, 8).toUpperCase(),
          body: String(p.balance.body || '').slice(0, 4000),
          json: {
            remaining: String((p.balance.json && p.balance.json.remaining) || '').slice(0, 200),
            total: String((p.balance.json && p.balance.json.total) || '').slice(0, 200),
            used: String((p.balance.json && p.balance.json.used) || '').slice(0, 200),
            scale: isFinite(Number(p.balance.json && p.balance.json.scale)) ? Number(p.balance.json.scale) : undefined,
          },
        })
        if (balIn && Object.keys(balIn).length) model.balance = balIn
        else delete model.balance
        if (p.balance.usage && p.balance.usage.url) {
          model.balance = model.balance || {}
          model.balance.usage = stripEmptyDeep({
            url: String(p.balance.usage.url).slice(0, 500),
            auth: String(p.balance.usage.auth == null ? '' : p.balance.usage.auth).slice(0, 200),
            json: { used: String((p.balance.usage.json && p.balance.usage.json.used) || '').slice(0, 200), scale: isFinite(Number(p.balance.usage.json && p.balance.usage.json.scale)) ? Number(p.balance.usage.json.scale) : undefined },
          })
        }
      }
      // 会话事件归属：默认用「模型名」和「id」做子串匹配，用户可另填
      // 自定义单价（元/百万 token）：缓存命中 / 未命中输入 / 输出。留空则沿用内置价目表
      if (p.price && typeof p.price === 'object') {
        const num = (v) => {
          const s = String(v === undefined || v === null ? '' : v).trim()
          if (s === '') return undefined
          return isFinite(Number(s)) ? Number(s) : undefined
        }
        const pr = { hit: num(p.price.hit), miss: num(p.price.miss), out: num(p.price.out) }
        const cur0 = String(p.price.cur || '').trim().toUpperCase().slice(0, 8)
        const rate0 = num(p.price.rate)
        const anyPrice = pr.hit !== undefined || pr.miss !== undefined || pr.out !== undefined
        // 校验（为什么：不校验的话，负数/超大值会算出荒谬金额；USD 缺汇率会被静默当人民币记账）
        const inRange = (v, max) => v === undefined || (v >= 0 && v <= max)
        if (!inRange(pr.hit, 1000000) || !inRange(pr.miss, 1000000) || !inRange(pr.out, 1000000)) {
          return { ok: false, error: '单价必须是 0–1000000 之间的数字（单位：币种/百万 token）' }
        }
        if (rate0 !== undefined && !(rate0 > 0 && rate0 <= 1000)) {
          return { ok: false, error: '汇率必须是 0–1000 之间的正数（元/USD）' }
        }
        if (anyPrice && cur0 === 'USD' && !(rate0 > 0)) {
          return { ok: false, error: '单价币种为美元时必须填写汇率（元/USD）' }
        }
        if (cur0) pr.cur = cur0
        if (rate0 !== undefined) pr.rate = rate0
        if (pr.hit === undefined && pr.miss === undefined && pr.out === undefined) delete model.price
        else model.price = pr
      } else if (p.price === null) {
        delete model.price
      }
      writeApiRegistry(reg)
      // 改完单价立即失效缓存：否则 refreshCustomPrices 的 10 秒节流会让新价最坏 10 秒后才生效
      customPriceAt = 0
      // v748：新增/编辑模型可能改变"有没有 Codex 模型"，让 Codex 统计开关与快照立刻重算
      try { codexInvalidate() } catch (err) {}
      let keySaved = false
      if (p.keyValue !== undefined && String(p.keyValue).length) {
        try {
          await ctx.credentials.set(keyRef, String(p.keyValue))
          keySaved = true
        } catch (err) {}
      }
      return { ok: true, id, keySaved }
    }
    // 列表（含实时余额与各模型提醒/预算）：余额并发取，失败只影响该项
    async function apiModelsPayload() {
      const models = apiAllModels()
      const settings = readUsageSettings()
      const out = []
      let codexStats = null // Codex 本地会话统计（机器级，多个 codex 模型共享，算一次）
      for (const m of models) {
        let entry = {
          id: m.id, name: m.name, provider: m.provider, currency: m.currency,
          keyRef: m.keyRef, builtin: !!m.builtin, baseUrl: m.baseUrl || '',
          // v761（安全修复 S1）：该模型当前的目的地拿不到凭据（非厂商内置端点且未在本机确认过），
          // 前端据此提示用户"要去本机面板确认"，而不是让余额莫名其妙地空着。
          needsHostConfirm: (() => {
            try {
              const tpl2 = apiTemplateOf(m.provider) || {}
              const b2 = mergeNonEmpty(tpl2.balance, m.balance) || {}
              const base2 = String(m.baseUrl || "").replace(/\/+$/, "")
              const u2 = String(tpl2.probeUrl || b2.url || "").replace("{base}", base2)
              return !!u2 && !credentialMayGoTo(m, tpl2, u2)
            } catch (err) { return false }
          })(),
          canAdjustBalance: canAdjustBuiltinBalance(m),
          matchIds: m.matchIds || [], settings: settings.models && settings.models[m.id] ? settings.models[m.id] : null,
          price: m.price || null,
          // 手动额度（订阅/资源包）：总量、单位、已用、重置周期；前端据此显示额度模块
          quota: (settings.models && settings.models[m.id] && settings.models[m.id].quota)
            ? Object.assign({}, settings.models[m.id].quota) : null,
          balance: null, todayUsage: null, todayUsageCurrency: null, usageSource: 'none', error: null,
        }
        // 自动模式的「已用」由 host 按会话 token 统计（前端不自己算）
        if (entry.quota) {
          entry.quota.autoUsed = apiQuotaAutoUsed(m.id, entry.quota)
          entry.quota.autoToday = Math.round(Number((apiUsageRaw(m.id) || {}).eventTokens) || 0)
        }
        // 把「接口描述」（url/请求头/字段）单独下发，供前端面板回填；
        // entry.balance 是数值，不能当描述用（否则面板保存会用空值覆盖描述）
        const tplE = apiTemplateOf(m.provider) || {}
        entry.balanceDesc = mergeNonEmpty(tplE.balance, m.balance) // v724：空串不覆盖模板
        // v789（issue #189）：把当前的凭据放行标志也下发 —— 前端勾选框要能**显示现状**，
        //   否则"看不到 → 保存时显式传 false"会把用户手改文件开的口子又关掉（反而更糟）。
        entry.allowCustomHost = m.allowCustomHost === true
        entry.params = (m.params && typeof m.params === 'object') ? m.params : null
        if (m.id === API_BUILTIN_ID) {
          entry.balanceMode = 'api'
          entry.hasBalanceApi = true
          try {
            const cred = await ctx.credentials.resolve(m.keyRef || 'DEEPSEEK_API_KEY')
            entry.hasKey = !!(cred && cred.value)
          } catch (err) {}
          try {
            const p = await getBalance()
            if (p && p.ok) {
              entry.balance = Number(p.totalBalance)
              const summary = daySummary(readUsageLedger(), todayKey())
              entry.currency = p.currency
              entry.todayUsage = summary.amount
              entry.todayUsageCurrency = summary.currency
              entry.usageSource = summary.source
              entry.usageLabel = summary.label
              entry.accounting = balanceSummary(readUsageLedger(), todayKey())
            } else if (p) entry.error = p.error || p.code || '余额获取失败'
          } catch (err) { entry.error = String((err && err.message) || err) }
        } else {
          let hasKey = false
          try {
            const cred = await ctx.credentials.resolve(m.keyRef || '')
            hasKey = !!(cred && cred.value)
          } catch (err) {}
          entry.hasKey = hasKey
          // 该模型实际生效的余额描述：模板默认 + 用户覆盖
          const tplM = apiTemplateOf(m.provider) || {}
          const balDesc = Object.assign({}, tplM.balance || {}, m.balance || {})
          const hasBalanceApi = !!String(balDesc.url || '').trim()
          entry.hasBalanceApi = hasBalanceApi
          entry.probeUrl = String(tplM.probeUrl || '')
          // 订阅额度（kind='quota' 的模板，如智谱/Kimi/MiniMax Coding）：前端据此显示额度行与模块
          entry.planSupport = !!tplM.quota
          // Codex 模式：不查余额、不需要密钥，直接给本地会话统计（今日/本月/累计/近7天）
          if (tplM.kind === 'codex') {
            // 这里能等：模型列表请求可以稍等一下在途扫描（最多 2.5s），但绝不触发同步扫描
            if (!codexStats) codexStats = await codexSummaryEnsured(2500)
            entry.codex = codexStats
            entry.hasKey = true
            entry.error = codexStats && codexStats.ok ? null
              : (codexStats && codexStats.disabled ? null : ((codexStats && codexStats.error) || '未找到 Codex 会话目录'))
          }
          // 没有余额接口的厂商（如火山方舟）：余额显示「—」，只用会话事件估算
          entry.balanceMode = hasBalanceApi ? 'api' : 'events'
          if (hasBalanceApi && hasKey) {
            const r = await fetchModelBalance(m)
            if (r && r.ok) {
              entry.balance = r.remaining
              if (r.currency) entry.currency = r.currency
              apiRecordBalance(m.id, r.remaining)
              const u = apiTodayUsage(m.id, entry.currency || m.currency)
              entry.todayUsage = u.amount
              entry.usageSource = u.source
              entry.todayUsageCurrency = u.currency
            } else if (r) {
              entry.error = r.error || r.code || '余额获取失败'
            }
          } else if (!hasBalanceApi) {
            entry.error = null // 无余额接口不算错误
          } else {
            entry.error = '未配置 ' + (m.keyRef || 'API key')
          }
          // 订阅额度：有额度接口 + 有 key 才请求；失败只影响 plan 字段
          if (tplM.quota && hasKey) {
            try {
              entry.plan = await fetchModelQuota(m)
              if (entry.plan && !entry.plan.ok && apiPlanNoPlan(entry.plan.error)) entry.plan.hide = true
            } catch (err) { entry.plan = { ok: false, error: String((err && err.message) || err) } }
          }
          if (entry.todayUsage === null) {
            const u2 = apiTodayUsage(m.id, entry.currency || m.currency)
            entry.todayUsage = u2.amount
            entry.usageSource = u2.source
            entry.todayUsageCurrency = u2.currency
          }
        }
        out.push(entry)
      }
      return {
        ok: true,
        builtinId: API_BUILTIN_ID,
        // v724：把模板的接口描述也下发（B 方案：前端选模板后直接回填这些字段）
        templates: Object.keys(API_TEMPLATES).map((k) => ({
          id: k, name: API_TEMPLATES[k].name, currency: API_TEMPLATES[k].currency,
          keyRef: API_TEMPLATES[k].keyRef, builtin: !!API_TEMPLATES[k].builtin,
          needsBaseUrl: !!API_TEMPLATES[k].needsBaseUrl,
          hasBalance: !!String((API_TEMPLATES[k].balance || {}).url || '').trim(),
          probeUrl: String(API_TEMPLATES[k].probeUrl || ''),
          kind: String(API_TEMPLATES[k].kind || 'balance'),
          balance: API_TEMPLATES[k].balance ? JSON.parse(JSON.stringify(API_TEMPLATES[k].balance)) : null,
          quota: API_TEMPLATES[k].quota ? JSON.parse(JSON.stringify(API_TEMPLATES[k].quota)) : null,
          matchIds: Array.isArray(API_TEMPLATES[k].matchIds) ? API_TEMPLATES[k].matchIds.slice(0, 12) : [],
          noBalanceApi: !!API_TEMPLATES[k].noBalanceApi,
          apiNote: String(API_TEMPLATES[k].apiNote || ''),
          sortKey: tplSortKey(API_TEMPLATES[k].name), // v726：下拉排序键（前端按它排）
        })),
        models: out,
      }
    }

    // Each currency/key has its own timed observation window. An increase is
    // recorded separately and never subtracts previously observed consumption.
    function recordLedgerUsage(currentBalance, currency, scope, at) {
      const led = readUsageLedger()
      observeBalance(led, { balance: currentBalance, currency, scope, at })
      pruneLedgerUsage(led)
      if (!writeUsageLedger(led)) throw new Error('账本保存失败，请检查 DSH 数据目录写入权限')
      return led
    }
    function normalizeUsageMode() {
      return 'ledger' // 小鲸鱼记账为唯一记账方式
    }
    function ledgerTodayTotal(led) { return daySummary(led, todayKey()).amount }

    function publicBalance(payload) {
      const { accountTag, ...visible } = payload
      const led = readUsageLedger()
      const summary = daySummary(led, todayKey())
      const nowSec = Math.floor(Date.now() / 1000)
      return {
        ...visible, version: '0.3.18', isPeak: isPeakTime(nowSec),
        // 峰谷切换点与节假日清单：前端倒计时要与宿主同源（否则法定节假日会算错切换点）
        peakNextChangeAt: nextPeakChangeAt(nowSec),
        peakHolidays: HOLIDAY_VALLEY_LIST,
        todayUsage: summary.amount, todayUsageCurrency: summary.currency,
        usageSource: summary.source, usageLabel: summary.label, usageMode: 'ledger',
        accounting: balanceSummary(led, todayKey()),
      }
    }

    function getBalance(force = false) {
      const now = Date.now()
      if (!force && balanceCache && now - balanceCache.at < BALANCE_TTL_MS) {
        return Promise.resolve(publicBalance(balanceCache.payload))
      }
      if (balanceInFlight) return balanceInFlight
      balanceInFlight = fetchBalance()
        .then((payload) => {
          if (payload.ok) {
            // v759（issue #157 报告人踩到）：**"记不了账"不该吞掉已经拿到的余额**。
            // 以前 recordLedgerUsage 抛错会被最外层 .catch 包成「余额服务异常: …」，
            // 界面看起来像"接口没通"，其实余额已经拿到了（accountTag/币种不合法就会这样）。
            // 但要与"**账本整个读不出来**"区分开：那种情况必须保持 fail-closed（见下面的 rethrow）——
            // 一边是"余额拿到了、只是没记上账"，一边是"账本已经坏了、连今日已用都算不出来"，
            // 后者若也回 ok:true，用户会以为一切正常，而账本其实不可用。
            let ledgerError = ''
            try {
              recordLedgerUsage(payload.totalBalance, payload.currency, payload.accountTag, Date.parse(payload.updatedAt))
            } catch (err) {
              ledgerError = String((err && err.message) || err).slice(0, 160)
            }
            let visible
            try {
              visible = publicBalance(payload) // 读账本算今日已用/近 7 天
            } catch (err) {
              throw err // 账本读不出来（结构损坏等）→ 交给最外层 .catch，报 ok:false 并保留原记录
            }
            balanceCache = { at: Date.now(), payload } // 先缓存：之后即使记账失败，余额也继续显示
            return ledgerError ? { ...visible, ledgerError } : visible
          }
          if (payload.transient && balanceCache) {
            return { ...publicBalance(balanceCache.payload), stale: true, error: payload.error }
          }
          return publicBalance(payload)
        })
        .catch((err) => ({
          ok: false, code: 'ERROR',
          error: '余额服务异常: ' + String((err && err.message) || err).slice(0, 200),
        }))
        .finally(() => { balanceInFlight = null })
      return balanceInFlight
    }

    function readSizeConfig() {
      for (const p of SIZE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && typeof parsed.scale === 'number') {
            return {
              scale: parsed.scale,
              sound: parsed.sound !== false,
              vol: typeof parsed.vol === 'number' ? parsed.vol : 0.9,
              soundSet: typeof parsed.soundSet === 'string' && parsed.soundSet ? parsed.soundSet : 'duck',
              usageMode: normalizeUsageMode(parsed.usageMode),
              peakMode: parsed.peakMode === 'liangwen' || parsed.peakMode === 'qiangqiang' ? parsed.peakMode : 'default',
              bubbleOn: parsed.bubbleOn !== false,
              turnCostOn: parsed.turnCostOn !== false,
              turnCostCloseMs: typeof parsed.turnCostCloseMs === 'number' ? parsed.turnCostCloseMs : 5000,
              scrollGapOn: parsed.scrollGapOn === true,
              scrollGapPx: typeof parsed.scrollGapPx === 'number' ? Math.round(parsed.scrollGapPx) : 17,
              menuBtnHide: parsed.menuBtnHide === true,
              // issue #116：Codex 本地统计可以在设置里关掉（默认开）。关掉后宿主完全不扫
              // ~/.codex/sessions，也不做后台预热。
              codexStatsOn: parsed.codexStatsOn !== false,
            }
          }
        } catch (err) {}
      }
      return null
    }

    function writeSizeConfig(scale, sound, vol, soundSet, usageMode, peakMode, bubbleOn, turnCostOn, turnCostCloseMs, scrollGapOn, scrollGapPx, menuBtnHide, codexStatsOnArg) {
      const um = normalizeUsageMode(usageMode)
      const pm = peakMode === 'liangwen' || peakMode === 'qiangqiang' ? peakMode : 'default'
      const bo = bubbleOn !== false
      const tco = turnCostOn !== false
      const tcc = typeof turnCostCloseMs === 'number' ? (turnCostCloseMs > 0 ? turnCostCloseMs : 0) : 5000
      const sgo = scrollGapOn === true
      const sgp = typeof scrollGapPx === 'number' && scrollGapPx > 0 ? Math.round(scrollGapPx) : 0
      const mbh = menuBtnHide === true
      const cso = codexStatsOnArg !== false
      const body = JSON.stringify({
        scale: scale,
        sound: sound !== false,
        vol: typeof vol === 'number' ? vol : 0.9,
        soundSet: typeof soundSet === 'string' && soundSet ? soundSet : 'duck',
        usageMode: um,
        peakMode: pm,
        bubbleOn: bo,
        turnCostOn: tco,
        turnCostCloseMs: tcc,
        scrollGapOn: sgo,
        scrollGapPx: sgp,
        menuBtnHide: mbh,
        codexStatsOn: cso,
        updatedAt: new Date().toISOString(),
      })
      let lastSizeErr = null
      for (const p of SIZE_FILE_CANDIDATES) {
        try {
          fs.writeFileSync(p, body, 'utf8')
          return {
            ok: true,
            scale: scale,
            sound: sound !== false,
            vol: typeof vol === 'number' ? vol : 0.9,
            soundSet: typeof soundSet === 'string' && soundSet ? soundSet : 'duck',
            usageMode: um,
            peakMode: pm,
            bubbleOn: bo,
            turnCostOn: tco,
            turnCostCloseMs: tcc,
            scrollGapOn: sgo,
            scrollGapPx: sgp,
            menuBtnHide: mbh,
            codexStatsOn: cso,
          }
        } catch (err) { lastSizeErr = err }
      }
      // #88 / #97 报告者建议：把底层原因（EPERM / EACCES / 路径问题…）带出去。
      // 原先无论哪个候选路径失败，返回的都是同一句固定文案，即使前端检查了响应也定位不到原因。
      return { ok: false, error: '无法持久化挂件尺寸' + (lastSizeErr && lastSizeErr.message ? '：' + lastSizeErr.message : '') }
    }

    function readBody(req) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > 8192) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    function readBodyMax(req, maxBytes) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > maxBytes) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    // —— 自定义角色存储：whale-roles/ 目录，每个角色一个 <id>.png + roles.json 索引 ——
    function pickRoleDir() {
      for (const p of ROLE_DIR_CANDIDATES) {
        try {
          fs.mkdirSync(p, { recursive: true })
          fs.accessSync(p, fs.constants.W_OK)
          return p
        } catch (err) {}
      }
      return ROLE_DIR_CANDIDATES[0]
    }

    function defaultRolesIndex() {
      return {
        version: 1,
        roles: [
          // 默认小鲸鱼初始置顶；pinnedAt=1 作为基线，任何新置顶（Date.now()）都会排在它上面
          { id: ROLE_DEFAULT_ID, name: '小鲸鱼', pinnedAt: 1, createdAt: 0 },
        ],
      }
    }

    function readRolesIndex() {
      const dir = pickRoleDir()
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, ROLE_INDEX_NAME), 'utf8'))
        if (parsed && Array.isArray(parsed.roles)) {
          if (!parsed.roles.some((r) => r && r.id === ROLE_DEFAULT_ID)) {
            parsed.roles.unshift(defaultRolesIndex().roles[0])
          }
          return parsed
        }
      } catch (err) {}
      return defaultRolesIndex()
    }

    function writeRolesIndex(index) {
      const dir = pickRoleDir()
      try {
        fs.writeFileSync(path.join(dir, ROLE_INDEX_NAME), JSON.stringify(index, null, 2), 'utf8')
        return true
      } catch (err) {
        return false
      }
    }

    // 排序：置顶的在前（pinnedAt 大者先，即最新置顶在最上面），未置顶按创建时间倒序
    function sortRoles(roles) {
      return roles.slice().sort((a, b) => {
        const ap = a.pinnedAt && a.pinnedAt > 0 ? a.pinnedAt : 0
        const bp = b.pinnedAt && b.pinnedAt > 0 ? b.pinnedAt : 0
        if (ap && bp) return bp - ap
        if (ap) return -1
        if (bp) return 1
        return (b.createdAt || 0) - (a.createdAt || 0)
      })
    }

    function rolesPayload() {
      const index = readRolesIndex()
      return {
        ok: true,
        roles: sortRoles(index.roles).map((r) => ({
          id: r.id,
          name: String(r.name || r.id),
          url: r.id === ROLE_DEFAULT_ID ? '/dsh-whale/image.png' : '/dsh-whale/role-image.png?id=' + encodeURIComponent(r.id),
          pinned: !!(r.pinnedAt && r.pinnedAt > 0),
          pinnedAt: r.pinnedAt || null,
          createdAt: r.createdAt || null,
          // format: 'png' | 'gif' | 'apng'（旧角色无 format 字段 → png）
          format: r.format === 'gif' || r.format === 'apng' ? r.format : 'png',
        })),
      }
    }

    // 角色文件按格式映射扩展名：gif→.gif，apng/png→.png（APNG 文件仍是 PNG 容器）
    function roleFileExt(format) {
      return format === 'gif' ? 'gif' : 'png'
    }

    function roleFilePath(id, format) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === ROLE_DEFAULT_ID) return null
      return path.join(pickRoleDir(), id + '.' + roleFileExt(format))
    }

    function roleImagePath(id) {
      // 查找角色元数据确定扩展名；找不到默认 png
      const { role } = roleIndexFind(id)
      const format = role && (role.format === 'gif' || role.format === 'apng') ? role.format : 'png'
      const p = roleFilePath(id, format)
      return p
    }

    function roleIdFromUrl(url) {
      try {
        const q = String(url || '').split('?')[1] || ''
        const m = /(?:^|&)id=([^&]+)/.exec(q)
        return m ? decodeURIComponent(m[1]) : ''
      } catch (err) { return '' }
    }

    function roleIndexFind(id) {
      const index = readRolesIndex()
      const role = index.roles.find((r) => r && r.id === id)
      return { index, role }
    }

    // —— 自定义音频：whale-audio/ 目录，片段 <id>.wav + audio.json 索引 ——
    function pickAudioDir() {
      for (const p of AUDIO_DIR_CANDIDATES) {
        try {
          fs.mkdirSync(p, { recursive: true })
          fs.accessSync(p, fs.constants.W_OK)
          return p
        } catch (err) {}
      }
      return AUDIO_DIR_CANDIDATES[0]
    }

    function defaultAudioIndex() {
      return { version: 1, groups: [], fragments: [] }
    }

    function readAudioIndex() {
      const dir = pickAudioDir()
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, AUDIO_INDEX_NAME), 'utf8'))
        if (parsed && Array.isArray(parsed.groups) && Array.isArray(parsed.fragments)) {
          return parsed
        }
      } catch (err) {}
      return defaultAudioIndex()
    }

    function writeAudioIndex(index) {
      const dir = pickAudioDir()
      try {
        fs.writeFileSync(path.join(dir, AUDIO_INDEX_NAME), JSON.stringify(index, null, 2), 'utf8')
        return true
      } catch (err) {
        return false
      }
    }

    // 自定义片段 id -> 文件路径；预设片段无文件
    function audioFragmentPath(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
      if (PRESET_FRAGMENTS[id]) return null
      return path.join(pickAudioDir(), id + '.wav')
    }

    function audioIdFromUrl(url) {
      try {
        const q = String(url || '').split('?')[1] || ''
        const m = /(?:^|&)id=([^&]+)/.exec(q)
        return m ? decodeURIComponent(m[1]) : ''
      } catch (err) { return '' }
    }

    // 片段列表：预设片段 + 用户自定义片段
    function audioFragmentsPayload() {
      const index = readAudioIndex()
      const presets = Object.keys(PRESET_FRAGMENTS).map((k) => ({
        id: k,
        name: PRESET_FRAGMENTS[k].name,
        preset: true,
      }))
      const custom = index.fragments.map((f) => ({
        id: f.id,
        name: String(f.name || f.id),
        preset: false,
        createdAt: f.createdAt || null,
      }))
      return presets.concat(custom)
    }

    // 音效组列表：预设组 + 用户自定义组（置顶优先，组内按创建时间倒序）
    function audioGroupsPayload() {
      const index = readAudioIndex()
      // 排序：置顶的自定义组最前，其次预设组，最后未置顶的自定义组（按创建时间倒序）
      const customs = index.groups.slice().map((g) => ({
        id: g.id,
        name: String(g.name || g.id),
        press: typeof g.press === 'string' ? g.press : null,
        release: typeof g.release === 'string' ? g.release : null,
        preset: false,
        pinned: !!(g.pinnedAt && g.pinnedAt > 0),
        pinnedAt: g.pinnedAt || null,
        createdAt: g.createdAt || 0,
      }))
      const pinned = customs.filter((g) => g.pinned).sort((a, b) => b.pinnedAt - a.pinnedAt)
      const unpinned = customs.filter((g) => !g.pinned).sort((a, b) => b.createdAt - a.createdAt)
      const presets = Object.keys(PRESET_GROUPS).map((k) => {
        const g = PRESET_GROUPS[k]
        return { id: g.id, name: g.name, press: g.press, release: g.release, preset: true, pinned: false, pinnedAt: null, createdAt: 0 }
      })
      return pinned.concat(presets, unpinned)
    }

    function audioPayload() {
      return {
        ok: true,
        groups: audioGroupsPayload(),
        fragments: audioFragmentsPayload(),
      }
    }

    // 取片段音频字节：内置随包片段 → 预设(SOUND_SETS) → 自定义 whale-audio/<id>.wav
    function loadAudioFragmentBytes(fragId) {
      if (BUILTIN_FRAGMENT_FILES[fragId]) {
        return loadSound(BUILTIN_FRAGMENT_FILES[fragId])
      }
      if (PRESET_FRAGMENTS[fragId]) {
        // 预设片段映射到对应音效文件：ya1->duck.press, ya2->duck.release, d1->fx1.press, d2->fx1.release
        const map = { ya1: ['duck', 'press'], ya2: ['duck', 'release'], d1: ['fx1', 'press'], d2: ['fx1', 'release'] }
        const [setName, slot] = map[fragId]
        const set = SOUND_SETS[setName]
        if (!set) return null
        return loadSound(set[slot])
      }
      const p = audioFragmentPath(fragId)
      if (!p) return null
      try {
        const bytes = fs.readFileSync(p)
        if (bytes && bytes.length > 0) return bytes
      } catch (err) {}
      return null
    }

    // 组内实际使用的片段：若自定义组引用的片段被删，回退到预设
    // 返回 '' 表示该槽显式留空（该事件静音），调用方应据此不发音频
    function groupFragmentId(groupId, slot) {
      const custom = readAudioIndex().groups.find((g) => g && g.id === groupId)
      if (custom) {
        const fid = custom[slot]
        if (fid === '') return ''
        if (fid) {
          if (PRESET_FRAGMENTS[fid]) return fid
          if (customFragExists(fid)) return fid
        }
        // 无字段/引用失效 → 回退预设：新组无引用时用 duck
        return slot === 'press' ? PRESET_GROUPS.duck.press : PRESET_GROUPS.duck.release
      }
      const preset = PRESET_GROUPS[groupId]
      if (preset) return preset[slot]
      return slot === 'press' ? PRESET_GROUPS.duck.press : PRESET_GROUPS.duck.release
    }

    function customFragExists(id) {
      try {
        const p = audioFragmentPath(id)
        if (!p) return false
        const st = fs.statSync(p)
        return st.isFile()
      } catch (err) { return false }
    }

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/image.png',
      handler: (req, res) => {
        try {
          const bytes = loadImage()
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('whale image unavailable: ' + String((err && err.message) || err))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/rua.gif',
      handler: (req, res) => {
        try {
          const bytes = loadGif()
          res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('rua gif unavailable: ' + String((err && err.message) || err))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/balance.json',
      handler: async (req, res) => {
        try {
          const refresh = new URL(req.url || '/', 'http://localhost').searchParams.get('refresh') === '1'
          const payload = await getBalance(refresh)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(payload))
        } catch (err) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/last-turn.json',
      handler: (req, res) => {
        // 返回最近一轮已完成的对话消耗；seq 递增供前端判断「新的一轮」
        const payload = lastTurn
          ? { ok: true, seq: lastTurnSeq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, ts: lastTurn.ts }
          : { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/size.json',
      handler: async (req, res) => {
        if (req.method === 'PUT' || req.method === 'POST') {
          try {
            const body = await readBody(req)
            const parsed = JSON.parse(body)
            const scale = typeof parsed.scale === 'number' ? parsed.scale : null
            if (scale === null) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'missing scale' }))
              return
            }
            // issue #97：缺字段一律「沿用现有值」，绝不落默认 —— 否则任何不全的 PUT
            // （旧客户端 / 手写 curl / 加载竞态）都会把用户的设置洗成默认值。
            // 特别注意 scrollGapPx：读取默认是 17，而写入缺省曾是 0，会静默把避让宽度改掉。
            const old = readSizeConfig() || {}
            const pickB = (v, cur, dflt) => (typeof v === 'boolean' ? v : (typeof cur === 'boolean' ? cur : dflt))
            const pickN = (v, cur, dflt) => (typeof v === 'number' ? v : (typeof cur === 'number' ? cur : dflt))
            const pickS = (v, cur, dflt) => (typeof v === 'string' && v ? v : (typeof cur === 'string' && cur ? cur : dflt))
            // 用量模式变化时让余额缓存失效，下次请求立即按新模式计算
            if (typeof parsed.usageMode === 'string') {
              if (normalizeUsageMode(old.usageMode) !== normalizeUsageMode(parsed.usageMode)) {
                balanceCache = null
              }
            }
            const result = writeSizeConfig(
              scale,
              pickB(parsed.sound, old.sound, true),
              pickN(parsed.vol, old.vol, 0.9),
              pickS(parsed.soundSet, old.soundSet, 'duck'),
              typeof parsed.usageMode === 'string' ? parsed.usageMode : old.usageMode,
              typeof parsed.peakMode === 'string' ? parsed.peakMode : old.peakMode,
              pickB(parsed.bubbleOn, old.bubbleOn, true),
              pickB(parsed.turnCostOn, old.turnCostOn, true),
              pickN(parsed.turnCostCloseMs, old.turnCostCloseMs, 5000),
              pickB(parsed.scrollGapOn, old.scrollGapOn, false),
              pickN(parsed.scrollGapPx, old.scrollGapPx, 17),
              pickB(parsed.menuBtnHide, old.menuBtnHide, false),
              pickB(parsed.codexStatsOn, old.codexStatsOn, true)
            )
            res.writeHead(result.ok ? 200 : 500, JSON_HEADERS)
            // 配置刚变（可能刚关掉/打开 Codex 统计）→ 丢掉旧快照，让下一次请求立刻反映新设置
            if (result.ok) { try { codexInvalidate() } catch (err) {} }
            res.end(JSON.stringify(result))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
          }
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(readSizeConfig() || {}))
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/wait.json',
      handler: (req, res) => {
        // v761（issue #161）：等待用户交互的挂起状态（提问 / 授权）。
        // 沿用"宿主出状态 + 前端每秒轮询"的既有模式，不引入新通道。
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: true,
          pending: waitState.pending,
          sessionName: waitState.sessionName || '',
        }))
      },
    }))
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/usage-records.json',
      handler: async (req, res) => {
        try {
          // Reports read the committed ledger. Replaying cached balance samples
          // here could roll back a correction or create a false midnight baseline.
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(usageRecordsPayload()))
        } catch (err) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
        }
      },
    }))
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/balance-adjustments.json',
      handler: async (req, res) => {
        try {
          // 先核对身份再碰余额或账本：必须是唯一且明确的 DeepSeek（内置）。
          // 新增厂商模板不会自动继承这个能力，也拒绝其它模型读写校正。
          const targetIds = new URL(req.url || '/', 'http://localhost').searchParams.getAll('modelId')
          const targetModelId = targetIds.length === 1 ? targetIds[0] : null
          if (targetModelId !== API_BUILTIN_ID || !canAdjustBuiltinBalance(apiModelById(targetModelId))) {
            const error = new Error('余额校正仅支持 DeepSeek（内置），请从该模型的设置菜单进入')
            error.status = 403
            throw error
          }
          if (req.method === 'PUT') {
            const input = JSON.parse(await readBodyMax(req, 8192))
            if (!input || typeof input !== 'object') throw new Error('校正内容无效')
            if (input.modelId !== targetModelId) {
              const error = new Error('校正请求的模型不匹配，仅支持 DeepSeek（内置）')
              error.status = 403
              throw error
            }
            if (input.day === todayKey()) {
              const fresh = await getBalance(true)
              if (!fresh.ok || fresh.stale) {
                res.writeHead(503, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: '暂时无法刷新余额，请稍后再保存校正' }))
                return
              }
            }
            const led = readUsageLedger()
            const summary = reconcileBalance(led, input)
            if (!writeUsageLedger(led)) throw new Error('校正保存失败，请检查 DSH 数据目录写入权限')
            balanceCache = null
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify({ ok: true, summary }))
            return
          }
          if (req.method !== 'GET' && req.method !== undefined) {
            res.writeHead(405, { ...JSON_HEADERS, Allow: 'GET, PUT' })
            res.end(JSON.stringify({ ok: false, error: '不支持的请求方法' }))
            return
          }
          const fresh = await getBalance(true)
          const led = readUsageLedger()
          const days = accountingDays(led).sort().reverse().map(day => balanceSummary(led, day))
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({
            ok: true, days, today: todayKey(), fresh: !!fresh.ok && !fresh.stale,
            error: !fresh.ok || fresh.stale ? (fresh.error || '余额暂未刷新') : null,
          }))
        } catch (err) {
          res.writeHead(err.status || 400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 240) }))
        }
      },
    }))

    // 用量设置(任务结束音/余额预警/今日预算)
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/usage-settings.json',
      handler: async (req, res) => {
        try {
          if (req.method === 'PUT' || req.method === 'POST') {
            const body = await readBody(req)
            const parsed = JSON.parse(body || '{}')
            if (!parsed || typeof parsed !== 'object') throw new Error('bad body')
            const result = writeUsageSettings(parsed)
            res.writeHead(result.ok ? 200 : 400, JSON_HEADERS)
            res.end(JSON.stringify(result))
            return
          }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, settings: readUsageSettings() }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
        }
      },
    }))

    // 自定义 API 模型：GET 列表（含实时余额/今日已用/各模型提醒预算）
    // POST {action: save|delete|set-key|delete-key|model-settings}
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/api-models.json',
      handler: async (req, res) => {
        try {
          if (req.method === 'PUT' || req.method === 'POST') {
            const body = await readBody(req)
            const parsed = JSON.parse(body || '{}')
            const action = String((parsed && parsed.action) || 'save')
            if (action === 'delete') {
              const r = apiDeleteModel(parsed.id)
              const list = await apiModelsPayload()
              res.writeHead(r.ok ? 200 : 400, JSON_HEADERS)
              res.end(JSON.stringify({ ...r, models: list.models }))
              return
            }
            if (action === 'probe') {
              // 只做只读连通性测试（如方舟 /api/v3/models），不消耗 token
              const m0 = apiModelById(parsed.id)
              const pr = await apiProbeModel(m0)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify(pr))
              return
            }
            if (action === 'set-key' || action === 'delete-key') {
              const ref = String(parsed.keyRef || '').trim()
              if (!ref) throw new Error('bad keyRef')
              const svc = ctx.credentials
              if (action === 'set-key') {
                await svc.set(ref, String(parsed.keyValue || ''))
              } else if (typeof svc.unset === 'function') {
                // 普通密钥存在凭据文档的 refs 段：必须用 unset 才能真正删除
                // （deleteRecord 只处理 records 段的结构化记录，对 refs 会静默返回）
                await svc.unset(ref)
              } else {
                await svc.deleteRecord(ref)
              }
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true }))
              return
            }
            if (action === 'model-settings') {
              const r = writeUsageSettings({ modelSettings: { id: String(parsed.id || ''), alert: parsed.alert, budget: parsed.budget, quota: parsed.quota } })
              res.writeHead(r.ok ? 200 : 400, JSON_HEADERS)
              res.end(JSON.stringify(r))
              return
            }
            // 注意：keyValue 在提交体上（不在 model 里），必须合并进去，
            // 否则前端面板里填的 API key 会被丢弃（密钥永远存不进去）
            const r = await apiSaveModel({ ...(parsed.model || parsed), keyValue: parsed.keyValue })
            const list2 = await apiModelsPayload()
            res.writeHead(r.ok ? 200 : 400, JSON_HEADERS)
            res.end(JSON.stringify({ ...r, models: list2.models }))
            return
          }
          const payload = await apiModelsPayload()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(payload))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/roles.json',
      handler: async (req, res) => {
        if (req.method === 'POST' || req.method === 'PUT') {
          try {
            // 放宽到 30MB：支持最大 20MB 的 GIF（base64 膨胀约 1.33 倍）
            const body = await readBodyMax(req, 30 * 1024 * 1024)
            const parsed = JSON.parse(body)
            const name = String(parsed.name || '').trim().slice(0, 20) || '新角色'
            const image = String(parsed.image || '')
            const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(image)
            if (!m) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'invalid image data' }))
              return
            }
            const buf = Buffer.from(m[2], 'base64')
            if (buf.length < 8 || buf.length > 20 * 1024 * 1024) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'image too large' }))
              return
            }
            // format：客户端显式告知 gif/apng（APNG 的 dataURL 是 image/png，需客户端区分）；
            // 未显式给时按 dataURL 的 MIME 推断（gif→gif，其余 png）
            const declared = parsed.format === 'gif' ? 'gif' : (parsed.format === 'apng' ? 'apng' : null)
            const fmt = declared || (m[1] === 'gif' ? 'gif' : 'png')
            const id = 'role_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
            const dir = pickRoleDir()
            fs.writeFileSync(path.join(dir, id + '.' + roleFileExt(fmt)), buf)
            const index = readRolesIndex()
            index.roles.push({ id, name, format: fmt, pinnedAt: null, createdAt: Date.now() })
            writeRolesIndex(index)
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(rolesPayload()))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
          }
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(rolesPayload()))
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/role-pin.json',
      handler: async (req, res) => {
        try {
          const body = await readBodyMax(req, 8192)
          const parsed = JSON.parse(body)
          const id = String(parsed.id || '')
          const { index, role } = roleIndexFind(id)
          if (!role) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'role not found' }))
            return
          }
          role.pinnedAt = parsed.pinned === true ? Date.now() : null
          writeRolesIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(rolesPayload()))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/role-delete.json',
      handler: async (req, res) => {
        try {
          const body = await readBodyMax(req, 8192)
          const parsed = JSON.parse(body)
          const id = String(parsed.id || '')
          if (id === ROLE_DEFAULT_ID) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'cannot delete default role' }))
            return
          }
          const { index, role } = roleIndexFind(id)
          if (!role) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'role not found' }))
            return
          }
          // 先按角色 format 确定文件路径（必须在从索引移除之前，否则查不到 format 默认成 png，删不掉 .gif）
          const fmt = role.format === 'gif' || role.format === 'apng' ? role.format : 'png'
          const p = roleFilePath(id, fmt)
          index.roles = index.roles.filter((r) => r.id !== id)
          writeRolesIndex(index)
          if (p) { try { fs.unlinkSync(p) } catch (err) {} }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(rolesPayload()))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/role-image.png',
      handler: (req, res) => {
        try {
          const id = roleIdFromUrl(req.url)
          const p = roleImagePath(id)
          if (!p) throw new Error('bad role id')
          const bytes = fs.readFileSync(p)
          // 按角色格式返回对应 MIME：gif 动图 → image/gif；png/apng 都是 PNG 容器 → image/png
          const { role } = roleIndexFind(id)
          const mime = role && role.format === 'gif' ? 'image/gif' : 'image/png'
          res.writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('role image unavailable')
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/audio.json',
      handler: async (req, res) => {
        if (req.method === 'POST' || req.method === 'PUT') {
          try {
            const body = await readBodyMax(req, 8 * 1024 * 1024)
            const parsed = JSON.parse(body)
            const action = parsed.action
            const index = readAudioIndex()
            if (action === 'upload-fragment') {
              const name = String(parsed.name || '').trim().slice(0, 40) || '未命名音频'
              const audio = String(parsed.audio || '')
              const m = /^data:audio\/wav;base64,([A-Za-z0-9+/=]+)$/.exec(audio)
              if (!m) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'invalid wav data' }))
                return
              }
              const buf = Buffer.from(m[1], 'base64')
              if (buf.length < 44 || buf.length > 8 * 1024 * 1024) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'audio too large' }))
                return
              }
              const id = 'audio_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
              fs.writeFileSync(path.join(pickAudioDir(), id + '.wav'), buf)
              index.fragments.push({ id, name, createdAt: Date.now() })
              writeAudioIndex(index)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, id, fragments: audioFragmentsPayload() }))
              return
            }
            if (action === 'save-group') {
              const id = String(parsed.id || '')
              const name = String(parsed.name || '').trim().slice(0, 20) || '未命名音效组'
              const press = String(parsed.press ?? '')
              const release = String(parsed.release ?? '')
              // 校验引用片段存在（预设或自定义）；空字符串=该槽留空(该事件静音)，允许保存
              const frags = audioFragmentsPayload().map((f) => f.id)
              const validPress = press === '' ? '' : (frags.includes(press) ? press : PRESET_GROUPS.duck.press)
              const validRelease = release === '' ? '' : (frags.includes(release) ? release : PRESET_GROUPS.duck.release)
              if (id && index.groups.some((g) => g.id === id)) {
                const g = index.groups.find((x) => x.id === id)
                g.name = name
                g.press = validPress
                g.release = validRelease
              } else {
                const gid = 'group_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
                index.groups.push({ id: gid, name, press: validPress, release: validRelease, pinnedAt: null, createdAt: Date.now() })
              }
              writeAudioIndex(index)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
              return
            }
            if (action === 'delete-group') {
              const id = String(parsed.id || '')
              if (PRESET_GROUPS[id]) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'cannot delete preset group' }))
                return
              }
              index.groups = index.groups.filter((g) => g.id !== id)
              writeAudioIndex(index)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
              return
            }
            if (action === 'delete-fragment') {
              const id = String(parsed.id || '')
              if (PRESET_FRAGMENTS[id]) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'cannot delete preset fragment' }))
                return
              }
              index.fragments = index.fragments.filter((f) => f.id !== id)
              writeAudioIndex(index)
              const p = audioFragmentPath(id)
              if (p) { try { fs.unlinkSync(p) } catch (err) {} }
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, fragments: audioFragmentsPayload(), groups: audioGroupsPayload() }))
              return
            }
            if (action === 'pin-group') {
              const id = String(parsed.id || '')
              const g = index.groups.find((x) => x.id === id)
              if (!g) {
                res.writeHead(404, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'group not found' }))
                return
              }
              g.pinnedAt = parsed.pinned === true ? Date.now() : null
              writeAudioIndex(index)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
              return
            }
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
          }
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(audioPayload()))
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/audio-fragment.wav',
      handler: (req, res) => {
        try {
          const id = audioIdFromUrl(req.url)
          const bytes = loadAudioFragmentBytes(id)
          if (!bytes) throw new Error('bad fragment id')
          // 预设/内置片段可能是 mp3 也可能是 wav —— Content-Type 必须与字节匹配，
          // 否则浏览器解码路径/加载行为异常（MIME 与字节不符会导致听感差异）
          const mime = fragmentMime(id)
          res.writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('audio fragment unavailable')
        }
      },
    }))

    // 片段字节对应的 MIME：内置/预设片段按声明，自定义片段一律 wav
    function fragmentMime(fragId) {
      const f = PRESET_FRAGMENTS[fragId]
      return (f && f.mime) || 'audio/wav'
    }

    function loadSound(candidates) {
      for (const p of candidates) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) return bytes
        } catch (err) {}
      }
      return null
    }

    function serveSound(req, res, candidates) {
      const bytes = loadSound(candidates)
      if (!bytes) {
        // v752：404 也带 no-store。原来只有 200 分支有缓存头，失败的响应可能被浏览器/中间层
        // 缓存住，一旦缓存就会变成"永久没声音、刷新也没用"。
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('sound unavailable')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    }

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/sound/press.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        // 自定义音效组：set 为组 id 时按组内 press 片段取音频
        const setName = soundSetFromUrl(req.url)
        if (setName && !SOUND_SETS[setName]) {
          const fragId = groupFragmentId(setName, 'press')
          if (fragId === '') { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return } // 留空槽：该事件静音（v752：补 no-store，空响应不允许被缓存）
          const bytes = loadAudioFragmentBytes(fragId)
          if (bytes) {
            res.writeHead(200, {
              'Content-Type': fragmentMime(fragId),
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
        }
        serveSound(req, res, set.press)
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/sound/release.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        const setName = soundSetFromUrl(req.url)
        if (setName && !SOUND_SETS[setName]) {
          const fragId = groupFragmentId(setName, 'release')
          if (fragId === '') { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return } // 留空槽：该事件静音（v752：补 no-store，空响应不允许被缓存）
          const bytes = loadAudioFragmentBytes(fragId)
          if (bytes) {
            res.writeHead(200, {
              'Content-Type': fragmentMime(fragId),
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
        }
        serveSound(req, res, set.release)
      },
    }))

    // —— 音乐播放器：托管目录 whale-music/（与音效库 whale-audio/ 同形但**不建索引**）——
    // 目录不存在时自动创建，与 pickAudioDir() 同一写法（候选表第一个可写的胜出）。
    function pickMusicDir() {
      for (const p of MUSIC_DIR_CANDIDATES) {
        try {
          fs.mkdirSync(p, { recursive: true })
          fs.accessSync(p, fs.constants.W_OK)
          return p
        } catch (err) {}
      }
      return MUSIC_DIR_CANDIDATES[0]
    }

    // 状态默认值：文件缺失/损坏、或某个键非法时都用它兜底。
    // ⚠️ 前端也会内置同一份默认值；两处必须一致，否则表现是"首次打开界面显示 0.9、存一次变 1"。
    function defaultMusicSettings() {
      return { volume: 0.9, loop: 'all', shuffle: false, pressMode: true, autoplay: false }
    }

    function defaultMusicState() {
      return { version: 1, customDir: '', settings: defaultMusicSettings() }
    }

    // 设置白名单 + 逐键类型校验：未知键**忽略**，非法值退回当前值/默认值。
    // 为什么不用 Object.assign 直接合并：请求体来自页面，直接合并会把任意键写进状态文件
    //（多余键既没人读、又会污染用户的配置文件），而 check-dead-settings.mjs 的口径就是
    //「写进去的键必须在运行时被读到」—— 所以宁可逐个挑。
    function normalizeMusicSettings(raw, base) {
      const out = Object.assign(defaultMusicSettings(), base || {})
      // base 也可能是从磁盘读回来的坏值，所以再校验一遍
      if (typeof out.volume !== 'number' || !isFinite(out.volume) || out.volume < 0 || out.volume > 1) out.volume = 0.9
      if (out.loop !== 'off' && out.loop !== 'all' && out.loop !== 'one') out.loop = 'all'
      out.shuffle = out.shuffle === true
      out.pressMode = out.pressMode !== false
      out.autoplay = out.autoplay === true
      if (!raw || typeof raw !== 'object') return out
      if (typeof raw.volume === 'number' && isFinite(raw.volume) && raw.volume >= 0 && raw.volume <= 1) out.volume = raw.volume
      if (raw.loop === 'off' || raw.loop === 'all' || raw.loop === 'one') out.loop = raw.loop
      if (typeof raw.shuffle === 'boolean') out.shuffle = raw.shuffle
      if (typeof raw.pressMode === 'boolean') out.pressMode = raw.pressMode
      if (typeof raw.autoplay === 'boolean') out.autoplay = raw.autoplay
      return out
    }

    function readMusicState() {
      for (const p of MUSIC_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          // 文件在但结构不对（手改坏 / 旧格式）→ 兜底默认值，**绝不抛**：
          // 抛出去会让 music.json 直接 500，整个播放器（连歌单）都点不开。
          if (parsed && typeof parsed === 'object') {
            return {
              version: 1,
              customDir: typeof parsed.customDir === 'string' ? parsed.customDir : '',
              settings: normalizeMusicSettings(parsed.settings),
            }
          }
        } catch (err) {}
      }
      return defaultMusicState()
    }

    // 原子写：先写同目录临时文件再 rename。为什么不用 writeFileSync 直写 —— 中途断电/宿主被杀
    // 会留下半个 JSON，下次读就是"设置每次都被重置"，而这种损坏最难排查（账本那边同理）。
    function writeMusicState(state) {
      const body = JSON.stringify({
        version: 1,
        customDir: typeof state.customDir === 'string' ? state.customDir : '',
        settings: normalizeMusicSettings(state.settings),
      }, null, 2)
      for (const p of MUSIC_FILE_CANDIDATES) {
        const temp = p + '.tmp-' + process.pid
        try {
          fs.writeFileSync(temp, body, 'utf8')
          fs.renameSync(temp, p)
          return true
        } catch (err) {
          try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch (cleanupErr) {}
        }
      }
      return false
    }

    // 曲目 id：绝对路径小写 + 正斜杠规范化后取 sha1 前 16 位。
    // 为什么不拿文件名/路径直接当 id：id 是**下发给浏览器**的，能反推路径就等于把用户的
    // 目录结构（常含用户名）暴露到页面上；而且 id 最终要参与"扫回来反查文件"，
    // 用一个纯十六进制串可以让"客户端字符串拼路径"这条路从根上走不通（见 findMusicTrack）。
    function musicIdOf(absPath) {
      const norm = String(absPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      return createHash('sha1').update(norm).digest('hex').slice(0, 16)
    }

    function musicExtOf(name) {
      const s = String(name || '')
      const i = s.lastIndexOf('.')
      return i > 0 ? s.slice(i + 1).toLowerCase() : ''
    }

    // f 是否在 dir 里（用于判定"这首歌属于托管目录"，删除权限只看这一个判断）
    function isInsideMusicDir(dir, absPath) {
      try {
        const rel = path.relative(path.resolve(dir), path.resolve(absPath))
        return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
      } catch (err) { return false }
    }

    // **只扫一层**（不递归子目录）：目录名是用户自己组织的，递归会把"还没整理/备份"的
    // 一堆音频也拉进歌单；只认 MUSIC_EXTS 白名单里的普通文件。
    // 返回的 path 只在本进程内用（不下发），下发给前端的字段见 musicPayload()。
    function scanMusicDir(dir, managed) {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (err) {
        return [] // 目录没了/没权限：当作空目录，由调用方决定要不要报 dirError
      }
      const out = []
      for (const ent of entries) {
        try {
          if (!ent.isFile()) continue
          const name = String(ent.name || '')
          const ext = musicExtOf(name)
          if (MUSIC_EXTS.indexOf(ext) < 0) continue
          const abs = path.join(dir, name)
          const st = fs.statSync(abs)
          if (!st.isFile()) continue
          out.push({
            id: musicIdOf(abs),
            name,
            title: name.slice(0, name.length - ext.length - 1),
            ext,
            size: st.size,
            mtime: Math.round(st.mtimeMs),
            inManaged: isInsideMusicDir(managed, abs),
            path: abs,
          })
        } catch (err) {}
      }
      return out
    }

    // 按文件名本地化排序：localeCompare + numeric —— 否则 track10 会排在 track2 前面，
    // 中文名也会按码点乱序（用户看到的是"歌单没排序"）。
    // 显式指定 zh-Hans-CN 是为了**跨机器稳定**（默认 locale 跟随系统，同一个目录换个环境顺序就变）；
    // 但 small-icu 的运行时可能不认这个 locale（localeCompare 会抛 RangeError）——排序失败绝不能
    // 把整个 music.json 打成 500，所以逐级退化到默认 locale、再退化到不依赖 ICU 的比较。
    function sortMusicTracks(tracks) {
      const byName = (locale) => (a, b) => String(a.name).localeCompare(String(b.name), locale, { numeric: true, sensitivity: 'base' })
      try {
        return tracks.slice().sort(byName('zh-Hans-CN'))
      } catch (err) {
        try { return tracks.slice().sort(byName(undefined)) } catch (err2) {
          return tracks.slice().sort((a, b) => (String(a.name) < String(b.name) ? -1 : (String(a.name) > String(b.name) ? 1 : 0)))
        }
      }
    }

    // 歌单 = 各扫描目录曲目的**并集**，按 id 去重、最后统一排序。
    // 为什么是并集而不是"只扫当前生效目录"：托管目录（whale-music/）是插件自己的曲库，
    // 里面的歌**必须始终出现在列表里** —— 否则用户一旦把扫描目录指向别的文件夹（自定义目录），
    // 刚导入进托管目录的歌就从列表里消失了，表现成"导入成功但列表里没有"。
    // 自定义目录只是"额外再扫一个文件夹"。去重按 id：两个目录相同时（或自定义目录失效、
    // dir 退回托管目录时）同一个文件只会出现一次。inManaged 仍由 scanMusicDir 按文件真实位置标注。
    function unionMusicTracks(dirs, managed) {
      const byId = new Map()
      for (const d of dirs) {
        for (const t of scanMusicDir(d, managed)) {
          if (!byId.has(t.id)) byId.set(t.id, t)
        }
      }
      return sortMusicTracks([...byId.values()])
    }

    // music.json 的响应体（GET 与四种 POST 成功时**同一个形状**，前端拿到就整体刷新）
    function musicPayload() {
      const managed = pickMusicDir()
      const state = readMusicState()
      const custom = state.customDir
      let dir = managed
      let dirError = null
      if (custom) {
        // 自定义目录失效（U 盘拔了 / 改名 / 权限没了）不能让整个接口 500：
        // 退回托管目录，并把原因用 dirError 下发给前端显示 —— 歌照放，用户也知道为什么少了歌。
        try {
          if (!fs.statSync(custom).isDirectory()) throw new Error('不是文件夹')
          fs.accessSync(custom, fs.constants.R_OK)
          dir = custom
        } catch (err) {
          dir = managed
          dirError = '自定义目录不可用：' + String((err && err.message) || err).slice(0, 120)
        }
      }
      // 扫描范围 = 当前生效目录 ∪ 托管目录；两者相同（含自定义目录失效退回托管目录）时只扫一次，
      // 并集里也就不会出现重复项。⚠️ dir 字段语义不变：它仍是"当前生效目录"，供面板显示。
      const scanDirs = dir === managed ? [managed] : [dir, managed]
      const payload = {
        ok: true,
        managed,
        dir,
        custom,
        tracks: unionMusicTracks(scanDirs, managed).map((t) => ({
          id: t.id,
          name: t.name,
          title: t.title,
          ext: t.ext,
          size: t.size,
          mtime: t.mtime,
          inManaged: t.inManaged,
          url: '/dsh-whale/music-file?id=' + t.id,
        })),
        settings: state.settings,
        supported: MUSIC_EXTS.slice(),
      }
      if (dirError) payload.dirError = dirError
      return payload
    }

    // id → 曲目：**每次都重新扫描目录并按 id 匹配**。
    // 这是防路径穿越的全部依据：客户端传来的字符串只参与「相等比较」（而且先按 16 位十六进制
    // 校验），返回的绝对路径来自 readdirSync 的目录项 —— 任何 `../` / 盘符 / NUL 都不可能进路径。
    // 扫描范围 = 当前生效目录 + 托管目录（**与 music.json 的歌单范围一致**，见 unionMusicTracks）：
    // 这样列表里给出的 id 与这里能解析出的路径永远对得上。
    function findMusicTrack(id) {
      if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return null
      const managed = pickMusicDir()
      const state = readMusicState()
      const dirs = []
      if (state.customDir) dirs.push(state.customDir)
      dirs.push(managed)
      for (const d of dirs) {
        for (const t of scanMusicDir(d, managed)) {
          if (t.id === id) return t
        }
      }
      return null
    }

    // 上传文件名消毒：name 是客户端给的字符串，不能让它影响落盘位置或形状。
    //   ① 只取最后一段（同时干掉 `../..` 与 `C:\`）② 去控制字符 ③ 去 Windows 非法字符
    //   ④ 去首部点（隐藏文件）与尾部点/空格（Windows 下建不出来）⑤ 限长
    //   ⑥ 扩展名一律用**校验过的 ext 重新拼**，不信任用户文件名里的后缀
    function sanitizeMusicName(rawName, ext) {
      let base = String(rawName || '').split(/[\\/]/).pop() || ''
      base = base.replace(/[\u0000-\u001f\u007f]/g, '')
      base = base.replace(/[<>:"|?*]/g, '_')
      base = base.trim().replace(/^\.+/, '').replace(/[. ]+$/, '')
      const innerExt = musicExtOf(base)
      if (innerExt && MUSIC_EXTS.indexOf(innerExt) >= 0) base = base.slice(0, base.length - innerExt.length - 1).replace(/[. ]+$/, '')
      if (base.length > 80) base = base.slice(0, 80).replace(/[. ]+$/, '')
      if (!base) return 'music.' + ext
      return base + '.' + ext
    }

    // 重名不覆盖：song.mp3 → song (2).mp3 → song (3).mp3 …
    //（同一首歌传两次很常见；覆盖掉等于静默删了用户原来的文件）
    function uniqueMusicName(dir, fileName) {
      const i = fileName.lastIndexOf('.')
      const stem = i > 0 ? fileName.slice(0, i) : fileName
      const ext = i > 0 ? fileName.slice(i) : ''
      if (!fs.existsSync(path.join(dir, fileName))) return fileName
      for (let n = 2; n < 1000; n++) {
        const cand = stem + ' (' + n + ')' + ext
        if (!fs.existsSync(path.join(dir, cand))) return cand
      }
      return stem + ' (' + Date.now().toString(36) + ')' + ext
    }

    // Range 解析（只支持单段，三种写法）：
    //   `bytes=a-b` 闭区间；b 越界按末尾截断（RFC 7233 允许收窄）
    //   `bytes=a-`  从 a 到末尾
    //   `bytes=-n`  末尾 n 字节（浏览器 seek 时常用：先探尾巴拿总长度）
    // 返回 null（没有 Range 头 → 全量 200）/ {start,end}（→ 206）/ {unsatisfiable:true}（→ 416）。
    // 多段 Range（`a-b,c-d`）不支持：一律按不可满足回 416 —— 浏览器收到 416 会自动退回单段/全量，
    // 比"我们自己拼 multipart/byteranges"简单且不会拼错。
    function parseMusicRange(header, total) {
      const raw = String(header || '').trim()
      if (!raw) return null
      if (!/^bytes=/i.test(raw)) return { unsatisfiable: true }
      const spec = raw.slice(raw.indexOf('=') + 1)
      if (spec.indexOf(',') >= 0) return { unsatisfiable: true } // 多段不支持
      const m = /^(\d*)-(\d*)$/.exec(spec.trim())
      if (!m) return { unsatisfiable: true }
      const hasStart = m[1] !== ''
      const hasEnd = m[2] !== ''
      if (!hasStart && !hasEnd) return { unsatisfiable: true }
      if (total <= 0) return { unsatisfiable: true } // 空文件没有任何可满足的区间
      if (!hasStart) {
        const n = Number(m[2])
        if (!isFinite(n) || n <= 0) return { unsatisfiable: true } // `bytes=-0` 按 RFC 是不可满足
        return { start: Math.max(0, total - n), end: total - 1 }
      }
      const start = Number(m[1])
      if (!isFinite(start) || start >= total) return { unsatisfiable: true } // start 越界（含 start == total）
      let end = hasEnd ? Number(m[2]) : total - 1
      if (hasEnd && (!isFinite(end) || end < start)) return { unsatisfiable: true }
      if (end > total - 1) end = total - 1
      return { start, end }
    }

    function musicIdFromUrl(url) {
      try {
        const q = String(url || '').split('?')[1] || ''
        const m = /(?:^|&)id=([^&]+)/.exec(q)
        return m ? decodeURIComponent(m[1]) : ''
      } catch (err) { return '' }
    }

    // —— 音乐接口 ①：列表 + 设置（GET）/ 四种 action（POST）——
    // 写请求的"来源必须是本机（回环）"判断**不在这个 handler 里**：它由 registerRoute() 的
    // 统一包装器（rejected → writeRejection）先跑，非回环的 POST 在进到这里之前就已经 403 了。
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/music.json',
      handler: async (req, res) => {
        if (req.method === 'POST' || req.method === 'PUT') {
          try {
            // body 上限 64MB：上传是唯一的大 body（base64 音频塞在 JSON 里）。
            // 与 MUSIC_MAX_BYTES（48MB，解码后）配套：48 × 4/3 ≈ 64，两者不能单独改。
            let body
            try {
              body = await readBodyMax(req, 64 * 1024 * 1024)
            } catch (err) {
              // body 超限也要说清"上限是多少"：base64 把音频放大 4/3 倍 ⇒ 先撞上 body 上限的
              // 正是"音频太大"这一种情况（JSON 外壳只有几十字节），所以这里直接报音频上限，
              // 而不是把 readBodyMax 的 "body too large" 抛给用户看。
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: '音频超过 ' + MUSIC_MAX_MB + 'MB 上限' }))
              return
            }
            const parsed = JSON.parse(body)
            const action = String((parsed && parsed.action) || '')
            if (action === 'set-settings') {
              // 只接受白名单键（volume/loop/shuffle/pressMode/autoplay），未知键忽略；
              // 合并写入（没传的键保持原值，避免"只改音量"把循环模式洗回默认）
              const state = readMusicState()
              state.settings = normalizeMusicSettings(parsed.settings, state.settings)
              writeMusicState(state)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify(musicPayload()))
              return
            }
            if (action === 'set-dir') {
              const raw = String((parsed && parsed.dir) || '').trim()
              const state = readMusicState()
              if (!raw) {
                state.customDir = '' // '' = 复位为托管目录（不是"清除字段"）
              } else {
                const abs = path.resolve(raw)
                let isDir = false
                try { isDir = fs.statSync(abs).isDirectory() } catch (err) {}
                if (!isDir) {
                  res.writeHead(400, JSON_HEADERS)
                  res.end(JSON.stringify({ ok: false, error: '目录不存在或不是文件夹' }))
                  return
                }
                // 存绝对路径：相对路径会被解析到宿主进程的工作目录，重启/换启动方式就漂了
                state.customDir = abs
              }
              writeMusicState(state)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify(musicPayload()))
              return
            }
            if (action === 'upload') {
              const dataUrl = String((parsed && parsed.dataUrl) || '')
              const m = /^data:audio\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl)
              const extFromMime = m ? MUSIC_EXT_BY_MIME[m[1].toLowerCase()] : null
              if (!m || !extFromMime) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: '音频数据格式不受支持（只接受 data:audio/<白名单格式>;base64,）' }))
                return
              }
              const buf = Buffer.from(m[2], 'base64')
              if (!buf.length) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: '音频数据为空' }))
                return
              }
              if (buf.length > MUSIC_MAX_BYTES) {
                // 文案里的数字从常量算：改了上限不会出现"上限 48MB 但提示写 64MB"
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: '音频超过 ' + MUSIC_MAX_MB + 'MB 上限' }))
                return
              }
              // 扩展名：name 的后缀在白名单里就用它（用户最清楚），否则按 mime 推断。
              // 两者都不认的情况在上面已经 400（MUSIC_EXT_BY_MIME 本身就是 mime 白名单）。
              const nameExt = musicExtOf(parsed && parsed.name)
              const ext = MUSIC_EXTS.indexOf(nameExt) >= 0 ? nameExt : extFromMime
              // ⚠️ 一律写进**托管目录**（即使当前扫的是自定义目录）：
              //   上传物是插件自己管理的，而"可删除"的边界也只有托管目录 —— 两边必须一致，
              //   否则会出现"传上去了却删不掉"（见 delete 分支）。
              const dir = pickMusicDir()
              const fileName = uniqueMusicName(dir, sanitizeMusicName(parsed && parsed.name, ext))
              const filePath = path.join(dir, fileName)
              fs.writeFileSync(filePath, buf)
              // 返回体与 GET 同形，另带 id：新文件的 id 直接由落盘路径算（而不是靠扫回来找）。
              // 歌单是「生效目录 ∪ 托管目录」，所以这首歌在 tracks[] 里一定看得见（inManaged=true），
              // 前端不需要靠这个 id 猜。
              const payload = musicPayload()
              payload.id = musicIdOf(filePath)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify(payload))
              return
            }
            if (action === 'delete') {
              const track = findMusicTrack(String((parsed && parsed.id) || ''))
              if (!track) {
                res.writeHead(404, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: '未找到该音频文件' }))
                return
              }
              // 安全边界：**只删托管目录**。自定义目录是用户自己的音乐库（可能是整个曲库目录），
              // "插件能扫到"不等于"插件有权删" —— 明确拒绝并说明原因。
              if (!track.inManaged) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: '自定义目录里的文件不会被插件删除' }))
                return
              }
              try { fs.unlinkSync(track.path) } catch (err) {}
              // 播放列表是每次扫目录算出来的（没有索引文件要清理），状态文件里也不存曲目
              //（删一首歌不该动用户的音量/循环设置），所以这里没有额外的清理动作。
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify(musicPayload()))
              return
            }
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
          }
          return
        }
        // GET：列表 + 设置一次拿齐（前端不用为设置再发一次请求）。
        // 外面再包一层 try：musicPayload() 内部已尽量不抛（坏目录/坏状态文件都兜底），
        // 但"歌单接口 500"对用户就是整个播放器打不开 —— 宁可回一个 ok:false 的错误体。
        try {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(musicPayload()))
        } catch (err) {
          res.writeHead(500, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    // —— 音乐接口 ②：音频字节（<audio> 的 src）——
    // 关键在 Range：**浏览器靠 206 判断"这条 URL 可以拖动进度条"**。只返 200 全量时，
    // 进度条会退化成"只能从头播、不能 seek"（甚至不显示总时长），所以 200/206/416 三条路径
    // 都必须给出正确的 Content-Range / Accept-Ranges。
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/music-file',
      handler: (req, res) => {
        try {
          const track = findMusicTrack(musicIdFromUrl(req.url))
          if (!track) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end('music unavailable')
            return
          }
          const total = track.size
          const mime = MUSIC_MIME_BY_EXT[track.ext] || 'application/octet-stream'
          const range = parseMusicRange(req.headers && req.headers.range, total)
          if (range && range.unsatisfiable) {
            // 416 必须带 Content-Range 的「bytes + 星号 + 斜杠 + 总长」形式（即 bytes 空格 星号 斜杠 total）：
            // 少了它浏览器会认为服务器不懂 Range，于是永远不做分段请求（表现为"拖不动进度条"）。
            // ⚠️ 这里刻意不写出那两个字符的连写 —— tools/check-dead-settings.mjs 用
            //    /\/\*[\s\S]*?\*\// 粗暴地剥块注释，源码里多一处裸的结束标记就会把一大段代码
            //    （含前端）当成注释吃掉，审计直接误报 8 个"死键"（实测踩过）。
            res.writeHead(416, {
              'Content-Type': mime,
              'Content-Range': 'bytes ' + '*' + '/' + total,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-store',
              'Content-Length': '0',
            })
            res.end()
            return
          }
          const start = range ? range.start : 0
          const end = range ? range.end : total - 1
          const headers = {
            'Content-Type': mime,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(total > 0 ? end - start + 1 : 0),
            'Cache-Control': 'no-store',
          }
          if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total
          res.writeHead(range ? 206 : 200, headers)
          if (total <= 0) { res.end(); return } // 空文件：createReadStream 的 end=-1 会抛范围错
          // 流式下发（**绝不** readFileSync 整个文件）：一首 flac 动辄几十 MB，整读进内存
          // 会在拖动进度条时让宿主明显卡顿，大文件还可能把内存打爆。
          const stream = fs.createReadStream(track.path, { start, end })
          stream.on('error', () => { try { res.destroy() } catch (err) {} })
          stream.pipe(res)
        } catch (err) {
          try {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end('music unavailable')
          } catch (e2) {}
        }
      },
    }))

    // ===================== 在线电台（Radio Browser / SomaFM）=====================
    // 与"音乐播放器"并列的第二套音频来源：那边播**本机文件**，这边播**网络流**。
    // 三条路由：radio.json（收藏 + 上次来源，读写各一次）、radio-search（上游搜索，仅回环）、
    // radio-stream（音频流代理，仅回环）。两条只读接口里，radio-search / radio-stream
    // **连读都要求回环** —— 它们会替宿主向外发请求，口径见 radioLoopbackRejection()。

    // 状态文件字段一律**先消毒再落盘**：body 来自页面，超长字符串或非数字 bitrate 一旦写进去，
    // 以后每次 GET 都要把它序列化下发给前端（而且用户手改坏文件时也要能读回来）。
    function radioText(value, max) {
      const s = value === undefined || value === null ? '' : String(value)
      return s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
    }
    function radioInt(value, max) {
      const n = Number(value)
      return isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : 0
    }

    // 归一化一条电台。**契约字段固定**（前端按它渲染），多余字段一律丢掉 ——
    // 上游（尤其 Radio Browser）会返回几十个字段，全存进状态文件既没用又会随上游变动而膨胀。
    // withVotes 只在下发给"搜索结果"时为 true：收藏里不存票数（票数会过期，存下来只会误导）。
    function normalizeRadioStation(raw, fallbackSource, withVotes) {
      const s = raw && typeof raw === 'object' ? raw : {}
      const out = {
        id: radioText(s.id, 120),
        name: radioText(s.name, 200),
        url: radioText(s.url, 2000),
        favicon: radioText(s.favicon, 1000),
        tags: radioText(s.tags, 400),
        country: radioText(s.country, 100),
        codec: radioText(s.codec, 40),
        bitrate: radioInt(s.bitrate, 1000000),
      }
      if (withVotes) out.votes = radioInt(s.votes, 100000000)
      const src = String(s.source || fallbackSource || '')
      out.source = src === 'somafm' ? 'somafm' : 'rb'
      return out
    }

    function defaultRadioState() {
      return { version: 1, lastSource: 'rb', updatedAt: 0, favorites: [] }
    }

    function readRadioState() {
      for (const p of RADIO_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          // 文件在但结构不对（手改坏 / 旧格式）→ 兜底默认值，**绝不抛**：
          // 抛出去会让 radio.json 直接 500，收藏与"上次来源"一起点不开。
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.favorites)) {
            return {
              version: 1,
              lastSource: parsed.lastSource === 'somafm' ? 'somafm' : 'rb',
              updatedAt: radioInt(parsed.updatedAt, Number.MAX_SAFE_INTEGER),
              // 读回来也过一遍归一化：上限在这里再兜一次（用户手改大数组时不会把响应撑爆）
              favorites: parsed.favorites.filter((f) => f && typeof f === 'object')
                .slice(0, RADIO_MAX_FAVORITES).map((f) => normalizeRadioStation(f, f.source, false)),
            }
          }
        } catch (err) {}
      }
      return defaultRadioState()
    }

    // 原子写：先写同目录临时文件再 rename（与 writeMusicState 同一写法，理由见那里的注释 ——
    // 中途被杀会留下半个 JSON，下次读就是"收藏全没了"）。updatedAt 由这里统一盖章。
    function writeRadioState(state) {
      const body = JSON.stringify({
        version: 1,
        lastSource: state && state.lastSource === 'somafm' ? 'somafm' : 'rb',
        updatedAt: Date.now(),
        favorites: ((state && state.favorites) || []).slice(0, RADIO_MAX_FAVORITES)
          .map((f) => normalizeRadioStation(f, f.source, false)),
      }, null, 2)
      for (const p of RADIO_FILE_CANDIDATES) {
        const temp = p + '.tmp-' + process.pid
        try {
          fs.writeFileSync(temp, body, 'utf8')
          fs.renameSync(temp, p)
          return true
        } catch (err) {
          try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch (cleanupErr) {}
        }
      }
      return false
    }

    // radio.json 的响应体（GET 与三种 action 成功时**同一个形状**，前端拿到就整体刷新）
    function radioPayload() {
      const state = readRadioState()
      return {
        ok: true,
        lastSource: state.lastSource,
        favorites: state.favorites,
        sources: {
          // rb 的 base 报**当前生效**的镜像（进程内第一个可用的；尚未探测过时报显式 BASE 或镜像表第一个）
          rb: { label: RADIO_SOURCE_LABELS.rb, base: radioRbBase },
          somafm: { label: RADIO_SOURCE_LABELS.somafm, base: SOMAFM_URL },
        },
        limits: { maxFavorites: RADIO_MAX_FAVORITES, maxStreams: RADIO_MAX_STREAMS },
      }
    }

    // —— 电台的"读也要求回环"栅栏 ——
    // 与其它只读接口不同：radio-search / radio-stream 会**代表宿主**向外部地址发请求
    //（搜索打上游 API、代理把上游字节中转到页面）。局域网里的一个 DSH 会话不该能借宿主的
    // 网络身份去打外部或内网地址，所以这两条路由只认回环，**不接受** DSHW_TRUSTED_HOSTS /
    // DSHW_ADMIN_HOSTS 的声明（那是"远程管理"的口子，不是"远程代理"的口子）。
    // 回环判定复用 isLoopbackHostname（不另造一套），缺 Host / 畸形地址一律按拒绝处理（fail-closed）。
    function radioLoopbackRejection(req, res) {
      try {
        const headers = (req && req.headers) || {}
        const hostUrl = new URL('http://' + String(headers.host || ''))
        if (isLoopbackHostname(hostUrl.hostname)) return false
      } catch (err) {} // 走下面的 403
      try {
        res.writeHead(403, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: '在线电台接口仅限本机（回环地址）访问' }))
      } catch (e2) {}
      return true
    }

    // —— SSRF 防护：返回 null = 放行，否则返回 {status, error}（error 是中文原因，直接下发前端）——
    // 状态码的分配：**请求本身就畸形**（非 http/https、带用户名密码、没有主机名）→ 400；
    // **目标地址不安全**（回环 / 私网 / 链路本地 / 保留段 / 本地解析域名）→ 403；
    // **解析不出来 / 我们自己的内部错误** → 5xx（见 radioResolveFailure，**不是** 403）。
    // 检查顺序固定：协议 → 用户名密码 → 显式放行名单 → 回环/域名后缀 → **全部**解析地址的范围。
    // 逐跳都要重新调用它（见 radioProxyStream）：第一跳是公网、第二跳跳回 127.0.0.1
    // 是最经典的 SSRF 绕过方式，只在入口查一次等于没查。
    async function radioTargetRejection(target) {
      let u = null
      try { u = new URL(String(target)) } catch (err) { return { status: 400, error: '地址无法解析' } }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { status: 400, error: '只允许 http/https 地址' }
      // `https://user:pass@host/` 一律拒：凭据会随请求发出去，而且这是"藏在 URL 里的秘密"
      if (u.username || u.password) return { status: 400, error: '地址里不允许带用户名或密码' }
      const host = radioHostOf(u)
      if (!host) return { status: 400, error: '地址缺少主机名' }
      const port = u.port || (u.protocol === 'https:' ? '443' : '80')
      // 显式放行名单：**只**跳过下面的内网判定（协议、凭据、逐跳重定向、Content-Type 照旧）
      if (radioAllowHit(host, port)) return null
      if (isLoopbackHostname(host)) return { status: 403, error: '拒绝内网地址（回环）' }
      const byName = radioHostnameSuffixRejection(host)
      if (byName) return { status: 403, error: byName }
      let addrs = []
      try {
        // ⚠️ 必须用 dns.promises.lookup。**回调式的 `dns.lookup(host, {all:true})` 少了 callback 会
        //   直接抛 ERR_INVALID_ARG_TYPE**（它不是"解析失败"），而这个抛被下面的 catch 吞成
        //   "域名无法解析 → 403" —— 于是所有**以主机名给出的目标**（真实电台 ice1.somafm.com 等）
        //   一律被拒，而 IP 字面量与放行命中根本不走这条分支，只看状态码的断言完全发现不了。
        //   改动这里请务必跑「主机名 + 不在放行名单」的用例（radio-harness 里有一条真实主机名用例）。
        // 对 IP 字面量（含 IPv6，方括号已在 radioHostOf 里去掉）它同样返回自身，所以这一条同时
        // 覆盖"域名"与"字面量"两种输入，不需要再引 net.isIP 分叉（少一条分支就少一处漏判）。
        addrs = await dns.promises.lookup(host, { all: true })
      } catch (err) {
        return radioResolveFailure(host, err)
      }
      if (!Array.isArray(addrs) || !addrs.length) return { status: 502, error: '域名无法解析' }
      // ⚠️ 必须看**全部**地址：只看第一条时，"第一条公网 + 第二条 127.0.0.1"的多 A 记录
      // 或 DNS rebinding 就能绕过。任一条命中即拒。
      for (const a of addrs) {
        const addr = a && a.address ? String(a.address) : ''
        const reason = a && Number(a.family) === 6 ? radioIpv6Rejection(addr) : radioIpv4Rejection(addr)
        if (reason) return { status: 403, error: reason }
      }
      return null
    }

    // DNS 解析失败时怎么答 —— 这里区分两件**性质完全不同**的事：
    //   ① 正常解析不出来（ENOTFOUND / EAI_AGAIN / ENODATA…）：属于"上游不可达" → **502**。
    //      以前这里回 403，用户与前端会把它读成"这台机器被回环限制"，排查方向整个被带偏。
    //   ② `ERR_*`（Node 内部错误 / 参数类型错）= **我们自己代码写错**的编程错误：绝不能伪装成
    //      "地址不安全"被静默 fail-closed —— 那会让真实故障看起来像安全拦截（本文件真踩过：
    //      dns 回调式 API 用错 → 所有真实电台一致"域名无法解析"）→ **500** 并在宿主日志留痕。
    // 两种情况都**不把** Node 内部错误码或原始英文 message 放进 `error`（用户看不懂、也容易被
    // 当成电台本身的问题）；原始信息只进 console.warn，供排查用。
    function radioResolveFailure(host, err) {
      const code = String((err && err.code) || '')
      try {
        console.warn('[whale-balance] 电台目标域名解析失败：host=' + host + ' code=' + (code || '(无)') + ' msg='
          + String((err && err.message) || err).replace(/[\r\n]+/g, ' ').slice(0, 200))
      } catch (warnErr) {}
      if (code.indexOf('ERR_') === 0) return { status: 500, error: '宿主解析上游地址失败（内部错误，详见宿主日志）' }
      return { status: 502, error: '域名无法解析' }
    }

    // —— 搜索：limit 归一（缺省 30 / 上限 50 / 非法值回落默认）——
    function radioSearchLimit(raw) {
      const n = Number(String(raw === undefined || raw === null ? '' : raw).trim())
      if (!isFinite(n) || n <= 0) return RADIO_SEARCH_DEFAULT_LIMIT // 空 / abc / 0 / 负数都走这里
      return Math.min(Math.floor(n), RADIO_SEARCH_MAX_LIMIT)
    }

    // 上游 JSON 请求（SomaFM 频道表这类**单一地址**的上游）：统一 10s 整请求超时。
    // 这里 follow 重定向是**安全**的：URL 由我们自己拼（用户输入只经 URLSearchParams 进查询串），
    // 与 radio-stream 那条"用户直接给 URL"的路由完全不同，所以不需要手动逐跳。
    // Radio Browser 不走这个函数 —— 它有镜像回退与更严的"可用"判据，见 radioFetchRbJson。
    async function radioFetchJson(target) {
      const res = await fetch(target, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': RADIO_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(RADIO_JSON_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error('上游返回 HTTP ' + res.status)
      return await res.json()
    }

    // 本次进程内**第一个被证明可用**的 Radio Browser 镜像（后续搜索直接用它，不再重试坏镜像）。
    // 初值：显式 BASE（若设了，离线端到端验证就是靠它指向桩）→ 否则镜像表第一个。
    // 它同时是 radio.json 里 `sources.rb.base`（"生效的上游"）的来源。
    let radioRbBase = RADIO_BROWSER_EXPLICIT || RADIO_BROWSER_MIRRORS[0] || ''
    // 候选顺序：记住的 → 显式 → 镜像表（按 URL 去重，避免同一个镜像试两遍）
    function radioRbCandidates() {
      const out = []
      for (const b of [radioRbBase, RADIO_BROWSER_EXPLICIT].concat(RADIO_BROWSER_MIRRORS)) {
        if (b && out.indexOf(b) < 0) out.push(b)
      }
      return out
    }
    // 探测"这个 Radio Browser 镜像真的能用"：判据刻意**严**（2xx + Content-Type 含 json +
    // body 能 JSON.parse 成**数组**）。只判"HTTP 通了"是不够的 —— 本网络里
    // api.radio-browser.info 会回 404 + text/html（一个普通网页），那是"通但不可用"。
    async function radioFetchRbJson(url, timeoutMs) {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': RADIO_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error('镜像返回 HTTP ' + res.status)
      const ctype = String(res.headers.get('content-type') || '').toLowerCase()
      if (ctype.indexOf('json') < 0) throw new Error('镜像返回的不是 JSON（' + (ctype.split(';')[0] || '无 Content-Type') + '）')
      const data = await res.json() // 坏 JSON 在这里抛，由调用方当作"这个镜像不可用"
      if (!Array.isArray(data)) throw new Error('镜像返回的 JSON 不是数组')
      return data
    }

    async function radioSearchRb(params) {
      const search = new URLSearchParams()
      search.set('hidebroken', 'true')
      search.set('order', 'votes')
      search.set('reverse', 'true')
      search.set('limit', String(params.limit))
      // q 为空时**不带** name：同一个接口在只有排序参数时返回的就是"票数最高的前 n 个"，
      // 所以"空查询 + tag/country"和"空查询 + 什么都没有"都不需要另走一条分支。
      if (params.q) search.set('name', params.q)
      if (params.country) search.set('countrycode', params.country)
      if (params.tag) search.set('tag', params.tag)
      const qs = search.toString()
      let last = ''
      // 总预算：每个镜像的单次超时取 min(6s, 剩余预算)，预算耗尽就不再试后面的候选
      const deadline = Date.now() + RADIO_BROWSER_TOTAL_BUDGET_MS
      for (const base of radioRbCandidates()) {
        const budgetLeft = deadline - Date.now()
        if (budgetLeft < 1500) { last = '总预算耗尽'; break }
        let data = null
        try {
          data = await radioFetchRbJson(base + '/json/stations/search?' + qs, Math.min(RADIO_BROWSER_PROBE_TIMEOUT_MS, budgetLeft))
        } catch (err) {
          last = String((err && err.message) || err)
          try {
            console.warn('[whale-balance] Radio Browser 镜像不可用，尝试下一个：' + base + ' —— ' + last.replace(/[\r\n]+/g, ' ').slice(0, 160))
          } catch (warnErr) {}
          continue
        }
        radioRbBase = base // 记住它：后续搜索直接从它开始
        const out = []
        for (const s of data) {
          if (!s || typeof s !== 'object') continue
          // url_resolved 才是最终直连地址（url 可能是个跳转页/播放器页），优先用它；
          // 两个都空的条目对播放毫无用处，直接丢掉（否则前端拿到一条点了没反应的电台）。
          const url = radioText(s.url_resolved || s.url || '', 2000).trim()
          if (!url) continue
          out.push(normalizeRadioStation({
            id: s.stationuuid,
            name: s.name,
            url: url,
            favicon: s.favicon,
            tags: s.tags,
            country: s.country,
            codec: s.codec,
            bitrate: s.bitrate,
            votes: s.votes,
          }, 'rb', true))
          if (out.length >= params.limit) break
        }
        return out
      }
      throw new Error('所有 Radio Browser 镜像都不可达')
    }

    // playlist 取舍：优先 mp3（浏览器 `<audio>` 对它支持最稳），同类里选 quality 最高的一条；
    // 一个 mp3 都没有就取 quality 最高的第一条（至少还能播，总比"这个台搜得到点不开"好）。
    function radioQualityRank(p) {
      const q = radioText(p && p.quality, 40).toLowerCase()
      const n = /(\d{2,4})/.exec(q)
      if (n) return Number(n[1])
      if (q.indexOf('highest') >= 0) return 1000
      if (q.indexOf('high') >= 0) return 500
      if (q.indexOf('medium') >= 0 || q.indexOf('mid') >= 0) return 250
      if (q.indexOf('low') >= 0) return 100
      return 0
    }
    // format → codec：`aacp`（HE-AAC）也算 aac；不认识的原样透出（总比编一个强）。
    // **不从 URL 里猜编码**：SomaFM 的真实地址是 .pls，里面没有编码信息（只有 .pls 的内容才有）。
    function radioCodecOf(format) {
      const f = radioText(format, 40).trim().toLowerCase()
      if (!f) return ''
      if (f.indexOf('mp3') >= 0) return 'mp3'
      if (f.indexOf('aac') >= 0) return 'aac'
      return f
    }
    // bitrate 的取值优先级（越靠前越准）：
    //   ① quality 里的数字（`128k` 这类，桩与部分镜像会给）；
    //   ② **播放列表 URL 自带的码率**：SomaFM 真实地址形如 `groovesalad256.pls` → 256、
    //      `beatblender130.pls` → 130 —— 这是真实数据，比猜词准；
    //   ③ quality 词映射（highest/high/medium/low）—— **近似值**，真实码率只有 .pls 里的
    //      File1 才知道，但总比给前端一个 0（会显示成"0kbps"）好。
    function radioBitrateOf(quality, url) {
      const qn = /(\d{2,4})/.exec(radioText(quality, 40))
      if (qn) return Number(qn[1])
      const un = /(\d{2,3})\.(?:pls|m3u8?)(?:[?#]|$)/i.exec(radioText(url, 2000))
      if (un) return Number(un[1])
      const q = radioText(quality, 40).toLowerCase()
      if (q.indexOf('highest') >= 0) return 256
      if (q.indexOf('high') >= 0) return 128
      if (q.indexOf('medium') >= 0 || q.indexOf('mid') >= 0) return 96
      if (q.indexOf('low') >= 0) return 64
      return 0
    }
    // codec / bitrate 都从 playlist 的 format/quality（以及 URL 里的码率数字）推出来
    function radioSomafmPlaylist(playlists) {
      const list = Array.isArray(playlists)
        ? playlists.filter((p) => p && typeof p === 'object' && radioText(p.url, 2000).trim())
        : []
      if (!list.length) return null
      const ranked = list.slice().sort((a, b) => radioQualityRank(b) - radioQualityRank(a))
      const mp3 = ranked.filter((p) => radioText(p.format, 40).toLowerCase().indexOf('mp3') >= 0)
      const pick = mp3.length ? mp3[0] : ranked[0]
      const url = radioText(pick.url, 2000).trim()
      return { url: url, codec: radioCodecOf(pick.format), bitrate: radioBitrateOf(pick.quality, url) }
    }
    // SomaFM 的 image 字段可能是相对路径（/img/xxx.png）→ 用 channels.json 的地址补全；
    // 不补的话前端 `<img src>` 会指向挂件自己那个源，图标必然 404。
    function radioSomafmImage(ch) {
      const raw = radioText(ch && (ch.image || ch.largeimage || ch.xlimage), 1000).trim()
      if (!raw) return ''
      if (/^https?:\/\//i.test(raw)) return raw
      try { return new URL(raw, SOMAFM_URL).toString() } catch (err) { return '' }
    }

    async function radioSearchSomafm(params) {
      const data = await radioFetchJson(SOMAFM_URL)
      const channels = data && Array.isArray(data.channels) ? data.channels : []
      const q = String(params.q || '').toLowerCase()
      const out = []
      for (const ch of channels) {
        if (!ch || typeof ch !== 'object') continue
        const id = radioText(ch.id, 120)
        const title = radioText(ch.title, 200)
        const desc = radioText(ch.description, 2000)
        const genre = radioText(ch.genre, 400)
        // q 为空 = 全部；否则在 title / description / genre / id 里做**不区分大小写**的包含匹配。
        // 刻意不做分词/模糊匹配：SomaFM 只有几十个台，一个子串匹配就够，模糊匹配只会给出
        // 用户看不懂的命中（而且本地化排序在 small-icu 上还可能抛）。
        if (q) {
          const hay = (title + '\n' + desc + '\n' + genre + '\n' + id).toLowerCase()
          if (hay.indexOf(q) < 0) continue
        }
        const pick = radioSomafmPlaylist(ch.playlists)
        if (!pick) continue
        out.push(normalizeRadioStation({
          id: id,
          name: title,
          url: pick.url,
          favicon: radioSomafmImage(ch),
          // tags 用 genre（前端只做截断显示）；个别频道没有 genre 时退回截断的 description，
          // 否则前端那一行会是空的。
          tags: genre || radioText(desc, 120),
          country: 'US',
          codec: pick.codec,
          bitrate: pick.bitrate,
        }, 'somafm', true))
        if (out.length >= params.limit) break
      }
      return out
    }

    // 带状态码的错误：让"哪一步失败 → 回哪个状态码"在一处决定（handler 里只做映射），
    // 避免在深层函数里直接写响应（写了就再也改不了状态码，而且容易重复写）。
    function radioHttpError(status, message) {
      const err = new Error(message)
      err.radioStatus = status
      return err
    }
    // 失败文案一律**可读中文**：这些字会直接显示在播放器的错误提示里。
    // ⚠️ **绝不**把 Node/undici 的内部错误码或原始英文 message 透出去（ERR_* / EAI_* / "fetch failed" /
    //    "getaddrinfo ENOTFOUND …"）：用户看不懂，而且会把"上游连不上"误读成电台或插件坏了。
    //    我们自己的中文文案（"上游返回 HTTP 500"、"域名无法解析"…）原样放行；其余一律收敛成
    //    "上游不可达"，原始信息只进宿主日志。
    function radioErrText(err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return '上游超时'
      const code = String((err && err.code) || (err && err.cause && err.cause.code) || '')
      const msg = String((err && err.message) || err || '').replace(/[\r\n]+/g, ' ').replace(/\s+$/, '').slice(0, 140)
      // 我们自己写的文案里可能夹着英文（如 "所有 Radio Browser 镜像都不可达"）⇒ 判"含中文"而不是
      // "以中文开头"，否则这类文案会被误收敛成"上游不可达"、丢掉真正的原因。
      if (/[\u3400-\u9fff]/.test(msg)) return msg
      try {
        console.warn('[whale-balance] 电台上游请求失败：code=' + (code || '(无)') + ' msg=' + msg.slice(0, 200))
      } catch (warnErr) {}
      return '上游不可达'
    }
    function radioStreamError(res, code, message) {
      try {
        res.writeHead(code, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: message }))
      } catch (err) {}
    }

    // 同时在转的流数量（上限 RADIO_MAX_STREAMS）。计数必须与**响应/连接的生命周期**绑定，
    // 任何一条路径漏减都会让并发数只增不减，最后所有请求全 429（见 radioProxyStream 的 finally）。
    let radioStreams = 0

    // 按同一套 SSRF 管线取回一个上游响应：**逐跳手动跟随重定向，每一跳重新过
    // radioTargetRejection**（含 DNS 解析后的范围判定）。返回 { up, url }。
    // rangeHeader 只在"这已经是音频流本身"时传：播放列表是小文本文件，带 Range 只会被截断。
    async function radioOpenUpstream(current, ac, rangeHeader) {
      let timer = null
      const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
      try {
        for (let hop = 0; ; hop++) {
          const bad = await radioTargetRejection(current)
          if (bad) throw radioHttpError(bad.status, bad.error)
          // ⚠️ Accept 的值刻意用拼接写：`*` + `/` + `*` 的**连写**会让 check-dead-settings.mjs
          //    那个粗暴的块注释剥离正则把它当成注释结束符，从而吃掉一大段代码并误报死键
          //（同一个坑在 music-file 的 416 Content-Range 那里已经踩过一次，见那里的注释）。
          const headers = { 'User-Agent': RADIO_UA, Accept: '*' + '/' + '*' }
          // 不少电台校验 Referer，缺了直接 403 —— 用目标自己的 origin 兜一个（不伪造别的站）
          try {
            const cu = new URL(current)
            headers.Referer = cu.protocol + '//' + cu.host + '/'
          } catch (err) {}
          if (rangeHeader) headers.Range = rangeHeader // 透传客户端 Range；没有/不该带就不带
          // 超时只覆盖"连接 + 首字节"：一旦响应头到手就撤掉计时器 ——
          // 电台是**无限流**，给整条流一个 15s 总超时等于"每次听到 15 秒就断"。
          timer = setTimeout(() => {
            try { ac.abort(radioHttpError(504, '上游超时')) } catch (err) {}
          }, RADIO_STREAM_TIMEOUT_MS)
          let up = null
          try {
            up = await fetch(current, {
              // 一律用 GET：HEAD 交给上游**不可靠**（有些 Icecast 直接 405），而 HEAD 预检要求
              // "状态码与 GET 一致" —— 用同一个方法取头，判定天然一致；HEAD 只是不写 body（见下）。
              method: 'GET',
              redirect: 'manual',
              headers: headers,
              signal: ac.signal,
            })
          } finally { clearTimer() }
          if (up.status >= 300 && up.status < 400) {
            const loc = up.headers.get('location')
            try { if (up.body) await up.body.cancel() } catch (err) {}
            if (!loc) throw radioHttpError(502, '上游返回了重定向但没有 Location')
            if (hop >= RADIO_STREAM_MAX_HOPS) throw radioHttpError(502, '上游重定向次数过多')
            try { current = new URL(loc, current).toString() } catch (err) {
              throw radioHttpError(502, '上游重定向地址无法解析')
            }
            continue
          }
          return { up: up, url: current }
        }
      } finally { clearTimer() }
    }

    // 读一小段文本（播放列表）：限长，读完**一定** cancel，别把上游连接挂在那里。
    async function radioReadTextLimited(up, maxBytes) {
      if (!up.body) return ''
      const reader = up.body.getReader()
      const chunks = []
      let size = 0
      try {
        for (;;) {
          const c = await reader.read()
          if (c.done) break
          if (!c.value || !c.value.length) continue
          size += c.value.length
          if (size > maxBytes) throw new Error('playlist too large')
          chunks.push(Buffer.from(c.value))
        }
      } finally {
        try { await reader.cancel() } catch (err) {}
      }
      return Buffer.concat(chunks).toString('utf8')
    }

    // —— 音频流代理 ——
    // 为什么必须有代理而不是让前端直接 `<audio src=上游>`：
    //   ① 上游多半不带 CORS 头，跨源会被浏览器拦；② 不少电台校验 Referer/UA；
    //   ③ https 页面放 http 电台会被"混合内容"拦掉 —— 经宿主的同源 http 中转才都能放。
    // 代价是这条路由会**替调用方**发请求，所以它同时是攻击面：SSRF、Content-Type 白名单、
    // 手动逐跳重定向、连接数上限，四道防护都在这里。
    // ⚠️ **播放列表要先解引用**：SomaFM 给的就是 `.pls`（`https://api.somafm.com/groovesalad256.pls`），
    //    直接把它的响应流给 `<audio>` 会得到一段文本 —— 用户看到"正在播放"却没有任何声音。
    //    所以顺序是「**先判播放列表 → 解析成真流 → 再代理**」，而不是"白名单不通过就拒"。
    //    headOnly（HEAD 预检）：走完全同一套判定，但不写 body（前端只用状态码/头）。
    async function radioProxyStream(req, res, target, ac, headOnly) {
      const clientRange = req.headers && typeof req.headers.range === 'string' && req.headers.range
        ? req.headers.range : ''
      let current = target
      let playlistDepth = 0
      for (;;) {
        // 这次要不要带 Range：目标看着像播放列表就不带（小文本文件被 Range 截断没有意义）
        const opened = await radioOpenUpstream(current, ac, radioPlaylistPathOf(current) ? '' : clientRange)
        const up = opened.up
        const ctype = up.headers.get('content-type')
        const playlistKind = radioPlaylistKind(opened.url, ctype)
        if (playlistKind) {
          if (playlistDepth >= RADIO_PLAYLIST_MAX_DEPTH) {
            try { if (up.body) await up.body.cancel() } catch (err) {}
            throw radioHttpError(502, '上游播放列表嵌套层数过多')
          }
          let text = ''
          try {
            text = await radioReadTextLimited(up, RADIO_PLAYLIST_MAX_BYTES)
          } catch (err) {
            throw radioHttpError(502, '上游播放列表读取失败')
          }
          const next = radioParsePlaylist(text, opened.url, playlistKind)
          if (!next) throw radioHttpError(502, '上游播放列表里没有可用地址')
          // 解出来的地址**会再完整过一遍** SSRF（下一轮 radioOpenUpstream 的第一件事），
          // 所以"播放列表指向 127.0.0.1"这类绕过同样会被拒。
          current = next
          playlistDepth++
          continue
        }
        // Content-Type 白名单：过了这一关才允许把上游字节交给页面
        //（播放列表类在这里也会被拒 —— 兜底 fail-closed，正常路径上已经在上面的分支处理掉了）
        const typeReason = radioStreamTypeRejection(ctype)
        if (typeReason) {
          try { if (up.body) await up.body.cancel() } catch (err) {}
          throw radioHttpError(502, typeReason)
        }
        const out = { 'Cache-Control': 'no-store' }
        const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges',
          'icy-name', 'icy-genre', 'icy-br', 'icy-description']
        const encoding = up.headers.get('content-encoding')
        for (const name of passthrough) {
          const v = up.headers.get(name)
          if (v === undefined || v === null || v === '') continue
          // undici 会自动解压 gzip/br：此时 body 已经不是原始字节，再透传 Content-Length
          // 会让浏览器按错误的长度截断或挂住 —— 这种情况丢掉长度，交给 chunked。
          if (name === 'content-length' && encoding && encoding !== 'identity') continue
          out[name] = v
        }
        res.writeHead(up.status, out) // 200/206 原样透传
        res.on('error', () => {}) // 客户端中途断开时 res 上的错误不该冒到宿主
        // HEAD 预检：状态码/响应头与 GET 完全一致，但**不写 body**、也不把上游流拉下来
        if (headOnly) {
          try { if (up.body) await up.body.cancel() } catch (err) {}
          try { res.end() } catch (err) {}
          return
        }
        // 流式转发：**绝不**把整个响应读进内存（电台是无限流，arrayBuffer() 永远不会返回）
        if (!up.body) { try { res.end() } catch (err) {} return }
        const reader = up.body.getReader()
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            if (!chunk.value || !chunk.value.length) continue
            if (!res.write(Buffer.from(chunk.value))) {
              // 背压：等 drain 再继续读上游，否则内存里会堆满没人要的音频
              await new Promise((resolve) => {
                res.once('drain', resolve)
                res.once('close', resolve) // 客户端断开时也要放行，否则这里永远挂着
              })
            }
          }
        } finally {
          try { await reader.cancel() } catch (err) {}
        }
        try { res.end() } catch (err) {}
        return
      }
    }

    // —— 电台接口 ①：收藏 / 上次来源（GET）+ 三种 action（POST）——
    // 与 music.json 同构：GET 与 POST 成功时返回**同一个形状**（radioPayload()）。
    // 写请求的"必须来自本机（回环）"判断不在这个 handler 里：registerRoute() → writeRejection()
    // 已经先跑过一遍，非回环的 POST 在进到这里之前就 403 了。
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/radio.json',
      handler: async (req, res) => {
        if (req.method === 'POST' || req.method === 'PUT') {
          try {
            // 收藏只是几条元数据，body 很小：8KB 足够，顺带挡住"拿这条接口灌大 body"。
            const body = await readBodyMax(req, 8 * 1024)
            const parsed = JSON.parse(body)
            const action = String((parsed && parsed.action) || '')
            const state = readRadioState()
            if (action === 'add-favorite') {
              const station = normalizeRadioStation((parsed && parsed.station) || {}, (parsed && parsed.station && parsed.station.source), false)
              // url 必须是 http/https（与 radio-stream 的第一道检查同口径）：
              // 收藏一个 `file:` / `data:` 地址只会变成"点了永远播不出来"的僵尸条目。
              if (!/^https?:\/\/[^\s]+$/i.test(station.url)) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: '收藏的电台地址必须是 http/https' }))
                return
              }
              const at = state.favorites.findIndex((f) => f.url === station.url)
              if (at >= 0) {
                // 按 url 去重：已存在就**更新**名称/标签等字段（用户重收藏一次是想刷新信息），
                // 而不是再加一条 —— 否则列表里会出现两个一模一样的台。
                state.favorites[at] = station
              } else {
                if (state.favorites.length >= RADIO_MAX_FAVORITES) {
                  res.writeHead(400, JSON_HEADERS)
                  res.end(JSON.stringify({ ok: false, error: '收藏已达上限 ' + RADIO_MAX_FAVORITES + ' 个' }))
                  return
                }
                state.favorites.push(station)
              }
              writeRadioState(state)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify(radioPayload()))
              return
            }
            if (action === 'remove-favorite') {
              const url = radioText(parsed && parsed.url, 2000)
              // 不存在也返回 200：这个动作的语义是"让它不在收藏里"，已经是目标状态了
              state.favorites = state.favorites.filter((f) => f.url !== url)
              writeRadioState(state)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify(radioPayload()))
              return
            }
            if (action === 'set-source') {
              const src = String((parsed && parsed.source) || '')
              if (src !== 'rb' && src !== 'somafm') {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'source 只能是 rb 或 somafm' }))
                return
              }
              state.lastSource = src
              writeRadioState(state)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify(radioPayload()))
              return
            }
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
          }
          return
        }
        // GET：收藏 + 上次来源 + 生效的上游 + 上限，一次拿齐
        try {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(radioPayload()))
        } catch (err) {
          res.writeHead(500, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    // —— 电台接口 ②：搜索（**仅回环**）——
    // 上游失败 / 超时 / JSON 坏 → 502 + {ok:false,error}（不抛：抛出去宿主回 500，
    // 前端只能看到"服务器错误"，而用户需要知道是"搜索源连不上"）。
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/radio-search',
      handler: async (req, res) => {
        if (radioLoopbackRejection(req, res)) return
        let source = 'rb'
        let query = ''
        let country = ''
        let tag = ''
        let limit = RADIO_SEARCH_DEFAULT_LIMIT
        try {
          const u = new URL(String(req.url || '/'), 'http://127.0.0.1')
          const params = u.searchParams
          // source **只接受** rb / somafm：传了别的值一律 400，而不是静默回落成 rb ——
          // 静默回落会让"客户端把来源拼错"变成"搜索结果来自另一条上游"且毫无提示。
          // 参数**缺省/为空**仍按默认源 rb：宿主与前端是两个可以版本不同步的文件（前端靠硬刷新
          // 更新），老前端不带这个参数时不该整条搜索直接失效。
          const rawSource = params.get('source')
          if (rawSource !== null && rawSource !== '') {
            if (rawSource !== 'rb' && rawSource !== 'somafm') {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'source 只能是 rb 或 somafm' }))
              return
            }
            source = rawSource
          }
          // 各字段都限长：它们会被拼进上游查询串（URLSearchParams 会编码，但长度还是要管）
          query = radioText(params.get('q'), 120).trim()
          country = radioText(params.get('country'), 8).trim()
          tag = radioText(params.get('tag'), 60).trim()
          limit = radioSearchLimit(params.get('limit'))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '查询参数无法解析' }))
          return
        }
        try {
          const stations = source === 'somafm'
            ? await radioSearchSomafm({ q: query, limit: limit })
            : await radioSearchRb({ q: query, country: country, tag: tag, limit: limit })
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, source: source, query: query, stations: stations }))
        } catch (err) {
          try {
            res.writeHead(502, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: radioErrText(err) }))
          } catch (e2) {}
        }
      },
    }))

    // —— 电台接口 ③：音频流代理（**仅回环**）——
    // u=<encodeURIComponent(上游地址)>。四道防护（SSRF / Content-Type 白名单 / 逐跳重定向
    // / 并发上限）的实现与理由都在 radioProxyStream 与 radioTargetRejection 上。
    // **HEAD 也支持**：前端会用一次 HEAD 预检来拿状态码（429/502/403），判定与 GET 完全同源，
    // 只是不写 body（HEAD 不能有 body；前端用状态码映射文案）。
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/radio-stream',
      handler: async (req, res) => {
        if (radioLoopbackRejection(req, res)) return
        const method = String((req && req.method) || 'GET').toUpperCase()
        const headOnly = method === 'HEAD'
        let target = ''
        try {
          const u = new URL(String(req.url || '/'), 'http://127.0.0.1')
          target = String(u.searchParams.get('u') || '').trim() // searchParams.get 已自动解码
        } catch (err) { target = '' }
        if (!target) {
          radioStreamError(res, 400, '缺少 u 参数（要播放的电台地址）')
          return
        }
        // 并发闸门：**先占坑再发请求**（超过上限立刻 429，别让上游连接先建起来）；
        // 计数在 finally 里释放，客户端中途断开 / 上游失败 / 正常播完都走同一条路径。
        // HEAD 预检同样占坑（否则预检期间并发已经满了，预检却报 200 —— 状态码就不一致了）。
        if (radioStreams >= RADIO_MAX_STREAMS) {
          radioStreamError(res, 429, '同时播放的在线流过多')
          return
        }
        radioStreams++
        let released = false
        const release = () => { if (!released) { released = true; radioStreams-- } }
        // 客户端断开（关页面 / 暂停后取消 / 切台）时必须 abort 上游：否则宿主会一直挂着那条
        // 上游连接读一个没人要的无限流 —— 每切一次台泄漏一条，几分钟就把连接和并发计数耗光。
        const ac = new AbortController()
        const onClientGone = () => { try { ac.abort() } catch (err) {} }
        req.on('close', onClientGone)
        req.on('aborted', onClientGone)
        res.on('close', onClientGone)
        try {
          await radioProxyStream(req, res, target, ac, headOnly)
        } catch (err) {
          // 已经发过头（音频流播到一半断了）就什么都不能再写，交给客户端自己收尾
          if (!res.headersSent) {
            // HEAD 的失败响应也只有状态码（不能有 body）—— 前端按状态码映射文案即可
            radioStreamError(res, Number(err && err.radioStatus) || 502, headOnly ? '' : radioErrText(err))
          }
        } finally {
          release()
          req.removeListener('close', onClientGone)
          req.removeListener('aborted', onClientGone)
          res.removeListener('close', onClientGone)
        }
      },
    }))

    function pickBubbleImgDir() {
      for (const p of BUBBLE_IMG_DIR_CANDIDATES) {
        try {
          fs.mkdirSync(p, { recursive: true })
          fs.accessSync(p, fs.constants.W_OK)
          return p
        } catch (err) {}
      }
      return BUBBLE_IMG_DIR_CANDIDATES[0]
    }
    function defaultBubbleImgIndex() {
      return { version: 1, images: [] }
    }
    function readBubbleImgIndex() {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(pickBubbleImgDir(), BUBBLE_IMG_INDEX_NAME), 'utf8'))
        if (parsed && Array.isArray(parsed.images)) return parsed
      } catch (err) {}
      return defaultBubbleImgIndex()
    }
    function writeBubbleImgIndex(index) {
      try {
        fs.writeFileSync(path.join(pickBubbleImgDir(), BUBBLE_IMG_INDEX_NAME), JSON.stringify(index, null, 2), 'utf8')
        return true
      } catch (err) {
        return false
      }
    }
    function bubbleImgPayload() {
      const index = readBubbleImgIndex()
      // 内置默认图常驻(先列出,不占 createdAt 排序;用户图库含同 id 时不重复)
      const seen = {}
      index.images.forEach((im) => { seen[im.id] = 1 })
      const builtins = DEFAULT_BUBBLE_IMGS.filter((d) => !seen[d.id]).map((d) => ({
        id: d.id,
        name: String(d.name || d.id),
        format: d.format === 'gif' ? 'gif' : 'png',
        url: '/dsh-whale/bubble-img.png?id=' + encodeURIComponent(d.id),
        createdAt: null,
        builtin: true,
      }))
      return {
        ok: true,
        images: builtins.concat(index.images.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((im) => ({
          id: im.id,
          name: String(im.name || im.id),
          format: im.format === 'gif' ? 'gif' : 'png',
          url: '/dsh-whale/bubble-img.png?id=' + encodeURIComponent(im.id),
          createdAt: im.createdAt || null,
        }))),
      }
    }
    function bubbleImgIdFromUrl(url) {
      try {
        const q = String(url || '').split('?')[1] || ''
        const m = /(?:^|&)id=([^&]+)/.exec(q)
        return m ? decodeURIComponent(m[1]) : ''
      } catch (err) { return '' }
    }
    function loadBubbleConfig() {
      for (const p of BUBBLE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && parsed.v === 1) return parsed
        } catch (err) {}
      }
      return null
    }
    function writeBubbleConfig(cfg) {
      const body = JSON.stringify(cfg, null, 2)
      for (const p of BUBBLE_FILE_CANDIDATES) {
        try { fs.writeFileSync(p, body, 'utf8'); return true } catch (err) {}
      }
      return false
    }

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/bubble.json',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST' || req.method === 'PUT') {
            const body = await readBodyMax(req, 512 * 1024)
            const parsed = JSON.parse(body)
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items) || !Array.isArray(parsed.lib)) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'invalid bubble config' }))
              return
            }
            // v727：tapAdvance =「点按角色推进泡泡队列」（只存布尔值，不放行其它字段）
            const cfg = { v: 1, items: parsed.items, lib: parsed.lib, tapAdvance: parsed.tapAdvance === true }
            writeBubbleConfig(cfg)
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify({ ok: true, config: cfg }))
            return
          }
          const cfg = loadBubbleConfig()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, config: cfg }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/bubble-imgs.json',
      handler: (req, res) => {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(bubbleImgPayload()))
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/bubble-img-upload.json',
      handler: async (req, res) => {
        try {
          const body = await readBodyMax(req, 10 * 1024 * 1024)
          const parsed = JSON.parse(body)
          const action = parsed && parsed.action
          const index = readBubbleImgIndex()
          if (action === 'upload') {
            const name = String(parsed.name || '').trim().slice(0, 40) || ''
            const data = String(parsed.data || '')
            const m = /^data:image\/(png|gif);base64,([A-Za-z0-9+/=]+)$/.exec(data)
            if (!m) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'invalid image data' }))
              return
            }
            const format = m[1] === 'gif' ? 'gif' : 'png'
            const buf = Buffer.from(m[2], 'base64')
            if (buf.length < 64 || buf.length > 8 * 1024 * 1024) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'image too large' }))
              return
            }
            const id = 'bimg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
            fs.writeFileSync(path.join(pickBubbleImgDir(), id + '.' + format), buf)
            index.images.push({ id, name, format, createdAt: Date.now() })
            writeBubbleImgIndex(index)
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(bubbleImgPayload()))
            return
          }
          if (action === 'delete') {
            const id = String(parsed.id || '')
            const img = index.images.find((x) => x.id === id)
            if (!img) {
              res.writeHead(404, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'image not found' }))
              return
            }
            index.images = index.images.filter((x) => x.id !== id)
            writeBubbleImgIndex(index)
            const ext = img.format === 'gif' ? 'gif' : 'png'
            try { fs.unlinkSync(path.join(pickBubbleImgDir(), id + '.' + ext)) } catch (err) {}
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(bubbleImgPayload()))
            return
          }
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/bubble-img.png',
      handler: (req, res) => {
        try {
          const id = bubbleImgIdFromUrl(req.url)
          // 1) 用户图库优先
          const index = readBubbleImgIndex()
          const img = index.images.find((x) => x.id === id)
          if (img) {
            const ext = img.format === 'gif' ? 'gif' : 'png'
            const bytes = fs.readFileSync(path.join(pickBubbleImgDir(), id + '.' + ext))
            res.writeHead(200, {
              'Content-Type': img.format === 'gif' ? 'image/gif' : 'image/png',
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
          // 2) 内置默认图回退(全新安装无用户图库时,泡泡序列引用的语义 id 也能出图)
          const def = DEFAULT_BUBBLE_IMGS.find((x) => x.id === id)
          if (def) {
            const bytes = loadBuiltinBubbleImgBytes(def)
            if (bytes) {
              res.writeHead(200, {
                'Content-Type': def.format === 'gif' ? 'image/gif' : 'image/png',
                'Cache-Control': 'no-store',
                'Content-Length': String(bytes.length),
              })
              res.end(bytes)
              return
            }
          }
          throw new Error('bad image id')
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('bubble image unavailable')
        }
      },
    }))

          disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/widget.js',
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadWidgetJs())
      },
    }))

    disposers.push(ctx.webServer.tapIndex((html) => {
      if (html.indexOf('/dsh-whale/widget.js') !== -1) return html
      const tag = '<script defer src="/dsh-whale/widget.js"></script>'
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
      return html + tag
    }))

    // —— 官方 DSH 桌面端（Electron）适配（issue #152 / #153 / #154）——
    // 桌面壳的 index.html 是**从安装包静态 dist 直接读盘**的（`dsh-app://app/`），永远不经过宿主的
    // renderIndex()，所以上面的 tapIndex 在桌面端不生效 —— 于是"宿主半区活着、客户端半区从未被请求"。
    // 桌面端唯一的注入通道是 `webserver/index-inject` 的结构化行（宿主启动时 collectIndexInjections()
    // 经 IPC 交给渲染层，渲染层按 kind 逐行应用）。
    // **该行的注册已上移到 apply() 开头**（见 `DESKTOP_WIDGET_ROW_TEXT` 上方那段注释）：两个原因 ——
    // ① 桌面端的注入表是**一次性收集**的，行必须尽早进表；② 行本身改成了**内联 script 行**，
    // 因为页面侧解释器对 `script-src` 是"加载失败即 reject 整个 boot"（issue #154 的致命启动错误）。

    ctx.effect(() => () => {
      for (const d of disposers) {
        try { d() } catch (err) {}
      }
    })
    }) // ← 结束 root.inject(['webServer','credentials','connection'], cb)
  },
}
