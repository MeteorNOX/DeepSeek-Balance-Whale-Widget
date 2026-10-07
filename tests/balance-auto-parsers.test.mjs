import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAutoResponse as parse } from '../runtime/balance-auto-parsers.mjs';

const router = { baseUrl: 'https://openrouter.ai/api/v1' };
const key = { data: { limit: 10, limit_remaining: 9, usage: 25, limit_reset: 'monthly' } };
const token = { data: { object: 'token_usage', total_available: 500000, total_used: 250000, total_granted: 750000, unlimited_quota: false } };
const meta = { metadata: { data: { quota_per_unit: 500000, quota_display_type: 'USD' } } };

test('OpenRouter uses explicit remaining rather than lifetime limit minus usage', () => {
  const value = parse('openrouter-key', key, router);
  assert.equal(value.totalBalance, 9);
  assert.equal(value.totalUsed, 25);
  assert.equal(value.balanceScope, 'api-key-quota');
  assert.equal(value.meter.counterWindow, 'lifetime');
});
test('OpenRouter null limit is key unlimited; rate_limit is irrelevant', () => {
  const value = parse('openrouter-key', { data: { limit: null, limit_remaining: null, usage: 5, rate_limit: { requests: -1 } } }, router);
  assert.equal(value.unlimited, true);
  assert.equal(value.totalBalance, null);
  assert.equal(value.totalUsed, 5);
  assert.equal(parse('openrouter-key', { data: { limit: 10, usage: 5 } }, router), null);
});
test('OpenRouter credits are account currency and preserve decimal difference', () => {
  const value = parse('openrouter-credits', { data: { total_credits: 0.3, total_usage: 0.1 } }, router);
  assert.equal(value.totalBalance, 0.2);
  assert.equal(value.balanceScope, 'account');
  assert.equal(value.currency, 'USD');
});
test('unofficial OpenRouter shapes cannot assert USD', () => {
  const value = parse('openrouter-key', key, { baseUrl: 'https://openrouter.ai.example.test' });
  assert.equal(value.trust, 'candidate');
  assert.equal(value.currency, null);
  assert.equal(value.totalBalance, null);
});
test('LiteLLM budget window participates in counter identity without retaining secrets', () => {
  const value = parse('litellm-key-info', { key: 'never-return-this', info: { spend: 3, max_budget: 10, budget_duration: '30d', budget_reset_at: '2026-11-01T00:00:00+00:00' } });
  assert.equal(value.totalBalance, 7);
  assert.equal(value.balanceScope, 'api-key-quota');
  assert.equal(value.meter.counterWindow, 'budget-window');
  assert.equal(value.meter.budgetResetAt, '2026-11-01T00:00:00+00:00');
  assert.ok(!JSON.stringify(value).includes('never-return-this'));
});
test('LiteLLM zero and negative budgets are finite; only null is unlimited', () => {
  for (const max_budget of [0, -1, null]) {
    const value = parse('litellm-key-info', { key: 'x', info: { spend: 3, max_budget } });
    assert.equal(value.unlimited, max_budget === null);
    assert.equal(value.totalBalance, max_budget === null ? null : max_budget - 3);
  }
  assert.equal(parse('litellm-key-info', { info: { spend: 3, max_budget: 10 } }), null);
});
test('SiliconFlow total includes charge balance and region proves currency', () => {
  const payload = { data: { balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88' } };
  for (const [domain, currency] of [['cn', 'CNY'], ['com', 'USD']]) {
    const value = parse('siliconflow-user-info', payload, { baseUrl: `https://api.siliconflow.${domain}/v1` });
    assert.equal(value.totalBalance, 88.88);
    assert.equal(value.currency, currency);
    assert.equal(value.totalUsed, null);
  }
  assert.equal(parse('siliconflow-user-info', payload, { baseUrl: 'https://mirror.test', currency: 'USD' }).trust, 'candidate');
});
test('NewAPI raw totals require actual metadata and remain USD under CNY display', () => {
  const value = parse('newapi-token-usage', token, meta);
  assert.equal(value.totalBalance, 1);
  assert.equal(value.totalUsed, 0.5);
  const cny = parse('newapi-token-usage', token, { metadata: { data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7 } } });
  assert.equal(cny.totalBalance, 1);
  assert.equal(cny.currency, 'USD');
});
test('NewAPI missing or token display units cannot manufacture a monetary preview', () => {
  for (const options of [{}, { metadata: { data: { quota_per_unit: 500000 } } }, { metadata: { data: { quota_per_unit: 500000, quota_display_type: 'TOKENS' } } }]) {
    const value = parse('newapi-token-usage', token, options);
    assert.equal(value.trust, 'candidate');
    assert.equal(value.totalBalance, null);
    assert.equal(value.totalUsed, null);
    assert.equal(value.needsConfirmation, false);
  }
});
test('NewAPI unlimited suppresses available even when it is a huge sentinel', () => {
  const value = parse('newapi-token-usage', { data: { ...token.data, total_available: 100000000, total_granted: 100250000, unlimited_quota: true } }, meta);
  assert.equal(value.totalBalance, null);
  assert.equal(value.unlimited, true);
  assert.equal(value.totalUsed, 0.5);
});
test('malformed scalar values and failed envelopes are rejected', () => {
  for (const usage of ['', ' ', true, false, [], {}, 'Infinity', '0x10', Infinity, NaN]) {
    assert.equal(parse('openrouter-key', { data: { ...key.data, usage } }, router), null);
  }
  assert.equal(parse('newapi-token-usage', { data: { ...token.data, object: 'credit_summary' } }, meta), null);
  assert.equal(parse('newapi-token-usage', { ...token, success: false }, meta), null);
  assert.equal(parse('openrouter-key', { ...key, error: { message: 'denied' } }, router), null);
  assert.equal(parse('openrouter-key', { data: { ...key.data, usage: '1e-8' } }, router).totalUsed, 1e-8);
});

test('native quota contract requires safe integers and granted equals used plus available', () => {
  for (const fields of [
    { total_granted: 749999 }, { total_available: 0.5, total_granted: 250000.5 },
    { total_used: 0.5, total_granted: 500000.5 }, { total_available: Number.MAX_SAFE_INTEGER + 1, total_granted: Number.MAX_SAFE_INTEGER + 1 },
    { total_available: Number.MAX_SAFE_INTEGER, total_used: 1, total_granted: Number.MAX_SAFE_INTEGER },
  ]) assert.equal(parse('newapi-token-usage', { data: { ...token.data, ...fields } }, meta), null);
  const debt = parse('newapi-token-usage', { data: { ...token.data, total_available: -500000, total_used: 750000, total_granted: 250000 } }, meta);
  assert.equal(debt.totalBalance, -1); assert.equal(debt.totalUsed, 1.5);
});
