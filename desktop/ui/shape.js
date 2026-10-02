(() => {
  'use strict';
  const bridge=window.whaleDesktop;
  if(bridge?.platform!=='win32'||typeof bridge.shape!=='function')return;
  let scheduled=0,last='',updates=0,rectangles=[];
  const margin=16;
  function visible(el,opening=false){
    if(!el?.isConnected||el.hidden)return false;
    return el.checkVisibility({visibilityProperty:true,opacityProperty:!opening});
  }
  function bounds(el){
    const r=el.getBoundingClientRect();
    if(r.width<=0||r.height<=0)return null;
    const x=Math.max(0,Math.floor(r.left-margin)),y=Math.max(0,Math.floor(r.top-margin));
    const right=Math.min(innerWidth,Math.ceil(r.right+margin)),bottom=Math.min(innerHeight,Math.ceil(r.bottom+margin));
    return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;
  }
  function publish(force=false){
    scheduled=0;const result=[],seen=new Set();
    const add=(el,opening=false)=>{if(!visible(el,opening))return;const r=bounds(el);if(!r)return;const key=JSON.stringify(r);if(!seen.has(key)){seen.add(key);result.push(r);}};
    // The region excludes all empty client space even while a menu accepts input.
    document.querySelectorAll('.dshwv-img,.dshwv-pop-open,.dshwv-menu-btn-visible,.dshwv-menu-open').forEach(e=>add(e,true));
    document.querySelectorAll('dialog[open],.dshwv-rolelist,.dshwv-audiolist,.dshwv-qedit,.dshwv-usagepanel,.dshwv-custmenu,.dshwv-tplhelp,.dshwv-fx-info,#toast:not([hidden])').forEach(e=>add(e));
    // Modal backdrops are viewport-sized. Include their cards, not the backdrop.
    function card(el,depth=0){if(!visible(el))return;const r=el.getBoundingClientRect();if(depth<3&&r.width>=innerWidth*.95&&r.height>=innerHeight*.95){for(const child of el.children)card(child,depth+1);}else add(el);}
    document.querySelectorAll('[class*="mask"]').forEach(e=>{if(!e.closest('.dshwv-root'))card(e);});
    rectangles=result.slice(0,64);
    const key=JSON.stringify(rectangles);
    if(force||key!==last){last=key;updates++;bridge.shape(rectangles);}
  }
  function request(){if(!scheduled)scheduled=requestAnimationFrame(()=>publish());}
  // Flex layout, font loading and intrinsic content can resize a surface without
  // changing its own attributes or the document viewport. Track the surfaces too.
  const observed=new Set(),resizeObserver=new ResizeObserver(request);
  function trackSurfaces(){
    const targets=new Set(document.querySelectorAll('.dshwv-img,.dshwv-root,.dshwv-menu,dialog,[class*="mask"]>*'));
    targets.add(document.documentElement);
    for(const el of observed)if(!targets.has(el)){resizeObserver.unobserve(el);observed.delete(el);}
    for(const el of targets)if(!observed.has(el)){observed.add(el);resizeObserver.observe(el);}
  }
  new MutationObserver(()=>{trackSurfaces();request();}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class','hidden','open','src']});
  trackSurfaces();
  document.fonts?.ready.then(request);
  document.addEventListener('load',request,true);
  window.addEventListener('resize',request);
  window.addEventListener('whale-shape-request',()=>{last='';publish(true);});
  for(const name of ['transitionrun','transitionend','animationstart','animationend'])document.addEventListener(name,request,true);
  window.WhaleRendering?.onFrame(()=>publish());
  if(bridge.testMode)window.__whaleShapeTest={publish:()=>publish(true),status:()=>({updates,rectangles})};
  publish(true);
})();
