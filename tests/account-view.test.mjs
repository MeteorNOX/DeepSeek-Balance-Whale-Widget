import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../desktop/ui/account-view.js', import.meta.url), 'utf8');
const exported = { module: { exports: {} } }; vm.runInNewContext(source, exported);
const { windowText, tokenText, noticeText, quotaLabel, quotaBubble } = exported.module.exports;

test('quota periods remain distinct regardless of incoming label',()=>{
  assert.equal(quotaLabel({windowDurationMins:300,label:'primary'}),'5 小时额度');
  assert.equal(quotaLabel({windowDurationMins:10080,label:'secondary'}),'每周额度');
  assert.equal(quotaLabel({windowDurationMins:60,label:'独立窗口'}),'独立窗口');
});

test('missing snapshot values never become zero quota or tokens', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '50']) {
    assert.equal(windowText({ usedPercent: value }), '额度比例未知');
    assert.equal(tokenText(value), '暂无记录');
  }
  assert.match(windowText({ usedPercent: 25.5, stale: true }), /已用 25.5% · 剩余 74.5%（快照已过期）/);
  assert.equal(tokenText(0), '0 token');
});
test('subscription notices do not display API money or generic failure text', () => {
  assert.equal(noticeText({ completionKind: 'failed', tokens: 10, amount: 5 }), '');
  assert.equal(noticeText({ completionKind: 'failed', failureKind: 'high-demand' }), '挤不进去...');
  assert.equal(noticeText({ completionKind: 'completed', tokens: 10, amount: 5 }), '本轮本机已观测：10 token');
});
test('subscription bubble keeps the 5-hour and weekly quota distinct', () => {
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(quotaBubble({ subscription: { available: true, windows: [
    { windowDurationMins: 10080, usedPercent: 68 },
    { windowDurationMins: 300, usedPercent: 37 },
  ] } })), {
    label: 'Codex 剩余额度',
    amount: '5h 额度 63.0%',
    hint: '周额度 32.0%',
  });
  assert.deepEqual(plain(quotaBubble({ subscription: { available: false, reason: '暂无快照' } })), {
    label: 'Codex 剩余额度', amount: '暂无快照', hint: '点击气泡查看小鲸鱼留言',
  });
});
function runtime(fetch) {
  const storage = new Map(); const events = [];
  const context = { document: { documentElement: {dataset:{}}, readyState: 'loading', addEventListener() {}, querySelectorAll(){return []} }, window: { dispatchEvent(e) { events.push(e); } }, localStorage: { getItem(k) { return storage.get(k); }, setItem(k,v) { storage.set(k,v); } }, fetch, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } };
  vm.runInNewContext(source, context);
  return { api: context.window.WhaleAccountView, storage, events, window:context.window };
}
test('subscription completion and cancellation return bubble text without API money',async()=>{
  const r=runtime(async()=>({ok:true,json:async()=>({mode:'subscription'})}));
  assert.equal(r.api.notice({completionKind:'success',tokens:12,amount:100}), null);
  await r.api.setMode('subscription');
  const completed=r.api.notice({completionKind:'success',tokens:12480,amount:100,currency:'USD'});
  const cancelled=r.api.notice({completionKind:'cancelled',tokens:12,amount:10});
  assert.deepEqual(JSON.parse(JSON.stringify(completed)),{label:'本轮本机已观测',amount:'12,480 token',hint:'Codex 订阅用量'});
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled)),{label:'本轮本机已观测',amount:'12 token',hint:'Codex 订阅用量'});
  assert.equal(r.api.notice({completionKind:'success',tokens:12,notify:false}),null);
  assert.ok([completed,cancelled].every(item=>!/[\$¥]|USD|API/.test(Object.values(item).join(''))));
});
test('a rejected save preserves mode and does not emit false switch events', async () => {
  for (const fetch of [async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ mode: 'api' }) }), async () => { throw Error('offline'); }]) {
    const { api, storage, events } = runtime(fetch);
    assert.equal(await api.setMode('subscription'), false);
    assert.equal(api.mode, 'api'); assert.equal(storage.size, 0); assert.equal(events.length, 0);
  }
});
test('successful switches persist display mode only after server acknowledgement', async () => {
  let resolve; let request;
  const { api, storage, events } = runtime((url, options) => { request = { url, options }; return new Promise(r => { resolve = r; }); });
  const pending = api.setMode('subscription');
  assert.equal(api.mode, 'api'); assert.equal(storage.size, 0);
  assert.equal(await api.setMode('api'), false);
  resolve({ ok: true, json: async () => ({ mode: 'subscription' }) });
  assert.equal(await pending, true); assert.equal(api.mode, 'subscription');
  assert.equal(storage.get('dshw-account-view'), 'subscription');
  assert.equal(request.url, '/api/display-mode'); assert.equal(request.options.body, '{"mode":"subscription"}');
  assert.equal(events[0].type, 'whale-account-view'); assert.equal(events[0].detail.mode, 'subscription');
});
