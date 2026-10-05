import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, Dedup } from '../src/normalize.ts';

// Constructed frames (to check shapes; not market data). Real frames are checked
// in fixtures.test.ts against a recording.

const SIG = '5xConstructedSignatureForShapeTestsOnly1111111111111111111111111';

test('swap frame becomes a swap event with the token mint, not the quote mint', () => {
  const r = normalize({
    type: 'swap', signature: SIG, tx_index: 3, ix_index: 1, slot: 100, block_time: 1700000000,
    pool: 'POOL1', mint: 'So11111111111111111111111111111111111111112', base_mint: 'TOKEN1', dex: 'raydium',
    side: 'sell', volume_usd: '12.5', price_usd: 0.01, trader: 'WALLET1',
  });
  assert.equal(r.type, 'swap');
  assert.deepEqual(r.drift, []);
  assert.ok(r.event && r.event.kind === 'swap');
  assert.equal(r.event.mint, 'TOKEN1');
  assert.equal(r.event.side, 'sell');
  assert.equal(r.event.volumeUsd, 12.5);
  assert.equal(r.event.slot, 100);
  assert.equal(r.event.id, `${SIG}:3:1:`);
});

test('missing fields are reported as drift, never guessed', () => {
  const r = normalize({ type: 'swap', pool: 'P', side: 'up' });
  assert.ok(r.drift.includes('signature'));
  assert.ok(r.drift.includes('volume_usd'));
  assert.ok(r.drift.includes('trader'));
  assert.ok(r.drift.includes('side(buy|sell)'));
  assert.ok(r.event && r.event.kind === 'swap' && r.event.volumeUsd === null);
});

test('liquidity add/remove and pool_create map to their events', () => {
  const add = normalize({ type: 'liquidity', signature: SIG, pool: 'P', kind: 'add', usd: 100 });
  const rem = normalize({ type: 'liquidity', signature: SIG, pool: 'P', kind: 'remove', quote_amount_usd: 40 });
  const launch = normalize({ type: 'pool_create', pool: 'P2', mint: 'M', dex: 'pumpswap', symbol: 'ABC', liquidity_usd: 900 });
  assert.ok(add.event?.kind === 'liquidity' && add.event.direction === 'add' && add.event.usd === 100);
  assert.ok(rem.event?.kind === 'liquidity' && rem.event.direction === 'remove' && rem.event.usd === 40);
  assert.ok(launch.event?.kind === 'launch' && launch.event.symbol === 'ABC' && launch.event.liquidityUsd === 900);
});

test('other frame types are counted but produce no event', () => {
  for (const type of ['candle', 'stats', 'trending', 'token_create']) {
    const r = normalize({ type });
    assert.equal(r.event, null);
    assert.equal(r.type, type);
  }
  assert.equal(normalize('nope').type, 'unknown');
  assert.equal(normalize([1]).type, 'unknown');
});

test('dedup drops a backfill replay but keeps two swaps in one transaction', () => {
  const d = new Dedup(10);
  assert.equal(d.fresh(`${SIG}:3:1:`), true);
  assert.equal(d.fresh(`${SIG}:3:1:`), false);
  assert.equal(d.fresh(`${SIG}:3:2:`), true);
  assert.equal(d.fresh(':::'), true, 'events without a signature are never deduplicated');
  assert.equal(d.fresh(':::'), true);
});

test('dedup forgets the oldest ids past its cap', () => {
  const d = new Dedup(3);
  for (const id of ['a:', 'b:', 'c:', 'd:']) d.fresh(id);
  assert.equal(d.fresh('a:'), true);
  assert.equal(d.fresh('d:'), false);
});
