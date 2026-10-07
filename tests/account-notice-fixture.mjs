import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {once} from 'node:events';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function verifyDesktop({app,window,screen,setHost,dispatcher,errors}) {
  const output=process.env.WHALE_DESKTOP_VERIFY_DIR,checks=[],requests=[],commits=[],geometry=[];
  const ev=code=>window.webContents.executeJavaScript(code),service=dispatcher.whale;
  const originalDispatch=dispatcher.dispatch;
  let failAck=false;
  const wait=async(predicate,label)=>{for(let i=0;i<100;i++){if(await predicate())return;await delay(60);}throw Error('Timed out: '+label);};
  const front=`document.querySelector('.dshwv-frame[aria-hidden="false"]')`;
  const uiReady=()=>wait(()=>ev('window.__whaleRenderTest && document.querySelector(".dshwv-img")?.naturalWidth>0'),'renderer ready');
  async function instrument() {
    await ev(`(()=>{
      window.__accountCommits=[];window.__accountSounds=[];
      const open=WhaleRendering.BubbleRenderer.prototype.open;
      WhaleRendering.BubbleRenderer.prototype.open=async function(...args){const committed=await open.apply(this,args);if(committed&&this.front.root.textContent.includes('账户新增消耗'))__accountCommits.push({text:this.front.root.textContent,at:Date.now()});return committed;};
      const play=WhaleFeedback.play;WhaleFeedback.play=function(...args){__accountSounds.push(args[0]);return play.apply(this,args);};
      __whaleRenderTest.scale(1);__whaleRenderTest.place(250,280,false);__whaleRenderTest.close();
    })()`);
  }
  async function capture(name,amount) {
    await wait(()=>ev(`Number(getComputedStyle(document.querySelector('.dshwv-text')).opacity)>=0.99 && Number(getComputedStyle(document.querySelector('.dshwv-bshape')).opacity)>=0.99`),'fully painted account bubble');
    await delay(80);
    const metric=await ev(`(()=>{const pop=document.querySelector('.dshwv-pop').getBoundingClientRect(),frame=${front};
      const cx=pop.left+pop.width*454/1026,cy=pop.top+pop.height*248/700,rx=pop.width*354/1026,ry=pop.height*213/700;
      const elements=[...frame.children].filter(e=>getComputedStyle(e).display!=='none'&&e.textContent).map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent,inside:Math.max(...[r.left,r.right].flatMap(x=>[r.top,r.bottom].map(y=>((x-cx)/rx)**2+((y-cy)/ry)**2)))<=1.03};});
      return {text:frame.textContent,elements,pop:pop.toJSON()};})()`);
    assert.match(metric.text,/账户新增消耗/);assert.ok(metric.text.includes(amount),'visible amount '+amount);
    assert.ok(metric.elements.every(item=>item.inside),'account cost fits ellipse');geometry.push({name,...metric});
    const p=metric.pop,clip={x:Math.max(0,Math.floor(p.x)-8),y:Math.max(0,Math.floor(p.y)-8),width:Math.ceil(p.width)+16,height:Math.ceil(p.width)+16};
    fs.writeFileSync(path.join(output,name+'.png'),(await window.webContents.capturePage(clip)).toPNG());
  }
  const shown=amount=>wait(()=>ev(`!__whaleRenderTest.status().switching && __whaleRenderTest.status().shown && ${front}?.textContent.includes('账户新增消耗') && ${front}.textContent.includes(${JSON.stringify(amount)})`),'account amount '+amount);
  const acknowledged=()=>wait(()=>service.accountNotices().notices.length===0,'backend ACK');
  const expense=enabled=>ev(`(()=>{const row=[...document.querySelectorAll('.dshwv-menu-row')].find(e=>e.textContent.includes('每轮消耗提示'));const toggle=row?.querySelector('input[type=checkbox]');if(!toggle)throw Error('expense toggle missing');toggle.checked=${enabled};toggle.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  dispatcher.dispatch=async(url,options={})=>{
    if(url==='/api/account-notices/ack') {
      const ids=JSON.parse(Buffer.from(options.body).toString()).ids;
      const visual=await ev(`({state:__whaleRenderTest.status(),text:${front}?.textContent||'',seen:JSON.parse(localStorage.getItem('dshw-account-notices-shown')||'{}')})`);
      requests.push({method:'ACK',ids,visual,failed:failAck});
      if(failAck)return {status:503,headers:{'Content-Type':'application/json'},body:Buffer.from(JSON.stringify({ok:false,error:'synthetic ACK retry'}))};
    }
    const result=await originalDispatch(url,options);
    if(url==='/api/account-notices')requests.push({method:'GET',...JSON.parse(result.body.toString())});
    return result;
  };
  try {
    assert.equal(dispatcher.watcher,null,'live session monitor disabled');
    const area=screen.getPrimaryDisplay().workArea;
    await setHost({hostAlive:true,hostPid:123456,window:'0',visible:true,attached:true,bounds:screen.dipToScreenRect(null,{x:area.x+30,y:area.y+30,width:900,height:720})});
    window.setIgnoreMouseEvents(true,{forward:false});await uiReady();await delay(650);await instrument();
    assert.deepEqual(service.config.resolve().setting.models,{},'no configured model pricing');
    await service.getBalance({force:true});assert.equal(service.accountNotices().notices.length,0);
    const a={id:'fixture-A:turn',sessionId:'fixture-A',turnId:'turn'},b={id:'fixture-B:turn',sessionId:'fixture-B',turnId:'turn'};
    service.beginTurn(a);await service.turns.get(a.id).start;service.beginTurn(b);await service.turns.get(b.id).start;
    service.provider.amount=12.0956;await service.getBalance({force:true});
    await shown('0.25');await acknowledged();await capture('parallel-account-025','0.25');
    assert.match(geometry.at(-1).text,/含并行任务/);
    const first=requests.find(r=>r.method==='ACK');assert.ok(first);assert.equal(first.visual.state.switching,false);assert.equal(first.visual.state.shown,true);assert.match(first.visual.text,/账户新增消耗/);
    assert.ok(Object.values(first.visual.seen).includes(first.ids[0]),'commit persisted before ACK');
    checks.push('real renderer GET shows account +0.25 with parallel flag without model pricing; commit and local seen precede ACK');
    await service.finishTurn({...b,outcome:'failed',statusNotify:false,byModel:{}});await service.finishTurn({...a,outcome:'completed',notify:false,byModel:{}});
    await ev('__whaleRenderTest.close()');await service.getBalance({force:true});await delay(1250);
    assert.equal(await ev('__accountCommits.length'),1);assert.equal(service.accountNotices().notices.length,0);
    checks.push('same sample and both turn endings do not repeat the 0.25 debit');
    failAck=true;service.provider.amount=11.9956;await service.getBalance({force:true});await shown('0.10');
    await wait(()=>requests.some(r=>r.method==='ACK'&&r.failed),'synthetic lost ACK');await capture('new-account-010','0.10');
    const second=service.accountNotices().notices[0];assert.equal(second.amount,0.1);assert.notEqual(second.id,first.ids[0]);
    commits.push(...await ev('__accountCommits'));assert.deepEqual(await ev('__accountSounds'),[]);
    await ev('__whaleRenderTest.close()');const loaded=once(window.webContents,'did-finish-load');window.webContents.reload();await loaded;await uiReady();await instrument();
    failAck=false;await acknowledged();await delay(1200);assert.equal(await ev('__accountCommits.length'),0);
    assert.ok(requests.some(r=>r.method==='ACK'&&r.ids[0]===second.id&&!r.failed));
    checks.push('next debit is a distinct +0.10; reload after failed ACK retries confirmation without replaying money');
    await expense(false);await delay(150);const countBefore=requests.filter(r=>r.method==='GET').length;
    service.provider.amount=11.7956;await service.getBalance({force:true});await delay(1200);
    assert.equal(requests.filter(r=>r.method==='GET').length,countBefore);assert.equal(service.accountNotices().notices[0].amount,0.2);
    await expense(true);await shown('0.20');await acknowledged();await capture('expense-reenabled-020','0.20');await ev('__whaleRenderTest.close()');
    checks.push('expense switch pauses polling without consuming the durable batch, then re-enabling shows +0.20 once');
    assert.equal(await ev("WhaleAccountView.setMode('subscription')"),true);await delay(150);const subscriptionGets=requests.filter(r=>r.method==='GET').length;
    service.provider.amount=11.6956;await service.getBalance({force:true});await delay(1200);
    assert.equal(requests.filter(r=>r.method==='GET').length,subscriptionGets);assert.equal(service.accountNotices().notices[0].amount,0.1);
    assert.equal(await ev("WhaleAccountView.setMode('api')"),true);await shown('0.10');await acknowledged();await capture('api-mode-resumed-010','0.10');
    checks.push('subscription display pauses API account notices; returning to API shows the retained +0.10 once');
    commits.push(...await ev('__accountCommits'));assert.deepEqual(await ev('__accountSounds'),[]);assert.equal(commits.length,4);
    assert.equal(errors.length,0,JSON.stringify(errors));
    fs.writeFileSync(path.join(output,'account-notices.json'),JSON.stringify({ok:true,checks,commits,geometry,requests},null,2));
    dispatcher.dispatch=originalDispatch;await setHost({hostAlive:false});
  } catch(error) {
    dispatcher.dispatch=originalDispatch;
    fs.writeFileSync(path.join(output,'account-notices.json'),JSON.stringify({ok:false,error:error.stack,checks,commits,geometry,requests,errors},null,2));app.exit(1);
  }
}
