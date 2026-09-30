import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function verifyDesktop({ app, window, screen, setHost, setTestCursor, dataDir, openedLinks, errors, renderInfo }) {
  const output = path.resolve(process.env.WHALE_DESKTOP_VERIFY_DIR);
  fs.mkdirSync(output, { recursive: true });
  const checks = [], ev = code => window.webContents.executeJavaScript(code);
  const wait = async (code, message, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await ev(code)) return; await delay(50); }
    throw new Error('Timed out: ' + message);
  };
  try {
    const area = screen.getPrimaryDisplay().workArea;
    const dip = { x: area.x + 24, y: area.y + 24, width: 700, height: 550 };
    const hostBounds = rect => typeof screen.dipToScreenRect === 'function' ? screen.dipToScreenRect(null, rect) : rect;
    await setHost({ hostAlive: true, hostPid: 123456, window: '0', visible: true, attached: true, bounds: hostBounds(dip) });
    await wait("document.querySelector('.dshwv-img')?.naturalWidth > 0 && localStorage.getItem('dshw-role') === 'default'", 'bad saved image falls back to the built-in role');
    await wait("window.__whaleRenderTest.status().balance === 12.3456 && !window.__whaleRenderTest.status().busy", 'startup size settings and initial data complete');
    assert.equal(window.isVisible(), true);
    checks.push('a missing saved image with retained metadata recovers a visible clickable default role on first launch');
    await ev('window.__whaleRenderTest.place(140, 140, false)'); await delay(450);
    const viewport = await ev("(() => {const r=document.querySelector('.dshwv-img').getBoundingClientRect(),p=document.querySelector('.dshwv-position'),root=document.querySelector('.dshwv-root');return {width:innerWidth,height:innerHeight,position:p.getBoundingClientRect().toJSON(),positionStyle:p.style.cssText,root:root.getBoundingClientRect().toJSON(),pet:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};})()");
    assert.ok(viewport.pet.width > 0 && viewport.pet.height > 0 && viewport.pet.left >= 0 && viewport.pet.top >= 0 && viewport.pet.right <= viewport.width && viewport.pet.bottom <= viewport.height, 'the complete role rectangle must be inside the fixture viewport: ' + JSON.stringify(viewport));
    const mask = await ev("WhaleRendering.hitCache.prepare('/dsh-whale/role-image.png?id=role_audit_apng').then(mask=>({width:mask.width,height:mask.height,alpha:[...mask.alpha]}))");
    assert.deepEqual(mask, { width: 2, height: 2, alpha: [0, 0, 255, 255] });
    checks.push('Chromium decodes the real two-frame APNG and both first-frame and later-frame pixels are clickable');
    assert.equal(await ev("whaleDesktop.openExternal('https://example.org/no-user-click')"), false);
    const edge = await ev(`(() => {
      const img=document.querySelector('.dshwv-img'),root=document.querySelector('.dshwv-root'),body=document.querySelector('.dshwv-body');
      const r=img.getBoundingClientRect(),candidates=[],flipped=WhaleRendering.mirrorScale(root)<0;
      for(let y=Math.ceil(r.top)+1;y<r.bottom-1;y+=2)for(let x=Math.ceil(r.left)+1;x<r.right-1;x+=2){
        const target=document.elementFromPoint(x,y);
        if(target?.closest('.dshwv-menu-btn,.dshwv-pop'))continue;
        if(WhaleRendering.hitCache.hit(img,x,y,flipped))candidates.push({x,y});
      }
      const css=body.style.cssText,transform=body.style.transform;body.style.transition='none';body.style.transform='scaleY(0.88) scaleX(1.05)';
      const result=candidates.find(p=>!WhaleRendering.hitCache.hit(img,p.x,p.y,flipped));body.style.transform=transform;void body.offsetWidth;body.style.cssText=css;
      document.addEventListener('pointerdown',e=>{window.__auditPointer=e.pointerId;},true);
      return result;
    })()`);
    assert.ok(edge, 'the original role must provide a press-animation boundary point');
    const pressPoint = await ev(`(() => {
      const img=document.querySelector('.dshwv-img'),root=document.querySelector('.dshwv-root'),r=img.getBoundingClientRect(),flipped=WhaleRendering.mirrorScale(root)<0;
      const points=[];for(let y=Math.ceil(r.top)+4;y<r.bottom-4;y+=4)for(let x=Math.ceil(r.left)+4;x<r.right-4;x+=4){
        const target=document.elementFromPoint(x,y);if(target?.closest('.dshwv-menu-btn,.dshwv-pop,.whale-account-card'))continue;
        if(WhaleRendering.hitCache.hit(img,x,y,flipped))points.push({x,y,d:(x-(r.left+r.width/2))**2+(y-(r.top+r.height/2))**2});
      }
      points.sort((a,b)=>a.d-b.d);return points[0];
    })()`);
    assert.ok(pressPoint, 'the original role must provide an unobscured central press point');
    const bodyTransform = () => ev(`(() => {const body=document.querySelector('.dshwv-body'),m=new DOMMatrix(getComputedStyle(body).transform);return {x:m.a,y:m.d,dragging:document.querySelector('.dshwv-root').classList.contains('dshwv-dragging')}})()`);
    for (const mode of ['api', 'subscription']) {
      assert.equal(await ev(`WhaleAccountView.setMode(${JSON.stringify(mode)})`), true);
      await ev('window.__whaleRenderTest.close(); WhaleAccountView.close()'); await delay(360);
      for (let attempt = 0; attempt < 3; attempt++) {
        setTestCursor(pressPoint); window.webContents.sendInputEvent({ type: 'mouseMove', ...pressPoint }); await delay(100);
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...pressPoint }); await delay(180);
        const pressed = await bodyTransform();
        await delay(260); const held = await bodyTransform();
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...pressPoint }); await delay(220);
        const released = await bodyTransform();
        const evidence = JSON.stringify({ pressed, held, released, inputEnabled: renderInfo().inputEnabled });
        assert.ok(pressed.y < .94 && pressed.x > 1.02 && pressed.dragging, mode + ' attempt ' + attempt + ' must visibly squash on pointerdown: ' + evidence);
        assert.ok(held.y < .94 && held.x > 1.02 && held.dragging, mode + ' attempt ' + attempt + ' must remain squashed while held: ' + evidence);
        assert.ok(released.y > .99 && released.x < 1.01 && !released.dragging, mode + ' attempt ' + attempt + ' must rebound only after pointerup: ' + evidence);
      }
    }
    await ev("WhaleAccountView.setMode('api'); window.__whaleRenderTest.close(); WhaleAccountView.close()"); await delay(360);
    checks.push('API and Codex subscription modes repeatedly squash on press, stay held, and rebound only on release');
    if (process.env.WHALE_PRESS_ONLY === '1') {
      fs.writeFileSync(path.join(output, 'desktop-audit.json'), JSON.stringify({ ok: true, checks, viewport, dataDir, pressOnly: true }, null, 2));
      ev('for (;;) {}').catch(() => {});
      await delay(80);
      app.quit();
      return;
    }
    setTestCursor(edge); window.webContents.sendInputEvent({ type: 'mouseMove', ...edge }); await delay(120);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...edge }); await delay(320);
    assert.equal(await ev(`WhaleRendering.hitCache.hit(document.querySelector('.dshwv-img'),${edge.x},${edge.y},WhaleRendering.mirrorScale(document.querySelector('.dshwv-root'))<0)`), false, 'the test pixel must become transparent while pressed');
    assert.equal(renderInfo().inputEnabled, true, 'a captured press must not make the window click-through');
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...edge });
    await wait("window.__whaleRenderTest.status().shown && !window.__whaleRenderTest.status().switching", 'accepted edge press completes its bubble click after moving alpha');
    checks.push('an actual boundary press keeps native input captured through squish and opens its bubble on release');
    await ev('window.__whaleRenderTest.close()'); await delay(350);
    await ev("window.__whaleRenderTest.scene([{type:'link',text:'审计测试链接',url:'https://example.org/whale-audit',size:3}],0)");
    await wait("!window.__whaleRenderTest.status().switching && !!document.querySelector('.dshwv-frame:not([inert]) [title=\"https://example.org/whale-audit\"]')", 'the real custom bubble link is rendered');
    await delay(500);
    const link = await ev("(() => {const e=document.querySelector('.dshwv-frame:not([inert]) [title=\"https://example.org/whale-audit\"]');const r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),left:r.left,top:r.top,right:r.right,bottom:r.bottom};})()");
    assert.ok(link.left >= 0 && link.top >= 0 && link.right <= viewport.width && link.bottom <= viewport.height);
    setTestCursor({ x: link.x, y: link.y });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: link.x, y: link.y }); await delay(100);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: link.x, y: link.y }); await delay(30);
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: link.x, y: link.y });
    const linkDeadline = Date.now() + 3000;
    while (openedLinks.length === 0 && Date.now() < linkDeadline) await delay(30);
    assert.deepEqual(openedLinks, ['https://example.org/whale-audit']);
    assert.equal(await ev("whaleDesktop.openExternal('https://example.org/repeated')"), false);
    checks.push('actual Electron input clicks the real custom-bubble link through enableLinkRun and opens exactly one allowed HTTP/S URL');
    // v0.3 feedback transactions exercised in the isolated real renderer.
    await ev("window.WhaleFeedback.open(); window.__feedbackBefore=localStorage.getItem('dshw-v3-feedback'); (()=>{const e=document.querySelector('.whale-v3-dialog input[type=range]'); e.value='0';e.dispatchEvent(new Event('input'));})()");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait("!document.querySelector('.whale-v3-dialog[open]')", 'Escape dismisses feedback draft');
    assert.equal(await ev("localStorage.getItem('dshw-v3-feedback') === window.__feedbackBefore"), true);
    await ev("window.WhaleFeedback.open(); (()=>{const d=document.querySelector('.whale-v3-dialog[open]'), e=d.querySelector('input[type=range]');e.value='0';e.dispatchEvent(new Event('input')); [...d.querySelectorAll('button')].find(b=>b.textContent==='保存').click();})()");
    assert.equal(await ev("JSON.parse(localStorage.getItem('dshw-v3-feedback')).events.press.volume"), 0);
    assert.equal(await ev("JSON.parse(localStorage.getItem('dshw-v3-feedback')).events.release.volume"), .8);
    await ev("window.WhaleFeedback.open(); (()=>{const d=document.querySelector('.whale-v3-dialog[open]'), e=d.querySelector('input[type=range]');e.value='.5';e.dispatchEvent(new Event('input')); [...d.querySelectorAll('button')].find(b=>b.textContent==='取消').click();})()");
    assert.equal(await ev("JSON.parse(localStorage.getItem('dshw-v3-feedback')).events.press.volume"), 0);
    checks.push('real feedback panel saves zero volume independently and discards Cancel and Escape drafts');
    await ev("window.WhaleFeedback.open()"); await delay(100);
    fs.writeFileSync(path.join(output, 'feedback-v3.png'), (await window.webContents.capturePage()).toPNG());
    await ev("document.querySelector('.whale-v3-dialog[open]').close(); WhaleAccountView.setMode('subscription').then(()=>window.dispatchEvent(new Event('whale-open-insights')))"); await delay(300);
    await wait("document.querySelector('.whale-v3-dialog[open]')?.textContent.includes('本机已观测 token')", 'insights response rendered');
    fs.writeFileSync(path.join(output, 'insights-v3.png'), (await window.webContents.capturePage()).toPNG());
    await ev("WhaleAccountView.setMode('api')");
    await ev("document.querySelector('.whale-v3-dialog[open]').close(); [...document.querySelectorAll('.dshwv-menu button')].find(b=>b.textContent==='本地创意工坊').click()"); await delay(100);
    fs.writeFileSync(path.join(output, 'workshop-v3.png'), (await window.webContents.capturePage()).toPNG());
    await ev("document.querySelector('.whale-v3-dialog[open]').close(); [...document.querySelectorAll('.dshwv-menu button')].find(b=>b.textContent==='进入桌面').click()"); await delay(150);
    assert.equal((await ev("whaleDesktop.command('mode')")), 'standalone');
    await ev("[...document.querySelectorAll('.dshwv-menu button')].find(b=>b.textContent==='跟随 Codex').click()"); await delay(150);
    assert.equal((await ev("whaleDesktop.command('mode')")), 'follow-codex');
    checks.push('feedback, insights and workshop panels render; desktop/follow buttons execute their real DOM command handlers');
    assert.equal(await ev("whaleDesktop.command('desktop')"), true);
    await delay(180);
    await setHost({hostAlive:false,hostPid:0,window:'0',visible:false,attached:false});
    await delay(180);
    assert.equal(window.isVisible(), true, 'standalone survives missing Codex host');
    await setHost({hostAlive:true,hostPid:123456,window:'0',visible:true,attached:true,bounds:hostBounds(dip)});
    assert.equal(await ev("whaleDesktop.command('follow')"), true);
    await delay(180);
    assert.equal(window.isVisible(), true);
    assert.equal(window.getBounds().width, dip.width);
    checks.push('real Electron commands switch to desktop, survive absent host and return to the follow viewport');
    const savedConfig=fs.readFileSync(path.join(dataDir,'fixture-codex','config.toml'),'utf8');
    assert.equal(await ev("WhaleAccountView.setMode('subscription')"),true);
    assert.equal(await ev("WhaleAccountView.mode"),'subscription');
    await ev("WhaleAccountView.toggleBubble(document.querySelector('.dshwv-root'))");
    await wait("document.querySelector('.whale-account-card')?.textContent.includes('本机近 7 天')",'subscription card uses real insights route');
    assert.equal(await ev("document.querySelector('.whale-account-card').textContent.includes('不能用百分比换算剩余 token')"),true);
    fs.writeFileSync(path.join(output,'subscription-mode.png'),(await window.webContents.capturePage()).toPNG());
    assert.equal(await ev("WhaleAccountView.setMode('api')"),true);
    assert.equal(await ev("!!document.querySelector('.whale-account-card')"),false);
    assert.equal(fs.readFileSync(path.join(dataDir,'fixture-codex','config.toml'),'utf8'),savedConfig);
    await ev("document.querySelector('.dshwv-menu-btn').click(); const r=document.createRange();r.selectNodeContents(document.querySelector('.dshwv-menu'));getSelection().addRange(r); window.dispatchEvent(new Event('whale-mode-changing'));");
    assert.equal(await ev("getSelection().toString()"),'');
    assert.equal(await ev("document.querySelector('.dshwv-menu').classList.contains('dshwv-menu-open')"),false);
    assert.equal(await ev("getComputedStyle(document.querySelector('.dshwv-menu')).userSelect"),'none');
    checks.push('API/member switch changes the card only, preserves Codex config, and mode transition closes menu and clears selection');
    const p=await ev("(()=>{const r=document.querySelector('.dshwv-img').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await setHost({hostAlive:true,hostPid:123456,window:'0',visible:true,attached:true,bounds:hostBounds(dip),mouseButtons:1});
    setTestCursor(p);await delay(180);assert.equal(renderInfo().inputEnabled,false,'external drag never activates overlay');
    await setHost({hostAlive:true,hostPid:123456,window:'0',visible:true,attached:true,bounds:hostBounds(dip),mouseButtons:0});
    setTestCursor(p);await delay(180);
    checks.push('external mouse drag is passed through instead of stealing the host cursor');
    await ev("window.__whaleShapeTest.publish()");await delay(150);
    const shapes=renderInfo().windowShape;
    assert.ok(shapes?.length>0);
    assert.ok(shapes.reduce((n,r)=>n+r.width*r.height,0)<dip.width*dip.height*.5,'empty client area is not a native overlay');
    const scale=await ev('devicePixelRatio');
    const python=process.env.WHALE_TEST_PYTHON;
    if(python){
      const result=await promisify(execFile)(python,[fileURLToPath(new URL('./region-probe.py',import.meta.url)),window.getNativeWindowHandle().readBigUInt64LE().toString(),String(process.pid),String(Math.round(2*scale)),String(Math.round(400*scale)),String(Math.round(p.x*scale)),String(Math.round(p.y*scale))],{windowsHide:true});
      const region=JSON.parse(result.stdout);assert.notEqual(region.kind,0);assert.deepEqual(region.contains,[false,true]);
      fs.writeFileSync(path.join(output,'native-region.json'),JSON.stringify(region));
      checks.push('native Windows region excludes the empty Codex text area and includes the whale');
    }
    await wait("document.querySelectorAll('.whale-account-menu [data-mode]').length===2", 'visible account mode switch mounts after widget creation');
    for (const [x,y] of [[0,0],[520,0],[0,370],[520,370]]) {
      await ev(`window.__whaleRenderTest.place(${x},${y},false);document.querySelector('.dshwv-menu-btn').click()`); await delay(300);
      assert.equal(await ev("(()=>{const r=document.querySelector('.dshwv-menu').getBoundingClientRect(),b=document.querySelector('[data-mode=subscription]').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&b.top>=r.top&&b.bottom<=r.bottom})()"),true,'corner menu and mode switch remain within viewport');
      await ev("document.querySelector('.dshwv-menu-btn').click()");
    }
    await ev("document.querySelector('.dshwv-menu-btn').click()"); await delay(200);
    fs.writeFileSync(path.join(output,'control-panel.png'),(await window.webContents.capturePage()).toPNG());
    await ev("document.querySelector('[data-mode=subscription]').click()");
    await wait("WhaleAccountView.mode==='subscription'",'subscription switch works through its actual button');
    assert.equal(await ev("!!document.querySelector('.dshwv-menu-open')"),true,'display switch does not close the menu');
    await ev("document.querySelector('.whale-mode-open').click()");
    await wait("document.querySelector('.whale-v3-dialog[open]')?.textContent.includes('本机已观测 token')",'visible subscription entry opens quota details');
    await ev("document.querySelector('.whale-v3-dialog[open]').close(); document.querySelector('[data-mode=api]').click()");
    await wait("WhaleAccountView.mode==='api'",'API switch works');
    assert.equal(await ev("!!document.querySelector('.dshwv-menu-open')"),true,'return to API keeps the same menu open');
    await ev("window.__shapeResizeStyle=document.createElement('style');__shapeResizeStyle.textContent='html.desktop .dshwv-menu{width:270px!important}';document.head.append(__shapeResizeStyle)");
    await wait("(()=>{const m=document.querySelector('.dshwv-menu').getBoundingClientRect();return __whaleShapeTest.status().rectangles.some(r=>r.x<=m.left&&r.y<=m.top&&r.x+r.width>=m.right&&r.y+r.height>=m.bottom)})()",'CSS-only layout changes update full native menu region');
    await ev("__shapeResizeStyle.remove()"); await delay(100);
    await ev("document.querySelector('.whale-mode-open').click()");
    await wait("document.querySelector('#settings-dialog').open",'settings entry opens');
    assert.equal(await ev("__whaleInputTest.hit({x:1,y:1})"),false,'an open dialog cannot intercept the transparent viewport corner');
    assert.equal(await ev("getComputedStyle(document.querySelector('#settings-dialog'),'::backdrop').backgroundColor"),'rgba(0, 0, 0, 0)');
    fs.writeFileSync(path.join(output,'api-settings.png'),(await window.webContents.capturePage()).toPNG());
    await ev("document.querySelector('#settings-dialog').close();[...document.querySelectorAll('.dshwv-menu button')].find(b=>b.textContent==='查看 API 消费记录').click()");
    await wait("document.querySelector('.dshwv-usage-more')",'usage overview loaded'); await delay(300);
    await ev("document.querySelector('.dshwv-usage-more').click()");
    await wait("document.querySelector('.dshwv-usage-wintitle')?.textContent==='API 消费记录'",'history modal loaded');
    assert.equal(await ev("getComputedStyle(document.querySelector('.dshwv-usage-mask')).backgroundColor"),'rgba(0, 0, 0, 0)');
    assert.equal(await ev("__whaleInputTest.hit({x:1,y:1})"),false,'a modal mask cannot intercept the transparent viewport corner');
    fs.writeFileSync(path.join(output,'usage-history.png'),(await window.webContents.capturePage()).toPNG());
    await ev("document.querySelector('.dshwv-usage-close').click();document.querySelector('[data-page=overview]').click()"); await delay(300);
    await ev("document.querySelector('[data-page=settings]').click();document.querySelectorAll('.whale-menu-group').forEach(g=>g.open=true)");
    const settingsInventory=await ev("document.querySelector('.whale-settings-page').textContent");
    for(const label of ['角色','大小','音效','音量','自定义泡泡','消耗提示','任务结束','币种','刷新汇率','吸附与翻转','资源管理','API 设置','音效与手感','进入桌面','跟随 Codex','本地创意工坊'])assert.ok(settingsInventory.includes(label),'retained settings: '+label);
    assert.equal(await ev("document.querySelector('.whale-settings-page').hidden"),false);
    fs.writeFileSync(path.join(output,'dashboard-settings.png'),(await window.webContents.capturePage()).toPNG());
    await ev("document.querySelector('[data-page=usage]').click();document.querySelector('[data-mode=subscription]').click()");
    await wait("WhaleAccountView.mode==='subscription'&&WhaleDashboard.page==='usage'",'switch preserves active usage tab');
    assert.equal(await ev("getComputedStyle(document.querySelector('.dshwv-usage-area')).display"),'none');
    await wait("document.querySelector('.whale-token-usage').textContent.includes('近 7 天')",'subscription usage shows token counters');
    await ev(`window.__dashboardFetch=window.fetch;window.fetch=(url,options)=>url==='/api/insights'?Promise.resolve({ok:true,json:async()=>({subscription:{available:true,windows:[{windowDurationMins:300,usedPercent:37,resetsAt:Date.now()+3600000},{windowDurationMins:10080,usedPercent:68,resetsAt:Date.now()+86400000}]},tokens:{total:12000,last5Hours:3000,input:10000,output:2000}})}):__dashboardFetch(url,options);document.querySelector('[data-page=overview]').click();WhaleDashboard.refresh()`);
    await ev("window.dispatchEvent(new CustomEvent('whale-turn-notice',{detail:{tokens:12480,amount:999,currency:'USD',completionKind:'success'}}))");
    const summary=await ev("document.querySelector('.whale-overview-data').textContent");
    assert.ok(summary.includes('5 小时额度')&&summary.includes('每周额度')&&summary.includes('63.0%')&&summary.includes('32.0%')&&summary.includes('12,480 token')&&!summary.includes('999'));
    fs.writeFileSync(path.join(output,'dashboard-subscription.png'),(await window.webContents.capturePage()).toPNG());
    await ev("window.fetch=__dashboardFetch;void 0");
    await setHost({hostAlive:true,hostPid:123456,window:'0',visible:true,attached:true,bounds:hostBounds({...dip,width:360,height:320})});await delay(250);
    for(const page of ['overview','usage','settings']){
      await ev(`document.querySelector('[data-page=${page}]').click()`);
      assert.equal(await ev("(()=>{const m=document.querySelector('.dshwv-menu').getBoundingClientRect(),t=document.querySelector('.whale-dashboard-tabs').getBoundingClientRect();return m.left>=0&&m.top>=0&&m.right<=innerWidth&&m.bottom<=innerHeight&&t.bottom<m.bottom})()"),true,'small viewport retains tabs and bounds');
    }
    fs.writeFileSync(path.join(output,'dashboard-small.png'),(await window.webContents.capturePage()).toPNG());
    await setHost({hostAlive:true,hostPid:123456,window:'0',visible:true,attached:true,bounds:hostBounds(dip)});
    await ev("WhaleAccountView.setMode('api')");
    checks.push('B dashboard retains settings inventory, legacy API budgets/history, token usage, distinct quota windows and stable tabs at 360x320');
    await ev("if(document.querySelector('.dshwv-menu-open'))document.querySelector('.dshwv-menu-btn').click()");
    checks.push('mode switch and details entry are discoverable; four corner menus fit and dialogs have no dimming backdrop');
    await ev("whaleDesktop.command('reset-position')"); await delay(350);
    const anchor=await ev("JSON.parse(localStorage.getItem('dshw-pos'))");
    assert.equal(anchor.hAnchor,'right');assert.equal(anchor.vAnchor,'bottom');
    assert.equal(await ev("(()=>{const r=document.querySelector('.dshwv-root').getBoundingClientRect();return r.left>innerWidth/2&&r.top>innerHeight/2&&r.right<=innerWidth&&r.bottom<=innerHeight})()"),true,'reset commits a visible bottom-right position');
    const remapsBefore=renderInfo().visibility.remaps;
    for(let cycle=0;cycle<6;cycle++){
      await ev("__whaleRenderTest.showCost(.003,{completionKind:'success',amount:.003,currency:'USD',costState:'observed',tokens:40,label:'本轮已观测消耗:'})");await delay(250);
      await ev("__whaleRenderTest.close()");await delay(350);
      const point=await ev("(()=>{const r=document.querySelector('.dshwv-img').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
      assert.ok(renderInfo().windowShape.some(r=>point.x>=r.x&&point.x<r.x+r.width&&point.y>=r.y&&point.y<r.y+r.height),'closing completion bubble retains whale in native region');
      assert.equal(window.isVisible(),true);
    }
    assert.equal(renderInfo().visibility.remaps,remapsBefore,'completion bubble cycles never hide/show the window');
    checks.push('bottom-right reset persists; six completion bubble close cycles retain whale region and never remap');
    await ev("document.querySelector('.dshwv-img').dispatchEvent(new Event('error'))");
    await wait("document.querySelector('.dshwv-img').src.startsWith('data:image/png') && document.querySelector('.dshwv-img').naturalWidth > 0", 'emergency default-role art decodes');
    assert.equal(await ev("document.querySelector('.dshwv-img').alt"), '小鲸鱼恢复占位图');
    checks.push('default-art failure handler produces network-independent visible emergency art');    fs.writeFileSync(path.join(output, 'desktop-audit.png'), (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'desktop-audit.json'), JSON.stringify({ ok: true, checks, viewport, link, expectedMissingImageConsoleMessages: errors.filter(message => /404|ERR_FILE_NOT_FOUND/.test(message)).length, dataDir }, null, 2));
    // Only this isolated test renderer is deliberately stalled. Production
    // Codex and its real companion remain untouched.
    ev('for (;;) {}').catch(() => {});
    await delay(80);
    app.quit();
  } catch (error) {
    const dialogs=await ev("[...document.querySelectorAll('dialog')].map(d=>({open:d.open,text:d.textContent.slice(0,1800)}))").catch(()=>[]);
    fs.writeFileSync(path.join(output, 'desktop-audit.json'), JSON.stringify({ ok: false, checks, error: error.message, errors, dialogs, dataDir }, null, 2));
    throw error;
  }
}
