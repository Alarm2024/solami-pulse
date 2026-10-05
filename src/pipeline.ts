import { normalize, Dedup, type MarketEvent } from './normalize.ts';
import { Metrics, type Snapshot } from './metrics.ts';
import { Health, type ProviderHealth } from './health.ts';
import { AlertEngine, type Alert, type Rule } from './alerts.ts';

// Everything the app learns arrives through this interface, with the receipt
// time attached. Mainnet sockets call it; a recording replays into it; the
// recorder tees it to disk. One code path, so a replay gives the same numbers.

export type VerifyOutcome = 'ok' | 'missing' | 'slot_mismatch';

export interface Input {
  register(name: string, kind: 'rpc' | 'blur', host: string): void;
  open(name: string, t: number): void;
  close(name: string, t: number, reason: string): void;
  blurFrame(raw: unknown, t: number): void;
  slot(provider: string, slot: number, t: number): void;
  rpc(provider: string, method: string, ms: number, ok: boolean, t: number, error?: string): void;
  verify(provider: string, signature: string, outcome: VerifyOutcome, t: number): void;
}

export interface State {
  at: number;
  market: Snapshot;
  health: ProviderHealth[];
  alerts: Alert[];
  frames: { total: number; byType: Record<string, number>; duplicates: number; drift: Record<string, number> };
  rules: Rule[];
}

export class Pulse implements Input {
  readonly metrics = new Metrics();
  readonly health = new Health();
  readonly dedup = new Dedup();
  readonly engine: AlertEngine;
  readonly alerts: Alert[] = [];
  private readonly listeners: ((a: Alert) => void)[] = [];
  private readonly verifyListeners: ((e: MarketEvent, t: number) => void)[] = [];
  frames = 0;
  duplicates = 0;
  readonly byType: Record<string, number> = {};
  readonly drift: Record<string, number> = {};

  constructor(rules: Rule[]) {
    this.engine = new AlertEngine(rules);
  }

  onAlert(fn: (a: Alert) => void): void {
    this.listeners.push(fn);
  }

  /** Called for every new on-chain market event (used to sample verification). */
  onEvent(fn: (e: MarketEvent, t: number) => void): void {
    this.verifyListeners.push(fn);
  }

  private emit(list: Alert[]): void {
    for (const a of list) {
      this.alerts.unshift(a);
      for (const fn of this.listeners) fn(a);
    }
    if (this.alerts.length > 200) this.alerts.length = 200;
  }

  register(name: string, kind: 'rpc' | 'blur', host: string): void {
    this.health.register(name, kind, host);
  }

  open(name: string, _t: number): void {
    this.health.onOpen(name);
  }

  close(name: string, _t: number, reason: string): void {
    this.health.onClose(name, reason);
  }

  blurFrame(raw: unknown, t: number): void {
    this.frames++;
    this.health.onMessage('blur', t);
    const { event, type, drift } = normalize(raw);
    this.byType[type] = (this.byType[type] ?? 0) + 1;
    for (const d of drift) {
      const k = `${type}.${d}`;
      this.drift[k] = (this.drift[k] ?? 0) + 1;
    }
    if (!event) return;
    if (!this.dedup.fresh(event.id)) {
      this.duplicates++;
      return;
    }
    if (event.slot !== null) this.health.onSlot('blur', event.slot, t);
    this.metrics.ingest(event, t);
    if (event.kind === 'launch') this.emit(this.engine.onLaunch(t, event));
    for (const fn of this.verifyListeners) fn(event, t);
  }

  slot(provider: string, slot: number, t: number): void {
    this.health.onMessage(provider, t);
    this.health.onSlot(provider, slot, t);
  }

  rpc(provider: string, _method: string, ms: number, ok: boolean, _t: number, error = ''): void {
    this.health.onRpc(provider, ms, ok, error);
  }

  verify(provider: string, _signature: string, outcome: VerifyOutcome, _t: number): void {
    this.health.onVerify(provider, outcome);
  }

  /** Periodic rule evaluation; call about once a second. */
  tick(t: number): void {
    this.emit(this.engine.evaluate(t, this.metrics.window(t, 5 * 60_000), this.metrics.allPools(t), this.health.snapshot(t)));
  }

  state(t: number): State {
    return {
      at: t,
      market: this.metrics.snapshot(t),
      health: this.health.snapshot(t),
      alerts: this.alerts.slice(0, 50),
      frames: { total: this.frames, byType: { ...this.byType }, duplicates: this.duplicates, drift: { ...this.drift } },
      rules: this.engine.rules,
    };
  }
}

/** Fan one input stream out to several sinks (the pipeline and the recorder). */
export function tee(...sinks: Input[]): Input {
  return {
    register: (...a) => sinks.forEach((s) => s.register(...a)),
    open: (...a) => sinks.forEach((s) => s.open(...a)),
    close: (...a) => sinks.forEach((s) => s.close(...a)),
    blurFrame: (...a) => sinks.forEach((s) => s.blurFrame(...a)),
    slot: (...a) => sinks.forEach((s) => s.slot(...a)),
    rpc: (...a) => sinks.forEach((s) => s.rpc(...a)),
    verify: (...a) => sinks.forEach((s) => s.verify(...a)),
  };
}
