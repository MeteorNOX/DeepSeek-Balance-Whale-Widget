import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parentPort, workerData } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';

const count = v => Number.isSafeInteger(v) && v >= 0 ? v : 0;
const ALIAS_CONFLICT = Symbol('conflicting aliases');
function alias(value, names) {
  const present=names.filter(name=>Object.hasOwn(value,name) && value[name] !== undefined);
  if (!present.length) return undefined;
  const selected=value[present[0]];
  return present.every(name=>isDeepStrictEqual(value[name],selected)) ? selected : ALIAS_CONFLICT;
}
export function quotaWindows(value, at, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isFinite(at)) return [];
  // Codex emits independent buckets in the same stream. Missing IDs are a
  // compatibility fallback only; an explicit, different ID is never account quota.
  const id=alias(value,['limit_id','limitId']),name=alias(value,['limit_name','limitName']);
  if (id === ALIAS_CONFLICT || name === ALIAS_CONFLICT || name != null && typeof name !== 'string') return [];
  const explicit = id === 'codex';
  if (!explicit && (id != null || name != null && name !== 'Codex' && name !== 'codex')) return [];
  const result = [];
  for (const key of ['primary','secondary']) {
    const w = value[key];
    if (!w || typeof w !== 'object' || Array.isArray(w)) continue;
    const used=alias(w,['used_percent','usedPercent']);
    const mins=alias(w,['window_minutes','window_duration_mins','windowDurationMins','windowMinutes']);
    const resets=alias(w,['resets_at','resetsAt']);
    if (!Number.isFinite(used) || used < 0 || used > 100 || resets === ALIAS_CONFLICT) continue;
    if (mins !== 300 && mins !== 10080) continue;
    // Both protocol spellings carry epoch seconds; the renderer uses milliseconds.
    const resetMs = Number.isFinite(resets) ? resets * 1000 : null;
    const reset = Number.isFinite(resetMs) ? resetMs : null;
    result.push({ label:mins === 300 ? '5 小时' : '周', windowDurationMins:mins,
      usedPercent:used, remainingPercent:100-used, resetsAt:reset,
      stale:now-at > 15*60000 || reset === null || reset <= now, observedAt:at,
      source:explicit ? 'codex' : 'legacy-unscoped' });
  }
  return result;
}

// Merge by duration, never by primary/secondary position or whole event. The
// official account bucket outranks an ambiguous old-client snapshot. Equal-time
// fragments fill missing reset data; conflicting values use a conservative,
// order-independent choice (higher usage and earlier reset).
export function mergeQuotaWindows(previous, incoming, now) {
  const windows = new Map();
  for (const item of [...previous, ...incoming]) {
    const old = windows.get(item.windowDurationMins);
    const rank = w => w.source === 'codex' ? 1 : 0;
    if (!old || rank(item) > rank(old) || rank(item) === rank(old) && item.observedAt > old.observedAt) {
      windows.set(item.windowDurationMins, {...item});
    } else if (rank(item) === rank(old) && item.observedAt === old.observedAt) {
      const usedPercent = Math.max(old.usedPercent, item.usedPercent);
      const resets = [old.resetsAt, item.resetsAt].filter(Number.isFinite);
      windows.set(item.windowDurationMins, {...old, usedPercent, remainingPercent:100-usedPercent,
        resetsAt:resets.length ? Math.min(...resets) : null});
    }
  }
  return [...windows.values()].sort((a,b) => a.windowDurationMins-b.windowDurationMins).map(w => ({...w,
    stale:now-w.observedAt > 15*60000 || w.resetsAt === null || w.resetsAt <= now}));
}

// Only counters and quota snapshots survive this parser; no messages or titles do.
export class InsightAccumulator {
  constructor(now, {quotaAfterMs=0}={}) { this.now=now; this.quotaAfterMs=quotaAfterMs; this.id=null; this.last=null; this.skip=0; this.created=0; this.forked=false; this.events=[]; this.quota=null; this.partial=false; }
  accept(d) {
    if (this.skip > 0) { this.skip--; return; }
    const p=d?.payload;
    if (!p) return;
    if (d.type === 'session_meta') {
      if (this.id !== null) return;
      this.id=typeof p.id==='string' ? p.id : typeof p.session_id==='string' ? p.session_id : '';
      this.skip=count(p.subagent_history_start_ordinal); this.created=Date.parse(p.timestamp)||0; this.forked=!!p.forked_from_id; return;
    }
    if (d.type !== 'event_msg' || p.type !== 'token_count') return;
    const at=Date.parse(d.timestamp);
    if (!Number.isFinite(at) || at > this.now+60000 || this.forked && at < this.created) return;
    const windows=at >= this.quotaAfterMs ? quotaWindows(alias(p,['rate_limits','rateLimits']),at,this.now) : [];
    if (windows.length) {
      const merged=mergeQuotaWindows(this.quota?.windows||[],windows,this.now);
      this.quota={at:Math.max(...merged.map(w=>w.observedAt)),windows:merged};
    }
    const raw=p.info?.total_token_usage;
    if (!raw) return;
    const keys=['input_tokens','output_tokens','cached_input_tokens','reasoning_output_tokens'];
    const next=Object.fromEntries(keys.map(k=>[k,count(raw[k])]));
    const reset=this.last && (next.input_tokens<this.last.input_tokens || next.output_tokens<this.last.output_tokens);
    if ((!this.last || reset) && !p.info.last_token_usage && at>=this.now-7*86400000) this.partial=true;
    const delta = this.last && !reset ? Object.fromEntries(keys.map(k=>[k,Math.max(0,next[k]-this.last[k])])) : Object.fromEntries(keys.map(k=>[k,count(p.info.last_token_usage?.[k])]));
    this.last=next;
    if (at>=this.now-7*86400000 && delta.input_tokens+delta.output_tokens>0) this.events.push({at,...delta});
  }
}

export function collectInsights({codexHome,now=Date.now(),maxFiles=256,maxBytes=128*1024*1024,quotaAfterMs=0}) {
  const files=[]; let visited=0, complete=true, scannedBytes=0;
  const walk=(dir,depth=0)=>{
    if(depth>5 || visited>12000){complete=false;return;}
    let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
    for(const e of entries){visited++;if(visited>12000){complete=false;break;}const f=path.join(dir,e.name);
      if(e.isSymbolicLink())continue;
      if(e.isDirectory())walk(f,depth+1);
      else if(e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {const s=fs.statSync(f);if(s.mtimeMs>=now-8*86400000)files.push({f,mtime:s.mtimeMs});}
    }
  };
  walk(path.join(codexHome,'sessions'));walk(path.join(codexHome,'archived_sessions'));
  files.sort((a,b)=>b.mtime-a.mtime); if(files.length>maxFiles)complete=false;
  const totals={total:0,input:0,output:0,cachedInput:0,reasoningOutput:0,last5Hours:0,last7Days:0};
  let quota=null, scannedFiles=0; const seen=new Set();
  for(const {f} of files.slice(0,maxFiles)) {
    if(scannedBytes>=maxBytes){complete=false;break;}
    const parser=new InsightAccumulator(now,{quotaAfterMs}), decoder=new StringDecoder('utf8');
    let fd;try{fd=fs.openSync(f,'r');}catch{complete=false;continue;}
    let pending='',discard=false;const buffer=Buffer.alloc(65536);
    try{while(scannedBytes<maxBytes){const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,maxBytes-scannedBytes),null);if(!n)break;scannedBytes+=n;pending+=decoder.write(buffer.subarray(0,n));
      let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(discard){discard=false;continue;}if(line.length>1024*1024){complete=false;continue;}
        if(!/"(?:token_count|session_meta)"/.test(line)) {if(parser.skip>0)parser.skip--;continue;}
        try{parser.accept(JSON.parse(line));}catch{complete=false;}
      }
      if(pending.length>1024*1024){pending='';discard=true;complete=false;}
    }}catch{complete=false;}finally{fs.closeSync(fd);}
    if(scannedBytes>=maxBytes)complete=false;
    scannedFiles++;
    // Copies in sessions/archived_sessions can contain complementary windows.
    // Merge quota before the token-session deduplication below.
    if(parser.quota) {
      const windows=mergeQuotaWindows(quota?.windows||[],parser.quota.windows,now);
      quota={at:Math.max(...windows.map(w=>w.observedAt)),windows};
    }
    if (parser.id && seen.has(parser.id)) continue;
    if (parser.id) seen.add(parser.id);
    if (parser.partial) complete=false;
    for(const e of parser.events){const total=e.input_tokens+e.output_tokens;totals.input+=e.input_tokens;totals.output+=e.output_tokens;totals.cachedInput+=e.cached_input_tokens;totals.reasoningOutput+=e.reasoning_output_tokens;totals.total+=total;if(e.at>=now-5*3600000)totals.last5Hours+=total;}
  }
  totals.last7Days=totals.total;
  return {tokens:{...totals,period:'rolling-7-days',complete,scannedFiles,note:'本机近 7 天已观测 token；缓存输入已含在输入内，推理输出已含在输出内。近 5 小时是滚动统计，不是官方额度窗口。'},windows:quota?.windows||[],observedAt:quota?.at||null};
}
if(parentPort) {try{parentPort.postMessage(collectInsights(workerData));}catch{parentPort.postMessage({error:'local-observation-unavailable'});}}
