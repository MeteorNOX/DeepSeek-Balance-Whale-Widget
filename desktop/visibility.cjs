'use strict';

// Frontmost visibility decision for the macOS overlay, kept free of Electron so
// it can be exercised by tests/visibility.test.mjs on any machine.
//
// The overlay is an always-on-top window parked on the Codex window rect, so
// "the Codex window is still on screen" is not enough to keep her visible: she
// also has to be worth showing, which means Codex (or the whale itself, while
// the user is clicking her) is the frontmost application.

// Share of the Codex window another application has to cover before we treat
// Codex as hidden rather than merely behind something.
const COVERED_SHARE = 0.9;
// Frontmost apps also own palettes and tooltips; anything below this is not a
// window the user could be working in.
const MIN_WINDOW_SIDE = 40;

function completeRect(rect) {
  return !!rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]));
}

// Codex sits on another display than the application the user just switched to:
// the frontmost window cannot be covering the Codex window, so keep following.
function onAnotherDisplay({ hostBounds, frontmostBounds, displayIdOf }) {
  if (!completeRect(hostBounds) || !completeRect(frontmostBounds)) return false;
  if (frontmostBounds.width < MIN_WINDOW_SIDE || frontmostBounds.height < MIN_WINDOW_SIDE) return false;
  try { return displayIdOf(hostBounds) !== displayIdOf(frontmostBounds); } catch { return false; }
}

function hostIsFrontmost({
  selfActive,
  selfPid,
  frontmostPid,
  hostPid,
  hostCoverage,
  hostBounds,
  frontmostBounds,
  displayIdOf
}) {
  if (selfActive) return true;                                  // whale menu, dialogs, clicked whale
  const frontmost = Number(frontmostPid) || 0;
  if (!frontmost) return true;                                  // probe cannot tell: never hide
  if (frontmost === selfPid) return true;                       // the user is on the whale
  if (frontmost === Number(hostPid)) return true;               // Codex is frontmost
  if (Number(hostCoverage) >= COVERED_SHARE) return false;      // covered by another app
  return onAnotherDisplay({ hostBounds, frontmostBounds, displayIdOf });
}

module.exports = { hostIsFrontmost, onAnotherDisplay, completeRect, COVERED_SHARE, MIN_WINDOW_SIDE };
