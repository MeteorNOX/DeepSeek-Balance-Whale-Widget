import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const widget = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8');
const begin = widget.indexOf('    function playTaskEndSound()');
const finish = widget.indexOf('    function playTaskEndGroupClick(', begin);
const startNotice = widget.indexOf('          var notice = WhaleTurnNotice.snapshot(d, state.currency);');
const endNotice = widget.indexOf('        }).catch(', startNotice);
assert.ok(begin >= 0 && finish > begin && startNotice >= 0 && endNotice > startNotice);

function fixture({ mode = 'api', kind = 'success', enabled = true, sound = true, slots = [] } = {}) {
  const calls = [], value = { completionKind: kind, failureKind: kind === 'failed' ? 'high-demand' : null };
  const context = {
    window: { WhaleFeedback: { play: (...args) => calls.push(['sound', ...args]) }, WhaleAccountView: { mode, notice: () => calls.push(['subscription']) }, dispatchEvent() {} },
    CustomEvent: class {}, WhaleTurnNotice: { snapshot: () => value }, d: {}, state: {}, turnCostOn: true,
    usageSet: { taskEnd: { on: enabled, sel: 'grp:duck' } }, soundOn: sound, soundVol: .3,
    audioGroupSlotEmpty: (_, slot) => slots.includes(slot), showCostBubble: () => calls.push(['bubble']),
    taskEndSel: {}, encodeURIComponent
  };
  vm.runInNewContext(widget.slice(begin, finish) + '\n(function(){\n' + widget.slice(startNotice, endNotice) + '\n})();', context);
  return calls;
}

test('API and subscription successes use the same complete task group before their display branches', () => {
  for (const mode of ['api', 'subscription']) {
    const calls = fixture({ mode });
    assert.equal(calls[0][0], 'sound'); assert.equal(calls[0][1], 'success');
    assert.deepEqual(Array.from(calls[0][2]), ['/dsh-whale/sound/press.mp3?set=duck', '/dsh-whale/sound/release.mp3?set=duck']);
    assert.equal(calls[0][3], .3);
    assert.equal(calls[1][0], mode === 'api' ? 'bubble' : 'subscription');
  }
});

test('task notifications in both modes honor task and master switches, including failures and cancellations', () => {
  for (const mode of ['api', 'subscription']) for (const kind of ['success', 'cancelled', 'failed']) {
    assert.equal(fixture({ mode, kind, enabled: false }).filter(v => v[0] === 'sound').length, 0);
    const muted = fixture({ mode, kind, sound: false }).filter(v => v[0] === 'sound');
    assert.ok(muted.length === 0 || muted.every(v => v[3] === 0));
    assert.equal(fixture({ mode, kind }).filter(v => v[0] === 'sound').length, 1);
  }
});

test('task group success preserves intentional empty slots', () => {
  const calls = fixture({ slots: ['press'] });
  assert.deepEqual(Array.from(calls[0][2]), ['/dsh-whale/sound/release.mp3?set=duck']);
});
