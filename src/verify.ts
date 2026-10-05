import type { MarketEvent } from './normalize.ts';
import type { Input } from './pipeline.ts';
import type { Rpc } from './sources/rpc.ts';

// Trust, then check: a sample of decoded Blur events is looked up on chain
// through the RPC provider chosen with RPC_PROVIDER (getSignatureStatuses, one
// batched read call). Each sampled signature ends as one of:
//   ok             found, in the slot Blur reported (or Blur gave no slot)
//   slot_mismatch  found, in a different slot
//   missing        not found within 30 s (dropped fork or a wrong signature)

const GRACE_MS = 2000;
const GIVE_UP_MS = 30_000;

interface Pending {
  sig: string;
  slot: number | null;
  seenAt: number;
}

export class Verifier {
  private readonly rpc: Rpc;
  private readonly input: Input;
  private readonly perMinute: number;
  private readonly queue: Pending[] = [];
  private tokens: number;
  private lastRefill: number;
  private busy = false;

  constructor(rpc: Rpc, input: Input, perMinute: number, now: number) {
    this.rpc = rpc;
    this.input = input;
    this.perMinute = Math.max(0, perMinute);
    this.tokens = this.perMinute;
    this.lastRefill = now;
  }

  /** Offer an event; samples at most `perMinute` signatures a minute. */
  offer(e: MarketEvent, t: number): void {
    if (!e.signature || e.kind !== 'swap') return;
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.lastRefill) / 60_000) * this.perMinute);
    this.lastRefill = t;
    if (this.tokens < 1) return;
    this.tokens -= 1;
    this.queue.push({ sig: e.signature, slot: e.slot, seenAt: t });
  }

  /** Check due signatures in one batched call. Call every couple of seconds. */
  async run(now: number): Promise<void> {
    if (this.busy) return;
    const due = this.queue.filter((p) => now - p.seenAt >= GRACE_MS).slice(0, 100);
    if (due.length === 0) return;
    this.busy = true;
    try {
      const res = await this.rpc.getSignatureStatuses(due.map((d) => d.sig));
      due.forEach((p, i) => {
        const st = res.value[i] ?? null;
        let outcome: 'ok' | 'missing' | 'slot_mismatch' | null = null;
        if (st) outcome = p.slot === null || st.slot === p.slot ? 'ok' : 'slot_mismatch';
        else if (now - p.seenAt >= GIVE_UP_MS) outcome = 'missing';
        if (outcome) {
          this.input.verify(this.rpc.name, p.sig, outcome, now);
          this.queue.splice(this.queue.indexOf(p), 1);
        }
      });
    } catch {
      // recorded by Rpc as an error; the sample stays queued until it times out
      for (const p of due) {
        if (now - p.seenAt >= GIVE_UP_MS) this.queue.splice(this.queue.indexOf(p), 1);
      }
    } finally {
      this.busy = false;
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}
