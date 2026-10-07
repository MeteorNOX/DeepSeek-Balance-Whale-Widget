import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise, resolve, reject}; }

test('settings merge delayed startup with edits and serialize only changed fields', async () => {
  const context = vm.createContext({});
  vm.runInContext(section('    function createSettingsWriter(', '    var settingsWriter ='), context);
  const first = deferred(), calls = [];
  const writer = context.createSettingsWriter({scale:1, vol:0.8, bubbleOn:true}, async patch => {
    calls.push({...patch}); if(calls.length===1) await first.promise;
  }, error => { throw error; });
  const a = writer.save({scale:1, vol:0.2, bubbleOn:true});
  await Promise.resolve();
  const b = writer.save({scale:1, vol:0.3, bubbleOn:true});
  assert.equal(calls.length,1);
  assert.deepEqual({...writer.loaded({scale:1.7, vol:0.8, bubbleOn:false})}, {scale:1.7,vol:0.3,bubbleOn:false});
  first.resolve(); await Promise.all([a,b]);
  assert.deepEqual(calls,[{vol:0.2},{vol:0.3}]);
});

test('failed settings write stays pending and retries without reverting a newer value', async () => {
  const context = vm.createContext({});
  vm.runInContext(section('    function createSettingsWriter(', '    var settingsWriter ='), context);
  const calls = [], errors=[];
  const writer = context.createSettingsWriter({vol:1, scale:1}, async patch => {
    calls.push({...patch}); if(calls.length===1) throw new Error('disk full');
  }, error=> errors.push(error.message));
  await writer.save({vol:0.4,scale:1});
  await writer.save({vol:0.4,scale:1.2});
  assert.deepEqual(errors,['disk full']);
  assert.deepEqual(calls,[{vol:0.4},{vol:0.4,scale:1.2}]);
});

function sceneHarness() {
  let now=1000, timerId=0;
  const timers=new Map(), renders=[], listeners={};
  const context=vm.createContext({
    Promise,
    Date:{now:()=>now}, setTimeout(fn,delay){timers.set(++timerId,{fn,delay});return timerId;}, clearTimeout(id){timers.delete(id);},
    window:{addEventListener(name,fn){listeners[name]=fn;}}, document:{hidden:false,addEventListener(name,fn){listeners[name]=fn;}},
    bubbleSceneEpoch:1,bubbleShown:true,bubbleScene:{kind:'normal',ttlMs:5000,deadline:6000},bubbleTtlTimer:null,
    bubbleFrames:{front:{},open(){const d=deferred();renders.push(d);return d.promise;},cancel(){}},
    bubbleClearAll(){context.bubbleSceneEpoch++;timers.clear();}, bubbleCloseVisual(){context.closed=true;},
    bindBubbleParts(){},WhaleMoney:{refreshBindings(){}},menuBox:{},WhaleRendering:{},
    whaleSysTick(){},whaleSysSwapNext(){return false;},hideBubble(){context.bubbleShown=false;context.bubbleScene=null;},
    hideCostBubble(){context.bubbleShown=false;context.bubbleScene=null;},hideUsageAlertBubble(){context.bubbleShown=false;context.bubbleScene=null;}
  });
  vm.runInContext(section('    function sceneOpen(', '    function bubbleRenderDefault('),context);
  return {context,timers,renders,listeners,setNow(v){now=v;}};
}

test('failed image switch restores the original deadline and expires immediately if elapsed', async () => {
  const h=sceneHarness();
  h.context.sceneOpen('custom',()=>{},5000);
  h.setNow(4000); h.renders[0].resolve(false); await Promise.resolve();
  assert.equal(h.context.bubbleScene.kind,'normal');
  assert.equal([...h.timers.values()][0].delay,2000);
  h.context.sceneOpen('custom',()=>{},5000);
  h.setNow(7000); h.renders[1].resolve(false); await Promise.resolve();
  assert.equal(h.context.bubbleShown,false);
});

test('stale timer and image callbacks cannot close a new scene; focus checks elapsed deadline', async () => {
  const h=sceneHarness();
  h.context.armBubbleDeadline(); const oldTimer=[...h.timers.values()][0].fn;
  h.context.sceneOpen('custom',()=>{},5000);
  h.context.sceneOpen('normal',()=>{},7000);
  h.renders[0].resolve(false); h.renders[1].resolve(true); await Promise.resolve();
  h.setNow(7000);oldTimer();
  assert.equal(h.context.bubbleShown,true);
  h.setNow(9000);h.listeners.focus();
  assert.equal(h.context.bubbleShown,false);
});

test('IME composition protects every keyboard shortcut including module name confirmation', () => {
  const listeners={}, context=vm.createContext({document:{addEventListener(name,fn){listeners[name]=fn;}}});
  vm.runInContext(section('    var whaleComposing =', '    function mediaDataUrl('),context);
  let saved=0,closed=0,keyHandler;
  Object.assign(context,{moduleNameInput:{addEventListener(name,fn){keyHandler=fn;}},saveModuleNamePrompt(){saved++;},closeModuleNamePrompt(){closed++;}});
  vm.runInContext(section("    moduleNameInput.addEventListener('keydown'", '    var CROP_BOX'),context);
  listeners.compositionstart();keyHandler({key:'Enter'});keyHandler({key:'Escape'});listeners.compositionend();
  keyHandler({key:'Enter',isComposing:true});keyHandler({key:'Escape',keyCode:229});
  assert.equal(saved,0);assert.equal(closed,0);
  keyHandler({key:'Enter'});keyHandler({key:'Escape'});assert.equal(saved,1);assert.equal(closed,1);
});

test('opening bubble editor fetches current state and captures revision; save conflict keeps draft open', async () => {
  const fresh=deferred(),context=vm.createContext({bubbleOpening:false,bubbleMask:{style:{display:'none'}},bubbleRevision:'old',loadBubbleCfg(){return fresh.promise;},assetFailure(){}});
  vm.runInContext(section('    function openBubbleEditor()', '    function buildBubbleEditor()'),context);
  let built=0;context.buildBubbleEditor=()=>built++;
  context.openBubbleEditor();assert.equal(built,0);
  context.bubbleRevision='new';fresh.resolve();await Promise.resolve();assert.equal(context.bubbleEditorRevision,'new');assert.equal(built,1);
  let sent,closed=false,failed=false;
  Object.assign(context,{BUBBLE_URL:'/bubble',fetch:async (_url,opts)=>{sent=JSON.parse(opts.body);return {json:async()=>({ok:false,error:'changed elsewhere'})};},requireSaved(data){if(!data.ok)throw new Error(data.error);},assetFailure(){failed=true;}});
  vm.runInContext(section('    function saveBubbleCfg(', '    function bubbleRowKeyOf('),context);
  context.saveBubbleCfg({expectedRevision:context.bubbleEditorRevision,items:[]},ok=>{if(ok!==false)closed=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.expectedRevision,'new');assert.equal(failed,true);assert.equal(closed,false);
});

test('late startup bubble read cannot restore a library deleted in a newer editor read', async () => {
  const requests=[],context=vm.createContext({bubbleCfgReadSeq:0,BUBBLE_URL:'/bubble',
    fetch(){const d=deferred();requests.push(d);return d.promise;},requireSaved(data){assert.equal(data.ok,true);},applyBubbleCfgSeq(){}});
  vm.runInContext(section('    function loadBubbleCfg()', '    function saveBubbleCfg('),context);
  const old=context.loadBubbleCfg(),fresh=context.loadBubbleCfg();
  requests[1].resolve({json:async()=>({ok:true,revision:'new',config:{items:[],lib:[]}})});await fresh;
  requests[0].resolve({json:async()=>({ok:true,revision:'old',config:{items:[],lib:[{id:'deleted'}]}})});await old;
  assert.equal(context.bubbleRevision,'new');assert.equal(context.bubbleLib.length,0);
});

test('missing saved bubble config is a successful default load, not a startup error', async () => {
  const context=vm.createContext({bubbleCfgReadSeq:0,BUBBLE_URL:'/bubble',
    fetch:async()=>({json:async()=>({ok:true,revision:'empty',config:null})}),
    requireSaved(data){assert.equal(data.ok,true);},bubbleDefaultQueue(){return [{kind:'normal'}];},applyBubbleCfgSeq(){}});
  vm.runInContext(section('    function loadBubbleCfg()', '    function saveBubbleCfg('),context);
  await context.loadBubbleCfg();
  assert.equal(context.bubbleCfg,null);assert.equal(context.bubbleRevision,'empty');
  assert.equal(context.bubbleLib.length,0);assert.equal(context.bubbleSeq[0].kind,'normal');
});
