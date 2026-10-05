import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Health, percentile } from '../src/health.ts';
import { parseSlotNotification } from '../src/sources/slots.ts';

// Constructed timings (bookkeeping checks, not provider measurements).

test('slot lag and ms behind the first provider to report each slot', () => {
  const h = new Health();
  h.register('solami', 'rpc', 'a');
  h.register('rpcfast', 'rpc', 'b');
  const t = 1_000_000;
  for (let i = 0; i < 10; i++) {
    h.onSlot('solami', 500 + i, t + i * 400);
    h.onSlot('rpcfast', 500 + i, t + i * 400 + 30); // always 30 ms later
  }
  h.onSlot('solami', 510, t + 4000); // rpcfast has not reported 510 yet
  const snap = Object.fromEntries(h.snapshot(t + 4100).map((s) => [s.name, s]));
  assert.equal(snap.solami?.slotLag, 0);
  assert.equal(snap.rpcfast?.slotLag, 1);
  assert.equal(snap.solami?.behindLeaderP50Ms, 0);
  assert.equal(snap.rpcfast?.behindLeaderP50Ms, 30);
});

test('message rate, reconnects, RPC latency and verification counts', () => {
  const h = new Health();
  h.register('blur', 'blur', 'x');
  h.register('rpcfast', 'rpc', 'y');
  h.onOpen('blur');
  h.onClose('blur', 'closed 1006');
  h.onOpen('blur');
  const t = 2_000_000_000;
  for (let i = 0; i < 120; i++) h.onMessage('blur', t + i * 500); // 2 per second for 60 s
  h.onRpc('rpcfast', 40, true);
  h.onRpc('rpcfast', 60, true);
  h.onRpc('rpcfast', 0, false, 'getSlot: HTTP 429');
  h.onVerify('rpcfast', 'ok');
  h.onVerify('rpcfast', 'missing');
  h.onVerify('rpcfast', 'slot_mismatch');
  const s = Object.fromEntries(h.snapshot(t + 60_000).map((x) => [x.name, x]));
  assert.equal(s.blur?.reconnects, 1);
  assert.equal(s.blur?.connected, true);
  assert.equal(s.blur?.msgPerSec, 2);
  assert.equal(s.blur?.lastMsgAgeMs, 500);
  assert.equal(s.rpcfast?.rpcCalls, 3);
  assert.equal(s.rpcfast?.rpcErrors, 1);
  assert.equal(s.rpcfast?.rpcP50Ms, 40);
  assert.equal(s.rpcfast?.lastError, 'getSlot: HTTP 429');
  assert.deepEqual([s.rpcfast?.verified, s.rpcfast?.verifyMissing, s.rpcfast?.verifySlotMismatch], [1, 1, 1]);
});

test('percentile uses nearest rank', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

test('slotSubscribe notifications parse; anything else is ignored', () => {
  assert.equal(parseSlotNotification('{"jsonrpc":"2.0","method":"slotNotification","params":{"result":{"parent":9,"root":1,"slot":10},"subscription":0}}'), 10);
  assert.equal(parseSlotNotification('{"jsonrpc":"2.0","result":0,"id":1}'), null);
  assert.equal(parseSlotNotification('not json'), null);
});
