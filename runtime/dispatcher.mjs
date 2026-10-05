import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ROOT, DATA_HOME, VERSION, readJson, writeJson } from './paths.mjs';
import { WhaleService } from './service.mjs';
import { SessionMonitor } from './session-monitor.mjs';
import { createWidgetHost } from '../lib/widget-host.mjs';
import { migrateData, stripRetiredModules } from './migration.mjs';
import { createFxService } from './fx.mjs';
import { MEDIA_POLICY } from '../lib/media-validation.mjs';
import { createInsightsService } from './insights.mjs';
import { pricingSchedule } from './pricing-schedule.mjs';
import { importWorkshop, exportWorkshop } from '../lib/workshop.mjs';

export const UI_ORIGIN = 'whale://widget';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif', '.mp3': 'audio/mpeg' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const jsonResult = (status, payload) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(payload)) });
const configurationFailure = error => {
  const message = error?.message;
  const safe = typeof message === 'string' && message.length <= 256 && /[\u4e00-\u9fff]/.test(message) && !/[\r\n]|https?:\/\/|[A-Z]:[\\/]/i.test(message);
  return jsonResult(400, { ok: false, error: safe ? message : '连接配置或余额预览失败，请检查请求规则' });
};

// Dispatch original resource handlers entirely in process; no HTTP listener exists.
export function createDispatcher({ dataDir = DATA_HOME, service = null, monitor = true, autoRefresh = true, fetchImpl, fxFetchImpl = fetchImpl, onStop = () => {}, onShow = () => {}, statusInfo = () => ({}) } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  migrateData(dataDir);
  const whale = service || new WhaleService({ dataDir, ...(fetchImpl ? { fetchImpl } : {}) });
  const fx = createFxService({ dataDir, ...(fxFetchImpl ? { fetchImpl: fxFetchImpl } : {}) });
  const insights = createInsightsService(whale.config);
  const displayModeFile = path.join(dataDir, 'display-mode.json');
  const displayMode = () => readJson(displayModeFile, {}).mode === 'subscription' ? 'subscription' : 'api';
  const routes = new Map(), effects = [];
  createWidgetHost(dataDir).apply({ whale, webServer: { register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path); }, tapIndex: () => () => {} }, effect: f => effects.push(f()) });
  const watcher = monitor ? new SessionMonitor(whale) : null;
  watcher?.start();
  const timer = autoRefresh ? setInterval(() => { if (displayMode() === 'api') whale.getBalance().catch(() => {}); }, 60000) : null;
  timer?.unref();
  if (autoRefresh) {
    if (displayMode() === 'api') whale.getBalance().catch(() => {});
    fx.start().catch(() => {});
  }
  const stateFile = path.join(dataDir, 'ui-state.json');
  const buildVersion = readJson(path.join(ROOT, '.codex-plugin', 'plugin.json'), {}).version || VERSION;
  const buildRevision = readJson(path.join(ROOT, 'package.json'), {}).codexBuild || '';
  let closing = false, closeJob = null;

  async function dispatch(route, { method = 'GET', body = null, headers = {} } = {}) {
    const result = await run(route, { method, body, headers });
    result.headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, ...result.headers };
    return result;
  }
  async function run(route, { method, body, headers }) {
    try {
      if (closing) return jsonResult(503, { ok: false, error: '挂件正在退出，请稍后重新打开' });
      if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || /[\\\x00-\x1f]/.test(route)) return jsonResult(400, { ok: false, error: '无效的本地操作' });
      const url = new URL(route, UI_ORIGIN);
      if (!['GET', 'POST', 'PUT', 'DELETE', 'HEAD'].includes(method)) return jsonResult(405, { ok: false });
      const bytes = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      if (bytes.length > 32 * 1024 * 1024) return jsonResult(413, { ok: false, error: '导入文件过大' });
      const parsed = () => JSON.parse(bytes.toString('utf8') || '{}');
      if (url.pathname === '/api/display-mode') {
        if (method === 'GET') return jsonResult(200, {ok:true,mode:displayMode()});
        if (method !== 'POST') return jsonResult(405, {ok:false});
        const input=parsed();
        if (!['api','subscription'].includes(input.mode)) return jsonResult(400,{ok:false,error:'请选择 API 或会员订阅额度模式'});
        writeJson(displayModeFile,{version:1,mode:input.mode});
        return jsonResult(200,{ok:true,mode:input.mode});
      }
      if (url.pathname === '/api/insights' && method === 'GET') return jsonResult(200, await insights.get());
      if (url.pathname === '/api/usage-scopes' && method === 'GET') return jsonResult(200, whale.usageScopes());
      if (url.pathname === '/api/account-notices') return method === 'GET' ? jsonResult(200, whale.accountNotices()) : jsonResult(405, {ok:false});
      if (url.pathname === '/api/account-notices/ack') return method === 'POST' ? jsonResult(200, whale.ackAccountNotices(parsed().ids)) : jsonResult(405, {ok:false});
      if (url.pathname === '/api/pricing' && method === 'GET') return jsonResult(200, {ok:true,...pricingSchedule(whale.config.resolve())});
      if (url.pathname === '/api/workshop/export' && method === 'GET') return jsonResult(200, exportWorkshop(dataDir));
      if (url.pathname === '/api/workshop/import' && method === 'POST') return jsonResult(200, importWorkshop(dataDir, parsed()));
      if (url.pathname === '/api/status' && method === 'GET') return jsonResult(200, { ok: true, version: VERSION, buildVersion, buildRevision, transport: 'local-ipc', webpage: false, provider: whale.config.publicInfo(), monitor: watcher?.status() || { watching: 0, activeTurns: 0 }, dataDir, ...statusInfo() });
      if (url.pathname === '/api/config') {
        if (method === 'GET') return jsonResult(200, { ok: true, ...whale.config.settingsInfo() });
        if (method === 'PUT') {
          try { whale.config.save(parsed()); return jsonResult(200, { ok: true, ...whale.config.settingsInfo() }); }
          catch (error) { return configurationFailure(error); }
        }
        return jsonResult(405, { ok: false });
      }
      if (url.pathname.startsWith('/api/connections/')) {
        if (method !== 'GET') return jsonResult(405, { ok: false });
        return jsonResult(200, { ok: true, connection: whale.config.readConnection(decodeURIComponent(url.pathname.slice('/api/connections/'.length))) });
      }
      if (url.pathname === '/api/balance-preview') {
        if (method !== 'POST') return jsonResult(405, { ok: false });
        if (bytes.length > 128 * 1024) return jsonResult(413, { ok: false, error: '连接规则过大' });
        try { return jsonResult(200, await whale.previewBalance(parsed().patch || {})); }
        catch (error) { return configurationFailure(error); }
      }
      if (url.pathname === '/api/fx/usd-cny') {
        if (method !== 'GET') return jsonResult(405, { ok: false });
        const manual = url.searchParams.get('refresh') === '1';
        try { return jsonResult(200, { ok: true, ...await fx.get(manual ? { force: true, reason: 'manual' } : {}) }); }
        catch (error) {
          const metadata = {};
          for (const key of ['cooldownRemainingMs', 'retryAfterMs']) if (Number.isFinite(error?.[key]) && error[key] >= 0) metadata[key] = error[key];
          for (const key of ['checkedAt', 'retrievedAt', 'nextDailyCheckAt']) if (error?.[key] === null || typeof error?.[key] === 'string' && Number.isFinite(Date.parse(error[key]))) metadata[key] = error[key];
          if (typeof error?.stale === 'boolean') metadata.stale = error.stale;
          return jsonResult(503, { ok: false, error: error?.message || '汇率暂时无法读取，请稍后重试', ...metadata });
        }
      }
      if (url.pathname === '/api/media-policy') {
        if (method !== 'GET') return jsonResult(405, { ok: false });
        return jsonResult(200, { ok: true, policy: MEDIA_POLICY });
      }
      if (url.pathname === '/api/ui-state') {
        if (method === 'GET') return jsonResult(200, { ok: true, values: readJson(stateFile, {}) });
        if (method === 'PUT') {
          const input = parsed(), values = {};
          if (!input || Array.isArray(input) || typeof input !== 'object') return jsonResult(400, { ok: false });
          for (const [key, value] of Object.entries(input)) if (/^dshw[-v]/.test(key) && typeof value === 'string' && value.length < 1024 * 1024) values[key] = value;
          writeJson(stateFile, values); return jsonResult(200, { ok: true });
        }
        return jsonResult(405, { ok: false });
      }
      if (url.pathname === '/api/show' && method === 'POST') { onShow(); return jsonResult(200, { ok: true, desktop: 'shown' }); }
      if (url.pathname === '/api/stop' && method === 'POST') { setTimeout(onStop, 100); return jsonResult(200, { ok: true }); }
      const uiFiles = { '/': 'widget.html', '/widget.html': 'widget.html', '/client.js': 'client.js', '/ui.css': 'ui.css', '/render.js': 'render.js', '/input.js': 'input.js', '/alpha-worker.js': 'alpha-worker.js', '/money.js': 'money.js', '/media-guard.js': 'media-guard.js', '/turn-notice.js': 'turn-notice.js', '/gesture.js':'gesture.js', '/audio-engine.js':'audio-engine.js', '/preferences-v3.js':'preferences-v3.js', '/insights.js':'insights.js', '/workshop.js':'workshop.js', '/usage-history.js':'usage-history.js', '/account-notices.js':'account-notices.js' };
      uiFiles['/account-view.js']='account-view.js';
      uiFiles['/shape.js']='shape.js';
      uiFiles['/dashboard.js']='dashboard.js';
      uiFiles['/connection-settings.js']='connection-settings.js';
      uiFiles['/balance-view.js']='balance-view.js';
      let file;
      if (Object.hasOwn(uiFiles, url.pathname)) file = path.join(ROOT, 'desktop', 'ui', uiFiles[url.pathname]);
      else if (url.pathname.startsWith('/assets/')) {
        const name = decodeURIComponent(url.pathname.slice(8));
        if (!/^[A-Za-z0-9_.-]+$/.test(name) || !MIME[path.extname(name)]) return jsonResult(404, { ok: false });
        file = path.join(ROOT, 'assets', name);
      }
      if (file) return ['GET', 'HEAD'].includes(method) ? { status: 200, headers: { 'content-type': MIME[path.extname(file)] }, body: method === 'HEAD' ? Buffer.alloc(0) : fs.readFileSync(file) } : jsonResult(405, { ok: false });
      const handler = routes.get(url.pathname);
      if (!handler) return jsonResult(404, { ok: false, error: '未找到此功能' });
      if (/(?:role-pin|role-delete|bubble-img-upload)\.json$/.test(url.pathname) && !['POST', 'PUT'].includes(method)) return jsonResult(405, { ok: false });
      if (url.pathname === '/dsh-whale/bubble.json' && ['POST', 'PUT'].includes(method)) body = Buffer.from(JSON.stringify(stripRetiredModules(parsed())));
      const requestBytes = Buffer.isBuffer(body) ? body : bytes;
      const req = Readable.from(requestBytes.length ? [requestBytes] : []);
      Object.assign(req, { url: route, method, headers: { 'content-type': 'application/json', ...headers } });
      return await new Promise((resolve, reject) => {
        const chunks = [], responseHeaders = {};
        const res = new Writable({ write(chunk, _enc, done) { chunks.push(Buffer.from(chunk)); done(); } });
        res.statusCode = 200; res.headersSent = false;
        res.setHeader = (name, value) => { responseHeaders[name.toLowerCase()] = String(value); };
        res.writeHead = (status, h = {}) => { res.statusCode = status; res.headersSent = true; for (const [k, v] of Object.entries(h)) res.setHeader(k, v); return res; };
        res.on('finish', () => resolve({ status: res.statusCode, headers: responseHeaders, body: Buffer.concat(chunks) }));
        req.on('error', reject); res.on('error', reject);
        Promise.resolve(handler(req, res)).catch(reject);
      });
    } catch { return jsonResult(400, { ok: false, error: '操作失败，请检查设置或导入文件' }); }
  }
  function close() {
    if (closeJob) return closeJob;
    closing = true; clearInterval(timer);
    closeJob = (async () => {
      const failures = [];
      insights.close();
      try { await fx.close(); } catch (error) { failures.push(error); }
      try { await watcher?.stop({ timeoutMs: 1200 }); } catch (error) { failures.push(error); }
      try { await whale.close?.({ timeoutMs: 3000 }); } catch (error) { failures.push(error); }
      for (const effect of effects.splice(0)) {
        try { if (typeof effect === 'function') await effect(); else await effect?.close?.(); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, '部分挂件组件未能正常关闭');
    })();
    return closeJob;
  }
  return { dispatch, whale, watcher, close };
}
