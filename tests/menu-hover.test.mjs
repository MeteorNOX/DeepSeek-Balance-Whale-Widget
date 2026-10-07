import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8');
const logic = source.slice(source.indexOf('    var menuHoverTimer = null;'), source.indexOf("    document.addEventListener('pointermove', onDocPointerMoveCursor"));
function fixture() {
  const classes = new Set(), timers = new Map(); let sequence = 0;
  const box = vm.createContext({
    menuBtnHide: false, menuOpen: false, drag: null,
    img: { getBoundingClientRect: () => ({ left: 100, right: 210, top: 100, bottom: 210 }) },
    menuBtn: {
      getBoundingClientRect: () => ({ left: 218, right: 244, top: 104, bottom: 130 }),
      classList: { contains: c => classes.has(c), remove: c => classes.delete(c), toggle: (c, value) => value ? classes.add(c) : classes.delete(c) },
    },
    document: { documentElement: { dataset: {} }, elementFromPoint: () => null },
    isWhaleHit: e => e.clientX === 170 && e.clientY === 160,
    setTimeout: callback => { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(logic, box);
  return {
    box, classes, timers,
    move: (x, y) => box.onDocPointerMoveCursor({ clientX: x, clientY: y }),
    visible: () => classes.has('dshwv-menu-btn-visible'),
    flush: () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
  };
}

test('transparent gap retains an already revealed menu button without changing the alpha cursor', () => {
  const f = fixture();
  f.move(214, 114); assert.equal(f.visible(), false, 'a transparent pixel cannot initially reveal the button');
  f.move(170, 160); assert.equal(f.visible(), true); assert.equal(f.box.widgetCursor, 'grab');
  f.move(214, 114); f.flush();
  assert.equal(f.visible(), true, 'slow movement or stopping between the sprite and button stays reachable');
  assert.equal(f.box.widgetCursor, '', 'hover retention does not claim a draggable sprite pixel');
  assert.equal(f.timers.size, 0);
});

test('leaving the hover envelope hides once, while reentry cancels the pending hide', () => {
  const f = fixture(); f.move(170, 160);
  for (let i = 0; i < 8; i++) f.move(400, 400);
  assert.equal(f.timers.size, 1);
  f.move(214, 114); assert.equal(f.timers.size, 0); f.flush(); assert.equal(f.visible(), true);
  f.move(400, 400); f.flush(); assert.equal(f.visible(), false);
  f.move(214, 114); assert.equal(f.visible(), false);
});

test('opening the menu cancels a pending hide and the explicit hide preference wins', () => {
  const f = fixture(); f.move(170, 160); f.move(400, 400);
  f.box.menuOpen = true; f.box.showMenuButton(); f.flush();
  f.move(400, 400); assert.equal(f.visible(), true); assert.equal(f.timers.size, 0);
  f.box.menuBtnHide = true; f.move(170, 160); assert.equal(f.visible(), false);
  f.box.showMenuButton(); assert.equal(f.visible(), false);
});

test('mode reset clears delayed hides and invalid native samples cannot retain hover', () => {
  const f = fixture(); f.move(170, 160); f.move(400, 400);
  f.box.resetMenuButtonHover(); assert.equal(f.timers.size, 0); assert.equal(f.visible(), false);
  f.move(170, 160); f.move(-1, -1); f.flush(); assert.equal(f.visible(), false);
  assert.equal(f.box.inMenuHoverArea({ clientX: NaN, clientY: 114 }), false);
});
