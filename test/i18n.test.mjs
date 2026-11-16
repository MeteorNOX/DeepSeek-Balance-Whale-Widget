// test/i18n.test.mjs —— 中英文文案运行时的行为测试（0 依赖：node:test + node:vm）
//
// 为什么用 vm 而不是 jsdom：被测文件是纯逻辑（查表 + 语言判定），不需要 DOM。
// 每个用例都在**全新上下文**里加载文件，避免 require 缓存把上一个用例的 window/localStorage 带进来。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CODE = fs.readFileSync(path.join(ROOT, 'assets', 'whale-widget-i18n.js'), 'utf8')

// win: 模拟 window 上已有的注入值（如宿主注入的 window.dshwLang 字符串）
// nav: 模拟 navigator；store: 模拟 localStorage 的初始内容
function load(win, nav, store) {
  const mem = Object.assign({}, store || {})
  const ctx = {
    window: win || {},
    navigator: nav || {},
    localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v) } },
    module: { exports: {} },
    console,
  }
  vm.createContext(ctx)
  vm.runInContext(CODE, ctx)
  return { window: ctx.window, mem }
}

const en = { language: 'en-US', languages: ['en-US'] }
const zh = { language: 'zh-CN', languages: ['zh-CN'] }

test('英文字典规模：全部文案都装进表里（≥1000 条，防止表被截断/清空）', () => {
  const { window } = load({}, en)
  assert.ok(window.dshwLang.size >= 1000, '字典只有 ' + window.dshwLang.size + ' 条')
})

test('英文环境下常见文案被翻译', () => {
  const { window } = load({}, en)
  assert.equal(window.dshwT('菜单'), 'Menu')
  assert.equal(window.dshwT('保存'), 'Save')
  assert.equal(window.dshwT('小鲸鱼'), 'Little Whale')
  assert.equal(window.dshwT('余额·加载中…'), 'Balance · loading…')
})

test('中文环境下文案原样返回（零行为变化）', () => {
  const { window } = load({}, zh)
  assert.equal(window.dshwLang.effective(), 'zh')
  assert.equal(window.dshwT('菜单'), '菜单')
  assert.equal(window.dshwT('保存'), '保存')
})

test('查不到译文时返回原文而不是 undefined（fail-open）', () => {
  const { window } = load({}, en)
  assert.equal(window.dshwT('这条文案不存在'), '这条文案不存在')
  assert.equal(window.dshwT(''), '')
  assert.equal(window.dshwT(null), null)
})

test('语言来源优先级：宿主注入 > 本机设置 > 浏览器语言', () => {
  // 宿主注入强制英文：即使浏览器是中文也用英文
  assert.equal(load({ dshwLang: 'en' }, zh).window.dshwT('菜单'), 'Menu')
  // 宿主注入强制中文：即使浏览器是英文也用中文
  assert.equal(load({ dshwLang: 'zh' }, en).window.dshwT('菜单'), '菜单')
  // 没有注入时看本机设置：浏览器英文 + 存了 zh ⇒ 中文
  assert.equal(load({}, en, { 'dshw-lang': 'zh' }).window.dshwT('菜单'), '菜单')
  // 本机设置 auto ⇒ 跟随浏览器
  assert.equal(load({}, zh, { 'dshw-lang': 'auto' }).window.dshwT('菜单'), '菜单')
})

test('非中文浏览器一律落到英文', () => {
  for (const lang of ['ja-JP', 'de-DE', 'fr-FR', 'ko-KR']) {
    assert.equal(load({}, { language: lang, languages: [lang] }).window.dshwT('菜单'), 'Menu', lang)
  }
  // 取不到浏览器语言时保持中文（与历史行为一致）
  assert.equal(load({}, {}).window.dshwT('菜单'), '菜单')
})

test('多行文案按整条匹配（不是按片段）', () => {
  const { window } = load({}, en)
  assert.equal(window.dshwT('✓ 测试通过\n'), '✓ Test passed\n')
  assert.equal(window.dshwT('\n上次：'), '\nLast time: ')
})

test('set() 会持久化，且非法值退回 auto', () => {
  const { window, mem } = load({}, en)
  assert.equal(window.dshwLang.get(), 'auto')
  window.dshwLang.set('zh')
  assert.equal(mem['dshw-lang'], 'zh')
  window.dshwLang.set('ja')
  assert.equal(mem['dshw-lang'], 'auto')
})

test('window.dshwLang 只暴露 API 对象，不会被当成强制值', () => {
  const { window } = load({}, en)
  assert.equal(typeof window.dshwLang, 'object')
  assert.equal(window.dshwLang.effective(), 'en')
})
