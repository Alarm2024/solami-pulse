import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadDotEnv, type Config } from './config.ts';
import { loadRules, type Alert } from './alerts.ts';
import { Pulse, tee, type Input } from './pipeline.ts';
import { Recorder, readRecording, replay } from './recorder.ts';
import { serve } from './server.ts';
import { startBlur } from './sources/blur.ts';
import { startSlots } from './sources/slots.ts';
import { Rpc } from './sources/rpc.ts';
import { Verifier } from './verify.ts';
import { hostOf, redact } from './redact.ts';
import type { SocketHandle } from './sources/socket.ts';

// solami-pulse — read-only. It opens WebSockets and makes read-only RPC calls.
// It holds no wallet, signs nothing and sends no transaction.

const VERSION = '0.1.0';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function sinkAlerts(cfg: Config, pulse: Pulse, persist: boolean): void {
  pulse.onAlert((a: Alert) => {
    const line = JSON.stringify(a);
    console.log(`[alert] ${a.rule} ${a.label} ${a.metric}=${a.value} (${a.threshold})`);
    if (persist) appendFileSync(join(cfg.dataDir, 'alerts.jsonl'), line + '\n');
    if (cfg.alertWebhookUrl) {
      fetch(cfg.alertWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: line, signal: AbortSignal.timeout(5000) }).catch(
        (e: unknown) => console.warn(`[alert] webhook failed: ${redact(String(e))}`),
      );
    }
  });
}

async function runReplay(cfg: Config, path: string): Promise<void> {
  const rec = readRecording(path);
  const pulse = new Pulse(loadRules(cfg.alertRulesFile));
  sinkAlerts(cfg, pulse, false);
  const end = replay(rec, pulse, (t) => pulse.tick(t));
  const s = pulse.state(end);
  console.log(`replayed ${path}`);
  console.log(`  recorded ${rec.meta.recorded_at} · ${rec.meta.source}`);
  console.log(`  frames ${s.frames.total} · duplicates ${s.frames.duplicates} · alerts ${s.alerts.length}`);
  if (arg('--serve') === undefined) return;
  serve(cfg.host, cfg.port, () => pulse.state(end), () => ({ kind: 'replay', file: path, recordedAt: rec.meta.recorded_at, source: rec.meta.source }));
  console.log(`dashboard (frozen at the end of the recording): http://${cfg.host}:${cfg.port}`);
}

async function runLive(cfg: Config, recordTo?: string): Promise<void> {
  if (!cfg.solamiApiKey) {
    console.error('SOLAMI_API_KEY is not set. Sign up at https://solami.dev, put the key in .env, then npm start.');
    console.error('Without a key you can still replay a recording: npm run replay -- fixtures/<file>.jsonl --serve');
    process.exit(1);
  }
  mkdirSync(cfg.dataDir, { recursive: true });
  const rules = loadRules(cfg.alertRulesFile);
  const pulse = new Pulse(rules);
  sinkAlerts(cfg, pulse, true);

  let input: Input = pulse;
  let recorder: Recorder | undefined;
  const handles: SocketHandle[] = [];
  const stop = async (why: string) => {
    for (const h of handles) h.stop();
    if (recorder) {
      await recorder.finish();
      console.log(`recording closed (${why}): ${recordTo} · ${recorder.blurFrames} Blur frames, ${recorder.lines} lines`);
    }
    process.exit(0);
  };
  if (recordTo) {
    const maxFrames = Number(arg('--max-frames') || '5000');
    recorder = new Recorder(recordTo, {
      format: 'solami-pulse/1',
      recorded_at: new Date().toISOString(),
      source: `Solami Blur + slotSubscribe (${cfg.providers.map((p) => p.name).join(', ')}) on Solana mainnet`,
      endpoints: Object.fromEntries([['blur', cfg.blurUrl], ...cfg.providers.flatMap((p) => [[`${p.name}.http`, p.httpUrl], [`${p.name}.ws`, p.wsUrl]])]),
      subscribe: cfg.blurSubscribe,
      rpc_provider: cfg.rpcProvider,
      tool_version: VERSION,
    }, maxFrames);
    recorder.onFull = () => void stop(`reached ${maxFrames} Blur frames`);
    input = tee(pulse, recorder);
    const minutes = Number(arg('--minutes') || '0');
    if (minutes > 0) setTimeout(() => void stop(`${minutes} min elapsed`), minutes * 60_000);
  }

  input.register('blur', 'blur', hostOf(cfg.blurUrl));
  for (const p of cfg.providers) input.register(p.name, 'rpc', hostOf(p.httpUrl));

  handles.push(startBlur(cfg.blurUrl, cfg.blurSubscribe, input));
  const rpcs = new Map<string, Rpc>();
  for (const p of cfg.providers) {
    handles.push(startSlots(p.name, p.wsUrl, input));
    rpcs.set(p.name, new Rpc(p.name, p.httpUrl, input));
  }

  const verifyRpc = rpcs.get(cfg.rpcProvider);
  if (!verifyRpc) console.warn(`RPC_PROVIDER=${cfg.rpcProvider} has no URL configured; on-chain verification is off.`);
  const verifier = verifyRpc ? new Verifier(verifyRpc, input, cfg.verifyPerMinute, Date.now()) : undefined;
  if (verifier) pulse.onEvent((e, t) => verifier.offer(e, t));

  setInterval(() => pulse.tick(Date.now()), 1000);
  setInterval(() => void verifier?.run(Date.now()), 2000);
  setInterval(() => {
    for (const r of rpcs.values()) r.getSlot().catch(() => {});
  }, 5000);
  const healthLog = join(cfg.dataDir, `health-${today()}.jsonl`);
  setInterval(() => appendFileSync(healthLog, JSON.stringify({ at: Date.now(), health: pulse.health.snapshot(Date.now()) }) + '\n'), 10_000);

  process.on('SIGINT', () => void stop('Ctrl-C'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  serve(cfg.host, cfg.port, () => pulse.state(Date.now()), () => ({ kind: recordTo ? 'mainnet+record' : 'mainnet', rpcProvider: cfg.rpcProvider }));
  console.log(`solami-pulse ${VERSION} · read-only · RPC_PROVIDER=${cfg.rpcProvider} · providers: ${cfg.providers.map((p) => `${p.name} (${hostOf(p.httpUrl)})`).join(', ')}`);
  console.log(`dashboard: http://${cfg.host}:${cfg.port}`);
  if (recordTo) console.log(`recording to ${recordTo}`);
}

loadDotEnv();
const cfg = loadConfig();
const replayPath = arg('--replay');
if (replayPath !== undefined) {
  if (!replayPath || !existsSync(replayPath)) {
    console.error('usage: npm run replay -- fixtures/<file>.jsonl [--serve]');
    process.exit(1);
  }
  await runReplay(cfg, replayPath);
} else if (arg('--record') !== undefined) {
  const out = arg('--out') || join('fixtures', `${today()}-mainnet-${Date.now()}.jsonl`);
  await runLive(cfg, out);
} else {
  await runLive(cfg);
}
