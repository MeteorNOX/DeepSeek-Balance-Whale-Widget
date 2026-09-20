'use strict';

// Keep the mature Windows Codex-following host intact, but make the macOS
// boundary explicit: the packaged Mac App never enters the host-tracking
// lifecycle or its coordinate conversion path.
if (process.platform === 'darwin') {
  require('./standalone-main.cjs');
} else if (process.argv.includes('--standalone') || process.env.WHALE_DESKTOP_MODE === 'standalone') {
  require('./standalone-main.cjs');
} else {
  require('./follow-main.cjs');
}
