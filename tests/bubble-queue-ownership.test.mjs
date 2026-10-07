import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.indexOf(`    function ${name}(`);
  assert.ok(start >= 0, name);
  // Declarations in the widget share this indentation; retain only the function
  // so adjacent DOM initialization is never executed by the unit fixture.
  const end = source.indexOf('\n    }', start) + '\n    }'.length;
  return source.slice(start, end);
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function harness() {
  const renders = [], rendered = [], timers = new Map(); let clock = 1000, timer = 0;
  const box = {
    Date: { now: () => clock }, Promise,
    setTimeout(fn, ms) { timers.set(++timer, { fn, ms }); return timer; }, clearTimeout(id) { timers.delete(id); },
    bubbleOn: true, bubbleBox: { classList: { add() {}, remove() {} } }, textBox: {},
    bubbleScene: null, bubbleShown: false, bubbleSceneEpoch: 0, bubbleTtlTimer: null,
    costBubbleActive: false, bubbleRandomActive: false, bubbleRandomLines: null,
    whaleSysItem: null, whaleSysQueue: [], whaleSysTimer: null, turnCostCloseMs: 5000, USAGE_ALERT_TTL: 6500,
    bubbleRoundOn: false, bubbleSeqIdx: 0, bubbleBuilding: false,
    bindBubbleParts() {}, menuBox: {}, WhaleMoney: { applyLatestQuote() {}, refreshBindings() {} }, WhaleRendering: { presentFor() {} },
    bubbleRenderCost(amount) { rendered.push(amount); }, bubbleRenderModules(mods) { rendered.push(mods); },
    bubbleFrames: { front: {}, cancel() {}, close() {}, open(build, ready) {
      const job = {}; job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      job.build = build; job.ready = ready; renders.push(job); build({}); return job.promise;
    } },
  };
  vm.createContext(box);
  vm.runInContext(['bubbleClearAll', 'bubbleCloseVisual', 'sceneOpen', 'armBubbleDeadline', 'bubbleAutoClose',
    'hideBubble', 'hideCostBubble', 'hideUsageAlertBubble', 'whaleSysPush', 'whaleSysTick', 'whaleSysOpenItem',
    'whaleSysDone', 'whaleSysSwapNext'].map(productionFunction).join('\n'), box);
  const enqueue = amount => { box.whaleSysPush({ kind: 'cost', amount, rank: 3 }); box.whaleSysTick(); };
  return { box, renders, rendered, timers, enqueue, now(v) { clock = v; } };
}

test('failed first frame releases queue ownership and automatically opens the following cost', async () => {
  const h = harness(); h.enqueue(1); h.enqueue(2);
  assert.deepEqual(h.rendered, [1]);
  h.renders[0].resolve(false); await flush();
  assert.deepEqual(h.rendered, [1, 2]);
  assert.equal(h.box.whaleSysItem.amount, 2);
  h.renders[1].resolve(true); await flush();
  assert.equal(h.box.bubbleScene.pending, false);
  assert.equal(h.box.whaleSysQueue.length, 0);
});
test('expired cost closes when the only queued account batch is invalid', async () => {
 const h=harness();let discarded=0;h.enqueue(1);h.renders[0].resolve(true);await flush();
 h.box.whaleSysPush({kind:'cost',amount:2,isValid:()=>false,onDiscard:()=>discarded++});
 h.now(7000);h.box.armBubbleDeadline();assert.equal(discarded,1);assert.equal(h.box.bubbleShown,false);assert.equal(h.box.bubbleScene,null);
});
test('queue advance skips an invalid batch and opens the following valid batch', async () => {
 const h=harness();h.enqueue(1);h.renders[0].resolve(true);await flush();
 h.box.whaleSysPush({kind:'cost',amount:2,isValid:()=>false});h.box.whaleSysPush({kind:'cost',amount:3});
 h.box.hideCostBubble();assert.deepEqual(h.rendered,[1,3]);
});
test('account batch confirmation follows render commit, while failures only discard', async () => {
 const h=harness();let shown=0,discarded=0;
 h.box.whaleSysPush({kind:'cost',amount:2,isValid:()=>true,onShown:()=>shown++,onDiscard:()=>discarded++});h.box.whaleSysTick();
 assert.equal(shown,0);h.renders[0].resolve(false);await flush();assert.equal(shown,0);assert.equal(discarded,1);
 h.box.whaleSysPush({kind:'cost',amount:3,isValid:()=>true,onShown:()=>shown++});h.box.whaleSysTick();h.renders[1].resolve(true);await flush();assert.equal(shown,1);
});

test('rejected renderer also advances, and a stale completion cannot release a newer item', async () => {
  const h = harness(); h.enqueue(1); h.enqueue(2);
  h.renders[0].reject(new Error('decode')); await flush();
  const second = h.box.bubbleScene;
  h.enqueue(3); assert.equal(h.box.whaleSysSwapNext(), true);
  h.renders[1].resolve(false); await flush();
  assert.notEqual(h.box.bubbleScene, second);
  assert.equal(h.box.whaleSysItem.amount, 3);
  h.renders[2].resolve(true); await flush();
  assert.equal(h.box.whaleSysItem.amount, 3);
});

test('closing during a pending render clears all ownership, timers and queued items', async () => {
  const h = harness(); h.enqueue(1); h.enqueue(2); h.box.hideBubble();
  h.renders[0].resolve(true); await flush();
  assert.equal(h.box.bubbleScene, null); assert.equal(h.box.whaleSysItem, null);
  assert.equal(h.box.bubbleShown, false); assert.equal(h.box.whaleSysQueue.length, 0);
  assert.equal(h.timers.size, 0);
  h.enqueue(3); assert.deepEqual(h.rendered, [1, 3]);
});

test('failed queue advance does not resurrect an expired or dismissed previous system bubble', async () => {
  const h = harness(); h.enqueue(1); h.renders[0].resolve(true); await flush();
  h.enqueue(2); h.enqueue(3); h.now(7000); h.box.armBubbleDeadline();
  h.renders[1].resolve(false); await flush();
  assert.deepEqual(h.rendered, [1, 2, 3]); assert.equal(h.box.whaleSysItem.amount, 3);
});

test('failed ordinary replacement restores the committed system owner and original deadline', async () => {
  const h = harness(); h.enqueue(1); h.renders[0].resolve(true); await flush();
  h.box.sceneOpen('normal', () => {}, 5000); h.now(4000);
  h.renders[1].resolve(false); await flush();
  assert.equal(h.box.whaleSysItem.amount, 1); assert.equal(h.box.bubbleScene.deadline, 6000);
  h.now(6500); h.box.armBubbleDeadline(); assert.equal(h.box.bubbleShown, false);
});

test('stale boolean flags cannot discard new queue entries', async () => {
  const h = harness(); h.box.costBubbleActive = true; h.box.whaleSysItem = { kind: 'cost', amount: 99 };
  h.enqueue(1); assert.deepEqual(h.rendered, [1]);
  h.renders[0].resolve(true); await flush(); assert.equal(h.box.whaleSysItem.amount, 1);
});

test('pending ordinary scenes yield to a queued notice after committing, not before', async () => {
  const h = harness(); h.box.sceneOpen('normal', () => {}, 5000); h.enqueue(1);
  assert.equal(h.renders.length, 1); h.renders[0].resolve(true); await flush();
  assert.equal(h.renders.length, 2); assert.equal(h.box.whaleSysItem.amount, 1);
});

test('synchronous renderer failure consumes only its own item and cannot strand the next one', async () => {
  const h = harness(), original = h.box.bubbleFrames.open; let fail = true;
  h.box.bubbleFrames.open = (...args) => { if (fail) { fail = false; throw new Error('renderer'); } return original(...args); };
  h.box.whaleSysQueue.push({ kind: 'cost', amount: 1 }, { kind: 'cost', amount: 2 }); h.box.whaleSysTick();
  assert.deepEqual(h.rendered, [2]); h.renders[0].resolve(true); await flush();
  assert.equal(h.box.whaleSysItem.amount, 2);
});

test('replacing two pending scenes rolls back to a committed frame, never to an uncommitted scene', async () => {
  const h = harness(); h.box.sceneOpen('normal', () => {}, 5000); h.renders[0].resolve(true); await flush();
  const committed = h.box.bubbleScene;
  h.box.sceneOpen('custom', () => {}, 5000); h.box.sceneOpen('random', () => {}, 5000);
  h.renders[1].resolve(false); h.renders[2].resolve(false); await flush();
  assert.equal(h.box.bubbleScene, committed); assert.equal(h.box.bubbleScene.pending, false);
});

test('ordinary and choice names survive editor, save and runtime conversions without aliasing modules', () => {
  const data = { items: [
    { kind: 'normal', name: '余额屏' },
    { kind: 'choice', name: '随机两屏', options: [
      { w: 8, name: '选项甲', item: { kind: 'custom', name: '甲屏', modules: [{ type: 'text', text: '保留', color: '#abc' }] } },
      { w: 3, item: { kind: 'random', name: '乙屏' } },
    ] },
  ], lib: [] };
  const box = { bubbleCfg: data, bubbleEditItems: [], bubbleLib: [], bubbleMask: { style: {} },
    closeRolePanel() {}, closeAudioGroupPanel() {}, renderBubbleEditor() {}, bubbleDefaultQueue: () => [],
    bubbleDefaultSecondModules: () => [{ type: 'random', lines: ['原文'] }], bubbleDefaultModules: () => [{ type: 'balance' }],
    bubbleRowsCanon() {}, bubbleSeq: [] };
  vm.createContext(box);
  vm.runInContext(['bubbleNamedItem', 'bubbleIsChoice', 'bubbleChoiceOptions', 'bubbleChoiceWeight',
    'bubbleSingleFromItem', 'bubbleStepToBubble', 'buildBubbleEditor', 'bubbleStepToSaved', 'applyBubbleCfgSeq']
    .map(productionFunction).join('\n'), box);
  box.buildBubbleEditor();
  const saved = box.bubbleEditItems.map(box.bubbleStepToSaved);
  assert.equal(saved[0].name, '余额屏'); assert.equal(saved[1].name, '随机两屏');
  assert.equal(saved[1].options[0].name, '选项甲');
  assert.deepEqual(Array.from(saved[1].options, o => o.item.name), ['甲屏', '乙屏']);
  assert.deepEqual(Array.from(saved[1].options, o => o.w), [8, 3]);
  assert.equal(saved[1].options[0].item.modules[0].color, '#abc');
  saved[1].options[0].item.modules[0].text = '修改';
  assert.equal(data.items[1].options[0].item.modules[0].text, '保留');
  box.bubbleCfg = { items: saved }; box.applyBubbleCfgSeq();
  assert.equal(box.bubbleSeq[1].name, '随机两屏'); assert.equal(box.bubbleSeq[1].options[1].item.name, '乙屏');
  assert.equal(box.bubbleSingleFromItem(saved[1].options[0].item).name, '甲屏');
  assert.equal(box.bubbleStepToBubble(saved[1].options[0].item).name, '甲屏');
  assert.equal(box.bubbleStepToSaved({ kind: 'normal', name: '' }).name, '');
  assert.equal(Object.hasOwn(box.bubbleStepToSaved({ kind: 'normal' }), 'name'), false);
});
