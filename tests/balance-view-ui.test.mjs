import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const box = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(new URL('../desktop/ui/balance-view.js', import.meta.url), 'utf8'), box);
const view = box.module.exports;
const widget = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8');
const refreshSource = widget.slice(widget.indexOf('    function refresh(manual) {'), widget.indexOf('    var soundOn = true;'));

test('monetary states retain their labels and never render unknown money as zero', () => {
  for (const [status, message] of [['unconfirmed', '金额口径待确认'], ['unsupported', '未提供余额接口'], ['unlimited', '密钥不限额']]) {
    const payload = { ok: true, balanceStatus: status, totalBalance: null, todayUsage: 99, canObserve: false };
    assert.equal(view.amount(payload, () => { throw Error('must not format'); }), message);
    assert.equal(view.describe(payload).canAlertBalance, false); assert.equal(view.describe(payload).canAlertBudget, false);
  }
  assert.equal(view.describe({ balanceStatus: 'finite', totalBalance: null }).balance, null);
  assert.equal(view.describe({ balanceStatus: 'finite', totalBalance: -2 }).balance, -2);
  assert.equal(view.describe({ balanceStatus: 'finite', totalBalance: 0 }).balance, 0);
  for (const [scope, label] of [['account', '账户可用余额'], ['api-key-quota', '密钥剩余额度'], ['custom', '自定义余额']]) {
    assert.equal(view.describe({ balanceScope: scope, balanceLabel: '后端完整详细说明' }).label, label);
  }
  for (const status of ['unconfirmed', 'unsupported']) assert.equal(view.describe({ balanceStatus: status, balanceLabel: '后端完整详细说明' }).label, '余额查询');
  assert.equal(view.describe({ balanceStatus: 'unlimited', balanceLabel: '后端完整详细说明' }).label, '密钥额度');
});

test('unlimited key quota permits budget alerts only with an observable used counter', () => {
  const payload = { ok: true, balanceStatus: 'unlimited', totalBalance: null, todayUsage: 5, canObserve: true };
  assert.equal(view.describe(payload).canAlertBudget, false);
  assert.equal(view.describe({ ...payload, counter: 'used' }).canAlertBudget, true);
  assert.equal(view.describe({ ...payload, counter: 'used', todayUsage: null }).canAlertBudget, false);
  assert.equal(view.describe({ ...payload, counter: 'used' }).canAlertBalance, false);
});

test('widget refresh stores null for unconfirmed and failed responses rather than Number(null)', async () => {
  for (const payload of [
    { ok: true, balanceStatus: 'unconfirmed', totalBalance: null, todayUsage: 100, canObserve: false },
    { ok: true, balanceStatus: 'unsupported', totalBalance: null, canObserve: false },
    { ok: false, error: '未提供余额接口', balanceStatus: 'unsupported' }
  ]) {
    const context = { window: { dispatchEvent() {} }, busy: false, state: { balance: 15, todayUsage: 2 },
      WhaleBalanceView: view, WhaleMoney: { setNativeCurrency() {} }, root: {}, BALANCE_URL: '/balance', FETCH_TIMEOUT_MS: 100,
      usageAlertBelowFired: true, usageBudgetFiredKey: 'previous', checkUsageAlerts() {},
      setTimeout: () => 1, clearTimeout() {}, AbortController, CustomEvent: class {}, fetch: async () => ({ json: async () => payload }) };
    vm.createContext(context); vm.runInContext(refreshSource, context); context.refresh(true);
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    assert.equal(context.state.balance, null); assert.equal(context.state.todayUsage, null); assert.equal(context.state.canObserve, false);
    assert.equal(context.state.balanceStatus, payload.balanceStatus); assert.equal(context.busy, false);
  }
});

test('real bubble alert logic suppresses unknown money but alerts on confirmed zero', () => {
  const alerts = [], context = { WhaleBalanceView: view, state: { status: 'ok', balanceStatus: 'unconfirmed', canObserve: false },
    usageSet: { alert: { on: true, below: 5 }, budget: { on: true, amount: 10 } }, usageAlertBelowFired: false, usageBudgetFiredKey: '',
    showUsagePopup: title => alerts.push(title), usageRemindLinesOf: () => [], usageTodayKeyStr: () => 'today' };
  vm.createContext(context);
  vm.runInContext(widget.slice(widget.indexOf('    function checkUsageAlerts('), widget.indexOf('    function usageAlertModsResolved(')), context);
  context.checkUsageAlerts(null, 50); assert.deepEqual(alerts, []);
  context.state.balanceStatus = 'finite'; context.state.canObserve = true;
  context.checkUsageAlerts(0, null); assert.deepEqual(alerts, ['余额预警']);
  context.checkUsageAlerts(0, null); assert.equal(alerts.length, 1);
  context.state.balanceStatus = 'unlimited'; context.state.counter = null;
  context.checkUsageAlerts(Infinity, 50); assert.equal(alerts.length, 1);
  context.state.counter = 'used'; context.checkUsageAlerts(Infinity, 50); assert.deepEqual(alerts, ['余额预警', '今日预算提醒']);
});
