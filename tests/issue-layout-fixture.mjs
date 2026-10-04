import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const scenarios = [
  { name: 'six-lines', modules: Array.from({length:6}, (_, i) => ({ type:'text', text:'第' + (i+1) + '行：完整文字必须留在气泡内部', size:10 })) },
  { name: 'long-text', modules: [{type:'text',text:'完整内容'+ 'abcdefghijklmnopqrstuv测试长文字'.repeat(6),size:9}] },
  { name: 'image-text', modules: [{type:'image',imgId:'bimg_yue_money',imgScale:0.8},{type:'text',text:'图片与完整提示同时展示',size:10},{type:'text',text:'点击气泡可继续下一条',size:7}] },
  { name: 'budget-alert', modules: [{type:'text',text:'今天已观测用量超过',size:6},{type:'text',text:'USD 123456.78',size:7},{type:'text',text:'账户期间扣费可能包含多个对话',size:6}] },
  { name: 'cost', cost: {id:'fixture:layout',conversationRef:'1234abcd',outcome:'failed',amount:12345678.12,costState:'estimated',source:'configured-pricing-estimate',tokens:999999} },
];
const edgeScenarios = [
  {name:'custom-font-size50',modules:Array.from({length:6},(_,i)=>({type:'text',text:'超大字号 '+(i+1)+'：保留所有文字',size:50,fontFamily:'Courier New, monospace'}))},
  {name:'six-inline-modules',modules:Array.from({length:6},(_,i)=>({type:'text',text:'模块'+(i+1)+'·完整内容',row:1,size:50,fontFamily:i%2?'Georgia, serif':'Arial, sans-serif',bg:i%2?'#edf2ff':''}))},
];
export async function verifyDesktop({app,window,screen,setHost,errors}) {
  const output=process.env.WHALE_DESKTOP_VERIFY_DIR, samples=[];
  const edgeOnly=process.env.WHALE_LAYOUT_EDGE_ONLY==='1', activeScenarios=edgeOnly?edgeScenarios:scenarios;
  const ev=code=>window.webContents.executeJavaScript(code);
  const wait=async code=>{for(let i=0;i<80;i++){if(await ev(code))return;await delay(60);}throw Error('Timed out: '+code);};
  try {
    const area=screen.getPrimaryDisplay().workArea;
    const host=async(width,height)=>setHost({hostAlive:true,hostPid:123456,window:'0',visible:true,attached:true,bounds:screen.dipToScreenRect(null,{x:area.x+30,y:area.y+30,width,height})});
    await host(900,720);window.setIgnoreMouseEvents(true,{forward:false});
    await wait('window.__whaleRenderTest && document.querySelector(".dshwv-img")?.naturalWidth>0');await delay(500);
    for(const small of [false,true]) {
      await host(small?380:900,small?340:720);await delay(150);
      for(const scale of small||edgeOnly?[1]:[0.6,1,1.8]) for(const flip of [false,true]) for(const scenario of activeScenarios) {
        await ev(`__whaleRenderTest.close();__whaleRenderTest.scale(${scale});__whaleRenderTest.place(${small?40:250},${small?100:280},${flip})`);
        await delay(60);
        const expected=scenario.modules?.filter(m=>m.type==='text').map(m=>m.text).join('')||'';
        await ev(scenario.cost?`__whaleRenderTest.cost(${JSON.stringify(scenario.cost)})`:`__whaleRenderTest.scene(${JSON.stringify(scenario.modules)},0)`);
        await wait('!__whaleRenderTest.status().switching');await delay(440);
        const metrics=await ev(`(()=>{window.__issueLayoutMeasure=()=>{
          const root=document.querySelector('.dshwv-pop'), p=root.getBoundingClientRect();
          const frame=[...root.querySelectorAll('.dshwv-frame')].find(e=>e.getAttribute('aria-hidden')==='false');
          if(!frame)throw Error('No visible frame');
          const flip=__whaleRenderTest.status().flip; const cx=p.left+p.width*(flip?1-454/1026:454/1026),cy=p.top+p.height*248/700;
          const rx=p.width*354/1026,ry=p.height*213/700;
          const elements=[...frame.children].filter(e=>getComputedStyle(e).display!=='none'&&(e.textContent||e.tagName==='IMG')).map(e=>{
            const r=e.getBoundingClientRect(); const max=Math.max(...[r.left,r.right].flatMap(x=>[r.top,r.bottom].map(y=>((x-cx)/rx)**2+((y-cy)/ry)**2)));
            return {tag:e.tagName,text:e.textContent,rect:r.toJSON(),ellipse:max,complete:e.tagName!=='IMG'||e.complete&&e.naturalWidth>0};
          });
          return {elements,text:frame.textContent,fit:frame.dataset.fitScale||null,viewport:[innerWidth,innerHeight],pop:p.toJSON(),overflow:elements.some(e=>e.ellipse>1.03),allImagesReady:elements.every(e=>e.complete)};
        };return window.__issueLayoutMeasure();})()`);
        assert.ok(metrics.allImagesReady,'image must decode before commit');
        if(expected) assert.equal(metrics.text.replace(/\s/g,''),expected.replace(/\s/g,''),'fit must retain all content');
        samples.push({name:scenario.name,small,scale,flip,...metrics});
        if(!flip&&(scale===1||small)) {
          const clip={x:Math.max(0,Math.floor(metrics.pop.x)-8),y:Math.max(0,Math.floor(metrics.pop.y)-8),width:Math.ceil(metrics.pop.width)+16,height:Math.ceil(metrics.pop.width)+16};
          fs.writeFileSync(path.join(output,`${scenario.name}-${small?'small':'normal'}.png`),(await window.webContents.capturePage(clip)).toPNG());
        }
      }
    }
    // Reflow an already-open frame without re-running its builder or losing nodes.
    await host(900,720);
    await ev(`__whaleRenderTest.close();__whaleRenderTest.scale(1);__whaleRenderTest.place(250,280,false);__whaleRenderTest.scene(${JSON.stringify(scenarios[0].modules)},0)`);
    await wait('!__whaleRenderTest.status().switching');await delay(450);
    await ev(`window.__layoutHeld=[...document.querySelector('.dshwv-frame[aria-hidden="false"]').childNodes]`);
    for(const [width,height,scale] of edgeOnly?[]:[[900,720,1.8],[380,340,0.6],[600,500,1]]) {
      await host(width,height);await ev(`__whaleRenderTest.scale(${scale})`);await delay(250);
      const metrics=await ev('__issueLayoutMeasure()');
      assert.equal(await ev(`__layoutHeld.every((node,i)=>document.querySelector('.dshwv-frame[aria-hidden="false"]').childNodes[i]===node)`),true,'responsive fit preserves content nodes');
      samples.push({name:'live-resize',scale,...metrics});
    }
    if(edgeOnly) {
      const changed='前台金额文字变化后也必须完整显示 '+ 'ABCDEFG变化测试'.repeat(10);
      const stable=await ev(`(async()=>{
        const frame=document.querySelector('.dshwv-frame[aria-hidden="false"]');
        const row=[...frame.children].find(e=>getComputedStyle(e).display!=='none'&&e.textContent);
        row.textContent=${JSON.stringify(changed)};
        const snapshots=[];
        for(let i=0;i<2;i++){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));snapshots.push({scale:frame.dataset.fitScale,text:frame.textContent});}
        return snapshots;
      })()`);
      assert.equal(stable[0].scale,stable[1].scale,'MutationObserver fit settles without a resize loop');
      assert.equal(stable[0].text,stable[1].text,'fit never rewrites the text');
      assert.ok(stable[1].text.includes(changed));
      samples.push({name:'foreground-text-mutation',stable,...await ev('__issueLayoutMeasure()')});
    }
    const violations=samples.filter(s=>s.overflow).length;
    if(process.env.WHALE_LAYOUT_REQUIRE_FIT!=='0')assert.equal(violations,0,'all content rectangles must fit inside ellipse');
    assert.equal(errors.length,0,JSON.stringify(errors));
    fs.writeFileSync(path.join(output,'issue-layout.json'),JSON.stringify({ok:true,violations,samples},null,2));await setHost({hostAlive:false});
  } catch(error) {
    fs.writeFileSync(path.join(output,'issue-layout.json'),JSON.stringify({ok:false,error:error.stack,samples,errors},null,2));app.exit(1);
  }
}
