import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../assets/whale-widget.js',import.meta.url),'utf8');
function extract(name) {
  let start=source.indexOf('async function '+name+'(');
  if(start<0)start=source.indexOf('function '+name+'(');
  assert.ok(start>=0,name);let end=source.indexOf('{',start)+1,depth=1;
  for(;depth;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
  return source.slice(start,end);
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const samples=Float32Array.from([0,0.25,0.5,-0.5,1,-1,0,0,0,0]);
const buffer={duration:1,sampleRate:10,numberOfChannels:1,length:10,getChannelData:()=>samples};
function harness() {
  const contexts=[],decodes=[],readers=[],uploads=[],notices=[],listeners={};
  class Offline {
    decodeAudioData(){const job=deferred();decodes.push(job);return job.promise;}
  }
  class Context {
    constructor(){this.state='suspended';this.nodes=[];this.resumption=deferred();this.closed=0;contexts.push(this);}
    resume(){this.resumed=true;return this.resumption.promise.then(()=>{if(this.state!=='closed')this.state='running';});}
    close(){this.state='closed';this.closed++;return Promise.resolve();}
    createBufferSource(){const node={connect(){},disconnect(){this.disconnected=true;},stop(){this.stopped=true;if(this.stopThrows)throw Error('already stopped');},start(...args){this.started=args;}};this.nodes.push(node);return node;}
  }
  class Reader {constructor(){readers.push(this);this.result='data:audio/wav;base64,fixture';}readAsDataURL(blob){this.blob=blob;}}
  const field=()=>({value:'',style:{},focus(){}});
  const s={window:{OfflineAudioContext:Offline,AudioContext:Context,addEventListener:(key,fn)=>listeners[key]=fn},
    document:{hidden:false,addEventListener:(key,fn)=>listeners[key]=fn},Blob,FileReader:Reader,DataView,ArrayBuffer,Float32Array,Promise,
    audioCropCtx:null,audioCropGeneration:0,audioCropPreviewGeneration:0,audioCropPreviewNode:null,audioCropBuffer:null,
    audioCropMask:{style:{display:'none'}},audioCropTarget:'press',audioCropFileBase:'',audioCropName:field(),
    audioEditMask:{style:{display:'flex'}},editingAudioGroupId:'group',stopAudioEditPreview(){},closeAudioSlotPanels(){},
    audioCropStart:field(),audioCropEnd:field(),audioCropStartNum:field(),audioCropEndNum:field(),audioCropZoomRange:field(),audioCropZoomNum:field(),
    audioCropZoom:1,audioCropOffset:0,drawAudioCrop(){},updateAudioCropOkState(){},assetNotice:message=>notices.push(message),
    WhaleMediaGuard:{getPolicy:()=>({maxAudioSeconds:300,maxAudioChannels:2,maxAudioSampleRate:96000,audioBytes:100000}),checkFile(){}},
    audioEditPressVal:'old',audioEditReleaseVal:'old',audioEditPressBtn:{},audioEditReleaseBtn:{},lastUploadedFragmentId:'new',
    audioSlotBtnText(){},audioEditPreviewEnsure(){},uploadAudioFragment:(data,name,cb)=>{uploads.push({data,name});cb(true);}};
  vm.createContext(s);
  for(const name of ['cancelAudioCropWork','openAudioCrop','audioCropRange','hideAudioCrop','hideAudioEditor','stopAudioCropPreview','previewAudioCrop','audioCropSlice','encodeWav','confirmAudioCrop'])vm.runInContext(extract(name),s);
  const begin=source.indexOf("window.addEventListener('blur', cancelAudioCropWork);");
  vm.runInContext(source.slice(begin,source.indexOf('async function openAudioCrop',begin)),s);
  const load=async()=>{const p=s.openAudioCrop(new ArrayBuffer(1),'clip.wav');decodes.at(-1).resolve(buffer);await p;};
  return {s,contexts,decodes,readers,uploads,notices,listeners,load};
}

test('decoding opens no output context and a closed decoder cannot reopen the editor',async()=>{
  const h=harness();await h.load();assert.equal(h.contexts.length,0);assert.equal(h.s.audioCropMask.style.display,'flex');
  const p=h.s.openAudioCrop(new ArrayBuffer(1),'late.wav');h.s.hideAudioCrop();h.decodes.at(-1).resolve(buffer);await p;
  assert.equal(h.s.audioCropMask.style.display,'none');assert.equal(h.s.audioCropBuffer,null);assert.equal(h.contexts.length,0);
  await h.load();assert.equal(h.s.audioCropBuffer,buffer);
});

test('closing the parent sound editor cancels an in-flight child decode',async()=>{
  const h=harness(),p=h.s.openAudioCrop(new ArrayBuffer(1),'pending.wav');h.s.hideAudioEditor();
  h.decodes[0].resolve(buffer);await p;
  assert.equal(h.s.audioCropMask.style.display,'none');assert.equal(h.s.audioEditMask.style.display,'none');
  assert.equal(h.s.audioCropTarget,null);assert.equal(h.s.audioCropBuffer,null);
});

test('preview resumes only on demand, natural end releases device, replay opens a fresh context',async()=>{
  const h=harness();await h.load();let p=h.s.previewAudioCrop(),c=h.contexts[0];
  assert.equal(c.resumed,true);assert.equal(c.nodes.length,0);c.resumption.resolve();await p;
  assert.equal(c.nodes[0].buffer,buffer);assert.deepEqual(c.nodes[0].started,[0,0,1]);
  c.nodes[0].onended();assert.equal(c.state,'closed');assert.equal(c.nodes[0].disconnected,true);assert.equal(h.s.audioCropCtx,null);
  p=h.s.previewAudioCrop();c=h.contexts[1];c.resumption.resolve();await p;assert.equal(c.nodes[0].started.length,3);
  h.s.hideAudioCrop();assert.equal(c.state,'closed');
});

test('closing while resume is pending prevents late playback and permits reopening',async()=>{
  const h=harness();await h.load();const p=h.s.previewAudioCrop(),c=h.contexts[0];
  h.s.hideAudioCrop();assert.equal(c.state,'closed');c.resumption.resolve();await p;
  assert.equal(c.nodes.length,0);assert.equal(h.notices.length,0);
  await h.load();const next=h.s.previewAudioCrop();h.contexts[1].resumption.resolve();await next;
  assert.equal(h.contexts[1].nodes.length,1);h.s.hideAudioCrop();
});

test('preview rejection and stop exceptions still close and disconnect device resources',async()=>{
  const h=harness();await h.load();let p=h.s.previewAudioCrop(),c=h.contexts[0];
  c.resumption.reject(Error('unavailable'));await p;assert.equal(c.state,'closed');assert.equal(h.notices.length,1);
  p=h.s.previewAudioCrop();c=h.contexts[1];c.resumption.resolve();await p;c.nodes[0].stopThrows=true;
  h.s.stopAudioCropPreview();assert.equal(c.state,'closed');assert.equal(c.nodes[0].disconnected,true);
});

test('an obsolete preview completion cannot close a newer preview',async()=>{
  const h=harness();await h.load();let p=h.s.previewAudioCrop();h.contexts[0].resumption.resolve();await p;
  const oldEnded=h.contexts[0].nodes[0].onended;
  p=h.s.previewAudioCrop();h.contexts[1].resumption.resolve();await p;oldEnded();
  assert.equal(h.contexts[0].state,'closed');assert.equal(h.contexts[1].state,'running');
  h.s.hideAudioCrop();assert.equal(h.contexts[1].state,'closed');
});

test('blur, page hide and unload cancel pending decode and release previews',async()=>{
  for(const event of ['blur','visibilitychange','beforeunload']) {
    const h=harness();await h.load();const p=h.s.previewAudioCrop(),c=h.contexts[0];c.resumption.resolve();await p;
    if(event==='visibilitychange')h.s.document.hidden=true;h.listeners[event]();assert.equal(c.state,'closed');
    const decode=h.s.openAudioCrop(new ArrayBuffer(1),'pending.wav');h.s.audioCropMask.style.display='none';h.listeners[event]();
    h.decodes.at(-1).resolve(buffer);await decode;assert.equal(h.s.audioCropBuffer,null);assert.equal(h.s.audioCropMask.style.display,'none');
  }
});

test('WAV slicing/export requires no playback context and keeps selected PCM samples',async()=>{
  const h=harness();await h.load();const sliced=h.s.audioCropSlice(buffer,0.2,3),blob=h.s.encodeWav(sliced);
  const bytes=await blob.arrayBuffer(),view=new DataView(bytes);
  assert.equal(bytes.byteLength,50);assert.equal(view.getUint32(40,true),6);
  assert.equal(view.getInt16(44,true),16383);assert.equal(view.getInt16(46,true),-16384);assert.equal(view.getInt16(48,true),32767);
  h.s.audioCropName.value='saved';h.s.confirmAudioCrop();h.readers[0].onload();
  assert.equal(h.uploads.length,1);assert.equal(h.s.audioEditPressVal,'new');assert.equal(h.s.audioCropMask.style.display,'none');assert.equal(h.contexts.length,0);
});

test('WAV channel lookup and sliced views are O(channels), preserving stereo PCM',async()=>{
  const h=harness();let sourceCalls=0,viewCalls=0;
  const stereo={sampleRate:10,numberOfChannels:2,length:10,getChannelData(channel){sourceCalls++;return channel===0?samples:Float32Array.from(samples,x=>-x);}};
  const sliced=h.s.audioCropSlice(stereo,0.2,3);
  assert.equal(sourceCalls,2);assert.equal(sliced.getChannelData(0),sliced.getChannelData(0));
  const lookup=sliced.getChannelData;sliced.getChannelData=channel=>{viewCalls++;return lookup(channel);};
  const bytes=await h.s.encodeWav(sliced).arrayBuffer(),view=new DataView(bytes);
  assert.equal(sourceCalls,2);assert.equal(viewCalls,2);assert.equal(bytes.byteLength,56);
  assert.deepEqual(Array.from({length:6},(_,i)=>view.getInt16(44+i*2,true)),[16383,-16384,-16384,16383,32767,-32768]);
});

test('closing during export read prevents an obsolete callback from changing the editor',async()=>{
  const h=harness();await h.load();h.s.audioCropName.value='cancelled';h.s.confirmAudioCrop();h.s.hideAudioCrop();h.readers[0].onload();
  assert.equal(h.uploads.length,0);assert.equal(h.s.audioEditPressVal,'old');assert.equal(h.s.audioCropMask.style.display,'none');
});
