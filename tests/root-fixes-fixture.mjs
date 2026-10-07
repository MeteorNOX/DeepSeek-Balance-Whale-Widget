import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function verifyDesktop({app,window,screen,setHost,dispatcher,errors}){
 const output=process.env.WHALE_DESKTOP_VERIFY_DIR, samples=[],checks=[];
 const ev=s=>window.webContents.executeJavaScript(s);
 const wait=async(s)=>{for(let i=0;i<80;i++){if(await ev(s))return;await delay(70);}throw Error('Timed out: '+s);};
 try{
  const area=screen.getPrimaryDisplay().workArea;
  await setHost({hostAlive:true,hostPid:123456,window:'0',visible:true,attached:true,bounds:screen.dipToScreenRect(null,{x:area.x+30,y:area.y+30,width:900,height:720})});
  window.setIgnoreMouseEvents(true,{forward:false});
  await wait('window.__whaleRenderTest && document.querySelector(".dshwv-img")?.naturalWidth>0');await delay(800);
  for(const [scale,amount,outcome] of [[0.6,0.000000004,'failed'],[1,0.000000004,'failed'],[1.8,123456789.12,'completed'],[1,null,'failed'],[1,0.3,'aborted']]){
   await ev(`__whaleRenderTest.close();__whaleRenderTest.scale(${scale});__whaleRenderTest.place(250,350,false)`);await delay(200);
   await ev(`__whaleRenderTest.cost(${JSON.stringify({id:'fixture:turn',sessionId:'fixture',conversationRef:'a1b2c3d4',outcome,amount,costState:amount===null?'unknown':'estimated',source:amount===null?'token-only':'configured-pricing-estimate',tokens:123456789})})`);await delay(650);
   const sample=await ev(`(()=>{const es=[...document.querySelectorAll('.dshwv-label,.dshwv-amount,.dshwv-hint')].filter(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).visibility!=='hidden');return es.map(e=>{const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return {class:e.className,text:e.textContent,width:r.width,height:r.height,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,inside:r.left>=p.left-2&&r.right<=p.right+2&&r.top>=p.top-2&&r.bottom<=p.bottom+2,parent:p.toJSON(),rect:r.toJSON()}})})()`);
   samples.push({scale,amount,outcome,elements:sample});
   const visible=sample.filter(e=>e.text);assert.ok(visible.length>=3,'cost content renders');
   for(const e of visible){assert.ok(e.scrollWidth<=e.clientWidth+2,JSON.stringify({overflow:e,scale}));assert.ok(e.inside,JSON.stringify({outside:e,scale}));}
   fs.writeFileSync(path.join(output,`bubble-${scale}-${outcome}-${amount === null ? 'unknown' : 'amount'}.png`),(await window.webContents.capturePage()).toPNG());
  }
  checks.push('real cost bubbles fit at small, standard and large scales, including tiny/large amounts and failed/cancelled/unknown states');
  await ev('__whaleRenderTest.close()');
  const history=await dispatcher.dispatch('/api/usage-scopes');assert.equal(history.status,200);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent==='历史账户账本');if(!b)throw Error('history menu missing');b.click()})()`);await delay(350);
  assert.equal(await ev('!!document.querySelector("dialog.whale-v3-dialog[open]")'),true);
  checks.push('history menu opens and reads the anonymous account endpoint');
  await ev('document.querySelector("dialog.whale-v3-dialog[open]").close()');
  assert.equal(errors.length,0,JSON.stringify(errors));
  fs.writeFileSync(path.join(output,'root-fixes.json'),JSON.stringify({ok:true,checks,samples},null,2));await setHost({hostAlive:false});
 }catch(error){fs.writeFileSync(path.join(output,'root-fixes.json'),JSON.stringify({ok:false,error:error.stack,checks,samples,errors},null,2));app.exit(1);}
}
