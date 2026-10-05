import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigStore } from './config.mjs';
import { BalanceProvider } from './providers.mjs';
import { UsageLedger, usageDefaults, normalizeTurnCost } from './ledger.mjs';
import { readJson, writeJson } from './paths.mjs';
import { decimalDifference, decimalAdd, decimalMultiply } from './money-precision.mjs';
import { accountNoticeScope } from './account-notices.mjs';
import { TurnJournal, safeSample, safeTurn, safeUsage } from './turn-journal.mjs';

const hasMeter = sample => /^[a-f0-9]{64}$/.test(sample?.meterId || '');
const observable = sample => sample?.canObserve !== false && !['unconfirmed', 'unsupported'].includes(sample?.balanceStatus);
const sameMeter = (a, b) => observable(a) && observable(b) &&
  (hasMeter(a) || hasMeter(b) ? hasMeter(a) && hasMeter(b) && a.meterId === b.meterId && a.counter === b.counter : true);

export class WhaleService {
  constructor(options = {}) {
    this.config = options.config || new ConfigStore(options);
    this.provider = options.provider || new BalanceProvider(options);
    this.previewProviderFactory = options.previewProviderFactory || (() => new BalanceProvider({ fetchImpl: this.provider.fetch, timeoutMs: this.provider.timeoutMs }));
    this.ledger = new UsageLedger(this.config.dataDir);
    this.cache = new Map(); this.inFlight = new Map(); this.turns = new Map(); this.settling = new Set(); this.settlingContexts = new Map();
    this.balanceSequence = 0; this.latestSamples = new Map(); this.latestQueries = new Map();
    this.lastFile = path.join(this.config.dataDir, 'last-turn.json');
    this.usageSettingsFile = path.join(this.config.dataDir, 'usage-settings.json');
    this.activeScope = null;
    this.journal = new TurnJournal(this.config.dataDir);
    this.jobs = new Set(); this.noticeTimers = new Map(); this.latestStarts = new Map(); this.pendingCosts = new Map();
    this.noticeDelayMs = options.noticeDelayMs ?? 2500; this.pendingCostMs = options.pendingCostMs ?? 30000;
    this.closed = false; this.restored = false; this.recoveryActive = new Set();
    this.cancelledOutcomes = new Set();
    this.recoveryError = '';
  }
  scope(c, currency) { return c.accountId + '-' + currency; }
  balanceIdentity(c) {
    const s = c.setting || {};
    // Prices and UI preferences do not change the API meter. Its adapter and
    // conversion settings do; never compare readings expressed on two scales.
    const parts = [c.accountId, s.provider, s.currency, s.balancePath, s.balanceField,
      s.usedField, s.balanceScale, s.billingUsageDivisor, s.quotaPerUnit];
    if (c.balanceConnection || c.connectionId || c.authHeaders) parts.push(c.connectionId || '', c.balanceConnection || null,
      createHash('sha256').update(JSON.stringify(c.authHeaders || {})).digest('hex'));
    return JSON.stringify(parts);
  }
  observationIdentity(c, payload) {
    const configurationKey = createHash('sha256').update(this.balanceIdentity(c)).digest('hex');
    return { configurationKey, meterKey: hasMeter(payload)
      ? createHash('sha256').update(configurationKey + ':' + payload.meterId).digest('hex') : configurationKey,
      ...(hasMeter(payload) ? { meterVersion: 2 } : {}) };
  }
  async previewBalance(patch) {
    const context = this.config.resolveDraft(patch);
    const requestedId = patch?.connectionUpdate?.id || patch?.selectedConnection;
    if (requestedId && context.connectionId !== requestedId) throw new Error('所编辑连接未匹配当前来源；请核对跟随条件，或选择固定连接并填写地址');
    // A separate adapter instance keeps draft detection out of live caches.
    // This method deliberately never calls getBalance or any ledger method.
    const result = await this.previewProviderFactory().balance(context);
    const raw = result.preview || result;
    const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    return { ok: result.ok !== false, balanceStatus: result.balanceStatus || 'finite',
      balanceLabel: result.balanceLabel || 'API 余额', currency: result.currency,
      canObserve: result.canObserve === true, connectionId: context.connectionId || '',
      connectionInfo: context.connectionInfo || null,
      preview: { balance: numeric(raw.balance ?? raw.totalBalance), used: numeric(raw.used ?? raw.totalUsed),
        currency: raw.currency || result.currency, scope: raw.scope || result.balanceScope, adapter: raw.adapter || result.adapter },
      unlimited: result.unlimited === true };
  }
  accountActivityCount(c) {
    const identity = this.balanceIdentity(c);
    return [...this.turns.values(), ...this.settlingContexts.values()].filter(turn => !turn.isSubagent && this.balanceIdentity(turn.context) === identity).length;
  }
  accountNoticeContext() {
    const context = this.config.resolve(), identity = this.balanceIdentity(context);
    const query = this.latestQueries.get(identity), configurationKey = createHash('sha256').update(identity).digest('hex');
    let meterKey = this.observationIdentity(context, query?.payload).meterKey;
    let currency = query?.payload.currency || context.setting.currency;
    const eligible = !query || observable(query.payload);
    if (!query) {
      // The adapter may return USD even when a display preference is CNY.
      // Restore the last actual meter currency without requiring a network call.
      const matches = this.ledger.scopes().filter(scope => scope.startsWith(context.accountId + '-'))
        .map(scope => ({ scope, ledger: this.ledger.load(scope) }))
        .filter(entry => entry.ledger.lastObservation?.configurationKey === configurationKey || entry.ledger.accountNotices?.meterKey === configurationKey)
        .sort((a, b) => (b.ledger.lastObservation?.at || 0) - (a.ledger.lastObservation?.at || 0));
      currency = matches[0]?.scope.slice(-3) || context.setting.currency;
      meterKey = matches[0]?.ledger.accountNotices?.meterKey || meterKey;
    }
    const scope = this.scope(context, currency);
    return { scope, meterKey, eligible, publicScope: accountNoticeScope(scope, meterKey) };
  }
  accountNotices() {
    const { scope, meterKey, eligible, publicScope } = this.accountNoticeContext();
    const notice = this.closed || !eligible ? null : this.ledger.accountNotice(scope, meterKey);
    return { ok: true, scope: publicScope, notices: notice ? [notice] : [] };
  }
  ackAccountNotices(ids) {
    if (this.closed) throw new Error('挂件正在退出，请稍后重试账户消费通知确认');
    const { scope, meterKey, eligible, publicScope } = this.accountNoticeContext();
    if (!eligible && ids?.length) throw new Error('当前连接的金额口径尚未确认');
    return { ok: true, scope: publicScope, acknowledged: this.ledger.acknowledgeNotices(scope, meterKey, ids) };
  }
  isCurrentBalanceContext(c) {
    try { return this.balanceIdentity(c) === this.balanceIdentity(this.config.resolve()); }
    catch { return false; }
  }
  newestBalanceSample(c, currency) {
    const query = this.latestQueries.get(this.balanceIdentity(c));
    const scoped = this.latestSamples.get(this.scope(c, currency));
    return !scoped || query && query.sequence > scoped.sequence ? query : scoped;
  }
  balanceCache(c, cacheKey) {
    const cached = this.cache.get(cacheKey);
    if (!cached) return null;
    const latest = this.newestBalanceSample(c, cached.payload.currency);
    if (!latest || latest.sequence <= (cached.sequence || 0)) return cached;
    return latest.identity === this.balanceIdentity(c) ? latest : null;
  }
  stoppedBalance() { return { ok: false, code: 'STOPPED', error: '挂件正在退出，余额将在下次启动时刷新' }; }
  async getBalance({ force = false, context = null } = {}) {
    if (this.closed) return this.stoppedBalance();
    let c;
    try { c = context || this.config.resolve(); }
    catch (error) { return { ok: false, code: 'CONFIG', error: error.message }; }
    const identity = this.balanceIdentity(c), cacheKey = identity + ':' + JSON.stringify(c.setting), cached = this.balanceCache(c, cacheKey);
    // Each caller checks its own context, even when it joins a round's request.
    // A UI request made before an account/currency switch returns current data.
    const deliver = value => {
      if (this.closed) return this.stoppedBalance();
      if (!context) {
        if (!this.isCurrentBalanceContext(c)) return this.getBalance();
        if (value.superseded) {
          const latest = this.newestBalanceSample(c, value.currency);
          return latest?.identity === identity ? this.decorate(c, latest.payload) : this.getBalance({ force: true });
        }
      }
      return value;
    };
    if (!force && cached && Date.now() - cached.at < Math.min(c.setting.refreshSeconds, 25) * 1000) return deliver(this.decorate(c, cached.payload));
    if (this.inFlight.has(cacheKey)) return deliver(await this.inFlight.get(cacheKey));
    const sequence = ++this.balanceSequence;
    const activityAtStart = this.accountActivityCount(c);
    const request = (async () => {
      try {
        const payload = await this.provider.balance(c);
        if (this.closed) return this.stoppedBalance();
        const scope = this.scope(c, payload.currency);
        const latest = this.newestBalanceSample(c, payload.currency);
        if (latest && (sequence < latest.sequence || latest.identity !== identity && !this.isCurrentBalanceContext(c))) {
          // Keep the actual request's sample for a round's interval; replacing
          // its end with a newer sample could include another task's debit.
          // UI callers receive the latest compatible sample in deliver().
          return { ...this.decorate(c, payload, { activate: false }), superseded: true,
            ...(latest.identity !== identity ? { stale: true } : {}) };
        }
        const meter = this.observationIdentity(c, payload);
        if (!payload.stale && payload.ok !== false && observable(payload)) this.ledger.observe(scope, { ...payload, ...meter,
          concurrentCount: Math.max(activityAtStart, this.accountActivityCount(c)) });
        const sample = { at: Date.now(), sequence, identity, payload };
        this.latestSamples.set(scope, sample);
        this.latestQueries.set(identity, sample);
        this.cache.set(cacheKey, sample);
        return this.decorate(c, payload);
      } catch (error) {
        if (this.closed) return this.stoppedBalance();
        const fallback = this.balanceCache(c, cacheKey);
        if (error.transient && fallback) return { ...this.decorate(c, fallback.payload), stale: true, error: error.message };
        return { ok: false, code: error.code || 'ERROR', error: error.code ? error.message : '余额服务暂时不可用', providerName: c.providerName, dashboardUrl: c.dashboardUrl, baseUrl: c.baseUrl, todayUsage: this.ledger.records(this.scope(c, c.setting.currency)).today.total, currency: c.setting.currency, usageMode: 'ledger' };
      } finally { this.inFlight.delete(cacheKey); }
    })();
    this.inFlight.set(cacheKey, request);
    return deliver(await request);
  }
  decorate(c, payload, { activate = true } = {}) {
    const scope = this.scope(c, payload.currency);
    const records = this.ledger.records(scope);
    if (activate && this.isCurrentBalanceContext(c)) this.activeScope = scope;
    return { ...payload, connectionInfo: c.connectionInfo || null, todayUsage: records.today.total, observedSince: records.today.since, usageMode: 'ledger', usageNote: records.note };
  }
  usageScopes() {
    const c = this.config.resolve();
    return { ok: true, scopes: this.ledger.scopes().map(scope => ({ scope, currency: scope.slice(-3), current: scope.startsWith(c.accountId + '-'), label: '匿名账户 ' + scope.slice(0, 8) + ' · ' + scope.slice(-3) })) };
  }
  usageRecords({ scope: requestedScope = null } = {}) {
    const c = this.config.resolve();
    const scope = requestedScope || (this.activeScope?.startsWith(c.accountId + '-') ? this.activeScope : this.scope(c, c.setting.currency));
    if (requestedScope && !this.ledger.scopes().includes(requestedScope)) throw new Error('历史账本不存在');
    return { ...this.ledger.records(scope), currency: scope.slice(-3), settings: this.readUsageSettings() };
  }
  readUsageSettings() {
    const saved = readJson(this.usageSettingsFile, {});
    const defaults = usageDefaults();
    defaults.alert.lines.find(line => line.type === 'link').url = this.config.resolve().dashboardUrl;
    for (const key of Object.keys(defaults)) defaults[key] = { ...defaults[key], ...saved[key] };
    delete defaults.outcomeNotice;
    return defaults;
  }
  writeUsageSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('用量设置格式无效');
    const result = this.readUsageSettings();
    for (const key of Object.keys(result)) if (patch[key] && typeof patch[key] === 'object') result[key] = { ...result[key], ...patch[key] };
    for (const [key, field] of [['alert', 'below'], ['budget', 'amount']]) if (!Number.isFinite(Number(result[key][field])) || Number(result[key][field]) < 0) throw new Error('提醒阈值须为非负数字');
    writeJson(this.usageSettingsFile, result);
    return { ok: true, settings: result };
  }
  lastTurn() {
    const last = readJson(this.lastFile, { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null });
    const c = this.config.resolve();
    if (last.accountId && last.accountId !== c.accountId) return { ok: true, seq: last.seq, turn: null, amount: null, tokens: null, ts: null };
    return normalizeTurnCost(last);
  }
  beginTurn(meta) {
    if (this.closed || this.settling.has(meta.id)) return;
    if (this.turns.has(meta.id)) { this.updateTurn(meta); return; }
    let context;
    try { context = this.config.resolve(); } catch { return; }
    if (!meta.isSubagent) {
      const session = meta.sessionId || meta.id;
      this.latestStarts.set(session, meta.id);
      const waiting = this.noticeTimers.get(session);
      if (waiting) { clearTimeout(waiting.timer); this.noticeTimers.delete(session); }
    }
    const roots = [...this.turns.values()].filter(active => !active.isSubagent);
    const entry = { ...safeTurn(meta), context, canQuery: true, concurrent: !meta.isSubagent && roots.length > 0 };
    if (!meta.isSubagent) for (const active of roots) active.concurrent = true;
    // Subagents contribute tokens, not overlapping API-balance intervals.
    entry.start = meta.isSubagent ? null : this.getBalance({ force: true, context });
    this.turns.set(meta.id, entry);
    this.persistTurn(entry, 'active');
    if (entry.start) entry.start.then(sample => {
      if (this.closed) return;
      entry.startSample = safeSample(sample);
      if (this.turns.get(meta.id) === entry) this.persistTurn(entry, 'active');
    }).catch(() => {});
  }
  updateTurn(meta) {
    const turn = this.turns.get(meta.id);
    if (!turn) return;
    turn.byModel = safeUsage(meta.byModel || turn.byModel);
    if (meta.rootTurnId) turn.rootTurnId = meta.rootTurnId;
    if (meta.ts) turn.ts = meta.ts;
    turn.failureKind = meta.failureKind === 'high-demand' ? 'high-demand' : null;
    this.persistTurn(turn, 'active');
  }
  persistTurn(turn, stage, meta = turn, extra = {}) {
    if (this.closed) return;
    this.journal.put({ stage, accountId: turn.context.accountId, currency: turn.context.setting.currency,
      pricing: turn.context.setting.models, meta: { ...meta, partial: !!turn.partial }, start: turn.startSample,
      concurrent: !!turn.concurrent, ...extra });
  }
  prepareRecovery() {
    if (this.restored) return [...this.recoveryActive];
    this.restored = true;
    let current;
    try { current = this.config.resolve(); } catch {}
    const waiting = [];
    for (const saved of this.journal.list()) {
      const matches = current?.accountId === saved.accountId && current.setting.currency === saved.currency;
      const context = matches ? { ...current, setting: { ...current.setting, models: saved.pricing } } :
        { accountId: saved.accountId, model: '', setting: { currency: saved.currency, models: saved.pricing } };
      const turn = { ...saved.meta, context, canQuery: matches, startSample: saved.start,
        start: Promise.resolve(saved.start || { ok: false }), concurrent: saved.concurrent };
      if (saved.stage === 'pending-cost') {
        // A restart cannot turn a later shared-key debit into an exact old bill.
        try { if (saved.scope) this.markCostUnknown(saved.scope, saved.meta.id); this.journal.remove(saved.meta.id); }
        catch { this.recoveryError = '一条待核对记录暂不可读；已保留恢复记录，其余功能仍可使用。'; }
        continue;
      }
      this.turns.set(saved.meta.id, turn);
      if (saved.stage === 'settling') waiting.push(saved.meta);
      else this.recoveryActive.add(saved.meta.id);
    }
    for (const meta of waiting) this.finishTurn({ ...meta, historical: true, notify: false, statusNotify: false }).catch(() => {});
    return [...this.recoveryActive];
  }
  finishMissingRecovery(seenIds = []) {
    const seen = new Set(seenIds);
    for (const id of this.recoveryActive) {
      const turn = this.turns.get(id);
      if (!seen.has(id) && turn) this.finishTurn({ ...safeTurn(turn), outcome: 'interrupted', historical: true,
        notify: false, statusNotify: false, ts: turn.ts || Date.now() }).catch(() => {});
    }
    this.recoveryActive.clear();
  }
  finishTurn(meta) {
    if (this.closed) return Promise.resolve();
    if (meta.statusCorrection === true && meta.outcome === 'aborted') { this.cancelOutcomeNotice(meta); return Promise.resolve(); }
    const turn = this.turns.get(meta.id);
    if (!turn) return Promise.resolve();
    this.turns.delete(meta.id);
    this.settling.add(meta.id); this.settlingContexts.set(meta.id, turn);
    this.persistTurn(turn, 'settling', meta);
    const job = this.settleTurn(meta, turn).finally(() => { this.settling.delete(meta.id); this.settlingContexts.delete(meta.id); this.jobs.delete(job); });
    this.jobs.add(job); return job;
  }
  async settleTurn(meta, turn) {
    const context = turn.context;
    let outcome = meta.outcome || 'completed';
    const ownUsage = safeUsage(meta.byModel || turn.byModel);
    const base = { id: meta.id, sessionId: meta.sessionId || turn.sessionId, turnId: meta.turnId,
      rootTurnId: meta.rootTurnId || turn.rootTurnId || meta.turnId, ts: meta.ts || Date.now(), outcome,
      partial: !!turn.partial, historical: !!meta.historical, accountId: context.accountId,
      failureKind: outcome === 'failed' && meta.failureKind === 'high-demand' ? 'high-demand' : null };
    if (turn.isSubagent || meta.isSubagent) {
      const estimate = !turn.partial ? estimateUsage(ownUsage, context.setting, base.ts) : null;
      const scope = this.scope(context, context.setting.currency);
      this.ledger.append(scope, { ...base, isSubagent: true, byModel: ownUsage,
        model: (Object.keys(ownUsage).join(' + ') || context.model || '未知模型') + ' · 子任务用量',
        cost: estimate, costState: estimate === null ? 'unknown' : 'estimated', tokens: tokenTotal(ownUsage),
        source: estimate === null ? 'subagent-token-only' : 'subagent-pricing-estimate' });
      this.reviseRootEstimate(scope, base.rootTurnId);
      this.journal.remove(meta.id);
      return;
    }
    const start = await turn.start || { ok: false };
    if (this.closed) return;
    turn.startSample = safeSample(start); this.persistTurn(turn, 'settling', meta);
    const end = turn.canQuery === false ? { ok: false } : await this.getBalance({ force: true, context });
    if (this.closed) return;
    let amount = null, source = 'token-only', costState = 'unknown', note = '没有可用的起止余额或模型价格，金额未知。';
    let currency = end.currency || start.currency || context.setting.currency;
    const children = this.ledger.load(this.scope(context, context.setting.currency)).events.filter(e => e.isSubagent && e.rootTurnId === base.rootTurnId);
    const combined = mergeUsage([ownUsage, ...children.map(e => e.byModel || {})]);
    const estimate = estimateUsage(combined, context.setting, meta.ts || Date.now());
    if (estimate !== null && !turn.partial && !children.some(e => e.partial)) {
      amount = estimate; currency = context.setting.currency; source = 'configured-pricing-estimate'; costState = 'estimated';
      note = '根据 Codex 记录的 token 数量与手动配置价格估算，包含本主轮已记录的子任务用量；服务商折扣、缓存策略和账单延迟可能造成差异。';
    }
    // Account observations have no request attribution, even when no local
    // parallel turn is visible (another device may use the same API key).
    let accountIntervalAmount = null;
    if (!meta.historical && outcome !== 'interrupted' && start.ok && end.ok && !start.stale && !end.stale && start.accountId === end.accountId && start.currency === end.currency && sameMeter(start, end)) {
      if (Number.isFinite(start.totalUsed) && Number.isFinite(end.totalUsed) && end.totalUsed >= start.totalUsed) accountIntervalAmount = decimalDifference(end.totalUsed, start.totalUsed);
      else if (start.totalUsed == null && end.totalUsed == null && Number.isFinite(start.totalBalance) && Number.isFinite(end.totalBalance) && end.totalBalance <= start.totalBalance) accountIntervalAmount = decimalDifference(start.totalBalance, end.totalBalance);
    }
    if (amount === null) note = '没有可验证的本轮账单或完整 token 价格估算，本轮费用未知；账户期间扣费可能来自其他对话、设备或延迟入账，不能归给本轮。';
    if (meta.historical && amount === null) note = '已恢复任务状态及可用 token 记录；任务结束时没有可靠余额采样，不能把停机期间其他扣费归入本轮。';
    const label = source === 'configured-pricing-estimate' ? '本轮消耗（估算）:' : '本轮费用未知:';
    const tokens = tokenTotal(combined);
    if(this.cancelledOutcomes.has(meta.id)){outcome='aborted';base.outcome='aborted';base.failureKind=null;}
    const completionKind = outcome === 'completed' ? 'success' : ['failed','interrupted','superseded'].includes(outcome) ? 'failed' : outcome === 'aborted' ? 'cancelled' : null;
    const event = { ...base, ok: true, turn: meta.turnId || meta.id, amount, cost: amount, costState, tokens, currency, source, label, note,
      accountIntervalAmount, accountIntervalCurrency: end.currency || start.currency || context.setting.currency,
      conversationRef: createHash('sha256').update(String(base.sessionId || base.id)).digest('hex').slice(0, 8),
      completionKind, notify: !meta.historical && !!completionKind && (outcome === 'completed' ? meta.notify !== false : meta.statusNotify === true || outcome === 'aborted' && this.cancelledOutcomes.has(meta.id)),
      concurrent: !!turn.concurrent, childTurns: children.length, ownByModel: ownUsage, byModel: combined,
      pricing: context.setting.models };
    const scope = this.scope(context, currency);
    const models = Object.keys(combined).join(' + ') || context.model || '未知模型';
    const model = source === 'shared-key-interval' ? models + ' · 期间扣费（同密钥合计）' : source === 'token-only' ? models + ' · 仅 token 记录' : models;
    if (!this.ledger.append(scope, { ...event, model })) {
      // A crash can happen between appending a pending row and changing the
      // journal stage. Recovery must not leave that durable row pending forever.
      if (meta.historical) this.markCostUnknown(scope, meta.id);
      this.journal.remove(meta.id); return;
    }
    if (costState === 'pending') {
      const dueAt = Date.now() + this.pendingCostMs;
      this.persistTurn(turn, 'pending-cost', meta, { dueAt, scope });
      this.pendingCosts.set(meta.id, { scope, context, dueAt, rechecked: false }); this.scheduleCostCheck();
    } else this.journal.remove(meta.id);
    this.queueNotice(scope, event);
  }
  reviseRootEstimate(scope, rootTurnId) {
    const events = this.ledger.load(scope).events;
    const root = events.find(e => !e.isSubagent && e.turnId === rootTurnId && e.ownByModel);
    if (!root) return;
    const children = events.filter(e => e.isSubagent && e.rootTurnId === rootTurnId);
    const combined = mergeUsage([root.ownByModel, ...children.map(e => e.byModel || {})]);
    const patch = { tokens: tokenTotal(combined), byModel: combined, childTurns: children.length };
    if (root.pricing && ['configured-pricing-estimate', 'token-only'].includes(root.source)) {
      const complete = !root.partial && !children.some(e => e.partial);
      const estimate = complete ? estimateUsage(combined, { models: root.pricing }, root.ts) : null;
      if (estimate !== null && ['configured-pricing-estimate', 'token-only'].includes(root.source)) {
        Object.assign(patch, { cost: estimate, amount: estimate, costState: 'estimated', source: 'configured-pricing-estimate',
          model: Object.keys(combined).join(' + '), label: '上一轮消耗（估算）:',
          note: '根据完整已记录主子任务 token 和配置价格修订的估算；修订不会再次播放提示音。' });
      } else if (root.source === 'configured-pricing-estimate') {
        Object.assign(patch, { cost: null, amount: null, costState: 'unknown', source: 'token-only',
          model: Object.keys(combined).join(' + ') + ' · 仅 token 记录', label: '上一轮 token 用量:',
          note: '后来收到的子任务用量不完整或缺少模型价格，不能把原先局部估算当作整个主轮金额。' });
      }
    }
    this.reviseRecord(scope, root.id, patch);
  }
  reviseRecord(scope, id, patch) {
    const event = this.ledger.revise(scope, id, patch);
    if (!event) return;
    const last = readJson(this.lastFile, { seq: 0 });
    if (last.id === id) writeJson(this.lastFile, { ...last, ...event, seq: last.seq, amount: event.cost });
  }
  markCostUnknown(scope, id) {
    const event = this.ledger.find(scope, { id });
    if (event?.costState === 'pending') this.reviseRecord(scope, id, { cost: null, amount: null, costState: 'unknown',
      note: '暂无可验证的逐请求账单，无法确定本轮金额；余额及每日合计仍随服务商最新返回值更新。' });
  }
  scheduleCostCheck() {
    if (this.costTimer || this.closed || !this.pendingCosts.size) return;
    const soonest = Math.min(...[...this.pendingCosts.values()].map(item => item.rechecked ? item.dueAt : Math.min(item.dueAt, Date.now() + 1500)));
    this.costTimer = setTimeout(() => {
      this.costTimer = null;
      for (const [id, item] of this.pendingCosts) {
        try {
          if (!item.rechecked) { item.rechecked = true; this.getBalance({ force: true, context: item.context }).catch(() => {}); }
          if (Date.now() >= item.dueAt) {
            this.markCostUnknown(item.scope, id); this.pendingCosts.delete(id); this.journal.remove(id);
          }
        } catch {
          this.recoveryError = '一条待核对费用暂时无法更新，恢复记录已保留。';
          item.dueAt = Date.now() + 60000; item.rechecked = true;
        }
      }
      this.scheduleCostCheck();
    }, Math.max(1, soonest - Date.now())); this.costTimer.unref();
  }
  cancelOutcomeNotice(meta) {
    this.cancelledOutcomes.add(meta.id);
    if(this.cancelledOutcomes.size>256)this.cancelledOutcomes.delete(this.cancelledOutcomes.values().next().value);
    const session=meta.sessionId||meta.id, waiting=this.noticeTimers.get(session);
    if(waiting?.id===meta.id){clearTimeout(waiting.timer);this.noticeTimers.delete(session);}
    let c;try{c=this.config.resolve();}catch{return;}
    const patch={outcome:'aborted',completionKind:'cancelled',failureKind:null,notify:!meta.historical&&!meta.isSubagent};
    for(const scope of new Set([this.activeScope,this.scope(c,c.setting.currency)])){
      if(!scope?.startsWith(c.accountId+'-'))continue;
      const found=this.ledger.find(scope,{id:meta.id});
      if(found?.outcome==='failed'){this.ledger.revise(scope,meta.id,patch);this.queueNotice(scope,{...found,...patch});}
    }
    const last=readJson(this.lastFile,{});
    if(last.id===meta.id&&last.outcome==='failed')writeJson(this.lastFile,{...last,...patch});
  }
  queueNotice(scope, event) {
    if (!event.notify || this.closed) return;
    if (['success','cancelled'].includes(event.completionKind) || event.completionKind === 'failed' && event.failureKind !== 'high-demand') { this.publishNotice(scope, event.id); return; }
    const session = event.sessionId || event.id;
    if (this.latestStarts.get(session) && this.latestStarts.get(session) !== event.id) return;
    const old = this.noticeTimers.get(session); if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => {
      this.noticeTimers.delete(session);
      if (!this.closed && (!this.latestStarts.get(session) || this.latestStarts.get(session) === event.id)) {
        try { this.publishNotice(scope, event.id); }
        catch { this.recoveryError = '任务状态提示暂不可写；用量记录与恢复文件仍保留。'; }
      }
    }, this.noticeDelayMs); timer.unref();
    this.noticeTimers.set(session, { timer, id: event.id });
  }
  publishNotice(scope, id) {
    const event = this.ledger.find(scope, { id });
    if (!event || event.noticePublished || !event.notify || this.closed) return;
    let config;
    try { config = this.config.resolve(); } catch { return; }
    if (config.accountId !== event.accountId) return;
    if (!['success','cancelled','failed'].includes(event.completionKind)) return;
    const seq = Number(readJson(this.lastFile, { seq: 0 }).seq || 0) + 1;
    this.ledger.revise(scope, id, { noticePublished: true });
    writeJson(this.lastFile, { ...event, seq, amount: event.cost, notificationAt: Date.now() });
  }
  async close({ timeoutMs = 3000 } = {}) {
    this.closed = true; clearTimeout(this.costTimer); this.costTimer = null;
    for (const item of this.noticeTimers.values()) clearTimeout(item.timer);
    this.noticeTimers.clear();
    if (!this.jobs.size) return;
    let timer;
    await Promise.race([Promise.allSettled([...this.jobs]), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timer);
    // Unfinished settlements were journaled before their first network await.
  }
}

const tokenTotal = usage => Object.values(usage).reduce((n, u) => n + (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0), 0);
function mergeUsage(parts) {
  const result = {};
  for (const part of parts) for (const [model, counts] of Object.entries(part)) {
    const total = Object.hasOwn(result, model) ? result[model] : (result[model] = {});
    for (const [key, value] of Object.entries(counts)) total[key] = (total[key] || 0) + (Number(value) || 0);
  }
  return result;
}

export function estimateUsage(byModel, settings, ts) {
  if (!Object.keys(byModel).length || tokenTotal(byModel) <= 0) return null;
  let total = '0';
  for (const [model, u] of Object.entries(byModel)) {
    const p = Object.hasOwn(settings.models || {}, model) ? settings.models[model] : null;
    if (!p) return null;
    const cached = Math.min(u.input_tokens, u.cached_input_tokens);
    const write = Math.min(Math.max(0, u.input_tokens - cached), u.cache_write_input_tokens || 0);
    const miss = Math.max(0, u.input_tokens - cached - write);
    // Reasoning tokens are already a subset of output_tokens in Codex events.
    for (const [count, price] of [[miss, p.input], [write, p.cacheWrite ?? p.input], [cached, p.cachedInput], [u.output_tokens, p.output]]) {
      if (!Number.isFinite(count) || !Number.isFinite(price) || count < 0 || price < 0) return null;
      total = decimalAdd(total, decimalMultiply(decimalMultiply(count, price), '0.000001'));
    }
  }
  return Number.isFinite(Number(total)) ? Number(total) : null;
}
