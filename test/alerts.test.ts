import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AlertEngine, validateRules, type Rule } from '../src/alerts.ts';
import { Metrics } from '../src/metrics.ts';
import type { ProviderHealth } from '../src/health.ts';

// Constructed inputs (rule logic, not market data).

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

function provider(over: Partial<ProviderHealth>): ProviderHealth {
  return {
    name: 'rpcfast', kind: 'rpc', host: 'h', connected: true, connects: 1, reconnects: 0, messages: 1, msgPerSec: 2,
    lastMsgAgeMs: 100, slot: 1, slotLag: 0, behindLeaderP50Ms: 0, behindLeaderP95Ms: 0, rpcCalls: 0, rpcErrors: 0,
    rpcP50Ms: null, rpcP95Ms: null, verified: 0, verifyMissing: 0, verifySlotMismatch: 0, lastError: '', ...over,
  };
}

test('the shipped example rules are valid', () => {
  const rules = validateRules(JSON.parse(readFileSync('alerts.example.json', 'utf8')));
  assert.ok(rules.length >= 5);
});

test('invalid rules are refused with a reason', () => {
  assert.throws(() => validateRules({}), /array/);
  assert.throws(() => validateRules([{ id: 'x', scope: 'pool', metric: 'nope', op: '>', value: 1 }]), /metric/);
  assert.throws(() => validateRules([{ id: 'x', scope: 'pool', metric: 'trades_5m', op: '!=', value: 1 }]), /op/);
  assert.throws(() => validateRules([{ id: 'x', scope: 'pool', metric: 'trades_5m', op: '>', value: 1 }, { id: 'x', scope: 'pool', metric: 'trades_5m', op: '>', value: 1 }]), /duplicate/);
});

test('pool rule fires once, then respects its cooldown', () => {
  const rules: Rule[] = [{ id: 'spike', scope: 'pool', metric: 'volume_5m_usd', op: '>=', value: 100, cooldown_s: 60 }];
  const e = new AlertEngine(rules);
  const m = new Metrics();
  m.ingest({ kind: 'swap', id: '1', signature: 's', slot: null, blockTime: null, pool: 'P', mint: 'M', dex: 'd', side: 'buy', volumeUsd: 150, priceUsd: null, trader: 'w' }, T0);
  const w = m.window(T0, 300_000);
  assert.equal(e.evaluate(T0, w, m.allPools(T0), []).length, 1);
  assert.equal(e.evaluate(T0 + 30_000, w, m.allPools(T0 + 30_000), []).length, 0, 'inside cooldown');
  assert.equal(e.evaluate(T0 + 61_000, w, m.allPools(T0 + 61_000), []).length, 1, 'after cooldown');
});

test('ratio rules wait for enough trades', () => {
  const rules: Rule[] = [{ id: 'buying', scope: 'pool', metric: 'buy_pressure_5m', op: '>=', value: 0.8, min_trades_5m: 3 }];
  const e = new AlertEngine(rules);
  const m = new Metrics();
  const s = (i: number) => m.ingest({ kind: 'swap', id: String(i), signature: 's', slot: null, blockTime: null, pool: 'P', mint: 'M', dex: 'd', side: 'buy', volumeUsd: 10, priceUsd: null, trader: 'w' }, T0 + i);
  s(1);
  s(2);
  assert.equal(e.evaluate(T0 + 3, m.window(T0 + 3, 300_000), m.allPools(T0 + 3), []).length, 0);
  s(3);
  assert.equal(e.evaluate(T0 + 4, m.window(T0 + 4, 300_000), m.allPools(T0 + 4), []).length, 1);
});

test('provider and launch rules', () => {
  const e = new AlertEngine([
    { id: 'lag', scope: 'provider', metric: 'slot_lag', op: '>=', value: 4 },
    { id: 'rich-launch', scope: 'launch', metric: 'liquidity_usd', op: '>=', value: 5000 },
  ]);
  const m = new Metrics();
  const fired = e.evaluate(T0, m.window(T0, 300_000), [], [provider({ name: 'solami', slotLag: 0 }), provider({ name: 'rpcfast', slotLag: 6 })]);
  assert.deepEqual(fired.map((a) => a.subject), ['rpcfast']);
  const base = { kind: 'launch' as const, id: 'x', signature: '', slot: null, blockTime: null, mint: 'M', dex: 'd', name: '', symbol: 'S' };
  assert.equal(e.onLaunch(T0, { ...base, pool: 'A', liquidityUsd: 6000 }).length, 1);
  assert.equal(e.onLaunch(T0, { ...base, pool: 'B', liquidityUsd: 10 }).length, 0);
  assert.equal(e.onLaunch(T0, { ...base, pool: 'C', liquidityUsd: null }).length, 0, 'unknown liquidity never fires');
});
