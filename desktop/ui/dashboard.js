(() => {
  'use strict';
  function init() {
    const menu=document.querySelector('.dshwv-menu'), account=window.WhaleAccountView;
    if(!menu||!account||!window.WhaleLegacyUsage)return;
    const settings=menu.querySelector('.dshwv-menuview'),usageArea=menu.querySelector('.dshwv-usage-area'),header=menu.querySelector('.whale-account-menu');
    if(!settings||!usageArea||!header)return;
    const originalControls=[...settings.querySelectorAll('button,input,select,textarea')];
    menu.classList.add('whale-dashboard');header.querySelector('strong').textContent='小鲸鱼';
    let page='overview',generation=0,balance=null,insights=null,lastNotice=null;
    const el=(parent,tag,value,cls)=>{const e=document.createElement(tag);if(value)e.textContent=value;if(cls)e.className=cls;parent.append(e);return e;};
    const nav=el(menu,'nav','','whale-dashboard-tabs');nav.setAttribute('role','tablist');nav.setAttribute('aria-label','小鲸鱼页面');header.after(nav);
    const scroll=el(menu,'div','','whale-dashboard-scroll');
    const overview=el(scroll,'section','','whale-overview');
    const overviewData=el(overview,'div','','whale-overview-data');
    const actions=el(overview,'div','','whale-dashboard-actions');
    const refreshButton=el(actions,'button','刷新');refreshButton.onclick=()=>refresh(true);
    const modeOpen=header.querySelector('.whale-mode-open');actions.append(modeOpen);
    const usage=el(scroll,'section','','whale-usage-page');usage.append(usageArea);
    const tokenUsage=el(usage,'section','','whale-token-usage');
    scroll.append(settings);settings.classList.add('whale-settings-page');
    // The legacy navigation button remains available from the API overview.
    const legacyNav=[...menu.children].find(e=>e.matches('[data-account-api]'));
    if(legacyNav)overview.append(legacyNav);
    const tabs={};const panels={overview,usage,settings};
    for(const [name,label] of [['overview','概览'],['usage','用量'],['settings','设置']]){
      const button=el(nav,'button',label);button.id='whale-tab-'+name;button.dataset.page=name;button.setAttribute('role','tab');button.setAttribute('aria-controls','whale-page-'+name);button.onclick=()=>select(name);tabs[name]=button;
      panels[name].id='whale-page-'+name;panels[name].setAttribute('role','tabpanel');panels[name].setAttribute('aria-labelledby',button.id);
    }
    nav.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      const keys=Object.keys(tabs),current=keys.indexOf(page);const next=event.key==='Home'?0:event.key==='End'?2:(current+(event.key==='ArrowRight'?1:2))%3;
      event.preventDefault();select(keys[next]);tabs[keys[next]].focus();
    });
    const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
    const token=value=>finite(value)?value.toLocaleString()+' token':'暂无记录';
    const date=value=>value&&Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString():'重置时间未知';
    const money=(value,currency=balance?.currency||'USD')=>{
      if(typeof value!=='number'||!Number.isFinite(value))return '暂不可用';
      const converted=window.WhaleMoney.convert(value,currency);
      if(converted===null)return '换算暂不可用';
      return converted>0&&converted<.01?'＜'+window.WhaleMoney.symbol()+'0.01':window.WhaleMoney.formatMoney(value,currency);
    };
    function metric(parent,label,value){const box=el(parent,'div','','whale-metric');el(box,'span',label);el(box,'strong',value);return box;}
    function render(){
      overviewData.replaceChildren();tokenUsage.replaceChildren();
      if(account.mode==='subscription'){
        const sub=insights?.subscription||{},grid=el(overviewData,'div','','whale-quota-grid');
        for(const [minutes,label] of [[300,'5 小时额度'],[10080,'每周额度']]){
          const w=(sub.windows||[]).find(w=>w.windowDurationMins===minutes),box=el(grid,'section','','whale-quota-box');
          el(box,'span',label);el(box,'strong',w&&finite(w.usedPercent)?'剩余 '+Math.max(0,100-w.usedPercent).toFixed(1)+'%':'未观测');
          if(w&&finite(w.usedPercent)){const progress=el(box,'progress');progress.max=100;progress.value=Math.max(0,100-w.usedPercent);progress.setAttribute('aria-label',label+'剩余');}
          el(box,'small',w?'重置：'+date(w.resetsAt):'等待官方额度快照');if(w?.stale)el(box,'small','快照已过期，请刷新');
        }
        if(!sub.available)el(overviewData,'p',sub.reason||'正在读取订阅额度…','whale-dashboard-note');
        metric(overviewData,'本轮已观测消耗',token(lastNotice?.tokens));
        el(overviewData,'p','额度来自官方快照；token 来自本机记录，两者分别统计。','whale-dashboard-note');
        el(tokenUsage,'h3','本机 token 用量');
        const totals=sub.tokens||insights?.tokens||{};
        metric(tokenUsage,'滚动 5 小时',token(totals.last5Hours));metric(tokenUsage,'近 7 天',token(totals.total));
        for(const [key,label] of [['input','输入'],['output','输出'],['cachedInput','缓存输入'],['reasoningOutput','推理输出']])metric(tokenUsage,label,token(totals[key]));
        el(tokenUsage,'p','缓存与推理可能是输入、输出的子集，请勿重复相加。其他设备不计入本机记录。','whale-dashboard-note');
        if(totals.complete===false)el(tokenUsage,'p','扫描尚不完整，仅显示部分记录。','whale-dashboard-note');
        const details=el(tokenUsage,'button','查看订阅额度详情');details.onclick=()=>window.dispatchEvent(new Event('whale-open-insights'));
      }else{
        const view=window.WhaleBalanceView.describe(balance||{}),connection=balance?.connectionInfo;
        if(connection?.name)el(overviewData,'p',connection.name+' · '+(connection.mode==='fixed'?'固定连接':'跟随 Codex'),'whale-connection-source');
        el(overviewData,'span',view.label,'whale-dashboard-label').title=balance?.balanceLabel||view.label;
        el(overviewData,'strong',view.message||money(view.balance),'whale-balance-number');
        if(balance?.stale)el(overviewData,'p','上次成功数据，等待更新','whale-dashboard-note');
        if(balance?.ok===false&&!view.message)el(overviewData,'p','暂时无法查询余额，请在设置中检查接口。','whale-dashboard-note');
        metric(overviewData,'今日已观测消耗',view.canObserve?money(view.todayUsage):'金额未知');
        metric(overviewData,'本轮已观测消耗',lastNotice?lastNotice.costState==='pending'?'待记账':lastNotice.costState==='unknown'?'金额未知':money(lastNotice.amount,lastNotice.currency):'暂无记录');
        el(overviewData,'p','消费记录、余额预警与每日预算在“用量”页。','whale-dashboard-note');
      }
    }
    async function refresh(manual=false){
      const own=++generation,mode=account.mode;refreshButton.disabled=true;
      try{
        const response=await fetch(mode==='subscription'?'/api/insights':'/dsh-whale/balance.json'+(manual?'?refresh=1':''),{cache:'no-store'});
        if(!response.ok)throw Error('刷新失败');const data=await response.json();
        if(own!==generation||account.mode!==mode)return;
        if(mode==='subscription')insights=data;else balance=data;render();
      }catch{if(own===generation){if(mode==='api')balance={ok:false};render();}}
      finally{if(own===generation)refreshButton.disabled=false;}
    }
    function select(next){
      if(!panels[next])return;page=next;
      for(const [key,panel] of Object.entries(panels)){panel.hidden=key!==page;tabs[key].setAttribute('aria-selected',String(key===page));tabs[key].tabIndex=key===page?0:-1;}
      const api=account.mode==='api';usageArea.hidden=!api;tokenUsage.hidden=api;
      window.WhaleLegacyUsage.stop();
      if(page==='usage'&&api&&menu.classList.contains('dshwv-menu-open'))window.WhaleLegacyUsage.start();
      scroll.scrollTop=0;render();window.WhaleRendering?.presentFor(100);
    }
    window.WhaleDashboard={select,refresh,get page(){return page;}};
    let wasOpen=false;new MutationObserver(()=>{
      const open=menu.classList.contains('dshwv-menu-open');if(open===wasOpen)return;wasOpen=open;
      if(open){select(page);refresh();}else{window.WhaleLegacyUsage.stop();generation++;refreshButton.disabled=false;}
    }).observe(menu,{attributes:true,attributeFilter:['class']});
    window.addEventListener('whale-account-view',()=>{generation++;lastNotice=null;select(page);if(wasOpen)refresh();});
    window.addEventListener('whale-turn-notice',event=>{lastNotice=event.detail;render();});
    window.addEventListener('whale-balance',event=>{balance=event.detail;if(account.mode==='api')render();});
    window.WhaleMoney.onChange(()=>{if(account.mode==='api')render();});
    setInterval(()=>{if(wasOpen&&page!=='settings')refresh();},30000);
    // Moving existing nodes preserves all original handlers and values.
    if(originalControls.some(control=>!settings.contains(control)))throw Error('Dashboard lost an existing settings control');
    select('overview');
  }
  if(document.readyState!=='complete')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
