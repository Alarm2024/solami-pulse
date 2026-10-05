// Stream health per provider, measured from what actually arrives:
// connects/reconnects, message rate, age of the newest message, newest slot,
// slot lag behind the best provider, how many ms each provider is behind the
// first provider to report the same slot, RPC latency and verification results.
// Every figure here is computed from timestamps taken on receipt.

export interface ProviderHealth {
  name: string;
  kind: 'rpc' | 'blur';
  host: string;
  connected: boolean;
  connects: number;
  reconnects: number;
  messages: number;
  msgPerSec: number; // over the last 60 s
  lastMsgAgeMs: number | null;
  slot: number | null;
  slotLag: number | null; // slots behind the highest slot any provider has reported
  behindLeaderP50Ms: number | null; // per slot: arrival time minus first arrival anywhere
  behindLeaderP95Ms: number | null;
  rpcCalls: number;
  rpcErrors: number;
  rpcP50Ms: number | null;
  rpcP95Ms: number | null;
  verified: number; // Blur signatures this provider confirmed on chain
  verifyMissing: number; // not found after the grace period
  verifySlotMismatch: number; // found, but in a different slot than Blur reported
  lastError: string;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] ?? null;
}

class Ring {
  private readonly cap: number;
  readonly values: number[] = [];

  constructor(cap: number) {
    this.cap = cap;
  }

  push(v: number): void {
    this.values.push(v);
    if (this.values.length > this.cap) this.values.shift();
  }
}

class Stream {
  readonly name: string;
  readonly kind: 'rpc' | 'blur';
  host: string;
  connected = false;
  connects = 0;
  messages = 0;
  lastMsgAt: number | null = null;
  slot: number | null = null;
  readonly perSecond = new Map<number, number>(); // unix second -> count
  readonly behind = new Ring(600);
  readonly rpcLatency = new Ring(300);
  rpcCalls = 0;
  rpcErrors = 0;
  verified = 0;
  verifyMissing = 0;
  verifySlotMismatch = 0;
  lastError = '';

  constructor(name: string, kind: 'rpc' | 'blur', host: string) {
    this.name = name;
    this.kind = kind;
    this.host = host;
  }
}

export class Health {
  private readonly streams = new Map<string, Stream>();
  private readonly firstArrival = new Map<number, number>(); // slot -> ms
  private maxSlot: number | null = null;

  register(name: string, kind: 'rpc' | 'blur', host: string): void {
    if (!this.streams.has(name)) this.streams.set(name, new Stream(name, kind, host));
  }

  private s(name: string): Stream {
    const s = this.streams.get(name);
    if (!s) throw new Error(`unknown stream ${name}`);
    return s;
  }

  onOpen(name: string): void {
    const s = this.s(name);
    s.connected = true;
    s.connects++;
  }

  onClose(name: string, reason: string): void {
    const s = this.s(name);
    s.connected = false;
    if (reason) s.lastError = reason;
  }

  onError(name: string, message: string): void {
    this.s(name).lastError = message;
  }

  onMessage(name: string, t: number): void {
    const s = this.s(name);
    s.messages++;
    s.lastMsgAt = t;
    const sec = Math.floor(t / 1000);
    s.perSecond.set(sec, (s.perSecond.get(sec) ?? 0) + 1);
    if (s.perSecond.size > 120) for (const k of s.perSecond.keys()) if (k < sec - 60) s.perSecond.delete(k);
  }

  /** A slot as reported by a provider at receipt time t. */
  onSlot(name: string, slot: number, t: number): void {
    const s = this.s(name);
    if (s.slot === null || slot > s.slot) s.slot = slot;
    if (this.maxSlot === null || slot > this.maxSlot) this.maxSlot = slot;
    const first = this.firstArrival.get(slot);
    if (first === undefined) {
      this.firstArrival.set(slot, t);
      if (this.firstArrival.size > 2000) {
        const cut = slot - 1500;
        for (const k of this.firstArrival.keys()) if (k < cut) this.firstArrival.delete(k);
      }
      s.behind.push(0);
    } else {
      s.behind.push(Math.max(0, t - first));
    }
  }

  onRpc(name: string, ms: number, ok: boolean, error = ''): void {
    const s = this.s(name);
    s.rpcCalls++;
    if (ok) s.rpcLatency.push(ms);
    else {
      s.rpcErrors++;
      if (error) s.lastError = error;
    }
  }

  onVerify(name: string, outcome: 'ok' | 'missing' | 'slot_mismatch'): void {
    const s = this.s(name);
    if (outcome === 'ok') s.verified++;
    else if (outcome === 'missing') s.verifyMissing++;
    else s.verifySlotMismatch++;
  }

  snapshot(now: number): ProviderHealth[] {
    const out: ProviderHealth[] = [];
    const nowSec = Math.floor(now / 1000);
    for (const s of this.streams.values()) {
      let last60 = 0;
      for (const [sec, n] of s.perSecond) if (sec > nowSec - 60 && sec <= nowSec) last60 += n;
      out.push({
        name: s.name,
        kind: s.kind,
        host: s.host,
        connected: s.connected,
        connects: s.connects,
        reconnects: Math.max(0, s.connects - 1),
        messages: s.messages,
        msgPerSec: Math.round((last60 / 60) * 10) / 10,
        lastMsgAgeMs: s.lastMsgAt === null ? null : Math.max(0, now - s.lastMsgAt),
        slot: s.slot,
        slotLag: s.slot === null || this.maxSlot === null ? null : this.maxSlot - s.slot,
        behindLeaderP50Ms: percentile(s.behind.values, 50),
        behindLeaderP95Ms: percentile(s.behind.values, 95),
        rpcCalls: s.rpcCalls,
        rpcErrors: s.rpcErrors,
        rpcP50Ms: percentile(s.rpcLatency.values, 50),
        rpcP95Ms: percentile(s.rpcLatency.values, 95),
        verified: s.verified,
        verifyMissing: s.verifyMissing,
        verifySlotMismatch: s.verifySlotMismatch,
        lastError: s.lastError,
      });
    }
    return out;
  }
}
