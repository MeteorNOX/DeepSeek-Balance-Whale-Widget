// Offline regression test for v0.3.4 appearance / skin colours.
//
// Exercises the real /dsh-whale/appearance.json and /dsh-whale/roles.json handlers with a
// fake ctx, a temp DSH_HOME and a generated PNG of a known colour, so the dominant-colour
// extraction and the palette/contrast maths are verified without a browser or network.
//
// Usage: node tools/appearance.test.mjs
import { EventEmitter } from 'node:events'
import zlib from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(PKG_ROOT, 'lib', 'index.js')
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-appear-test-'))
process.env.DSH_HOME = HOME

const mod = await import(new URL('file:///' + PLUGIN.replace(/\\/g, '/')))
const routes = new Map()

const ctx = {
  get: () => undefined,
  effect: () => () => {},
  on: () => {},
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  webServer: { register: (r) => { routes.set(r.path, r); return () => {} }, tapIndex: () => () => {} },
  credentials: {
    async resolve() { return undefined },
    async set() {},
    async unset() {},
  },
  connection: { requestRejection: () => undefined },
}
mod.default.apply(ctx)

// ---- minimal PNG encoder (RGBA, no filtering) --------------------------------
function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = c ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function solidPng(w, h, [r, g, b, a = 255]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 4)
    raw[off] = 0
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 4
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

function call(routePath, method, body) {
  const route = routes.get(routePath)
  if (!route) throw new Error('route not registered: ' + routePath)
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = routePath
    req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
    req.destroy = () => {}
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
      req.emit('end')
    })
    const res = {
      statusCode: 200,
      writeHead(code) { this.statusCode = code },
      end(text) { try { resolve({ status: this.statusCode, body: JSON.parse(text) }) } catch (e) { reject(e) } },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

let pass = 0, fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')) }
}
const isHex = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/.test(s)
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255)
}
const contrast = (a, b) => { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05) }

console.log('\n[1] 默认（未配置）=')
let r = await call('/dsh-whale/appearance.json', 'GET')
check('GET ok', r.body.ok === true, r.body)
check('默认 auto 模式', r.body.mode === 'auto', r.body.mode)
check('palette 是完整六个键', ['ui', 'uiHi', 'uiFg', 'txt', 'txtDim', 'base'].every((k) => k in (r.body.palette || {})), r.body.palette)
check('所有颜色都是合法 hex', ['ui', 'uiHi', 'uiFg', 'txt', 'txtDim', 'base'].every((k) => isHex(r.body.palette[k])), r.body.palette)

console.log('\n[2] custom 模式：指定颜色必须原样生效')
r = await call('/dsh-whale/appearance.json', 'POST', { mode: 'custom', color: '#2a9d8f' })
check('POST ok', r.body.ok === true, r.body)
check('mode=custom', r.body.appearance.mode === 'custom', r.body.appearance)
check('base 保留所选色', r.body.palette.base === '#2a9d8f', r.body.palette.base)
check('ui 仍是合法 hex', isHex(r.body.palette.ui), r.body.palette.ui)
check('按钮文字对比度 ≥ 4.5', contrast(r.body.palette.ui, r.body.palette.uiFg) >= 4.5,
  { ui: r.body.palette.ui, uiFg: r.body.palette.uiFg, ratio: contrast(r.body.palette.ui, r.body.palette.uiFg) })
check('ui 的亮度被压到 0.30 附近（浅色泡泡上可读）', lum(r.body.palette.ui) < lum(r.body.palette.uiHi), { ui: r.body.palette.ui, uiHi: r.body.palette.uiHi })

console.log('\n[3] 非法输入被拒（不写坏文件）')
r = await call('/dsh-whale/appearance.json', 'POST', { mode: 'custom', color: 'red' })
check('拒绝非 #RRGGBB', r.body.ok === false && /RRGGBB/.test(String(r.body.error)), r.body)
r = await call('/dsh-whale/appearance.json', 'POST', { mode: 'nonsense' })
check('拒绝未知模式', r.body.ok === false, r.body)
r = await call('/dsh-whale/appearance.json', 'GET')
check('坏输入后仍能读到之前的设置', r.body.appearance.color === '#2a9d8f', r.body.appearance)

console.log('\n[4] default 模式回落内置蓝')
r = await call('/dsh-whale/appearance.json', 'POST', { mode: 'default' })
check('mode=default', r.body.appearance.mode === 'default', r.body.appearance)
check('回落 #203170', r.body.palette.base === '#203170', r.body.palette.base)
check('source=default', r.body.source === 'default', r.body.source)

console.log('\n[5] auto 模式：从角色图提取主色（上传一张纯青色 PNG）')
const png = solidPng(64, 64, [42, 157, 143]) // #2a9d8f 纯色
r = await call('/dsh-whale/roles.json', 'POST', {
  name: '测试角色',
  format: 'png',
  image: 'data:image/png;base64,' + png.toString('base64'),
})
check('上传角色 ok', r.body.ok === true && r.body.roles.length >= 2, r.body.roles && r.body.roles.length)
const roleId = (r.body.roles || []).find((x) => x.name === '测试角色').id
check('拿到新角色 id', !!roleId, roleId)
check('roles payload 带 appearance', !!r.body.appearance, r.body.appearance)

r = await call('/dsh-whale/appearance.json', 'POST', { mode: 'auto', roleId })
check('auto 提取成功', r.body.ok === true && r.body.source === 'role', r.body)
check('提取到的主色接近青色', r.body.palette.base === '#2a9d8f', r.body.palette.base)
check('auto 与 custom 对同色得到同一套 palette', isHex(r.body.palette.ui) && isHex(r.body.palette.uiFg), r.body.palette)

console.log('\n[6] 跟随角色切换：auto 模式下换角色，配色跟着变')
const png2 = solidPng(48, 48, [200, 60, 60]) // 红色角色
r = await call('/dsh-whale/roles.json', 'POST', {
  name: '红色角色', format: 'png', image: 'data:image/png;base64,' + png2.toString('base64'),
})
const role2 = (r.body.roles || []).find((x) => x.name === '红色角色').id
r = await call('/dsh-whale/appearance.json', 'POST', { mode: 'auto', roleId: role2 })
check('新模式色被提取', r.body.palette.base !== '#203170', r.body.palette.base)
check('来自角色', r.body.source === 'role', r.body.source)
r = await call('/dsh-whale/appearance.json', 'GET')
check('GET 能复现同一配色', r.body.palette.base === r.body.palette.base && isHex(r.body.palette.ui), r.body.palette)

console.log('\n[7] 配色持久化在 roles.json 的 appearance 段')
const idxPath = path.join(HOME, 'whale-roles', 'roles.json')
const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
check('文件里有 appearance', !!idx.appearance, idx.appearance)
check('appearance 记下了角色 id', idx.appearance.roleId === role2, idx.appearance.roleId)
check('appearance 里没有密钥之类的东西', Object.keys(idx.appearance).every((k) => ['version', 'mode', 'color', 'roleId'].includes(k)), Object.keys(idx.appearance))

fs.rmSync(HOME, { recursive: true, force: true })
console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
