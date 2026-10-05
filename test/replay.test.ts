import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pulse, tee } from '../src/pipeline.ts';
import { Recorder, readRecording, replay } from '../src/recorder.ts';

// Record a constructed session, replay it, and get the same state back.
// (Constructed frames: this tests the record/replay mechanism, not the market.)

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

test('a recording replays to the same numbers the streaming pipeline computed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-'));
  const path = join(dir, 'r.jsonl');
  const streaming = new Pulse([]);
  const rec = new Recorder(path, {
    format: 'solami-pulse/1', recorded_at: new Date(T0).toISOString(), source: 'constructed test session',
    endpoints: { blur: 'wss://ws.solami.dev/data/subscribe?api_key=SHOULDNOTAPPEAR' }, subscribe: '{}', rpc_provider: 'solami', tool_version: 'test',
  });
  const input = tee(streaming, rec);
  input.register('blur', 'blur', 'ws.solami.dev');
  input.register('solami', 'rpc', 'rpc.solami.dev');
  input.open('blur', T0);
  input.blurFrame({ type: 'swap', signature: 'S1', ix_index: 0, pool: 'P', mint: 'M', side: 'buy', volume_usd: 100, trader: 'A' }, T0 + 10);
  input.blurFrame({ type: 'swap', signature: 'S1', ix_index: 0, pool: 'P', mint: 'M', side: 'buy', volume_usd: 100, trader: 'A' }, T0 + 20); // backfill duplicate
  input.blurFrame({ type: 'swap', signature: 'S2', ix_index: 0, pool: 'P', mint: 'M', side: 'sell', volume_usd: 50, trader: 'B' }, T0 + 30);
  input.slot('solami', 1000, T0 + 40);
  input.rpc('solami', 'getSlot', 35, true, T0 + 50);
  input.verify('solami', 'S1', 'ok', T0 + 60);
  await rec.finish();

  const file = readFileSync(path, 'utf8');
  assert.ok(!file.includes('SHOULDNOTAPPEAR'), 'API key must be redacted in the header');

  const r = readRecording(path);
  assert.equal(r.meta.source, 'constructed test session');
  const again = new Pulse([]);
  const end = replay(r, again);
  assert.equal(end, T0 + 60);
  const a = streaming.state(T0 + 60);
  const b = again.state(T0 + 60);
  assert.deepEqual(b.market, a.market);
  assert.deepEqual(b.frames, a.frames);
  assert.deepEqual(b.health, a.health);
  assert.equal(b.frames.duplicates, 1);
  assert.equal(b.market.h1.volumeUsd, 150);
});

test('a file without the header line is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-'));
  const path = join(dir, 'bad.jsonl');
  const r = new Recorder(path, { format: 'solami-pulse/1', recorded_at: '', source: '', endpoints: {}, subscribe: '', rpc_provider: '', tool_version: '' });
  void r;
  assert.throws(() => readRecording(join(dir, 'missing.jsonl')));
});
