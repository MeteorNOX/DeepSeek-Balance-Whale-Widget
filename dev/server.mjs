#!/usr/bin/env node
// ============================================================================
// dev/server.mjs —— 小鲸鱼挂件的本地调试台（harness）
// ============================================================================
// 作用：不启动 DSH，也能把挂件跑起来，用于快速迭代 lib/index.js 里的前端代码
// （WIDGET_JS：CSS / 气泡位置 / 动画 / 拖拽 / 点击判定）。
//
// 原理：前端只依赖 10 条写死的绝对路径路由（/dsh-whale/*）。真机上是 DSH 插件的
// apply() 注册的；这里我们用假数据把它们重放一遍，并把 lib/index.js 里的
// WIDGET_JS 现场抠出来发出去。
//
// 关键点：每次 lib/index.js 存盘后自动重新抠取（按 mtime 失效），
// 所以「存盘 -> F5」就能看到效果，不用重启 DSH。
//
// 用法：
//   node dev/server.mjs            # 默认 http://127.0.0.1:5599
//   $env:PORT=6000; node dev/server.mjs
// 或在 VS Code 里按 F5（见 .vscode/launch.json）。
// ============================================================================

import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LIB = path.join(ROOT, 'lib', 'index.js')
const ASSETS = path.join(ROOT, 'assets')
const PORT = Number(process.env.PORT || 5599)
const HOST = process.env.HOST || '127.0.0.1'

// 临时模块必须放在 dev/ 下：lib/index.js 顶层用
//   PACKAGE_ROOT = path.resolve(dirname(import.meta.url), '..')
// 推导包根目录，只有 dev/ 的上一级才是仓库根，放别处图片路径会全错。
const TMP_MODULE = path.join(HERE, '.widget.mjs')

// ---------------------------------------------------------------------------
// 假数据（可用页面上的控制面板实时改）
// ---------------------------------------------------------------------------
const state = {
  // GET /dsh-whale/balance.json 的返回体
  balance: {
    ok: true,
    totalBalance: 42.5,
    currency: 'CNY',
    todayUsage: 1.23,
    isPeak: false,
  },
  // GET/PUT /dsh-whale/size.json —— 与真机 writeSizeConfig() 的字段一一对应
  size: {
    scale: 1,
    sound: true,
    vol: 0.9,
    soundSet: 'duck',
    usageMode: 'ledger',
    peakMode: 'default',
    bubbleOn: true,
    turnCostOn: true,
    turnCostCloseMs: 5000,
    scrollGapOn: true,
    scrollGapPx: 12,
    // 定时「吃饭」动画间隔（分钟，0 = 关闭）—— 对应真机 size.json 的 eatMin
    eatMin: 15,
  },
  // GET /dsh-whale/last-turn.json —— seq 递增即代表「新的一轮」。
  // main:false = 该轮由子代理（spawn/fork）完成，挂件不播吃饭动画（真机上由
  // session.header.origin === 'subagent' 判定）。
  lastTurn: { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null, main: true },
}

// ---------------------------------------------------------------------------
// 从 lib/index.js 现场抠出 WIDGET_JS
// ---------------------------------------------------------------------------
let widgetCache = { mtimeMs: 0, js: '' }

async function loadWidgetJs() {
  const st = await fs.stat(LIB)
  if (st.mtimeMs === widgetCache.mtimeMs && widgetCache.js) return widgetCache.js

  const src = await fs.readFile(LIB, 'utf8')
  const patched = src.replace(
    /^export\s*\{\s*name,\s*inject,\s*apply\s*\}\s*$/m,
    'export { name, inject, apply, WIDGET_JS }',
  )
  if (patched === src) {
    throw new Error(
      '在 lib/index.js 里没找到 "export { name, inject, apply }" —— ' +
        '该行结构变了，请同步更新 dev/server.mjs 的替换规则',
    )
  }

  await fs.writeFile(TMP_MODULE, patched, 'utf8')
  // 带 ?t= 破掉 Node 的 ESM 模块缓存，保证拿到最新代码
  const mod = await import(pathToFileURL(TMP_MODULE).href + '?t=' + Date.now())
  if (typeof mod.WIDGET_JS !== 'string') throw new Error('模块未导出 WIDGET_JS')

  widgetCache = { mtimeMs: st.mtimeMs, js: mod.WIDGET_JS }
  return widgetCache.js
}

// lib/index.js 语法错误时，别让页面白屏，把错误直接显示出来
function widgetErrorJs(err) {
  const msg = String((err && err.stack) || err).replace(/`/g, "'")
  return `console.error(${JSON.stringify('[harness] 提取 WIDGET_JS 失败]')})
console.error(${JSON.stringify(msg)})
;(function () {
  var d = document.createElement('div')
  d.style.cssText = 'position:fixed;left:12px;bottom:12px;max-width:70vw;z-index:99999;' +
    'background:#7f1d1d;color:#fff;font:12px/1.5 ui-monospace,Consolas,monospace;' +
    'padding:12px 14px;border-radius:8px;white-space:pre-wrap'
  d.textContent = '[harness] lib/index.js 提取失败，请检查语法：\\n' + ${JSON.stringify(msg)}
  document.body.appendChild(d)
})()`
}

// ---------------------------------------------------------------------------
// 资源读取
// ---------------------------------------------------------------------------
async function readFirst(candidates) {
  for (const p of candidates) {
    try {
      const b = await fs.readFile(p)
      if (b.length) return b
    } catch {}
  }
  return null
}

const IMG_CANDIDATES = [
  path.join(ASSETS, 'DSniang1.png'),
  path.join(ASSETS, 'DSniang02.png'),
]
// 点击切换用的额外素材（真机侧见 lib/index.js 的 EXTRA_IMAGES）
// 新增图片：assets/ 放文件后，在这里加一项，并在 lib/index.js 的 EXTRA_IMG_URLS 加一行。
const EXTRA_IMAGES = [
  { route: 'image-tired.png', names: ['DSniang_tierd.PNG', 'DSniang_tierd.png'] },
  { route: 'image-mad.png', names: ['DSniang_mad.PNG', 'DSniang_mad.png'] },
  { route: 'image-sad.png', names: ['DSniang_sad.PNG', 'DSniang_sad.png'] },
]
// 定时「吃饭」动画素材（真机侧见 lib/index.js 的 EATING_VIDEO_CANDIDATES）
const EATING_VIDEO = ['DSniang_eating_rice_2.webm', 'DSniang_eating_rice_2.WEBM']
const gifPath = path.join(ASSETS, 'rua.gif')
const SOUNDS = {
  duck: { press: 'Ya1.mp3', release: 'Ya2.mp3' },
  fx1: { press: 'D1.mp3', release: 'D2.mp3' },
}

function send(res, code, headers, body) {
  res.writeHead(code, headers)
  res.end(body)
}
const sendJson = (res, obj) =>
  send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(obj))

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`)
  const p = url.pathname

  try {
    // ---- 调试台页面 ----
    if (p === '/' || p === '/index.html') {
      const html = await fs.readFile(path.join(HERE, 'index.html'))
      return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, html)
    }
    if (p === '/favicon.ico') return send(res, 204, {}, '')

    // ---- 挂件脚本（现场从源码抠，存盘即生效）----
    if (p === '/dsh-whale/widget.js') {
      try {
        const js = await loadWidgetJs()
        console.log('  [widget.js] 已从 lib/index.js 重新提取')
        return send(res, 200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }, js)
      } catch (err) {
        console.error('  [widget.js] 提取失败:', err.message)
        return send(res, 200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }, widgetErrorJs(err))
      }
    }

    // ---- 图片 / 动画 / 音效 ----
    if (p === '/dsh-whale/image.png') {
      const b = await readFirst(IMG_CANDIDATES)
      if (!b) return send(res, 404, { 'Content-Type': 'text/plain' }, 'no image in assets/')
      return send(res, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(b.length) }, b)
    }
    for (const slot of EXTRA_IMAGES) {
      if (p === '/dsh-whale/' + slot.route) {
        const b = await readFirst(slot.names.map((n) => path.join(ASSETS, n)))
        if (!b) return send(res, 404, { 'Content-Type': 'text/plain' }, 'no ' + slot.route + ' in assets/')
        return send(res, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(b.length) }, b)
      }
    }
    if (p === '/dsh-whale/eating.webm') {
      const b = await readFirst(EATING_VIDEO.map((n) => path.join(ASSETS, n)))
      if (!b) return send(res, 404, { 'Content-Type': 'text/plain' }, 'no eating.webm in assets/')
      return send(res, 200, { 'Content-Type': 'video/webm', 'Cache-Control': 'no-store', 'Content-Length': String(b.length) }, b)
    }
    if (p === '/dsh-whale/rua.gif') {
      try {
        const b = await fs.readFile(gifPath)
        return send(res, 200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store', 'Content-Length': String(b.length) }, b)
      } catch {
        return send(res, 404, { 'Content-Type': 'text/plain' }, 'no rua.gif')
      }
    }
    if (p === '/dsh-whale/sound/press.mp3' || p === '/dsh-whale/sound/release.mp3') {
      const set = url.searchParams.get('set') === 'fx1' ? 'fx1' : 'duck'
      const which = p.endsWith('press.mp3') ? 'press' : 'release'
      const file = path.join(ASSETS, SOUNDS[set][which])
      try {
        const b = await fs.readFile(file)
        return send(res, 200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Content-Length': String(b.length) }, b)
      } catch {
        return send(res, 404, { 'Content-Type': 'text/plain' }, 'no sound ' + file)
      }
    }

    // ---- 数据接口 ----
    if (p === '/dsh-whale/balance.json') return sendJson(res, state.balance)

    if (p === '/dsh-whale/last-turn.json') return sendJson(res, state.lastTurn)

    if (p === '/dsh-whale/size.json') {
      if (req.method === 'PUT' || req.method === 'POST') {
        try {
          const parsed = JSON.parse(await readBody(req))
          Object.assign(state.size, parsed)
          console.log('  [size.json] 已保存配置:', JSON.stringify(parsed))
        } catch (err) {
          console.error('  [size.json] PUT 解析失败:', err.message)
        }
      }
      return sendJson(res, state.size)
    }

    // ---- 调试台控制接口（只有 harness 有，真机没有）----
    if (p === '/__dev/state') return sendJson(res, state)

    if (p === '/__dev/update' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        if (body.balance) Object.assign(state.balance, body.balance)
        if (body.turn) Object.assign(state.lastTurn, body.turn)
        return sendJson(res, { ok: true, state })
      } catch (err) {
        return sendJson(res, { ok: false, error: String(err.message) })
      }
    }

    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'harness: 未处理的路由 ' + p)
  } catch (err) {
    console.error('  [500]', err)
    return send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, String((err && err.stack) || err))
  }
})

server.listen(PORT, HOST, () => {
  console.log('')
  console.log('  🐋 小鲸鱼挂件调试台')
  console.log('  ─────────────────────────────────────────')
  console.log(`  页面      http://${HOST}:${PORT}`)
  console.log(`  挂件脚本  http://${HOST}:${PORT}/dsh-whale/widget.js`)
  console.log('')
  console.log('  改 lib/index.js 里的 WIDGET_JS -> 存盘 -> 浏览器 F5 即生效')
  console.log('  数据是假的（见页面左上角控制面板），不消耗额度')
  console.log('')
})
