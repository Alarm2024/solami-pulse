import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics, buyPressure, zero } from '../src/metrics.ts';
import { HyperLogLog } from '../src/hll.ts';
import type { SwapEvent } from '../src/normalize.ts';

// Constructed events (arithmetic checks, not market data).

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const MIN = 60_000;

function swap(over: Partial<SwapEvent>): SwapEvent {
  return {
    kind: 'swap', id: Math.random().toString(36), signature: 's', slot: null, blockTime: null,
    pool: 'P', mint: 'M', dex: 'd', side: 'buy', volumeUsd: 10, priceUsd: 1, trader: 'W', ...over,
  };
}

test('volume, trades, buy share and unique wallets over 5 m / 1 h / 24 h', () => {
  const m = new Metrics();
  m.ingest(swap({ side: 'buy', volumeUsd: 300, trader: 'A' }), T0);
  m.ingest(swap({ side: 'sell', volumeUsd: 100, trader: 'B' }), T0 + 1000);
  m.ingest(swap({ side: 'buy', volumeUsd: 50, trader: 'A' }), T0 - 30 * MIN);
  m.ingest(swap({ side: 'sell', volumeUsd: 1000, trader: 'C' }), T0 - 5 * 60 * MIN);

  const now = T0 + 2000;
  const m5 = m.window(now, 5 * MIN);
  assert.equal(m5.volumeUsd, 400);
  assert.equal(m5.trades, 2);
  assert.equal(m5.buyPressure, 0.75);
  assert.equal(m5.uniqueWallets, 2);
  assert.equal(m5.uniqueApprox, false);

  const h1 = m.window(now, 60 * MIN);
  assert.equal(h1.volumeUsd, 450);
  assert.equal(h1.uniqueWallets, 2, 'A twice, B once');

  const h24 = m.window(now, 24 * 60 * MIN);
  assert.equal(h24.volumeUsd, 1450);
  assert.equal(h24.trades, 4);
  assert.equal(h24.uniqueWallets, 3);
  assert.equal(h24.uniqueApprox, true);
});

test('events older than 24 h fall out of the window', () => {
  const m = new Metrics();
  m.ingest(swap({ volumeUsd: 999 }), T0);
  const later = T0 + 24 * 60 * MIN + 2 * MIN;
  m.ingest(swap({ volumeUsd: 1 }), later);
  assert.equal(m.window(later, 24 * 60 * MIN).volumeUsd, 1);
});

test('swaps without a USD value are counted, not priced at zero silently', () => {
  const m = new Metrics();
  m.ingest(swap({ volumeUsd: null }), T0);
  const w = m.window(T0, 5 * MIN);
  assert.equal(w.trades, 1);
  assert.equal(w.noUsd, 1);
  assert.equal(w.volumeUsd, 0);
  assert.equal(w.buyPressure, 1, 'falls back to trade count when no USD is known');
});

test('buyPressure is null when idle', () => {
  assert.equal(buyPressure(zero()), null);
});

test('liquidity and launches roll up per pool and market-wide', () => {
  const m = new Metrics();
  m.ingest({ kind: 'liquidity', id: 'l1', signature: 's', slot: null, blockTime: null, pool: 'P', mint: 'M', dex: 'd', direction: 'add', usd: 500 }, T0);
  m.ingest({ kind: 'liquidity', id: 'l2', signature: 's', slot: null, blockTime: null, pool: 'P', mint: 'M', dex: 'd', direction: 'remove', usd: 200 }, T0);
  m.ingest({ kind: 'launch', id: 'n1', signature: 's', slot: null, blockTime: null, pool: 'Q', mint: 'N', dex: 'pumpswap', name: '', symbol: 'NEW', liquidityUsd: null }, T0);
  const s = m.snapshot(T0);
  assert.equal(s.h1.liqAddUsd, 500);
  assert.equal(s.h1.liqRemoveUsd, 200);
  assert.equal(s.h1.launches, 1);
  assert.equal(s.launches[0]?.symbol, 'NEW');
  const p = s.pools.find((r) => r.pool === 'P');
  assert.equal(p?.h1.liqRemoveUsd, 200);
  assert.equal(s.pools.find((r) => r.pool === 'Q'), undefined, 'a pool with no trade or liquidity move is listed under new pools, not in the table');
  assert.equal(s.launches[0]?.seenAt, T0);
});

test('pool table is ordered by 1 h volume and evicts the least recently active pool', () => {
  const m = new Metrics(2);
  m.ingest(swap({ pool: 'A', volumeUsd: 5 }), T0);
  m.ingest(swap({ pool: 'B', volumeUsd: 50 }), T0 + 1);
  m.ingest(swap({ pool: 'A', volumeUsd: 1 }), T0 + 2); // A is now most recent
  m.ingest(swap({ pool: 'C', volumeUsd: 7 }), T0 + 3); // evicts B
  const rows = m.poolRows(T0 + 4);
  assert.deepEqual(rows.map((r) => r.pool), ['C', 'A']);
});

test('HyperLogLog stays within 2 % on 50 000 distinct addresses', () => {
  const h = new HyperLogLog();
  for (let i = 0; i < 50_000; i++) h.add(`wallet-${i}`);
  for (let i = 0; i < 50_000; i++) h.add(`wallet-${i}`); // repeats change nothing
  const est = h.estimate();
  assert.ok(Math.abs(est - 50_000) / 50_000 < 0.02, `estimate ${est}`);
});

test('HyperLogLog merge equals the union', () => {
  const a = new HyperLogLog();
  const b = new HyperLogLog();
  for (let i = 0; i < 3000; i++) a.add(`w${i}`);
  for (let i = 2000; i < 5000; i++) b.add(`w${i}`);
  a.merge(b);
  const est = a.estimate();
  assert.ok(Math.abs(est - 5000) / 5000 < 0.03, `estimate ${est}`);
});
