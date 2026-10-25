const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.WHALE_PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync('assets/whale-widget.js', 'utf8');
async function runScenario(importAudio) {
  const browser = await chromium.launch({headless: true, channel: 'chrome'});
  try {
    const page = await browser.newPage();
    await page.route('http://whale.test/**', route => route.fulfill({status: 200, contentType: 'application/json', body: '{}'}));
    await page.goto('http://whale.test/');
    await page.setContent('<html><head></head><body><div id="root"></div></body></html>');
    await page.evaluate(() => {
      window.alerts = [];
      window.alert = message => window.alerts.push(message);
      window.contexts = [];
      const NativeAudio = window.AudioContext;
      window.AudioContext = class extends NativeAudio {
        constructor(...args) { super(...args); window.contexts.push(this); }
      };
      const NativeReader = window.FileReader;
      window.FileReader = class extends NativeReader {
        readAsArrayBuffer(file) {
          window.importCompleted = new Promise(resolve => this.addEventListener('loadend', resolve, {once: true}));
          return super.readAsArrayBuffer(file);
        }
      };
    });
    await page.addScriptTag({content: source});
    return await page.evaluate(async importAudio => {
      const lifecycle = window.__dshWhaleLifecycle;
      const before = lifecycle.resources();
      const contextCount = window.contexts.length;
      if (importAudio) {
        const input = document.querySelector('input[type=file][accept="audio/*"]');
        const files = new DataTransfer();
        files.items.add(new File(['invalid audio'], 'bad.wav', {type: 'audio/wav'}));
        input.files = files.files;
        input.dispatchEvent(new Event('change'));
      }
      lifecycle.stop('client-disabled');
      if (importAudio) await window.importCompleted;
      // decodeAudioData completes asynchronously after FileReader.loadend.
      await new Promise(resolve => setTimeout(resolve, 250));
      return {before, after: lifecycle.resources(), connectedNodes: document.querySelectorAll('[class^=dshwv]').length,
        alerts: window.alerts, contextsCreatedAfterStop: window.contexts.length - contextCount};
    }, importAudio);
  } finally { await browser.close(); }
}
test('MOUNTED-STOP-01: full production renderer releases mounted resources', async () => {
  const result = await runScenario(false);
  assert.ok(result.before.nodes > 0 && result.before.timers > 0 && result.before.audioContexts > 0);
  assert.deepEqual(result.after, {timers: 0, observers: 0, listeners: 0, nodes: 0, audioContexts: 0});
  assert.equal(result.connectedNodes, 0);
});
test('LATE-AUDIO-01: disabled instance cannot create audio contexts or alert from pending local import', async () => {
  const result = await runScenario(true);
  console.log('LATE-AUDIO-01 baseline', JSON.stringify(result));
  assert.deepEqual({alerts: result.alerts, contextsCreatedAfterStop: result.contextsCreatedAfterStop},
    {alerts: [], contextsCreatedAfterStop: 0});
});
