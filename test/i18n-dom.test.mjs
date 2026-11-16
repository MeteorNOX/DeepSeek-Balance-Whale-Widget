// test/i18n-dom.test.mjs —— 端到端：把**真实挂件**在 DOM 里跑起来，验证中英两种界面
//
// 与 i18n.test.mjs 的分工：
//   · i18n.test.mjs   只测查表函数本身（0 依赖，任何环境都能跑）；
//   · 本文件          测"挂件真正渲染出来以后"界面是否真的换成了英文 —— 这是用户真正看到的。
//
// 依赖 jsdom 与 ../node_modules（本仓库的 CI 不装依赖，所以**没有 jsdom 时整组跳过**，
// 用 node_modules/.bin 外的方式跑不到它也不至于让 CI 变红）。本地验证请：
//   npm i -D jsdom && node --test test/i18n-dom.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const I18N = fs.readFileSync(path.join(ROOT, 'assets', 'whale-widget-i18n.js'), 'utf8')
const WIDGET = fs.readFileSync(path.join(ROOT, 'assets', 'whale-widget.js'), 'utf8')

function loadJsdom() {
  // jsdom 29 是具名导出（{ JSDOM }），老版本是默认导出，两种都兼容
  const pick = (mod) => (mod && typeof mod.JSDOM === 'function' ? mod.JSDOM : (typeof mod === 'function' ? mod : null))
  for (const base of [path.join(ROOT, 'package.json'), path.join(ROOT, '..', 'deepseek-harness', 'package.json')]) {
    try { const J = pick(createRequire(base)('jsdom')); if (J) return J } catch (err) {}
  }
  for (const p of ['/root/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.4.0/node_modules/jsdom']) {
    try { const J = pick(createRequire(p + '/package.json')('jsdom')); if (J) return J } catch (err) {}
  }
  return null
}
const JSDOM = loadJsdom()
const skip = JSDOM ? false : 'jsdom 未安装（本地请 npm i -D jsdom）'

// 在指定浏览器语言下把挂件真正跑起来，返回渲染后的 document
function boot(lang) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"><div data-composer-input="true"></div></div></body></html>', {
    url: 'http://127.0.0.1:8081/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  })
  const w = dom.window
  Object.defineProperty(w.navigator, 'language', { value: lang, configurable: true })
  Object.defineProperty(w.navigator, 'languages', { value: [lang], configurable: true })
  // 测试里不联网：配置/余额请求一律失败，挂件应走"读取失败"分支而不是崩溃
  w.fetch = () => Promise.reject(new Error('no network in test'))
  w.HTMLCanvasElement.prototype.getContext = () => null
  const errors = []
  w.addEventListener('error', (e) => errors.push(String(e.message)))
  // 挂件状态标记挂在它自己的 IIFE 里（window.__dshWhaleWidget）；这里读 w.eval 的返回值不可靠，
  // 所以用 w.__dshWhaleWidget（同一全局对象）判断是否启动，并在 eval 后立刻取值。
  w.eval(I18N)
  w.eval(WIDGET)
  return { dom, w, errors, started: w.__dshWhaleWidget === true }
}

const settle = () => new Promise((r) => setTimeout(r, 800))
// 挂件会起 interval / MutationObserver —— 测完必须 close()，否则 node 进程不退出
const done = (dom) => { try { dom.window.close() } catch (err) {} }

test('挂件在 DOM 里能启动（中英都不抛错）', { skip }, async () => {
  for (const lang of ['en-US', 'zh-CN']) {
    const { dom, w, errors, started } = boot(lang)
    await settle()
    done(dom)
    assert.equal(started, true, lang + ' 未启动')
    assert.deepEqual(errors, [], lang + ' 有未捕获错误')
  }
})

test('英文环境：渲染出的界面里没有中文残留（除用户自己的泡泡内容外）', { skip }, async () => {
  const { dom, w } = boot('en-US')
  await settle()
  const text = w.document.body.textContent || ''
  done(dom)
  const cjk = text.match(/[\u4e00-\u9fff]/g) || []
  assert.equal(cjk.length, 0, '英文界面里仍有中文：' + JSON.stringify(text.match(/[\u4e00-\u9fff].{0,20}/g)))
})

test('中文环境：界面仍是中文（零行为变化）', { skip }, async () => {
  const { dom, w } = boot('zh-CN')
  await settle()
  const text = w.document.body.textContent || ''
  done(dom)
  assert.ok((text.match(/[\u4e00-\u9fff]/g) || []).length > 100, '中文界面文字过少，可能没渲染')
})

test('英文环境：界面文案确实被换成了英文（抽查可见文字与悬停提示）', { skip }, async () => {
  const { dom, w } = boot('en-US')
  await settle()
  const text = w.document.body.textContent || ''
  // 挂件收起时菜单行是隐藏的，但面板内的文案与 title 提示都已渲染 —— 两处一起抽查
  const attrs = [...w.document.querySelectorAll('[title]')].map((n) => n.getAttribute('title')).join(' | ')
  done(dom)
  const haystack = text + ' | ' + attrs
  for (const word of ['Bubble frame', 'Snap & flip settings', 'Flip line', 'Cancel', 'Save']) {
    assert.ok(haystack.includes(word), '英文界面里找不到 ' + word)
  }
})
