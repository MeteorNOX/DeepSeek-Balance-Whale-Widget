import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hostIsFrontmost, onAnotherDisplay, COVERED_SHARE, MIN_WINDOW_SIDE } = require('../desktop/visibility.cjs');

// Two displays side by side, in CG coordinates, so the "Codex on the other
// screen" branch can be exercised without a second monitor.
const displays = [
  { id: 1, bounds: { x: 0, y: 0, width: 1470, height: 956 } },
  { id: 2, bounds: { x: 1470, y: 0, width: 1920, height: 1080 } }
];

function displayIdOf(rect) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const hit = displays.find(d => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width
    && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height);
  if (!hit) throw new Error('rect is not on a known display');
  return hit.id;
}

const SELF_PID = 4242;
const CODEX_PID = 35660;
const SAFARI_PID = 653;

// Codex on display 1, with Safari covering it from a window on the same display.
const codexBounds = { x: 181, y: 70, width: 1090, height: 760 };
const safariBounds = { x: 0, y: 33, width: 1450, height: 813 };
// Same geometry, but the Codex window is dragged to display 2.
const codexOnSecondDisplay = { x: 1571, y: 70, width: 1090, height: 760 };

function state(overrides = {}) {
  return {
    selfActive: false,
    selfPid: SELF_PID,
    frontmostPid: SAFARI_PID,
    hostPid: CODEX_PID,
    hostCoverage: 1,
    hostBounds: codexBounds,
    frontmostBounds: safariBounds,
    displayIdOf,
    ...overrides
  };
}

test('挂件自己在前台时显示（用户正在点她，或菜单/对话框），即使别的应用盖住 Codex', () => {
  assert.equal(hostIsFrontmost(state({ selfActive: true })), true);
  assert.equal(hostIsFrontmost(state({ selfActive: true, frontmostPid: 0, hostCoverage: 0 })), true);
});

test('探针拿不到前台信息时不隐藏', () => {
  assert.equal(hostIsFrontmost(state({ frontmostPid: 0 })), true);
  assert.equal(hostIsFrontmost(state({ frontmostPid: undefined })), true);
  assert.equal(hostIsFrontmost(state({ frontmostPid: null })), true);
});

test('前台是挂件自己的进程号时显示', () => {
  assert.equal(hostIsFrontmost(state({ frontmostPid: SELF_PID })), true);
});

test('Codex 在前台时显示', () => {
  assert.equal(hostIsFrontmost(state({ frontmostPid: CODEX_PID, hostCoverage: 0 })), true);
  // 前台进程号是字符串也要认出来（探针的 JSON 字段可能被序列化成字符串）
  assert.equal(hostIsFrontmost(state({ frontmostPid: String(CODEX_PID), hostCoverage: 0 })), true);
});

test('Codex 被别的应用遮挡到阈值以上时隐藏——即使前台窗口在另一块屏幕', () => {
  assert.equal(hostIsFrontmost(state({
    hostCoverage: COVERED_SHARE,
    hostBounds: codexOnSecondDisplay,
    frontmostBounds: safariBounds
  })), false);
  assert.equal(hostIsFrontmost(state({ hostCoverage: 1 })), false);
});

test('遮挡没到阈值、前台窗口和 Codex 在同一块屏时隐藏', () => {
  assert.equal(hostIsFrontmost(state({ hostCoverage: 0.875 })), false);
  assert.equal(hostIsFrontmost(state({ hostCoverage: 0 })), false);
});

test('Codex 开在另一块屏、用户在别的应用里时继续显示', () => {
  assert.equal(hostIsFrontmost(state({
    hostCoverage: 0,
    hostBounds: codexOnSecondDisplay,
    frontmostBounds: safariBounds
  })), true);
});

test('前台应用的最上层窗口还留在另一块屏上也继续显示', () => {
  const frontmostOnSecondDisplay = { x: 1571, y: 40, width: 900, height: 700 };
  assert.equal(hostIsFrontmost(state({
    hostCoverage: 0,
    hostBounds: codexBounds,
    frontmostBounds: frontmostOnSecondDisplay
  })), true);
});

test('前台应用没有真正的窗口（只有桌面/调色板）时隐藏', () => {
  // Finder 桌面不是 layer 0，探针给不出 frontmostBounds
  assert.equal(hostIsFrontmost(state({ hostCoverage: 0, frontmostBounds: null })), false);
  // 比 MIN_WINDOW_SIDE 还小的浮层不算用户正在工作的窗口
  const tiny = { x: 10, y: 10, width: MIN_WINDOW_SIDE - 1, height: MIN_WINDOW_SIDE - 1 };
  assert.equal(hostIsFrontmost(state({ hostCoverage: 0, frontmostBounds: tiny })), false);
});

test('几何信息不全或屏幕查询失败时按隐藏收场，不抛异常', () => {
  assert.equal(hostIsFrontmost(state({ hostCoverage: 0, hostBounds: null })), false);
  assert.equal(hostIsFrontmost(state({ hostCoverage: 0, frontmostBounds: { x: 0, y: 0 } })), false);
  assert.equal(hostIsFrontmost(state({
    hostCoverage: 0,
    displayIdOf: () => { throw new Error('screen lookup failed'); }
  })), false);
  assert.equal(hostIsFrontmost(state({ hostCoverage: 0, displayIdOf: undefined })), false);
});

test('onAnotherDisplay 单独看也只在两块屏且窗口像样时为真', () => {
  assert.equal(onAnotherDisplay({ hostBounds: codexBounds, frontmostBounds: safariBounds, displayIdOf }), false);
  assert.equal(onAnotherDisplay({
    hostBounds: codexOnSecondDisplay,
    frontmostBounds: safariBounds,
    displayIdOf
  }), true);
  assert.equal(onAnotherDisplay({ hostBounds: codexBounds, frontmostBounds: null, displayIdOf }), false);
  assert.equal(onAnotherDisplay({
    hostBounds: codexBounds,
    frontmostBounds: safariBounds,
    displayIdOf: () => { throw new Error('nope'); }
  }), false);
});

test('PR #137 正文里的验证表逐条对上', () => {
  // Codex 在前台：frontmostBundleId = com.openai.codex
  assert.equal(hostIsFrontmost(state({ frontmostPid: CODEX_PID, hostCoverage: 0 })), true);
  // Safari 盖住 Codex：hostCoverage = 1
  assert.equal(hostIsFrontmost(state({ hostCoverage: 1 })), false);
  // 挂件自己成为前台（模拟点击她）
  assert.equal(hostIsFrontmost(state({ selfActive: true, hostCoverage: 1 })), true);
  // 切回 Codex 立即恢复
  assert.equal(hostIsFrontmost(state({ frontmostPid: CODEX_PID, hostCoverage: 0 })), true);
});
