// Opt-in real Chromium regression test / interactive preview for issue #245.
// WHALE_PLAYWRIGHT_DIR points at an existing Playwright installation; no new
// production dependency or access to real balances/settings is required.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(process.env.WHALE_PLAYWRIGHT_DIR || root, 'package.json'))
const { _electron: electron } = require('playwright')
const output = path.resolve(process.env.WHALE_FIT_OUTPUT || path.join(os.tmpdir(), 'whale-balance-fit-results'))
fs.mkdirSync(output, { recursive: true })
const before = execFileSync('git', ['show', 'upstream/main:assets/whale-widget.js'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
const after = fs.readFileSync(path.join(root, 'assets/whale-widget.js'), 'utf8')
const hook = `
window.balanceFixture = function(o) {
  if (animId) cancelAnimationFrame(animId);
  shown = null; state.balance = o.balance; state.currency = o.currency || 'CNY'; state.status = 'ok';
  root.style.width = o.width + 'px'; root.style.height = o.width + 'px';
  root.style.setProperty('--dshw-u', (o.width / 1026) + 'px');
  textBox.style.setProperty('--dshw-u', (o.width / 1026) + 'px');
  root.style.left = '26px'; root.style.top = '60px'; root.style.right = 'auto'; root.style.bottom = 'auto';
  textBox.classList.toggle('dshwv-textsafe', !!o.safe);
  textBox.style.width = o.safe ? o.safe + '%' : '66%';
  var mods = [{type:'text',text:'DeepSeek 余额',size:6,bold:true},
    {type:'balance',size:o.size || 21,tpl:o.tpl || '{balance_ds}',bg:o.bg || '',fontFamily:o.font || ''},
    {type:'text',text:'今日已用 ¥ 0.00',size:4}];
  bubbleShown = false;
  sceneOpen('custom', function(){bubbleRenderModules(mods)}, 0);
  if (o.legacy) {
    bubbleClearModuleRows(); labelEl.style.display = ''; amountEl.style.display = ''; hintEl.style.display = '';
    render(); if(o.animate) animateAmount(o.balance, o.balance / 2, state.currency, 180);
  }
  if(o.preview) bubblePreviewInto(document.getElementById('preview'),mods);
  if(o.random) applyBubbleLines([{s:'L',t:'趣味文案'},{s:'A',t:'保持原版字号'}]);
  return fmt(state.balance, state.currency);
};
`
function instrument(source) {
  const anchor = 'setInterval(function () { pollLastTurn(); pollWaitState() }, 1000)'
  assert.ok(source.includes(anchor), 'fixture hook anchor')
  return source.replace(anchor, hook + '\n' + anchor)
}
const fixture = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white;font-family:Segoe UI,sans-serif}#preview-host{position:absolute;left:550px;top:70px;width:400px}h3{margin:16px 26px;color:#203170}</style><h3>模拟余额 · 不连接真实账户</h3><div id="root"><textarea hidden></textarea></div><div id="preview-host"><div id="preview"></div></div><script>
window.fetch=async()=>({ok:true,json:async()=>({ok:false,config:null,models:[],items:[],roles:[],audio:[],seq:0})});
</script><script src="/widget.js?mode=MODE"></script>`
const viewer = `<!doctype html><meta charset="utf-8"><title>#245 余额显示修复对比</title><style>body{font:15px Segoe UI,sans-serif;background:#f1f5f9;color:#203170;margin:20px}label{margin-right:16px}input{width:110px}main{display:flex;gap:16px;margin-top:20px}section{background:white;border-radius:12px;padding:12px}iframe{width:545px;height:620px;border:0}h2{margin:5px}p{color:#64748b}</style><h1>#245 · 大额余额显示对比</h1><p>全部为模拟数据，不读取密钥、不更改真实账目。</p><label>余额 <input id="balance" type="number" value="24271.67" step="0.01"></label><label>字号档位 <input id="size" type="number" value="21" min="1" max="50"></label><label>安全区宽度（%，0 为经典框） <input id="safe" type="number" value="0" min="0" max="66"></label><button id="update">查看效果</button><main><section><h2>修复前</h2><iframe src="/fixture?mode=before"></iframe></section><section><h2>修复后</h2><iframe src="/fixture?mode=after"></iframe></section></main><script>
function update(){for(const f of document.querySelectorAll('iframe'))f.contentWindow.balanceFixture?.({balance:Number(document.querySelector('#balance').value),size:Number(document.querySelector('#size').value),safe:Number(document.querySelector('#safe').value),width:487})}document.querySelector('#update').onclick=update;for(const f of document.querySelectorAll('iframe'))f.onload=()=>setTimeout(update,300);
</script>`
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/') { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(viewer); return }
  if (url.pathname === '/fixture') { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(fixture.replace('MODE', url.searchParams.get('mode') === 'before' ? 'before' : 'after')); return }
  if (url.pathname === '/widget.js') { res.setHeader('Content-Type','text/javascript; charset=utf-8'); res.end(instrument(url.searchParams.get('mode') === 'before' ? before : after)); return }
  const name = url.pathname.endsWith('image.png') ? 'DSniang1.png' : url.pathname.endsWith('rua.gif') ? 'rua.gif' : path.basename(url.pathname)
  const asset = path.join(root, 'assets', name)
  if (fs.existsSync(asset) && fs.statSync(asset).isFile()) { res.setHeader('Content-Type',name.endsWith('.png')?'image/png':name.endsWith('.gif')?'image/gif':'application/octet-stream'); fs.createReadStream(asset).pipe(res); return }
  res.setHeader('Content-Type','application/json'); res.end('{}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
console.log('Preview: ' + url)
if (process.argv.includes('--serve')) { fs.writeFileSync(path.join(output,'preview-url.txt'),url); }
else {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-balance-ui-'))
  const main = path.join(home, 'main.cjs')
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(home)});app.whenReady().then(()=>{const w=new BrowserWindow({width:1040,height:800,webPreferences:{contextIsolation:true,sandbox:true}});w.loadURL(${JSON.stringify(url + '/fixture?mode=before')})});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [main], env })
  try {
    const page = await app.firstWindow()
    const options = { balance:24271.67,currency:'CNY',width:487,size:21 }
    const setup = async(mode,o=options)=>{await page.goto(url+'/fixture?mode='+mode);await page.waitForFunction(()=>!!window.balanceFixture);await page.evaluate(o=>window.balanceFixture(o),o);await page.waitForTimeout(650)}
    const geometry = () => page.evaluate(() => {
      const row = document.querySelector('.dshwv-text .dshwv-trow:nth-last-child(2)') || document.querySelector('.dshwv-amount')
      const range=document.createRange();range.selectNodeContents(row);const boxes=[...range.getClientRects()];const css=getComputedStyle(row)
      return {text:row.textContent,lines:new Set(boxes.map(b=>Math.round(b.top))).size,font:parseFloat(css.fontSize),width:row.getBoundingClientRect().width,parent:row.parentElement.clientWidth,overflow:row.scrollWidth>row.clientWidth+1}
    })
    await setup('before');const baseline=await geometry();await page.screenshot({path:path.join(output,'before.png')})
    await setup('after');const fixed=await geometry();await page.screenshot({path:path.join(output,'after.png')})
    console.log(JSON.stringify({baseline,fixed}));assert.ok(baseline.lines>1,JSON.stringify(baseline));assert.equal(fixed.lines,1);assert.equal(fixed.text,'¥ 24271.67');assert.ok(fixed.font<baseline.font);assert.equal(fixed.overflow,false)
    let cases = 0;
    for(const balance of [0,12.34,24271.67,9999999.99,-24271.67,null])for(const currency of ['CNY','USD','EUR'])for(const width of [240,487])for(const safe of [0,25]){
      await page.evaluate(o=>window.balanceFixture(o),{...options,balance,currency,width,safe,bg:'#ffe6ef',font:'Consolas'})
      await page.waitForTimeout(30);const g=await geometry();assert.equal(g.lines,1,JSON.stringify({balance,currency,width,safe,g}));assert.equal(g.overflow,false)
      assert.ok(g.width<=g.parent+1)
      cases++
    }
    await setup('after',{...options,balance:12.34});const small=await geometry();assert.ok(small.font>fixed.font)
    await page.evaluate(o=>window.balanceFixture({...o,preview:true}),options);assert.equal(await page.locator('#preview .dshwv-amount-fit').count(),1)
    await page.evaluate(o=>window.balanceFixture({...o,legacy:true,animate:true}),options);await page.waitForTimeout(250);assert.ok((await page.locator('.dshwv-amount').textContent()).includes('12135.83'))
    await page.evaluate(o=>window.balanceFixture({...o,legacy:true,random:true}),options);assert.equal(await page.locator('.dshwv-root .dshwv-amount-fit').count(),0)
    assert.equal(await page.getByText('保持原版字号',{exact:true}).evaluate(el=>el.style.fontSize),'')
    await page.evaluate(o=>window.balanceFixture({...o,tpl:'余额说明很长，保持原有换行：{balance_ds}'}),options);assert.equal(await page.locator('.dshwv-root .dshwv-trow.dshwv-amount-fit').count(),0)
    for(const size of [1,11,21,50]) {
      await page.evaluate(o=>window.balanceFixture(o),{...options,size,safe:25,preview:true})
      await page.waitForTimeout(30)
      const g=await geometry();assert.equal(g.lines,1);assert.equal(g.overflow,false)
      const preview=await page.locator('#preview .dshwv-amount-fit').evaluate(el=>({text:el.textContent,width:el.getBoundingClientRect().width,parent:el.parentElement.clientWidth,overflow:el.scrollWidth>el.clientWidth+1}))
      assert.equal(preview.text,g.text);assert.equal(preview.overflow,false);assert.ok(preview.width<=preview.parent+1)
      cases++
    }
    await page.evaluate(()=>document.fonts.dispatchEvent(new Event('loadingdone')))
    await page.waitForTimeout(30);assert.equal((await geometry()).overflow,false)
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({baseline,fixed,cases,small},null,2))
    await page.goto(url);await page.waitForTimeout(900);await page.screenshot({path:path.join(output,'comparison.png'),fullPage:true})
    console.log('Balance fit: original wrap reproduced; single-line values, currencies, fonts, safe areas, restoration, preview and animation passed.')
  } finally { await app.close();server.close();fs.rmSync(home,{recursive:true,force:true}) }
}
