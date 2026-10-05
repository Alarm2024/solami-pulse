import { createWriteStream, mkdirSync, readFileSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { Input, VerifyOutcome } from './pipeline.ts';
import { redact } from './redact.ts';

// A recording is JSON Lines. Line 1 is a header saying when, from where and
// with which subscription it was taken (URLs redacted). Every later line is one
// input with its receipt time, exactly as the pipeline saw it.

export interface RecordingMeta {
  format: 'solami-pulse/1';
  recorded_at: string; // ISO time of the first line
  source: string; // human description, e.g. "Solami Blur + slotSubscribe (solami, rpcfast)"
  endpoints: Record<string, string>; // name -> redacted URL
  subscribe: string; // what was sent to Blur after open
  rpc_provider: string;
  tool_version: string;
  note?: string;
}

export type Line =
  | { t: number; k: 'reg'; name: string; kind: 'rpc' | 'blur'; host: string }
  | { t: number; k: 'open'; name: string }
  | { t: number; k: 'close'; name: string; reason: string }
  | { t: number; k: 'blur'; frame: unknown }
  | { t: number; k: 'slot'; p: string; slot: number }
  | { t: number; k: 'rpc'; p: string; m: string; ms: number; ok: boolean; err?: string }
  | { t: number; k: 'verify'; p: string; sig: string; o: VerifyOutcome };

export class Recorder implements Input {
  private readonly out: WriteStream;
  lines = 0;
  blurFrames = 0;
  private readonly maxBlurFrames: number;
  private full = false;
  onFull: () => void = () => {};

  constructor(path: string, meta: RecordingMeta, maxBlurFrames = 5000) {
    mkdirSync(dirname(path), { recursive: true });
    this.out = createWriteStream(path);
    this.maxBlurFrames = maxBlurFrames;
    const safe = { ...meta, endpoints: Object.fromEntries(Object.entries(meta.endpoints).map(([k, v]) => [k, redact(v)])) };
    this.out.write(JSON.stringify({ meta: safe }) + '\n');
  }

  private w(line: Line): void {
    if (this.full) return;
    this.out.write(JSON.stringify(line) + '\n');
    this.lines++;
  }

  register(name: string, kind: 'rpc' | 'blur', host: string): void {
    this.w({ t: 0, k: 'reg', name, kind, host });
  }
  open(name: string, t: number): void {
    this.w({ t, k: 'open', name });
  }
  close(name: string, t: number, reason: string): void {
    this.w({ t, k: 'close', name, reason: redact(reason) });
  }
  blurFrame(raw: unknown, t: number): void {
    this.w({ t, k: 'blur', frame: raw });
    if (++this.blurFrames >= this.maxBlurFrames && !this.full) {
      this.full = true;
      this.onFull();
    }
  }
  slot(provider: string, slot: number, t: number): void {
    this.w({ t, k: 'slot', p: provider, slot });
  }
  rpc(provider: string, method: string, ms: number, ok: boolean, t: number, error?: string): void {
    this.w({ t, k: 'rpc', p: provider, m: method, ms, ok, ...(error ? { err: redact(error) } : {}) });
  }
  verify(provider: string, signature: string, outcome: VerifyOutcome, t: number): void {
    this.w({ t, k: 'verify', p: provider, sig: signature, o: outcome });
  }

  finish(): Promise<void> {
    return new Promise((resolve) => this.out.end(resolve));
  }
}

export interface Recording {
  meta: RecordingMeta;
  lines: Line[];
}

export function readRecording(path: string): Recording {
  const text = readFileSync(path, 'utf8');
  const rows = text.split('\n').filter((l) => l.trim());
  const head = JSON.parse(rows[0] ?? '{}') as { meta?: RecordingMeta };
  if (!head.meta || head.meta.format !== 'solami-pulse/1') throw new Error(`${path}: not a solami-pulse/1 recording (missing header line)`);
  return { meta: head.meta, lines: rows.slice(1).map((l) => JSON.parse(l) as Line) };
}

/** Feed a recording into any Input; returns the receipt time of the last line. */
export function replay(rec: Recording, into: Input, onTick?: (t: number) => void): number {
  let last = 0;
  let nextTick = 0;
  for (const line of rec.lines) {
    if (line.t > 0) {
      if (onTick && nextTick === 0) nextTick = line.t + 1000;
      while (onTick && line.t >= nextTick) {
        onTick(nextTick);
        nextTick += 1000;
      }
      last = Math.max(last, line.t);
    }
    switch (line.k) {
      case 'reg':
        into.register(line.name, line.kind, line.host);
        break;
      case 'open':
        into.open(line.name, line.t);
        break;
      case 'close':
        into.close(line.name, line.t, line.reason);
        break;
      case 'blur':
        into.blurFrame(line.frame, line.t);
        break;
      case 'slot':
        into.slot(line.p, line.slot, line.t);
        break;
      case 'rpc':
        into.rpc(line.p, line.m, line.ms, line.ok, line.t, line.err);
        break;
      case 'verify':
        into.verify(line.p, line.sig, line.o, line.t);
        break;
    }
  }
  if (onTick && last > 0) onTick(last);
  return last;
}
