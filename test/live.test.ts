import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Pulse } from '../src/pipeline.ts';
import { startBlur } from '../src/sources/blur.ts';
import { startSlots } from '../src/sources/slots.ts';
import { Rpc } from '../src/sources/rpc.ts';
import { Verifier } from '../src/verify.ts';

// End-to-end over real sockets against a local stand-in for Blur, a JSON-RPC
// WebSocket and a JSON-RPC HTTP endpoint. The frames are constructed; what is
// tested is the wiring: subscribe message, parsing, reconnect, verification.

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('Blur + slotSubscribe + RPC verification over local sockets', async () => {
  const subscribes: string[] = [];
  const rpcMethods: string[] = [];
  let blurConns = 0;
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const m = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      rpcMethods.push(m.method);
      const result = m.method === 'getSlot' ? 1234 : { value: (m.params[0] as string[]).map((s) => (s === 'SIG-ON-CHAIN' ? { slot: 77, confirmationStatus: 'confirmed' } : null)) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (ws: WsSocket, req) => {
    if (req.url?.startsWith('/data/subscribe')) {
      blurConns++;
      ws.on('message', (m) => {
        subscribes.push(String(m));
        ws.send(JSON.stringify({ type: 'swap', signature: 'SIG-ON-CHAIN', ix_index: 0, slot: 77, pool: 'P', mint: 'M', side: 'buy', volume_usd: 25, trader: 'A' }));
        ws.send(JSON.stringify([{ type: 'swap', signature: 'SIG-ON-CHAIN', ix_index: 0, slot: 77, pool: 'P', mint: 'M', side: 'buy', volume_usd: 25, trader: 'A' }])); // replay, array form
        if (blurConns === 1) setTimeout(() => ws.close(1011, 'test restart'), 50);
      });
    } else {
      ws.on('message', () => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', result: 0, id: 1 }));
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'slotNotification', params: { result: { slot: 1000, parent: 999, root: 968 }, subscription: 0 } }));
      });
    }
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;

  const pulse = new Pulse([]);
  pulse.register('blur', 'blur', 'local');
  pulse.register('solami', 'rpc', 'local');
  const blur = startBlur(`ws://127.0.0.1:${port}/data/subscribe?chain=solana&api_key=x`, '{"backfill":30}', pulse);
  const slots = startSlots('solami', `ws://127.0.0.1:${port}/ws`, pulse);
  const rpc = new Rpc('solami', `http://127.0.0.1:${port}/`, pulse);
  const verifier = new Verifier(rpc, pulse, 60, Date.now() - 60_000);
  pulse.onEvent((e, t) => verifier.offer(e, t - 5000)); // pretend it arrived 5 s ago so it is due now

  try {
    await until(() => blurConns >= 2 && pulse.frames >= 4); // reconnected and re-subscribed
    await until(() => pulse.health.snapshot(Date.now()).find((h) => h.name === 'solami')?.slot === 1000);
    assert.equal(await rpc.getSlot(), 1234);
    await verifier.run(Date.now());

    const h = Object.fromEntries(pulse.health.snapshot(Date.now()).map((x) => [x.name, x]));
    assert.deepEqual(subscribes.slice(0, 2), ['{"backfill":30}', '{"backfill":30}']);
    assert.equal(h.blur?.reconnects, 1);
    assert.equal(pulse.duplicates, 3, 'the same swap four times counts once');
    assert.equal(pulse.metrics.window(Date.now(), 300_000).volumeUsd, 25);
    assert.equal(h.solami?.verified, 1);
    assert.ok(rpcMethods.includes('getSignatureStatuses'));
    assert.ok(rpcMethods.every((m) => m === 'getSlot' || m === 'getSignatureStatuses'));
    await assert.rejects(rpc.call('sendTransaction', []), /refusing/);
  } finally {
    blur.stop();
    slots.stop();
    wss.close();
    http.close();
  }
});
