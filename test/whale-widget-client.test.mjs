#!/usr/bin/env node
// 前端挂件冒烟测试：把注入到页面的 WIDGET_JS 真跑一遍（jsdom），验证
//   · Qwen 显示态渲染的是 Credits 而不是 ¥
//   · 超阈值 shouldAnnounce 自动冒泡，点击即确认
//   · 每轮消耗泡泡按套餐走 Credits 口径
//   · 菜单里「显示 / 套餐告警」两行确实存在并可改
// 没装 jsdom 时整份跳过（不误报失败）：node test/whale-widget-client.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let JSDOM
try {
  JSDOM = (await import('jsdom')).JSDOM
} catch (err) {
  console.log('跳过：本机没有 jsdom（pnpm add -D jsdom 后可跑）')
  process.exit(0)
}

const src = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8')
const bodyStart = src.indexOf('`', src.indexOf('const WIDGET_JS = `')) + 1
const client = src.slice(bodyStart, src.indexOf('})()`', bodyStart) + 4)

function qwenOk(over) {
  return Object.assign(
    {
      ok: true,
      estimated: true,
      source: 'ledger',
      provider: 'tokenplan',
      cap: 10000,
      used: 720,
      usedAllTime: 1500,
      remaining: 9280,
      pct: 7.2,
      dayIndex: 3,
      daysLeft: 5,
      windowIndex: 0,
      windowStart: 1,
      windowStartKey: '2026-09-03',
      windowEnd: 2,
      resetAt: Date.now() + 4.5 * 86400000,
      resetInMs: 4.5 * 86400000,
      anchorSource: 'config',
      today: { credits: 412.5, tokens: 1500000, calls: 88 },
      series: [{ credits: 0 }, { credits: 100 }, { credits: 200 }, { credits: 300 }, { credits: 400 }, { credits: 500 }, { credits: 412.5 }],
      windowDays: [],
      byModel: [{ model: 'qwen3.8-flash', credits: 700, tokens: 1, calls: 70 }],
      unknownModels: [],
      payg: { windowCny: 7.2, ledgerCny: 7.2, planPriceCny: 139, savedCny: -131.8, roiPercent: 5.2 },
      quotaHitAt: null,
      quotaHitSuspectAt: null,
      rateLimitedAt: null,
      alert: { level: 'ok', label: '', pct: 7.2, warnPct: 70, shouldAnnounce: false },
      note: '',
      generatedAt: Date.now(),
    },
    over || {},
  )
}
// 72.5% ≥ 阈值：服务端那次现算会把 shouldAnnounce 置 true（同窗口同级只给一次）
const QWEN_WARN = qwenOk({
  used: 7250,
  remaining: 2750,
  pct: 72.5,
  byModel: [{ model: 'qwen3.8-flash', credits: 7250, tokens: 1, calls: 700 }],
  payg: { windowCny: 72.5, ledgerCny: 72.5, planPriceCny: 139, savedCny: -66.5, roiPercent: 52.2 },
  alert: { level: 'warn', label: '周额度告警', pct: 72.5, warnPct: 70, shouldAnnounce: true },
})
// 级别升档用（warn → high）：验证「没到重弹间隔但升一档要立刻再报」
const QWEN_HIGH = qwenOk({
  used: 8800, remaining: 1200, pct: 88,
  byModel: [{ model: 'qwen3.8-flash', credits: 8800, tokens: 1, calls: 800 }],
  alert: { level: 'high', label: '周额度告警', pct: 88, warnPct: 70, shouldAnnounce: false },
})
const BALANCE = { ok: true, totalBalance: 123.45, currency: 'CNY', todayUsage: 6.7, isPeak: false }

function makeWindow(opts) {
  const o = opts || {}
  const sizeCfg = Object.assign(
    {
      scale: 0.18,
      sound: false,
      vol: 0,
      soundSet: 'duck',
      usageMode: 'ledger',
      peakMode: 'default',
      bubbleOn: true,
      turnCostOn: true,
      turnCostCloseMs: 0,
      scrollGapOn: false,
      scrollGapPx: 0,
      display: 'qwen',
      qwenWarnPct: 70,
    },
    o.size || {},
  )
  let turnPolls = 0
  let qwenPolls = 0
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1:3080/',
    // outside-only：页面不跑 script 标签，但 window.eval 能在窗口上下文里执行挂件脚本
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const w = dom.window
  // jsdom 没有 2D canvas：给 canvas/Image 打最小桩，让挂件的命中测试走完
  // （否则 isWhaleHit 永远返回 true，文档级拦截器会吃掉所有合成 click）。
  // 元素 getBoundingClientRect 宽度为 0 → isWhaleHit 走「不在鲸鱼上」分支。
  w.HTMLCanvasElement.prototype.getContext = function () {
    // 不透明像素：让 isWhaleHit 判定「按在鲸鱼身上」，走真正的拖拽/点击链
    return { drawImage: function () {}, getImageData: function () { return { data: [0, 0, 0, 255] } } }
  }
  w.Image = function () {
    var self = this
    var _src = ''
    Object.defineProperty(self, 'src', {
      get: function () { return _src },
      set: function (v) {
        _src = v
        setTimeout(function () { if (typeof self.onload === 'function') self.onload() }, 0)
      },
    })
  }
  const putCalls = []
  w.fetch = function (url, init) {
    const u = String(url)
    if (init && init.method === 'PUT') {
      putCalls.push({ url: u, body: JSON.parse(init.body) })
      return Promise.resolve({ json: function () { return Promise.resolve(sizeCfg) } })
    }
    let json
    if (u.indexOf('balance.json') !== -1) json = BALANCE
    else if (u.indexOf('qwen.json') !== -1) {
      qwenPolls++
      if (o.qwen === null) json = { ok: false, error: 'NO_DATA' }
      else {
        var base = typeof o.qwen === 'function' ? o.qwen(qwenPolls) : (o.qwen || QWEN_WARN)
        // 服务端每次现算：同窗口同级只报一次，第 2 次起 shouldAnnounce=false
        json = qwenPolls === 1 ? base : qwenOk(Object.assign({}, base, { alert: Object.assign({}, base.alert, { shouldAnnounce: false }) }))
      }
    }
    else if (u.indexOf('size.json') !== -1) json = sizeCfg
    else if (u.indexOf('last-turn.json') !== -1) {
      // 默认给一个恒定 seq：前端只会「对齐」，不会弹消耗泡泡干扰别的用例
      turnPolls++
      json = o.turns && turnPolls > 1
        ? { ok: true, seq: 8, turn: 8, amount: null, credits: 42.5, provider: 'tokenplan', tokens: 1200, ts: Date.now() }
        : { ok: true, seq: 7, turn: 7, amount: null, credits: null, provider: '', tokens: 0, ts: Date.now() }
    } else json = { ok: false, error: 'unexpected ' + u }
    return Promise.resolve({ json: function () { return Promise.resolve(json) }, text: function () { return Promise.resolve('') } })
  }
  w.eval(client)
  // 鲸鱼命中测试要真跑：给 .dshwv-img 一个 610×610 的方框，于是
  //   框内坐标 → 命中（拖动/点鲸鱼）；框外坐标 → 穿透到 bubble 自己的 click
  var imgEl = w.document.querySelector('.dshwv-img')
  if (imgEl) {
    imgEl.getBoundingClientRect = function () {
      return { left: 0, top: 0, width: 610, height: 610, right: 610, bottom: 610, x: 0, y: 0 }
    }
  }
  return { dom, w, putCalls }
}
// 在鲸鱼轮廓外点一下（走 bubbleBox 自己的 click：确认/切台词）
function clickBubble(w) {
  el(w, '.dshwv-bubble').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 4000, clientY: 4000 }))
}
// 在鲸鱼身上按一下就松（走 pointerdown → endDrag → showBubble + refresh）
function clickWhale(w) {
  // pointerdown 必须落在鲸鱼 img 上（onDocPointerDown 会忽略 .dshwv-bubble 内的目标）
  var target = el(w, '.dshwv-img') || el(w, '.dshwv-root img')
  target.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 100, button: 0 }))
  w.document.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 100, clientY: 100, button: 0 }))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const el = (w, sel) => w.document.querySelector(sel)
const txt = (w, sel) => (el(w, sel) ? el(w, sel).textContent : '(missing ' + sel + ')')

let passed = 0
function t(name, cond, extra) {
  if (cond) {
    passed++
    console.log('  ok   ' + name + (extra ? '  ' + extra : ''))
  } else {
    process.exitCode = 1
    console.log('  FAIL ' + name + (extra ? '  ' + extra : ''))
  }
}
function acctRow(w, key) {
  return w.document.querySelector('.dshwv-acct-item[data-acct="' + key + '"]')
}
function acctNums(w, key) {
  var r = acctRow(w, key)
  var n = r && r.querySelector('.dshwv-acct-nums')
  return n ? n.textContent : '(missing)'
}
function pickAcct(w, key) {
  // 菜单里的行点在鲸鱼轮廓外，走按钮自己的 click
  acctRow(w, key).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 4000, clientY: 4000 }))
}

console.log('\n[Qwen 显示态] 超阈值自动冒泡，点击确认后回到 Credits')
{
  const env = makeWindow({})
  await sleep(300)
  const w = env.w
  t('挂件已挂载', !!el(w, '.dshwv-root'))
  t('shouldAnnounce 自动冒泡', el(w, '.dshwv-bubble').className.indexOf('dshwv-bubble-open') !== -1)
  t('告警标题「周额度告警」', txt(w, '.dshwv-label') === '周额度告警', JSON.stringify(txt(w, '.dshwv-label')))
  t('告警金额行为百分比', txt(w, '.dshwv-amount') === '72.5%', JSON.stringify(txt(w, '.dshwv-amount')))
  t('告警提示行给出已用/剩余', /7250\/10\.0k · 剩 2750/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  t('告警金额行变红', el(w, '.dshwv-amount').style.color === 'rgb(224, 67, 63)', el(w, '.dshwv-amount').style.color)
  clickBubble(w)
  await sleep(150)
  t('点击即确认关闭告警', el(w, '.dshwv-bubble').className.indexOf('dshwv-bubble-open') === -1)
  // 关闭瞬间不闪现余额（沿用原挂件约定：文字等下次 showBubble 再恢复），
  // 但渲染锁必须解除 —— 切一次显示态就能看到常态画面
  pickAcct(w, 'ds')
  await sleep(120)
  t('锁解除后余额态能正常渲染', txt(w, '.dshwv-amount') === '¥ 123.45', JSON.stringify(txt(w, '.dshwv-amount')))
  pickAcct(w, 'qwen')
  await sleep(120)
  t('金额行 = 7250 Cr（不是 ¥）', txt(w, '.dshwv-amount') === '7250 Cr', JSON.stringify(txt(w, '.dshwv-amount')))
  t('提示行含剩余与重置', /剩 2750/.test(txt(w, '.dshwv-hint')) && /重置/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  t('超阈值常态显示转橙色警示', el(w, '.dshwv-amount').style.color === 'rgb(224, 122, 31)', el(w, '.dshwv-amount').style.color)
  env.w.close()
}

console.log('\n[DeepSeek 显示态] 原行为不回归')
{
  const env = makeWindow({ size: { display: 'ds' }, qwen: qwenOk() })
  await sleep(300)
  const w = env.w
  t('金额行 = ¥ 余额', txt(w, '.dshwv-amount') === '¥ 123.45', JSON.stringify(txt(w, '.dshwv-amount')))
  t('提示行 = 今日已用', /今日已用 ¥ 6\.70/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  t('未弹套餐告警', txt(w, '.dshwv-label') === 'DeepSeek 余额', JSON.stringify(txt(w, '.dshwv-label')))
  t('余额模式金额行无着色', el(w, '.dshwv-amount').style.color === '', JSON.stringify(el(w, '.dshwv-amount').style.color))
  env.w.close()
}

console.log('\n[菜单] 显示切换与阈值写回')
{
  const env = makeWindow({ size: { display: 'ds' }, qwen: qwenOk() })
  await sleep(300)
  const w = env.w
  t('列表两行账户（轮换已去掉）', !!acctRow(w, 'ds') && !!acctRow(w, 'qwen') && !acctRow(w, 'rotate'))
  t('默认选中 DeepSeek 行', acctRow(w, 'ds').className.indexOf('dshwv-acct-on') !== -1, acctRow(w, 'ds').className)
  t('DeepSeek 行 = 余额 + 今日', /¥ 123\.45/.test(acctNums(w, 'ds')) && /今 ¥ 6\.70/.test(acctNums(w, 'ds')), JSON.stringify(acctNums(w, 'ds')))
  t('Token Plan 行 = 已用/上限 + 累计', /720\/10\.0k/.test(acctNums(w, 'qwen')) && /累计 1500 Cr/.test(acctNums(w, 'qwen')), JSON.stringify(acctNums(w, 'qwen')))
  const warnInput = Array.prototype.slice.call(w.document.querySelectorAll('input[type=number]')).filter(function (i) { return i.value === '70' })[0]
  t('「套餐告警」阈值输入存在', !!warnInput)
  pickAcct(w, 'qwen')
  await sleep(120)
  t('点行后选中态转移', acctRow(w, 'qwen').className.indexOf('dshwv-acct-on') !== -1 && acctRow(w, 'ds').className.indexOf('dshwv-acct-on') === -1)
  t('切换后金额行变 Credits', txt(w, '.dshwv-amount') === '720 Cr', JSON.stringify(txt(w, '.dshwv-amount')))
  const put = env.putCalls[env.putCalls.length - 1]
  t('PUT 带 display=qwen', !!put && put.body.display === 'qwen', put ? JSON.stringify(put.body.display) : 'no PUT')
  warnInput.value = '55'
  warnInput.dispatchEvent(new w.Event('input'))
  await sleep(120)
  const put2 = env.putCalls[env.putCalls.length - 1]
  t('阈值改动写回 qwenWarnPct=55', !!put2 && put2.body.qwenWarnPct === 55, put2 ? String(put2.body.qwenWarnPct) : 'no PUT')
  env.w.close()
}

console.log('\n[点鲸鱼] Qwen 态先看套餐详情')
{
  const env = makeWindow({ size: { display: 'qwen' }, qwen: qwenOk() })
  await sleep(300)
  const w = env.w
  clickWhale(w)
  await sleep(400)
  t('点鲸鱼先开泡泡（显示常态读数）', el(w, '.dshwv-bubble').className.indexOf('dshwv-bubble-open') !== -1)
  clickBubble(w)
  await sleep(700) // swapBubbleContent 有淡出→换字→淡入的节奏，给足时间
  t('标题行给出窗口第几天', /^第 \d\/7 天/.test(txt(w, '.dshwv-label')), JSON.stringify(txt(w, '.dshwv-label')))
  t('金额行是本周用量', txt(w, '.dshwv-amount') === '720 Cr', JSON.stringify(txt(w, '.dshwv-amount')))
  t('提示行含今日与主力模型', /今日 413 ·/.test(txt(w, '.dshwv-hint')) && /qwen3\.8-flash/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  env.w.close()
}

console.log('\n[每轮消耗] 套餐轮次用 Credits')
{
  const env = makeWindow({ size: { display: 'ds' }, qwen: qwenOk(), turns: true })
  await sleep(2400) // pollLastTurn 每秒一次：首次对齐，第二次触发
  const w = env.w
  t('标题「上一轮套餐消耗:」', txt(w, '.dshwv-label') === '上一轮套餐消耗:', JSON.stringify(txt(w, '.dshwv-label')))
  t('金额行 ≈ 42.5 Cr', txt(w, '.dshwv-amount') === '≈ 42.5 Cr', JSON.stringify(txt(w, '.dshwv-amount')))
  t('提示行标注估算', /估算/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  env.w.close()
}

console.log('\n[自适应] 文字过长时不该把脚本搞崩（jsdom 宽度 0 → fit 早退）')
{
  const env = makeWindow({ size: { display: 'qwen' }, qwen: qwenOk({ used: 123456, cap: 10000, remaining: 0, pct: 1234.6, usedAllTime: 999999 }) })
  await sleep(3200)
  const w = env.w
  t('超长读数仍能渲染', txt(w, '.dshwv-amount').indexOf('123.5k') !== -1, JSON.stringify(txt(w, '.dshwv-amount')))
  t('超长时不抛异常（泡泡文字在）', txt(w, '.dshwv-hint').length > 0, JSON.stringify(txt(w, '.dshwv-hint')))
  env.w.close()
}

console.log('\n[无数据] 优雅显示')
{
  const env = makeWindow({ qwen: null })
  await sleep(300)
  const w = env.w
  t('空态金额行 --', txt(w, '.dshwv-amount') === '--', JSON.stringify(txt(w, '.dshwv-amount')))
  t('空态提示「暂无套餐用量记录」', /暂无套餐用量记录/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  t('空态不冒泡', el(w, '.dshwv-bubble').className.indexOf('dshwv-bubble-open') === -1)
  env.w.close()
}

console.log('\n[自适应 v2] 先长气泡 → 再缩「估算」行 → 主行字号不背锅')
{
  // jsdom 没有排版引擎，量出来永远是 0 → 只能验「不崩」。这里给窗口装一个按 em 估宽
  // 的假排版：字号/折行宽度都从挂件真正写的 CSS 变量读，于是 fitBubbleText 的决策
  // 会反过来改变下一轮的测量值（和真浏览器一样的反馈回路），才算真的测到东西。
  const FSU = { 'dshwv-label': 66, 'dshwv-period': 104, 'dshwv-amount': 128, 'dshwv-hint': 44 }
  function installLayout(w, cfg) {
    const u = cfg.base / 1026
    const root = el(w, '.dshwv-root')
    const bub = el(w, '.dshwv-bubble')
    const box = el(w, '.dshwv-text')
    const lines = [el(w, '.dshwv-label'), el(w, '.dshwv-amount'), el(w, '.dshwv-hint')]
    root.getBoundingClientRect = () => ({
      left: cfg.left, top: cfg.top, width: cfg.base, height: cfg.base,
      right: cfg.left + cfg.base, bottom: cfg.top + cfg.base, x: cfg.left, y: cfg.top,
    })
    w.innerWidth = cfg.vw
    w.innerHeight = cfg.vh
    const numv = (name, d) => {
      const v = parseFloat(bub.style.getPropertyValue(name))
      return isNaN(v) ? d : v
    }
    function fontOf(node) {
      let f = 40 * u
      for (const k in FSU) {
        if (node.className.indexOf(k) === -1) continue
        f = FSU[k] * u
        if (k === 'dshwv-hint') f *= numv('--dshw-hfit', 1)
      }
      return f
    }
    function natOf(node) {
      let em = 0
      for (const ch of node.textContent) em += ch.codePointAt(0) > 0x2e80 ? 1 : 0.52
      return em * fontOf(node)
    }
    function layout() {
      const ms = lines.map((n) => {
        if (n.style.display === 'none' || !n.textContent) return { w: 0, h: 0 }
        const lh = fontOf(n) * 1.18
        const nat = natOf(n)
        if (n.className.indexOf('dshwv-wrap') !== -1) {
          const maxw = parseFloat(n.style.maxWidth) || 480 * u * numv('--dshw-bgrow', 1)
          return { w: Math.min(nat, maxw), h: Math.max(1, Math.ceil(nat / maxw)) * lh }
        }
        return { w: nat, h: lh }
      }).map((m) => ({ w: Math.ceil(m.w), h: Math.ceil(m.h) })) // 浏览器给的也是整像素
      let total = 0
      const tops = []
      for (let i = 0; i < 3; i++) {
        if (!ms[i].w) { tops.push(0); continue }
        if (total > 0) total += i === 2 ? Math.ceil(7 * u) : 0
        tops.push(total)
        total += ms[i].h
      }
      return { ms, tops, total }
    }
    for (let i = 0; i < 3; i++) {
      const idx = i
      const node = lines[i]
      const def = (prop, get) => Object.defineProperty(node, prop, { configurable: true, get })
      def('scrollWidth', () => layout().ms[idx].w)
      def('offsetWidth', () => layout().ms[idx].w)
      def('offsetHeight', () => layout().ms[idx].h)
      def('offsetTop', () => layout().tops[idx])
    }
    Object.defineProperty(box, 'offsetHeight', { configurable: true, get: () => layout().total })
    return { u, bub, lines, layout, numv }
  }
  // 独立复核：用最终落到 DOM 上的变量再算一次「还有没有捅出椭圆」
  function worstOverflow(L) {
    const g = L.numv('--dshw-bgrow', 1)
    const ts = L.numv('--dshw-ts', 1)
    const ai = (373 - 9) * g * L.u // 描边内沿半轴
    const bi = (232 - 9) * g * L.u
    const A = ai - 26 * L.u // 再让出横向呼吸位
    const B = bi - 16 * L.u
    const cy = (646 - 399 * g) * L.u
    const py = (646 - 380 * g) * L.u
    const lay = L.layout()
    let worst = 0
    for (let i = 0; i < 3; i++) {
      const m = lay.ms[i]
      if (!m.w) continue
      const center = py + ts * (lay.tops[i] + m.h / 2 - lay.total / 2)
      const ymax = Math.abs(center - cy) + (ts * m.h * 0.7) / 2 // 只有「墨」需要在椭圆里
      if (ymax >= B) {
        worst = Math.max(worst, ymax - B)
        if (process.env.WHALE_FIT_DEBUG) console.log('   row' + i + ' 纵向溢出 ' + Math.round(ymax - B) + ' (ymax=' + Math.round(ymax) + ' B=' + Math.round(B) + ')')
        continue
      }
      const lim = ai * Math.sqrt(Math.max(0, 1 - (ymax / bi) * (ymax / bi))) - 26 * L.u
      const over = (ts * m.w) / 2 - lim
      if (process.env.WHALE_FIT_DEBUG) console.log('   row' + i + ' w=' + m.w + ' h=' + m.h + ' top=' + lay.tops[i] + ' total=' + lay.total + ' ymax=' + Math.round(ymax) + ' lim=' + Math.round(lim) + ' over=' + Math.round(over))
      worst = Math.max(worst, over)
    }
    return worst
  }
  const LONG_HINT = '本周 Credits 顶到天花板了，等服务恢复（估算）'
  async function fitCase(cfg, texts) {
    const env = makeWindow({ size: { display: 'qwen' } })
    await sleep(300)
    const w = env.w
    clickWhale(w) // 先把泡泡打开，三行才有内容
    await sleep(120)
    const L = installLayout(w, cfg)
    L.lines[0].textContent = texts[0]
    L.lines[1].textContent = texts[1]
    L.lines[2].textContent = texts[2]
    w.dispatchEvent(new w.Event('resize')) // 只重排文字，不改内容 → 确定性触发 fit
    await sleep(120)
    return { L, w, env, g: L.numv('--dshw-bgrow', 1), ts: L.numv('--dshw-ts', 1), hf: L.numv('--dshw-hfit', 1), over: worstOverflow(L) }
  }
  const ROOMY = { base: 375, left: 880, top: 400, vw: 1280, vh: 800 }

  const tiny = await fitCase(ROOMY, ['余额', '720', '今天'])
  t('真·短内容不放大也不缩字', tiny.g === 1 && tiny.ts === 1 && tiny.hf === 1, JSON.stringify({ g: tiny.g, ts: tiny.ts, hf: tiny.hf }))
  t('真·短内容零溢出', tiny.over <= 2, String(Math.round(tiny.over * 10) / 10))
  tiny.env.w.close()

  // 常态套餐面板那三行本来就把椭圆腰挤满了（就是「依旧有超出」那一档）：
  // 正解是气泡长一点点，而不是把 128 号字的金额行缩糊
  const panel = await fitCase(ROOMY, ['Token Plan 本周', '720 Cr', '剩 9280 · 4天12h后重置'])
  t('常态面板：只长一点气泡，字号一个没缩', panel.g > 1 && panel.g < 1.25 && panel.ts === 1 && panel.hf === 1, JSON.stringify({ g: panel.g, ts: panel.ts, hf: panel.hf }))
  t('常态面板零溢出', panel.over <= 2, String(Math.round(panel.over * 10) / 10))
  panel.env.w.close()

  const wide = await fitCase(ROOMY, ['Token Plan 第 2/7 天', '2946 Cr', '随便造~'])
  t('宽的标题行：靠长气泡解决，不缩字号', wide.g > 1 && wide.ts === 1 && wide.hf === 1, JSON.stringify({ g: wide.g, ts: wide.ts, hf: wide.hf }))
  t('宽标题行零溢出', wide.over <= 2, String(Math.round(wide.over * 10) / 10))
  wide.env.w.close()

  const long = await fitCase(ROOMY, ['Token Plan 第 2/7 天', '2946 Cr', LONG_HINT])
  t('超长提示行：气泡先长大', long.g > 1.05, 'bgrow=' + long.g)
  t('超长提示行：主行字号一点没缩', long.ts === 1, 'ts=' + long.ts)
  t('超长提示行：「估算」那行单独缩了', long.hf < 1, 'hfit=' + long.hf)
  t('超长提示行：仍然零溢出', long.over <= 2, String(Math.round(long.over * 10) / 10))
  long.env.w.close()

  const huge = await fitCase(ROOMY, ['Token Plan 第 2/7 天', '123.5k Cr', LONG_HINT + '，' + LONG_HINT + '，' + LONG_HINT])
  t('极端超长：折行兜底', /dshwv-wrap/.test(huge.L.lines[2].className), JSON.stringify(huge.L.lines[2].className))
  t('极端超长：气泡长到上限附近', huge.g > 1.3, 'bgrow=' + huge.g)
  t('极端超长：主行几乎没缩', huge.ts >= 0.9, 'ts=' + huge.ts)
  t('极端超长：依旧零溢出', huge.over <= 2, String(Math.round(huge.over * 10) / 10))
  huge.env.w.close()

  // 贴屏幕左上角：向上/向外没地方长，必须自动收敛并退回缩字
  const tight = await fitCase({ base: 375, left: 0, top: 0, vw: 1280, vh: 800 }, ['Token Plan 第 2/7 天', '2946 Cr', LONG_HINT])
  t('贴边时气泡不长出屏幕', tight.g <= 1.06, 'bgrow=' + tight.g)
  t('贴边时改用缩字补位', tight.hf < 1 || tight.ts < 1, JSON.stringify({ hf: tight.hf, ts: tight.ts }))
  t('贴边时依旧零溢出', tight.over <= 2, String(Math.round(tight.over * 10) / 10))
  tight.env.w.close()

  // 文字块中心要跟着长大后的白区一起挪，否则字会贴着下边缘
  const moved = await fitCase(ROOMY, ['Token Plan 第 2/7 天', '2946 Cr', LONG_HINT])
  const wantTy = Math.round((moved.g - 1) * (266 - 646) * moved.L.u * 100) / 100
  t('放大后文字块跟着挪回白区中心', Math.round(parseFloat(moved.L.bub.style.getPropertyValue('--dshw-ty'))) === Math.round(wantTy), moved.L.bub.style.getPropertyValue('--dshw-ty') + ' vs ' + wantTy)
  moved.env.w.close()
}


// —— 告警持久性：不自动关、确认到点再提醒、没回安全线红点一直在 ——
console.log(String.fromCharCode(10) + '[告警持久性] 不自动关 + 到点再提醒 + 常驻红点')
{
  const env = makeWindow({ qwen: QWEN_WARN })
  const w = env.w
  await sleep(400)
  t('告警泡泡自动弹出', el(w, '.dshwv-bubble').className.indexOf('bubble-open') >= 0)
  t('告警金额行显示百分比', txt(w, '.dshwv-amount') === '72.5%', txt(w, '.dshwv-amount'))
  t('超标时红点挂上', el(w, '.dshwv-root').className.indexOf('dshwv-alert-over') >= 0)
  t('源码里不再排自关定时器', client.indexOf('setTimeout(hideQwenAlert') === -1)
  await sleep(1800)
  t('等 1.8s 依旧开着（不会自己消失）', el(w, '.dshwv-bubble').className.indexOf('bubble-open') >= 0)

  let off = 0
  const realNow = Date.now
  w.Date.now = function () { return realNow() + off }
  clickWhale(w)
  await sleep(250)
  t('点鲸鱼即确认关闭', el(w, '.dshwv-bubble').className.indexOf('bubble-open') < 0)
  t('确认后红点仍留（还没回安全线）', el(w, '.dshwv-root').className.indexOf('dshwv-alert-over') >= 0)

  clickWhale(w) // 顺带 fetchQwen：静默期内不该重弹
  await sleep(350)
  t('静默期内不重弹', txt(w, '.dshwv-amount') !== '72.5%', txt(w, '.dshwv-amount'))

  off = 3600001 // 越过 warn 的 60min 重弹间隔
  clickWhale(w)
  await sleep(350)
  t('到点同级还会再提醒', txt(w, '.dshwv-amount') === '72.5%', txt(w, '.dshwv-amount'))
  w.close()
}
{
  const env = makeWindow({ qwen: function (n) { return n <= 2 ? QWEN_WARN : QWEN_HIGH } })
  const w = env.w
  await sleep(400)
  clickWhale(w) // 确认掉 warn 告警（第二次轮询仍是 warn，静默）
  await sleep(300)
  const silenced = txt(w, '.dshwv-amount') !== '72.5%'
  clickWhale(w) // 第三次轮询：级别升到 high
  await sleep(350)
  t('未到重弹间隔但级别升档，立即再弹', silenced && txt(w, '.dshwv-amount') === '88%', txt(w, '.dshwv-amount'))
  t('升档后红点还在', el(w, '.dshwv-root').className.indexOf('dshwv-alert-over') >= 0)
  w.close()
}
{
  const env = makeWindow({ qwen: function (n) { return n <= 1 ? QWEN_WARN : qwenOk() } })
  const w = env.w
  await sleep(400)
  t('首轮是告警', txt(w, '.dshwv-amount') === '72.5%', txt(w, '.dshwv-amount'))
  clickWhale(w) // 确认 + 触发读到 ok 的那次轮询
  await sleep(450)
  t('回到安全线后红点消失', el(w, '.dshwv-root').className.indexOf('dshwv-alert-over') < 0)
  t('回到安全线后不再弹告警', txt(w, '.dshwv-amount') !== '72.5%', txt(w, '.dshwv-amount'))
  w.close()
}
console.log('\n[额度三态] 限流绝不许显示成「已触顶 · 暂停」')
{
  // 本机事故复现：周额度实际用了 66.5%，一次 429 TPM 限流把气泡钉成已触顶。
  // 服务端 classifyFailure 之后不会给 quotaHitAt，只给 rateLimitedAt。
  const env = makeWindow({
    size: { display: 'qwen' },
    qwen: qwenOk({
      used: 6651.5, remaining: 3348.5, pct: 66.5,
      rateLimitedAt: Date.now(),
      alert: { level: 'ok', label: '', pct: 66.5, warnPct: 70, shouldAnnounce: false },
    }),
  })
  const w = env.w
  await sleep(320)
  t('限流态提示行写「限流中」', /限流中/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  t('限流态不出现「已触顶」', txt(w, '.dshwv-hint').indexOf('已触顶') === -1, JSON.stringify(txt(w, '.dshwv-hint')))
  t('限流态仍显示剩余 Credits', /剩 3349|剩 3348/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  t('限流态转橙不转红', el(w, '.dshwv-amount').style.color === 'rgb(224, 122, 31)', el(w, '.dshwv-amount').style.color)
  t('限流态不挂常驻红点', el(w, '.dshwv-root').className.indexOf('dshwv-alert-over') < 0)
  w.close()
}
{
  // 颜色判序：快用完了该红就红，不能被一条限流信号压成橙色
  const env = makeWindow({
    size: { display: 'qwen' },
    qwen: qwenOk({
      used: 9200, remaining: 800, pct: 92, rateLimitedAt: Date.now(),
      alert: { level: 'high', label: '周额度即将用尽', pct: 92, warnPct: 70, shouldAnnounce: false },
    }),
  })
  const w = env.w
  await sleep(320)
  clickBubble(w) // high 级别会弹常驻告警，点掉看常态画面
  await sleep(150)
  pickAcct(w, 'ds')
  await sleep(120)
  pickAcct(w, 'qwen')
  await sleep(120)
  t('92% 撞上限流仍是红色，不被橙色降级', el(w, '.dshwv-amount').style.color === 'rgb(224, 67, 63)', el(w, '.dshwv-amount').style.color)
  t('但提示行照实说限流，不喊已触顶', /限流中/.test(txt(w, '.dshwv-hint')) && txt(w, '.dshwv-hint').indexOf('已触顶') === -1, JSON.stringify(txt(w, '.dshwv-hint')))
  w.close()
}
{
  // 真触顶（quotaHitAt 由服务端确认后下发）才是那套红字与措辞
  const env = makeWindow({
    size: { display: 'qwen' },
    qwen: qwenOk({
      used: 10000, remaining: 0, pct: 100, quotaHitAt: Date.now(),
      alert: { level: 'exhausted', label: '套餐额度已触顶', pct: 100, warnPct: 70, shouldAnnounce: false },
    }),
  })
  const w = env.w
  await sleep(320)
  t('真触顶弹常驻告警泡泡', el(w, '.dshwv-bubble').className.indexOf('dshwv-bubble-open') !== -1)
  t('告警金额行是 100%', txt(w, '.dshwv-amount') === '100%', txt(w, '.dshwv-amount'))
  clickBubble(w) // 告警必须人点掉
  await sleep(150)
  pickAcct(w, 'ds') // 切一次显示态，看到确认后的常态画面
  await sleep(120)
  pickAcct(w, 'qwen')
  await sleep(120)
  t('真触顶才写「已触顶 · 暂停」', txt(w, '.dshwv-hint') === '已触顶 · 暂停', JSON.stringify(txt(w, '.dshwv-hint')))
  t('真触顶转红', el(w, '.dshwv-amount').style.color === 'rgb(224, 67, 63)', el(w, '.dshwv-amount').style.color)
  w.close()
}
{
  // 存疑：报错说额度不足，但估算还剩三成 —— 只能说存疑，不能喊触顶
  const env = makeWindow({
    size: { display: 'qwen' },
    qwen: qwenOk({
      used: 6651.5, remaining: 3348.5, pct: 66.5, quotaHitSuspectAt: Date.now(),
      alert: { level: 'ok', label: '', pct: 66.5, warnPct: 70, shouldAnnounce: false },
    }),
  })
  const w = env.w
  await sleep(320)
  t('存疑态写「存疑」不写「已触顶」', /存疑/.test(txt(w, '.dshwv-hint')) && txt(w, '.dshwv-hint').indexOf('已触顶') === -1, JSON.stringify(txt(w, '.dshwv-hint')))
  t('存疑态转橙不转红', el(w, '.dshwv-amount').style.color === 'rgb(224, 122, 31)', el(w, '.dshwv-amount').style.color)
  w.close()
}

console.log('\n' + passed + ' 项通过')
