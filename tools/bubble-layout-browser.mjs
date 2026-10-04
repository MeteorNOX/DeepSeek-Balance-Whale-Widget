// Optional browser QA: provide Playwright and a browser externally; never launches DSH.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.WHALE_QA_PLAYWRIGHT || 'playwright')
const output = path.resolve(process.argv[2] || path.join(root, 'qa-output'))
fs.mkdirSync(output, { recursive: true })
let source = fs.readFileSync(process.env.WHALE_QA_SOURCE || path.join(root, 'assets/whale-widget.js'), 'utf8')
const hook = `window.__layoutQA = {
  root: root, bubble: bubbleBox, text: textBox,
  fit: typeof bubbleFitText === 'function' ? bubbleFitText : function(){},
  show: function(mods, scale, flip) {
    state.scale = scale; state.h = null; state.v = null; state.left = 180; state.top = 100;
    state.flip = flip; state.balance = 182.52; state.todayUsage = 10.23; state.currency = 'CNY'; state.status = 'ok'; shown = 182.52;
    root.style.setProperty('--dshw-scale', String(scale)); express();
    if (mods) sceneOpen('custom', function(){bubbleRenderModules(mods)}, 0);
    else sceneOpen('normal', bubbleRenderDefault, 0);
  }
};`
source = source.replace('setInterval(function () { pollLastTurn(); pollWaitState() }, 1000)', hook)
const routes = {
  '/dsh-whale/widget.js': () => ['application/javascript', source],
  '/dsh-whale/image.png': () => ['image/png', fs.readFileSync(path.join(root, 'assets/DSniang1.png'))],
  '/dsh-whale/rua.gif': () => ['image/gif', fs.readFileSync(path.join(root, 'assets/rua.gif'))],
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<!doctype html><html><head><meta charset="utf-8"><style>body{background:#20293a;color:#fff;font:16px Arial,sans-serif}#root{visibility:hidden}*{animation:none!important;transition:none!important}</style></head><body><div id="root"><textarea></textarea></div><script src="/dsh-whale/widget.js"></script></body></html>')
    return
  }
  if (routes[url.pathname]) {
    const [type, body] = routes[url.pathname]()
    res.setHeader('content-type', type); res.end(body); return
  }
  let payload = { ok: true }
  if (url.pathname.endsWith('/size.json')) payload = { scale: 0.8, sound: false }
  if (url.pathname.endsWith('/balance.json')) payload = { ok: true, totalBalance: 182.52, todayUsage: 10.23, currency: 'CNY' }
  if (url.pathname.endsWith('/roles.json')) payload.roles = []
  if (url.pathname.endsWith('/audio.json')) { payload.groups = []; payload.fragments = [] }
  if (/\.(wav|mp3)$/.test(url.pathname)) { res.writeHead(204); res.end(); return }
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.WHALE_QA_BROWSER || undefined })
} catch (err) {
  await new Promise((resolve) => server.close(resolve))
  throw err
}
const context = await browser.newContext({ viewport: { width: 859, height: 608 }, deviceScaleFactor: 2 })
const page = await context.newPage()
const base = 'http://127.0.0.1:' + server.address().port
await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort())
const errors = []
page.on('pageerror', (err) => errors.push(err.message))
const cases = {
  normal: null,
  three: ['今日预算提醒', '今日消费已经超过预算', '请核对当前账户余额'].map((text) => ({ type: 'text', text, size: 6 })),
  paragraph: [{ type: 'text', text: '今日预算提醒：今日消费已经超过预算，请核对当前账户余额。', size: 12 }],
  multi: [1, 2, 3, 4, 5, 6].map((n) => ({ type: 'text', text: '第 ' + n + ' 行提醒内容', size: 6 })),
  long: [{ type: 'text', text: '长文本内容完整保留，滚动后仍能阅读。'.repeat(15) + '最后一句：验证到达结尾。', size: 6 }],
}
const results = []
try {
  await page.goto(base)
  await page.waitForFunction(() => window.__layoutQA)
  await page.waitForTimeout(700)
  for (const scale of [0.8, 1.5, 2.5]) for (const flip of [false, true]) for (const [name, mods] of Object.entries(cases)) {
    await page.evaluate(({ mods, scale, flip }) => window.__layoutQA.show(mods, scale, flip), { mods, scale, flip })
    await page.waitForTimeout(220)
    const metrics = await page.evaluate(() => {
      const q = window.__layoutQA, tb = q.text
      const rect = tb.getBoundingClientRect()
      const svg = q.bubble.querySelector('svg'), inverse = svg.getScreenCTM().inverse()
      function contains(r) {
        for (const x of [r.left, r.right]) for (const y of [r.top, r.bottom]) {
          const p = svg.createSVGPoint(); p.x = x; p.y = y
          const a = p.matrixTransform(inverse)
          if (((a.x - 454) / 358) ** 2 + ((a.y - 247) / 217) ** 2 > 1.001) return false
        }
        return true
      }
      const scroll = tb.classList.contains('dshwv-text-scroll')
      const visible = Array.from(tb.children).filter((x) => getComputedStyle(x).display !== 'none')
      return { text: tb.textContent, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        scrollHeight: tb.scrollHeight, clientHeight: tb.clientHeight, scrollWidth: tb.scrollWidth, clientWidth: tb.clientWidth,
        fontSizes: visible.map((x) => getComputedStyle(x).fontSize),
        inside: scroll ? contains(rect) : visible.every((x) => contains(x.getBoundingClientRect())),
        overflow: getComputedStyle(tb).overflowY, root: q.root.getBoundingClientRect().width }
    })
    const filename = name + '-' + scale + (flip ? '-left' : '-right')
    await page.screenshot({ path: path.join(output, filename + '.png') })
    if (!process.env.WHALE_QA_BASELINE) {
      assert.equal(metrics.inside, true, filename + ': content outside ellipse')
      assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, filename + ': horizontal clipping')
      if (name === 'normal') assert.equal(metrics.overflow, 'visible', 'normal layout must stay unchanged')
      if (name === 'long') {
        const box = await page.locator('.dshwv-pop .dshwv-text-scroll').boundingBox()
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.wheel(0, 120)
        await page.waitForTimeout(80)
        assert.ok(await page.evaluate(() => window.__layoutQA.text.scrollTop) > 0, filename + ': wheel cannot scroll')
        await page.locator('.dshwv-pop .dshwv-text-scroll').click()
        assert.equal(await page.evaluate(() => window.__layoutQA.bubble.classList.contains('dshwv-pop-open')), true, 'reading click must not dismiss')
        const end = await page.evaluate(() => {
          const q = window.__layoutQA, tb = q.text
          tb.scrollTop = tb.scrollHeight
          const before = tb.scrollTop
          q.fit(tb, false)
          const visible = Array.from(tb.children).filter((x) => getComputedStyle(x).display !== 'none')
          const last = visible[visible.length - 1]
          const range = document.createRange(); range.selectNodeContents(last)
          const r = range.getClientRects(); const tail = r[r.length - 1], box = tb.getBoundingClientRect()
          return { before, after: tb.scrollTop, tailVisible: tail.bottom <= box.bottom + 1 && tail.bottom > box.top, open: q.bubble.classList.contains('dshwv-pop-open') }
        })
        assert.ok(end.before > 0, filename + ': cannot scroll')
        assert.ok(Math.abs(end.after - end.before) <= 1, filename + ': layout reset scroll position')
        assert.equal(end.tailVisible, true, filename + ': final text inaccessible')
        await page.screenshot({ path: path.join(output, filename + '-end.png') })
      }
    }
    results.push({ name, scale, flip, ...metrics })
  }
  fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify({ results, errors }, null, 2))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ browser: await browser.version(), output, cases: results.length, scrollCases: results.filter((r) => r.overflow === 'auto').length, errors }, null, 2))
} finally {
  await context.close(); await browser.close(); await new Promise((resolve) => server.close(resolve))
}
