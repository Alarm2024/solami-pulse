// Prints every number the README and the submission quote, from one recording.
//   npm run report -- fixtures/<file>.jsonl            human-readable
//   npm run report -- fixtures/<file>.jsonl --json     the same as JSON
//   npm run report -- fixtures/<file>.jsonl --write-expected
//       writes fixtures/<file>.expected.json, which test/fixtures.test.ts then
//       checks on every `npm test`.
import { writeFileSync } from 'node:fs';
import { Pulse } from '../src/pipeline.ts';
import { readRecording, replay } from '../src/recorder.ts';
import { loadRules } from '../src/alerts.ts';

export function summarize(path: string, rulesFile = 'alerts.example.json') {
  const rec = readRecording(path);
  const pulse = new Pulse(loadRules(rulesFile));
  const end = replay(rec, pulse, (t) => pulse.tick(t));
  const s = pulse.state(end);
  const first = rec.lines.find((l) => l.t > 0)?.t ?? end;
  const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    file: path,
    recorded_at: rec.meta.recorded_at,
    source: rec.meta.source,
    duration_s: Math.round((end - first) / 1000),
    frames: s.frames.total,
    frames_by_type: s.frames.byType,
    duplicates_dropped: s.frames.duplicates,
    schema_drift: s.frames.drift,
    window_whole_recording: {
      volume_usd: r2(s.market.h24.volumeUsd),
      trades: s.market.h24.trades,
      buys: s.market.h24.buys,
      sells: s.market.h24.sells,
      buy_share: r2(s.market.h24.buyPressure),
      swaps_without_usd: s.market.h24.noUsd,
      unique_wallets_estimate: s.market.h24.uniqueWallets,
      new_pools: s.market.h24.launches,
      liquidity_added_usd: r2(s.market.h24.liqAddUsd),
      liquidity_removed_usd: r2(s.market.h24.liqRemoveUsd),
    },
    pools_tracked: s.market.trackedPools,
    alerts: s.alerts.length,
    health: s.health.map((h) => ({
      stream: h.name,
      messages: h.messages,
      reconnects: h.reconnects,
      slot_lag_at_end: h.slotLag,
      behind_leader_p50_ms: h.behindLeaderP50Ms,
      behind_leader_p95_ms: h.behindLeaderP95Ms,
      rpc_calls: h.rpcCalls,
      rpc_errors: h.rpcErrors,
      rpc_p50_ms: h.rpcP50Ms,
      rpc_p95_ms: h.rpcP95Ms,
      verified: h.verified,
      verify_missing: h.verifyMissing,
      verify_slot_mismatch: h.verifySlotMismatch,
    })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: npm run report -- fixtures/<file>.jsonl [--json|--write-expected]');
    process.exit(1);
  }
  const out = summarize(path);
  if (process.argv.includes('--write-expected')) {
    const target = path.replace(/\.jsonl$/, '.expected.json');
    writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${target}`);
  } else if (process.argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const w = out.window_whole_recording;
    console.log(`${out.file}\n  recorded ${out.recorded_at} · ${out.duration_s} s · ${out.source}`);
    console.log(`  frames ${out.frames} (duplicates dropped ${out.duplicates_dropped}) · by type ${JSON.stringify(out.frames_by_type)}`);
    console.log(`  volume $${w.volume_usd} · trades ${w.trades} (buy ${w.buys} / sell ${w.sells}) · buy share ${w.buy_share} · wallets ≈${w.unique_wallets_estimate} · new pools ${w.new_pools}`);
    console.log(`  liquidity +$${w.liquidity_added_usd} / -$${w.liquidity_removed_usd} · swaps without USD ${w.swaps_without_usd} · alerts ${out.alerts}`);
    for (const h of out.health) console.log(`  ${h.stream}: msgs ${h.messages}, reconnects ${h.reconnects}, behind p50/p95 ${h.behind_leader_p50_ms}/${h.behind_leader_p95_ms} ms, rpc p50/p95 ${h.rpc_p50_ms}/${h.rpc_p95_ms} ms (${h.rpc_errors}/${h.rpc_calls} errors), verified ${h.verified}, missing ${h.verify_missing}, slot≠ ${h.verify_slot_mismatch}`);
    if (Object.keys(out.schema_drift).length) console.log(`  schema drift: ${JSON.stringify(out.schema_drift)}`);
  }
}
