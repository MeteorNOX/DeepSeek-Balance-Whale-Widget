// Bounded metadata only. No renderer evaluation or window mutations while sampling.
function createVisibilityRecorder({ read, write, now = Date.now, limit = 120 }) {
  const history = []; let lastSample = -Infinity, lastWrite = -Infinity, reports = 0;
  function sample(force = false) {
    const at = now();
    if (!force && at - lastSample < 1000) return;
    const state = read();
    if (!state) return;
    history.push({ at, ...state });
    if (history.length > limit) history.shift();
    lastSample = at;
    if (at - lastWrite >= 10000) {
      write('visibility-observation.json', { schemaVersion: 1, history }); lastWrite = at;
    }
  }
  function report() {
    sample(true);
    const result = { schemaVersion: 1, reportedAt: now(), history: history.slice() };
    // Three bounded independent reports survive subsequent focus changes.
    const slot = reports % 3 + 1;
    write('visibility-report-' + slot + '.json', result);
    reports++;
    return { saved: true, slot, reportedAt: result.reportedAt };
  }
  return { sample, report };
}
module.exports = { createVisibilityRecorder };
