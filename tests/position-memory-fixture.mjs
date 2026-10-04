import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function verifyDesktop({ app, window, screen, setHost, setTestCursor, dataDir, errors }) {
  const output = path.resolve(process.env.WHALE_DESKTOP_VERIFY_DIR), phase = process.env.WHALE_POSITION_PHASE;
  const checks = [], samples = [], ev = code => window.webContents.executeJavaScript(code);
  const wait = async (code, label) => { for (let n = 0; n < 100; n++) { if (await ev(code)) return; await delay(60); } throw new Error('Timed out: ' + label); };
  const snapshot = () => ev(`(() => {const r=document.querySelector('.dshwv-root').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,saved:localStorage.getItem('dshw-pos')}})()`);
  const same = (a,b,label) => { assert.ok(Math.abs(a.x-b.x)<2 && Math.abs(a.y-b.y)<2, label + ': ' + JSON.stringify({a,b})); samples.push({label,actual:a,expected:b}); };
  const expected = s => { const a=JSON.parse(s.saved); return {x:a.hAnchor==='left'?a.hDist:Math.max(0,s.vw-s.width-a.hDist),y:a.vAnchor==='top'?a.vDist:Math.max(0,s.vh-s.height-a.vDist)}; };
  const area=screen.getPrimaryDisplay().workArea;
  const bounds={x:area.x+20,y:area.y+20,width:900,height:700};
  const host={hostAlive:true,hostPid:123456,window:'0',visible:true,attached:true};
  const resize = async b => { await setHost({...host,bounds:screen.dipToScreenRect(null,b)}); await delay(450); };
  const ready = async () => { await wait("window.__whaleRenderTest?.status().balance===12.3456 && document.querySelector('.dshwv-img')?.naturalWidth>0 && !window.__whaleRenderTest.status().busy",'renderer ready'); await delay(500); };
  try {
    // Always intercept native input; sendInputEvent supplies only this isolated window.
    window.setIgnoreMouseEvents(true,{forward:false});
    await resize(bounds);
    window.webContents.send('whale-desktop-mode','follow-codex');
    await ready();
    let s=await snapshot(); same(s,expected(s),'startup DOM matches persisted anchor');
    if(phase==='interior') same(s,{x:200,y:100},'explicit interior seed is restored');
    if(phase==='bottom') same(s,{x:0,y:s.vh-s.height},'explicit bottom seed is restored');
    checks.push(phase+': saved anchor restores actual DOM coordinates despite immediate mode notification');
    if (phase==='restart') {
      const prior=JSON.parse(fs.readFileSync(path.join(output,'drag-expected.json'),'utf8'));
      same(s,prior,'full process restart returns to dragged coordinates');
      assert.equal(s.saved,prior.saved); checks.push('dragged position persists to ui-state.json and a completely new Electron process');
    } else if (phase==='interior') {
      await ev('window.__whaleRenderTest.scale(2)'); await delay(600);
      s=await snapshot(); const anchor=JSON.parse(s.saved); assert.ok(anchor.hDist>=0 && anchor.vDist>=0); same(s,expected(s),'scaled anchor matches DOM');
      const loaded=once(window.webContents,'did-finish-load'); window.webContents.reload(); await loaded;
      window.webContents.send('whale-desktop-mode','follow-codex'); await ready();
      same(await snapshot(),s,'scale then renderer reload'); checks.push('scale saves valid nonnegative margins and reload restores exact coordinates');
      const saved=s.saved;
      await resize({...bounds,width:300,height:240});
      const clamped=await snapshot(); assert.ok(Math.abs(clamped.x-s.x)>2 || Math.abs(clamped.y-s.y)>2,'small viewport actually clamps the displayed position');
      samples.push({label:'temporary small viewport clamps only display',actual:clamped});
      window.webContents.send('whale-desktop-mode-changing');
      window.webContents.send('whale-desktop-mode','standalone');
      await ev(`(() => {const e=[...document.querySelectorAll('input[type=range]')].find(e=>e.max==='1');if(!e)throw new Error('volume control missing');e.value='0.15';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await delay(400); assert.equal((await snapshot()).saved,saved,'ordinary preferences preserve intended position in clamped viewport');
      await resize(bounds); same(await snapshot(),s,'viewport shrink then restore'); checks.push('temporary viewport clamp and volume adjustment do not overwrite remembered position');
      await setHost({...host,visible:false}); assert.equal(window.isVisible(),false);
      await resize(bounds); same(await snapshot(),s,'minimize then restore'); checks.push('mode notifications and minimize/restore retain actual coordinates');
      // Start the restart check at the fixture startup scale, avoiding makeFixture's reset to 1.
      await ev('window.__whaleRenderTest.scale(1)'); await delay(500);
      const before=await snapshot();
      const p=await ev(`(() => {const img=document.querySelector('.dshwv-img'),r=img.getBoundingClientRect(),c=document.createElement('canvas');c.width=c.height=610;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,610,610);const a=ctx.getImageData(0,0,610,610).data;for(let y=300;y<500;y+=5)for(let x=300;x<500;x+=5)if(a[(y*610+x)*4+3]>230)return{x:r.x+(WhaleRendering.mirrorScale(document.querySelector('.dshwv-root'))<0?610-x:x)*r.width/610,y:r.y+y*r.height/610};throw new Error('no opaque drag target')})()`);
      window.focus(); await wait('document.hasFocus()','synthetic pointer focus');
      const move=(x,y)=>{setTestCursor({x,y});window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(x),y:Math.round(y)});};
      move(p.x,p.y); await delay(100);
      window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(p.x),y:Math.round(p.y)});
      for(let i=1;i<=8;i++){move(p.x+i*12,p.y+i*10);await delay(35);}
      window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(p.x+96),y:Math.round(p.y+80)});
      await delay(700); const dragged=await snapshot();
      assert.ok(Math.abs(dragged.x-before.x)>50,'real Electron pointer drag moves whale'); same(dragged,expected(dragged),'drag commits actual anchor');
      fs.writeFileSync(path.join(output,'drag-expected.json'),JSON.stringify(dragged)); checks.push('real Electron pointer drag commits a new position');
    }
    assert.equal(errors.length,0,JSON.stringify(errors));
    fs.writeFileSync(path.join(output,'position-'+phase+'.json'),JSON.stringify({ok:true,checks,samples,dataDir},null,2));
    await setHost({hostAlive:false});
  } catch(error) {
    fs.writeFileSync(path.join(output,'position-'+phase+'.json'),JSON.stringify({ok:false,checks,samples,error:error.stack,snapshot:await snapshot().catch(()=>null),errors,dataDir},null,2));
    app.exit(1);
  }
}
