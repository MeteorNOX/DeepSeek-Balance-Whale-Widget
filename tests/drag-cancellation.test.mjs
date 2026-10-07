import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../assets/whale-widget.js',import.meta.url),'utf8');
function real(name){const start=source.indexOf(`    function ${name}(`);assert.ok(start>=0);const end=source.indexOf('\n    }',start);return source.slice(start,end+6);}
function setup(){
 let committed=0,saved=0,clicked=0;const state={left:330,top:340,flip:false};
 const h=vm.createContext({Number,WhaleRendering:{},state,drag:{active:true,moved:true,origLeft:300,origTop:300,startX:350,startY:350,vp:{w:1000,h:700},w:200,h:200},
 root:{hasPointerCapture:()=>false,classList:{remove(){}}},document:{removeEventListener(){}},positioner:{style:{}},pressUp(){},isWhaleHit:()=>false,setWidgetCursor(){},onDocPointerMove(){},onDocPointerUp(){},
 applyAnchorPos(){state.left=300;state.top=300;},settle(){},whaleClick(){clicked++;},refresh(){},commitPosition(){committed++;},saveConfig(){saved++;},
 clamp:(x,a,b)=>Math.max(a,Math.min(b,x)),artCenterAt:(x,y,w,h)=>({cx:x+w/2,cy:y+h/2}),snapZones:()=>({zH:null,zV:null,flip:false})});
 vm.runInContext(real('onDocPointerCancel')+'\n'+real('endDrag'),h);
 return {h,state,counts:()=>({committed,saved,clicked})};
}
for(const [name,event] of [['zero',{clientX:0,clientY:0}],['valid',{clientX:500,clientY:400}]]){
 test(`pointercancel with ${name} coordinates restores intended position without persisting`,()=>{
  const x=setup();x.h.onDocPointerCancel(event);assert.deepEqual(x.state,{left:300,top:300,flip:false});assert.deepEqual(x.counts(),{committed:0,saved:0,clicked:0});assert.equal(x.h.drag.active,false);
 });
}
test('lost capture, blur and invalid ending coordinates cannot persist unfinished drags',()=>{
 for(const [event,allowed] of [[null,false],[{clientX:0,clientY:0},false],[{clientX:450,clientY:NaN},true],[{clientX:Infinity,clientY:400},true]]){
  const x=setup();x.h.endDrag(event,allowed);assert.equal(x.state.left,300);assert.equal(x.state.top,300);assert.equal(x.counts().committed,0);
 }
});
test('normal pointerup still saves exactly once, including a legitimate screen origin',()=>{
 for(const [point,expected] of [[{clientX:400,clientY:420},[350,370]],[{clientX:0,clientY:0},[0,0]]]){
  const x=setup();x.h.endDrag(point,true);assert.deepEqual([x.state.left,x.state.top],expected);assert.deepEqual(x.counts(),{committed:1,saved:1,clicked:0});x.h.endDrag(point,true);assert.equal(x.counts().committed,1);
 }
});
