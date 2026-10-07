import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { BrowserWindow } = createRequire(import.meta.url)('electron');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function verifySurfaceLifecycle({ app, window, screen, setHost, setTestCursor, dataDir, renderInfo }) {
  const output = path.resolve(process.env.WHALE_DESKTOP_VERIFY_DIR);
  fs.mkdirSync(output, { recursive: true });
  const report = { ok: false, checks: [], samples: [], menuPaths: [], dataDir };
  const ev = code => window.webContents.executeJavaScript(code);
  const wait = async (code, message) => {
    const end = Date.now() + 7000;
    while (Date.now() < end) { if (await ev(code)) return; await delay(35); }
    throw Error('Timed out: ' + message);
  };
  let backdrop, helper;
  try {
    assert.equal(process.platform, 'win32', 'native region regression requires Windows');
    assert.ok(process.env.WHALE_TEST_PYTHON, 'set WHALE_TEST_PYTHON to Python with Pillow');
    const area = screen.getPrimaryDisplay().workArea;
    const dip = { x: area.x + 30, y: area.y + 30, width: 700, height: 550 };
    await setHost({ hostAlive: true, hostPid: 123456, window: '0', visible: true, attached: true, bounds: screen.dipToScreenRect(null, dip) });
    await wait("document.querySelector('.dshwv-img')?.naturalWidth > 0 && window.__whaleRenderTest?.status().balance === 12.3456 && !__whaleRenderTest.status().busy", 'fixture ready');
    await delay(1800);
    await ev("__whaleRenderTest.scale(1); __whaleRenderTest.place(140,140,false); __whaleRenderTest.close()");
    await delay(700);
    // Isolate animation clipping from other applications and never capture user
    // content. Topmost is confined to this temporary test backdrop: this test
    // makes no claim about production stacking or intermittent visibility.
    backdrop = new BrowserWindow({ ...window.getBounds(), frame: false, thickFrame: false, resizable: false, roundedCorners: false, hasShadow: false, show: false, backgroundColor: '#253953', webPreferences: { sandbox: true } });
    await backdrop.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:#253953"></body>'));
    backdrop.setAlwaysOnTop(true);
    window.setParentWindow(backdrop); backdrop.show(); window.setAlwaysOnTop(true); window.showInactive(); window.moveTop();
    await delay(250);
    report.windows = { widget: window.getBounds(), backdrop: backdrop.getBounds(), backdropVisible: backdrop.isVisible(), background: await backdrop.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor') };
    let seq = 0;
    const pending = new Map();
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    helper = spawn(process.env.WHALE_TEST_PYTHON, ['-u', fileURLToPath(new URL('./surface-native-probe.py', import.meta.url)), window.getNativeWindowHandle().readBigUInt64LE().toString(), String(process.pid), backdrop.getNativeWindowHandle().readBigUInt64LE().toString(), output], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let helperErrors = ''; helper.stderr.on('data', b => { helperErrors += b; });
    createInterface({ input: helper.stdout }).on('line', line => {
      const result = JSON.parse(line);
      if (result.ready) readyResolve();
      else { const finish = pending.get(result.id); pending.delete(result.id); finish?.(result); }
    });
    await Promise.race([ready, delay(6000).then(() => { throw Error('Native probe did not start: ' + helperErrors); })]);
    const probe = async request => {
      const id = ++seq;
      const response = new Promise(resolve => pending.set(id, resolve));
      helper.stdin.write(JSON.stringify({ id, ...request }) + '\n');
      const result = await Promise.race([response, delay(4000).then(() => { throw Error('Native probe timeout'); })]);
      assert.equal(result.error, undefined); assert.ok(result.kind > 0, 'actual Windows HRGN must exist');
      return result;
    };
    const scale = await ev('devicePixelRatio');
    const bubble = await ev("document.querySelector('.dshwv-pop').getBoundingClientRect().toJSON()");
    const points = [[bubble.left + 2,bubble.top + 2],[bubble.right - 2,bubble.top + 2],[bubble.left + 2,bubble.bottom - 2],[bubble.right - 2,bubble.bottom - 2],[(bubble.left+bubble.right)/2,(bubble.top+bubble.bottom)/2]].map(p => p.map(v => Math.round(v * scale)));
    const visual = () => ev("(()=>{const p=document.querySelector('.dshwv-pop'); return {open:p.classList.contains('dshwv-pop-open'), painted:[...p.querySelectorAll('.dshwv-bshape,.dshwv-b1,.dshwv-b2')].some(e=>Number(getComputedStyle(e).opacity)>.01), animations:p.getAnimations({subtree:true}).filter(a=>a.playState==='running'||a.playState==='pending').length, shape:__whaleShapeTest.status()};})()");
    const show = async () => { await ev("__whaleRenderTest.showCost(.003,{completionKind:'success',amount:.003,currency:'USD',costState:'observed',tokens:40,label:'Fixture usage:'})"); await wait("__whaleRenderTest.status().shown&&!__whaleRenderTest.status().switching", 'bubble opens'); await delay(650); };
    const capture = async (name, request = {}) => {
      const result = await probe({ ...request, capture: name + '.png' });
      assert.equal(result.unobscured, true, 'screen evidence inconclusive: ' + JSON.stringify(result.occlusion));
      assert.ok(result.nonBackdropPixels > 40, 'native screen capture must contain rendered widget pixels');
      assert.ok(result.capture, 'capture did not contain the isolated opaque backdrop: ' + JSON.stringify({background:result.backdropPixels,total:result.pixelCount}));
      return result;
    };
    for (const reopen of [false, true]) {
      await show();
      const before = await capture(reopen ? 'rapid-before' : 'close-before', { points });
      assert.ok(before.contains.every(Boolean), 'opened bubble is fully present in real Windows region');
      await ev('__whaleRenderTest.close()');
      const started = Date.now();
      for (const target of [0,60,130,220,340,460,600,780]) {
        await delay(Math.max(0, started + target - Date.now()));
        if (reopen && target === 130) await ev("__whaleRenderTest.showCost(.004,{completionKind:'success',amount:.004,currency:'USD',costState:'observed',tokens:50,label:'Reopened fixture:'})");
        const state = await visual();
        const native = target === 220 || target === 460 ? await capture(`${reopen?'rapid':'close'}-${target}`, { points }) : await probe({ points });
        report.samples.push({ cycle: reopen ? 'rapid-reopen' : 'close', target, elapsed: Date.now()-started, state, native });
        if (state.open || state.painted || state.animations) assert.ok(native.contains.every(Boolean), `native bubble clipped while visible at ${target}ms (${reopen?'reopen':'close'})`);
        if (!reopen && target === 780) assert.equal(native.contains[0], false, 'finished close releases the bubble-only upper corner');
      }
      if (reopen) assert.equal((await visual()).open, true, 'old close callbacks cannot dismiss a reopened bubble');
      await ev('__whaleRenderTest.close()'); await delay(800);
    }
    report.checks.push('actual GetWindowRgn/GetRegionData retains complete bubble through closing frames and drops it after completion; rapid reopening survives old close callbacks');
    const getMenuGeometry = () => ev(`(()=>{
      const img=document.querySelector('.dshwv-img'), b=document.querySelector('.dshwv-menu-btn').getBoundingClientRect(), r=img.getBoundingClientRect();
      const flipped=WhaleRendering.mirrorScale(document.querySelector('.dshwv-root'))<0;
      const button={x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)}, solid=[],empty=[];
      for(let y=Math.max(1,Math.ceil(r.top));y<Math.min(innerHeight-1,r.bottom);y+=2)for(let x=Math.max(1,Math.ceil(r.left));x<Math.min(innerWidth-1,r.right);x+=2){
        if(x>=b.left-2&&x<=b.right+2&&y>=b.top-2&&y<=b.bottom+2)continue;
        const p={x,y};
        if(WhaleRendering.hitCache.hit(img,x,y,flipped))solid.push(p);
        else if(!__whaleInputTest.hit(p))empty.push(p);
      }
      const distance=(p,q)=>(p.x-q.x)**2+(p.y-q.y)**2;
      empty.sort((p,q)=>distance(p,button)-distance(q,button));
      const gap=empty[0];
      solid.sort((p,q)=>distance(p,gap)-distance(q,gap));
      return {pet:solid[0],gap,button};
    })()`);
    const move = async (point, pause) => {
      setTestCursor(point); await delay(25);
      // Production does not forward mouse movement while the overlay ignores
      // input. Only send Chromium movement once native interaction is enabled.
      if (renderInfo().inputEnabled) window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      await delay(pause);
    };
    const click = async p => {
      assert.equal(renderInfo().inputEnabled, true, 'real button route must enable native input');
      window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p}); await delay(25);
      window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p}); await delay(180);
    };
    for (const speed of ['slow','fast']) {
      await move({x:5,y:500},400);
      const menuGeometry=await getMenuGeometry(); assert.ok(menuGeometry.pet&&menuGeometry.gap);
      await move(menuGeometry.pet,250);
      const steps = speed==='slow'?18:5, pause = speed==='slow'?75:0;
      const samples=[], menuEntry={speed,geometry:menuGeometry,samples}; report.menuPaths.push(menuEntry);
      for(let i=0;i<=steps;i++) {
        const middle=Math.floor(steps/2), first=i<=middle;
        const from=first?menuGeometry.pet:menuGeometry.gap,to=first?menuGeometry.gap:menuGeometry.button,t=first?i/middle:(i-middle)/(steps-middle);
        const p={x:Math.round(from.x+(to.x-from.x)*t),y:Math.round(from.y+(to.y-from.y)*t)};
        await move(p,pause);
        const state=await ev(`(()=>{const b=document.querySelector('.dshwv-menu-btn');return {visible:b.classList.contains('dshwv-menu-btn-visible'),opacity:Number(getComputedStyle(b).opacity),hit:__whaleInputTest.hit(${JSON.stringify(p)})};})()`);
        // Renderer-to-main input flags travel asynchronously over IPC. Wait a
        // bounded interval for that update before testing Windows hit routing.
        const inputAt=Date.now();
        while(renderInfo().inputEnabled!==state.hit && Date.now()-inputAt<250)await delay(5);
        const sample={point:p,...state,inputEnabled:renderInfo().inputEnabled,inputSettleMs:Date.now()-inputAt}; samples.push(sample);
        assert.ok(state.visible && state.opacity>.8, 'menu button must remain visible across transparent hover gap: '+JSON.stringify({speed,i,state,p}));
        if(!state.hit){
          assert.equal(renderInfo().inputEnabled,false,'transparent hover corridor remains click-through');
          const native=await probe({hitPoints:[[Math.round(p.x*scale),Math.round(p.y*scale)]]});
          assert.equal(native.hitsWidget[0],false,'Windows routes the transparent gap to the underlying window');
          sample.nativeHitWidget=native.hitsWidget[0];
        }
      }
      assert.ok(samples.some(s=>!s.hit),'path must actually cross a transparent gap');
      await click(menuGeometry.button);
      assert.equal(await ev("document.querySelector('.dshwv-menu').classList.contains('dshwv-menu-open')"),true,'menu accepts click after crossing gap');
      await capture('menu-'+speed);
      // The existing dashboard may overlap its toggle button. Close through
      // the exposed sprite, the widget's established in-widget close gesture.
      const closePoint=await ev(`(()=>{const img=document.querySelector('.dshwv-img'),r=img.getBoundingClientRect(),flip=WhaleRendering.mirrorScale(document.querySelector('.dshwv-root'))<0;for(let y=Math.ceil(r.top);y<r.bottom;y+=2)for(let x=Math.ceil(r.left);x<r.right;x+=2){const e=document.elementFromPoint(x,y);if(!e?.closest('.dshwv-menu,.dshwv-menu-btn,.dshwv-pop-open')&&WhaleRendering.hitCache.hit(img,x,y,flip))return {x,y};}return null;})()`);
      assert.ok(closePoint,'an exposed sprite pixel must remain available');
      await move(closePoint,80); await click(closePoint);
      assert.equal(await ev("document.querySelector('.dshwv-menu').classList.contains('dshwv-menu-open')"),false,'sprite click closes the expanded menu');
      await move({x:5,y:500},550);
      const hiddenInput=await ev(`(()=>{const p=${JSON.stringify(menuGeometry.button)};return {hit:__whaleInputTest.hit(p),pet:WhaleRendering.hitCache.hit(document.querySelector('.dshwv-img'),p.x,p.y,WhaleRendering.mirrorScale(document.querySelector('.dshwv-root'))<0)};})()`);
      assert.equal(hiddenInput.hit,hiddenInput.pet,'hidden button adds no hotspot beyond the sprite pixels underneath it');
      const hidden=await ev("(()=>{const b=document.querySelector('.dshwv-menu-btn');return {visible:b.classList.contains('dshwv-menu-btn-visible'),opacity:Number(getComputedStyle(b).opacity)};})()");
      assert.equal(hidden.visible,false);assert.equal(hidden.opacity,0);
      menuEntry.hidden=hidden;
    }
    report.checks.push('slow and fast alpha-to-menu paths cross a pass-through gap without button flicker, accept real Electron clicks, and leave no hidden button hotspot');
    report.ok=true;
  } catch(error) { report.error=error.stack; throw error; }
  finally {
    fs.writeFileSync(path.join(output,'surface-lifecycle.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(output,'desktop-audit.json'),JSON.stringify(report,null,2));
    helper?.stdin.end(JSON.stringify({quit:true})+'\n');
    if(backdrop&&!backdrop.isDestroyed()){ window.setParentWindow(null);backdrop.destroy(); }
    app.quit();
  }
}
