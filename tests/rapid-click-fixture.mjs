import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT} from '../runtime/paths.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function verifyDesktop({app,window,screen,setHost,setTestCursor,dataDir,errors,renderInfo}) {
  const {BrowserWindow}=await import('electron');
  const output=path.resolve(process.env.WHALE_DESKTOP_VERIFY_DIR),report={ok:false,scenarios:[],errors};
  fs.mkdirSync(output,{recursive:true});let host;
  const ev=source=>window.webContents.executeJavaScript(source);
  const wait=async(source)=>{for(let i=0;i<100;i++){if(await ev(source))return;await delay(50);}throw Error('Timed out: '+source);};
  const python=process.env.WHALE_TEST_PYTHON||'python';
  try {
    assert.equal(process.platform,'win32');setTestCursor(null);
    const area=screen.getPrimaryDisplay().workArea;
    const bounds={x:area.x+30,y:area.y+30,width:Math.min(1100,area.width-60),height:Math.min(820,area.height-60)};
    host=new BrowserWindow({...bounds,frame:false,show:false,title:'小鲸鱼连续点击隔离测试（自动关闭）',backgroundColor:'#e7f0f5',webPreferences:{sandbox:true}});
    await host.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta charset="utf-8"><title>Isolated harmless receiver</title><style>body{margin:0;background:#e7f0f5;font:20px system-ui;padding:20px}</style><p>正在验证小鲸鱼连续点击。此窗口只统计鼠标事件。</p>'));
    await host.webContents.executeJavaScript(`window.__counts={down:0,up:0,click:0,untrusted:0};for(const [event,key] of [['pointerdown','down'],['pointerup','up'],['click','click']])window.addEventListener(event,e=>{__counts[key]++;if(!e.isTrusted)__counts.untrusted++;},true);`);
    host.show();host.setAlwaysOnTop(true);host.moveTop();
    const widgetHandle=window.getNativeWindowHandle().readBigUInt64LE().toString(),hostHandle=host.getNativeWindowHandle().readBigUInt64LE().toString();
    await setHost({hostAlive:true,hostPid:process.pid,window:hostHandle,visible:true,attached:true,bounds:screen.dipToScreenRect(null,bounds)});
    await promisify(execFile)(python,[path.join(ROOT,'tests/fixture-owner.py'),widgetHandle,String(process.pid),hostHandle,String(process.pid)],{windowsHide:true,timeout:10000});
    window.showInactive();window.setAlwaysOnTop(true);window.moveTop();
    await wait('window.__whaleRenderTest && window.__whaleInputTest && window.WhaleRendering?.petInteraction && document.querySelector(".dshwv-img")?.naturalWidth>0');
    await ev(`window.__rapidTrace=[];window.__rapidCursor=[];whaleDesktop.onCursor(p=>{__rapidCursor.push(p);if(__rapidCursor.length>20)__rapidCursor.shift();});for(const type of ['pointerdown','pointerup','click'])window.addEventListener(type,e=>{const img=document.querySelector('.dshwv-img'),root=document.querySelector('.dshwv-root');__rapidTrace.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY,alpha:WhaleRendering.hitCache.hit(img,e.clientX,e.clientY,WhaleRendering.mirrorScale(root)<0),guard:WhaleRendering.petInteraction.hit(img,root,e.clientX,e.clientY),phase:WhaleRendering.petInteraction.state?.phase||null});},true);`);
    await delay(700);
    async function burst(point,count,interval,label) {
      await ev('window.__rapidTrace=[]');await host.webContents.executeJavaScript('window.__counts={down:0,up:0,click:0,untrusted:0}');
      const wb=window.getContentBounds(),physical=screen.dipToScreenPoint({x:wb.x+point.x,y:wb.y+point.y});
      let native;
      try {const result=await promisify(execFile)(python,[path.join(ROOT,'tests/rapid-click-native.py'),widgetHandle,String(process.pid),hostHandle,String(process.pid),String(Math.round(physical.x)),String(Math.round(physical.y)),String(count),String(interval),'40'],{windowsHide:true,timeout:20000});native=JSON.parse(result.stdout);}
      catch(error){try{native=JSON.parse(error.stdout);}catch{}throw Error(JSON.stringify({label,native,error:error.message}));}
      await delay(180);
      const trace=await ev('window.__rapidTrace'),lower=await host.webContents.executeJavaScript('window.__counts');
      const result={label,count,interval,point,native,lower,trace,render:renderInfo(),windowBounds:wb,cursor:await ev('__rapidCursor'),input:await ev('__whaleInputTest.status()'),shape:await ev('__whaleShapeTest.status()')};
      report.scenarios.push(result);assert.equal(native.ok,true);assert.equal(native.sent,count);
      assert.equal(lower.untrusted,0);assert.ok(trace.every(e=>e.trusted),'only OS-injected events count');
      return result;
    }
    for(const [scale,flip,interval] of [[.6,false,20],[.6,true,50],[1.2,false,100],[1.2,true,20],[2,false,50],[2,true,100]]) {
      const left=flip?120:Math.min(bounds.width-540,Math.round(bounds.width*.57));
      await ev(`__whaleRenderTest.close();__whaleRenderTest.scale(${scale});__whaleRenderTest.place(${left},150,${flip});`);await delay(500);
      // Pose setup only: commit the fixture's saved anchor through the real drag
      // handler, so the first later click cannot restore a different old anchor.
      // All test counts are reset afterward; proof below uses only OS SendInput.
      const grip=await ev(`(()=>{const img=document.querySelector('.dshwv-img'),root=document.querySelector('.dshwv-root'),r=img.getBoundingClientRect();for(let y=Math.round((r.top+r.bottom)/2);y<r.bottom;y+=2)for(let x=Math.round(r.left+8);x<r.right;x+=2)if(WhaleRendering.petInteraction.hit(img,root,x,y))return {x,y};throw Error('No setup grip');})()`);
      setTestCursor(grip);window.webContents.sendInputEvent({type:'mouseMove',...grip});
      window.webContents.sendInputEvent({type:'mouseDown',...grip,button:'left',clickCount:1});await delay(20);
      setTestCursor({x:grip.x+5,y:grip.y+5});window.webContents.sendInputEvent({type:'mouseMove',x:grip.x+5,y:grip.y+5,button:'left'});
      window.webContents.sendInputEvent({type:'mouseUp',x:grip.x+5,y:grip.y+5,button:'left',clickCount:1});
      setTestCursor(null);await delay(700);
      assert.equal(await ev('__whaleRenderTest.status().flip'),flip,'fixture pose uses its real persisted orientation');
      const point=await ev(`(()=>{const img=document.querySelector('.dshwv-img'),root=document.querySelector('.dshwv-root'),body=document.querySelector('.dshwv-body');const r=img.getBoundingClientRect(),b=body.getBoundingClientRect(),flip=WhaleRendering.mirrorScale(root)<0,cx=(b.left+b.right)/2;const pressed={left:cx+(r.left-cx)*1.05,top:b.bottom-(b.bottom-r.top)*.88,width:r.width*1.05,height:r.height*.88};pressed.right=pressed.left+pressed.width;pressed.bottom=pressed.top+pressed.height;const hit=(x,y,rect)=>WhaleRendering.hitCache.hit(img,x,y,flip,rect);for(let y=Math.ceil(r.top+2);y<r.bottom-2;y+=2)for(let x=Math.ceil(r.left+2);x<r.right-2;x+=2){if(hit(x,y)&&hit(x-1,y)&&hit(x+1,y)&&hit(x,y-1)&&hit(x,y+1)&&!hit(x,y,pressed))return {x,y,predictedAlphaLost:true};}throw Error('No stable-edge candidate');})()`);
      const row=await burst(point,20,interval,`edge-${scale}-${flip?'flipped':'normal'}-${interval}ms`);
      assert.equal(row.lower.down,0,JSON.stringify({leaked:row.lower,label:row.label}));assert.equal(row.lower.click,0);
      assert.equal(row.trace.filter(e=>e.type==='pointerdown').length,20);assert.equal(row.trace.filter(e=>e.type==='pointerup').length,20);
      assert.ok(row.native.records.every(r=>r.before.regionContains&&r.during.regionContains),'native region retains the edge throughout burst');
      await ev('__whaleRenderTest.close()');await delay(700);
      const empty={x:30,y:bounds.height-35};
      const control=await burst(empty,3,50,`transparent-after-${scale}-${flip}`);
      assert.equal(control.trace.filter(e=>e.type==='pointerdown').length,0);assert.equal(control.lower.down,3);assert.equal(control.lower.click,3);
    }
    report.alphaLostEvents=report.scenarios.flatMap(r=>r.trace).filter(e=>e.type==='pointerup'&&!e.alpha).length;
    assert.ok(report.alphaLostEvents>0,'at least one real release occurred after compression moved alpha away');
    assert.equal(errors.length,0,JSON.stringify(errors));report.ok=true;
  } catch(error){report.error=error.stack;}
  finally {
    fs.writeFileSync(path.join(output,'rapid-click.json'),JSON.stringify(report,null,2));
    try {await setHost({hostAlive:false});}catch{}
    if(host&&!host.isDestroyed())host.destroy();
    if(report.ok)app.quit();else app.exit(1);
  }
}
