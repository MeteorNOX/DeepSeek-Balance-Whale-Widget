import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { ROOT } from '../runtime/paths.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function childControl(file, args, env, windowsHide = true) {
  const child = spawn(file, args, { env, windowsHide, stdio: ['pipe', 'pipe', 'pipe'] });
  let serial = 0, log = '', readyResolve, readyReject, input = child.stdin;
  const pending = new Map(); let closed = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(new Error('Fixture startup timed out: ' + log.slice(-1200))), 20000);
  child.stderr.on('data', data => { log += data; });
  const fail = error => { closed = true; clearTimeout(readyTimer); readyReject(error); for (const complete of pending.values()) complete({ error: error.message }); pending.clear(); };
  child.on('error', fail);
  // Cleanup can race a helper that has already exited. Stream errors must be
  // consumed as test failures, never unhandled Electron error dialogs.
  child.stdin.on('error', error => fail(new Error('Fixture stdin closed: ' + error.code + ': ' + log.slice(-1200))));
  child.stdout.on('error', fail); child.stderr.on('error', fail);
  child.on('exit', code => fail(new Error('Fixture exit ' + code + ': ' + log.slice(-1200))));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try {
      const value = JSON.parse(line.replace(/^\uFEFF/, ''));
      if (value.ready) {
        if (value.pipe) {
          input = net.createConnection(value.pipe); input.on('error', fail);
          readline.createInterface({ input }).on('line', line => { try { const reply = JSON.parse(line); if(pending.has(reply.id)){pending.get(reply.id)(reply);pending.delete(reply.id);} } catch(error){ fail(error); } });
          input.once('connect', () => { clearTimeout(readyTimer); readyResolve(value); });
        } else { clearTimeout(readyTimer); readyResolve(value); }
      }
      else if (pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); }
      else if (value.error) readyReject(new Error(value.error));
    } catch { log += line; }
  });
  const request = (command, timeout = 10000) => new Promise((resolve, reject) => {
    if (closed || input.destroyed || !input.writable) { reject(new Error('Fixture pipe closed: ' + command)); return; }
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(command + ' timed out: ' + log.slice(-800))); }, timeout);
    pending.set(id, value => { clearTimeout(timer); value.error ? reject(new Error(value.error)) : resolve(value); });
    input.write(JSON.stringify({ id, command }) + '\n', error => { if (error) fail(error); });
  });
  return { child, ready, request, log: () => log, async stop(command) {
    clearTimeout(readyTimer);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, 'exit');
    if (!closed && !input.destroyed && input.writable) input.write(JSON.stringify({ command }) + '\n', () => {});
    const timer = setTimeout(() => child.kill(), 4000); await stopped; clearTimeout(timer); if(input!==child.stdin)input.destroy();
  } };
}

export async function verifyDesktop({ app, window, screen, setHost, dispatcher, dataDir, errors, renderInfo }) {
  const { nativeImage } = await import('electron');
  const output = path.resolve(process.env.WHALE_DESKTOP_VERIFY_DIR);
  fs.mkdirSync(output, { recursive: true });
  const temporary = path.join(output, 'temp'); fs.mkdirSync(temporary, { recursive: true });
  const env = { ...process.env, TEMP: temporary, TMP: temporary }; delete env.ELECTRON_RUN_AS_NODE;
  // GUI fixture must receive its first ShowWindow normally. SW_HIDE in the
  // process startup info suppresses the host and makes native visibility false.
  const host = childControl(process.execPath, [path.join(ROOT, 'tests', 'visibility-stress-host.cjs'), '--fixture-dir=' + dataDir], env, false);
  let native, polling, samplingPaused = false, busy = false, serial = 0, lastState, pollError;
  const results = { ok: false, minimize: [], saveCancel: [], explicitShow: [], foreground: [], firstMismatches: [], checks: [], startedAt: new Date().toISOString() };
  const ev = code => window.webContents.executeJavaScript(code);
  const waitFor = async (predicate, label, timeout = 10000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) { if (await predicate()) return; if (pollError) throw pollError; await delay(40); }
    throw new Error('Timed out: ' + label);
  };
  try {
    const fixture = await host.ready;
    native = childControl(process.env.WHALE_TEST_POWERSHELL || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'tests', 'visibility-stress-native.ps1'), '-Overlay', window.getNativeWindowHandle().readBigUInt64LE().toString(), '-OverlayPid', String(process.pid), '-FixtureHost', fixture.handle, '-FixturePid', String(fixture.pid)], env);
    await native.ready;
    // Keep production's non-topmost owned window policy. Raising either HWND
    // before sampling can restore a lost surface and conceal the failure.
    const pollHost = async () => {
      const { state, visibilityRevision, visualDiagnostics } = await native.request('probe'); state.visibilityRevision = visibilityRevision; state.visualDiagnostics = visualDiagnostics; lastState = state;
      await setHost({ hostAlive: true, hostPid: fixture.pid, window: fixture.handle, attached: true, nativeFollowing: true, ...state, serial: ++serial });
      return state;
    };
    await pollHost();
    assert.equal(lastState.owned, true, 'fixture overlay is owned by its host');
    assert.equal(lastState.hostTopmost, false, 'fixture host follows production non-topmost policy');
    assert.equal(lastState.overlayTopmost, false, 'fixture overlay follows production non-topmost policy');
    results.windowPolicy = { owned: lastState.owned, hostTopmost: lastState.hostTopmost, overlayTopmost: lastState.overlayTopmost };
    polling = setInterval(async () => {
      if (samplingPaused || busy) return; busy = true;
      try { await pollHost(); } catch (error) { pollError = error; } finally { busy = false; }
    }, 100);
    await waitFor(() => ev("!!window.__whaleRenderTest && document.querySelector('.dshwv-img')?.complete && document.querySelector('.dshwv-img').naturalWidth > 0"), 'whale decoded');
    await delay(1800); // Allow startup preferences and viewport/anchor settling to finish.
    await ev("window.__whaleRenderTest.close(); window.__whaleRenderTest.scale(1); window.__whaleRenderTest.place(120,80,false); const style=document.createElement('style'); style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.append(style);document.getAnimations().forEach(a=>a.pause())");
    await waitFor(() => window.isVisible() && !renderInfo().visibility.pending, 'initial mapped surface');
    await delay(500);
    const rectangle = await ev("document.querySelector('.dshwv-img').getBoundingClientRect().toJSON()");
    const reference = await window.webContents.capturePage();
    fs.writeFileSync(path.join(output, 'visibility-reference.png'), reference.toPNG());
    let points;
    const firstMismatches = new Set();
    const compositionOnly=process.env.WHALE_COMPOSITION_IDLE_TEST==='1';
    async function pixels(label, save = false, deadline = Date.now() + 1200, obstructionDeadline = Date.now() + 60000, occludedMs = 0) {
      // Passive screen copy comes first. Never raise, focus, show, invalidate
      // or capturePage during sampling: each can heal the observed failure.
      const { png, unobscured, state: sampledState } = await native.request('capture');
      const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
      const size = image.getSize(), actual = image.toBitmap();
      assert.equal(sampledState.owned, true, 'overlay remains owned during sampling');
      assert.equal(sampledState.hostTopmost || sampledState.overlayTopmost, false, 'sampling never makes either fixture topmost');
      if (unobscured === false) {
        if(!occludedMs)process.stdout.write(JSON.stringify({screenObscured:true})+'\n');
        if(Date.now()>=obstructionDeadline) throw new Error('Another application or system switcher obscured the fixture for 60 seconds; no surface verdict');
        await delay(250);
        return pixels(label,save,Date.now()+1200,obstructionDeadline,occludedMs+250);
      }
      if (!points) {
        const expected = reference.resize({ width: size.width, height: size.height }).toBitmap();
        const dip = window.getContentBounds(), sx = size.width / dip.width, sy = size.height / dip.height;
        results.capture = { reference: reference.getSize(), size, dip, rectangle, expectedBytes: expected.length, actualBytes: actual.length };
        points = [];
        for (let y = Math.ceil(rectangle.y * sy); y < (rectangle.y + rectangle.height) * sy; y += 4) {
          for (let x = Math.ceil(rectangle.x * sx); x < (rectangle.x + rectangle.width) * sx; x += 4) {
            const at = (y * size.width + x) * 4;
            if (expected[at + 3] > 245 && Math.abs(expected[at] - 245) + Math.abs(expected[at + 1] - 240) + Math.abs(expected[at + 2] - 231) > 100)
              points.push({ x, y, color: [expected[at], expected[at + 1], expected[at + 2]] });
          }
        }
        if (points.length <= 100) fs.writeFileSync(path.join(output, 'visibility-initial.png'), image.toPNG());
        assert.ok(points.length > 100, 'reference contains enough opaque whale pixels: ' + points.length);
      }
      let matched = 0;
      for (const point of points) {
        let found = false;
        for (let dy = -2; dy <= 2 && !found; dy++) for (let dx = -2; dx <= 2; dx++) {
          const at = ((point.y + dy) * size.width + point.x + dx) * 4;
          if (point.color.every((value, channel) => Math.abs(actual[at + channel] - value) <= 22)) { found = true; break; }
        }
        if (found) matched++;
      }
      const ratio = matched / points.length;
      if (ratio < 0.85 && !firstMismatches.has(label)) {
        firstMismatches.add(label);
        const evidence = { label, ratio, at: new Date().toISOString(), native: sampledState, host: lastState, rendering: renderInfo() };
        results.firstMismatches.push(evidence);
        // Persist the untouched desktop sample before retrying or obtaining a
        // renderer screenshot, including failures that later recover by themselves.
        fs.writeFileSync(path.join(output, label + '-first-mismatch.png'), image.toPNG());
        fs.writeFileSync(path.join(output, label + '-first-mismatch.json'), JSON.stringify(evidence, null, 2));
      }
      if (ratio < 0.85 && Date.now() < deadline) { await delay(75); return pixels(label, save, deadline, obstructionDeadline, occludedMs); }
      if (save || ratio < 0.85) fs.writeFileSync(path.join(output, label + '.png'), image.toPNG());
      if (ratio < 0.85) {
        results.failureState = { host: lastState, overlay: window.getBounds(), rendering: renderInfo(), dom: await ev("({rect:document.querySelector('.dshwv-img').getBoundingClientRect().toJSON(),viewport:[innerWidth,innerHeight]})") };
        fs.writeFileSync(path.join(output, label + '-renderer.png'), (await window.webContents.capturePage()).toPNG());
      }
      assert.ok(ratio >= 0.85, label + ': actual desktop whale pixel match ' + ratio);
      return { ratio, samples: points.length, occludedMs, initiallyMismatched: firstMismatches.has(label), foreground: sampledState.foreground };
    }
    async function foregroundCycles(count) {
      for (let n = 0; n < count; n++) {
        await pixels('before-foreground-' + (n + 1));
        const epoch = lastState.visibilityRevision, remaps = renderInfo().visibility.remaps;
        await host.request('focus-away');
        await waitFor(() => lastState.foreground !== fixture.handle, 'fixture peer receives foreground');
        await delay(180);
        await host.request('focus-host');
        await waitFor(() => lastState.foreground === fixture.handle && window.isVisible() && !renderInfo().visibility.pending, 'fixture host receives foreground without remapping');
        await delay(250);
        const pixel = await pixels('foreground-' + (n + 1));
        assert.equal(lastState.visibilityRevision, epoch, 'focus-only transitions do not become lifecycle recovery epochs');
        assert.equal(renderInfo().visibility.remaps, remaps, 'foreground return never hides and remaps the overlay');
        results.foreground.push({ cycle: n + 1, ...pixel });
      }
    }
    await pixels('visibility-initial', true);
    if(compositionOnly){
      const remaps=renderInfo().visibility.remaps;results.composition=[];
      for(let n=0;n<12;n++){
        if(n%3===0){await ev("__whaleRenderTest.showCost(.003,{completionKind:'success',amount:.003,currency:'USD',costState:'observed',tokens:40,label:'本轮已观测消耗:'})");await delay(300);await ev('__whaleRenderTest.close()');}
        await delay(600);results.composition.push(await pixels('composition-'+n));
        assert.equal(renderInfo().visibility.remaps,remaps,'screen sampling never remaps');
      }
      await foregroundCycles(3);
      assert.equal(renderInfo().visibility.remaps, remaps, 'passive composition and foreground cycles never remap');
      if (process.env.WHALE_RENDER_MODE !== 'hardware') assert.equal(renderInfo().gpuStatus.hardwareAcceleration,false);
      const idle=renderInfo().presents;await delay(1000);assert.equal(renderInfo().presents,idle,'no idle repaint loop');
      results.composition.push(await pixels('composition-final-idle', true));
      assert.equal(errors.length, 0, JSON.stringify(errors));
      results.checks.push('Non-topmost owned HWNDs match production window policy','13 passive desktop samples without raising or capturePage between samples','Completion bubble closes and idle remain visible without remaps','3 foreground cycles preserve pixels without lifecycle epochs or remaps','No idle repaint loop; first mismatching screen samples are preserved before retry');
      results.rendering=renderInfo();results.ok=true;return;
    }
    for(let n=0;n<3;n++){
      const remaps=renderInfo().visibility.remaps;
      await dispatcher.dispatch('/api/show',{method:'POST'});
      await waitFor(()=>window.isVisible()&&!renderInfo().visibility.pending&&renderInfo().visibility.remaps>remaps,'explicit show recovery');
      results.explicitShow.push({cycle:n+1,...await pixels('explicit-show-'+(n+1))});
    }
    const initialEpoch = lastState.visibilityRevision;
    for (let n = 0; n < 100; n++) {
      // Every fourth cycle is shorter than the poll interval and intentionally
      // withheld from IPC; only the real native lifecycle epoch can detect it.
      const missedByPolling = n % 4 === 0;
      samplingPaused = missedByPolling; await waitFor(() => !busy, 'pending probe');
      const beforeEpoch = lastState.visibilityRevision;
      await native.request('minimize'); await delay(missedByPolling ? 25 : n % 10 === 1 ? 2000 : 160);
      const at = Date.now(); await native.request('restore');
      await delay(30); samplingPaused = false; await pollHost();
      await waitFor(() => lastState.visible && window.isVisible() && !renderInfo().visibility.pending && lastState.visibilityRevision > beforeEpoch, 'minimize restore lifecycle');
      await delay(70);
      const pixel = await pixels('minimize-' + (n + 1), n === 99);
      results.minimize.push({ cycle: n + 1, missedByPolling, recoveredMs: Date.now() - at, epoch: lastState.visibilityRevision, ...pixel });
      if ((n + 1) % 20 === 0) process.stdout.write(JSON.stringify({ stressProgress: 'minimize', completed: n + 1 }) + '\n');
    }
    assert.ok(lastState.visibilityRevision > initialEpoch, 'native lifecycle hook observed real owned HWND transitions');
    for (let n = 0; n < 50; n++) {
      const save = host.request('save', 15000).catch(error => ({ error: error.message }));
      // Capture both Chromium and Windows views: owner disabled while the
      // native common file dialog is open, then close only that fixture dialog.
      await waitFor(() => lastState.modal && !window.isVisible(), 'native Save As modal');
      // The host is disabled before the asynchronous file picker is visible.
      let cancel;
      await waitFor(async () => { cancel = await native.request('cancel'); return cancel.closed === 1; }, 'visible native Save As dialog to cancel', 5000);
      assert.equal((await save).cancelled, true);
      const at = Date.now();
      await waitFor(() => !lastState.modal && window.isVisible() && !renderInfo().visibility.pending, 'Save As cancel restore');
      await delay(70);
      const pixel = await pixels('save-cancel-' + (n + 1), n === 49);
      results.saveCancel.push({ cycle: n + 1, recoveredMs: Date.now() - at, epoch: lastState.visibilityRevision, ...pixel });
      if ((n + 1) % 10 === 0) process.stdout.write(JSON.stringify({ stressProgress: 'save-cancel', completed: n + 1 }) + '\n');
    }
    await foregroundCycles(5);
    await delay(400);
    const before = renderInfo(); await delay(2000); const after = renderInfo();
    assert.equal(after.visibility.remaps, before.visibility.remaps, 'idle heartbeats never remap');
    assert.equal(after.presents, before.presents, 'idle heartbeats never repaint');
    assert.equal(fs.existsSync(path.join(dataDir, 'CANCEL-ONLY-no-file-created.txt')), false);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    results.checks.push('100 real owned-window minimize/restore cycles including 25 missed IPC samples', '50 native Save As dialogs cancelled without creating a file', 'Actual screen pixels matched the whale after all 150 cycles', 'No repeated remap or forced repaint during idle heartbeats');
    results.checks.push('3 explicit show requests remap without a visibility transition','5 real foreground cycles preserve pixels without remapping','No topmost promotion or raising during passive screen sampling');
    results.rendering = renderInfo(); results.ok = true;
  } catch (error) {
    results.error = error.stack;
  } finally {
    clearInterval(polling);
    results.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'visibility-stress.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(output, 'visibility-stress-native.log'), native?.log() || '');
    fs.writeFileSync(path.join(output, 'visibility-stress-host.log'), host.log());
    await native?.stop('quit').catch(() => {}); await host.stop('close').catch(() => {});
    if (!results.ok) process.stderr.write(results.error + '\n');
    await setHost({ hostAlive: false });
  }
}
