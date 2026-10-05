import { HyperLogLog } from './hll.ts';
import type { MarketEvent, LaunchEvent } from './normalize.ts';

// Rolling market metrics. Time is always passed in (ms), never read from the
// clock, so a recorded capture replays to exactly the same numbers.
//
// Precision, stated once so the dashboard can say it too:
// - market-wide windows use 1-minute buckets (edge error < 1 minute);
// - unique wallets over 24 h is a HyperLogLog estimate (±0.8 %) on 10-minute buckets;
//   over 5 m and 1 h it is an exact count;
// - per-pool 24 h windows use 1-hour buckets, 5 m and 1 h use 1-minute buckets.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface Counts {
  volumeUsd: number;
  trades: number;
  buys: number;
  sells: number;
  buyUsd: number;
  sellUsd: number;
  noUsd: number; // swaps that carried no USD value
  liqAddUsd: number;
  liqRemoveUsd: number;
  launches: number;
}

export function zero(): Counts {
  return { volumeUsd: 0, trades: 0, buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, noUsd: 0, liqAddUsd: 0, liqRemoveUsd: 0, launches: 0 };
}

function addInto(a: Counts, b: Counts): void {
  a.volumeUsd += b.volumeUsd;
  a.trades += b.trades;
  a.buys += b.buys;
  a.sells += b.sells;
  a.buyUsd += b.buyUsd;
  a.sellUsd += b.sellUsd;
  a.noUsd += b.noUsd;
  a.liqAddUsd += b.liqAddUsd;
  a.liqRemoveUsd += b.liqRemoveUsd;
  a.launches += b.launches;
}

function apply(c: Counts, e: MarketEvent): void {
  if (e.kind === 'swap') {
    c.trades++;
    const usd = e.volumeUsd ?? 0;
    if (e.volumeUsd === null) c.noUsd++;
    c.volumeUsd += usd;
    if (e.side === 'buy') {
      c.buys++;
      c.buyUsd += usd;
    } else {
      c.sells++;
      c.sellUsd += usd;
    }
  } else if (e.kind === 'liquidity') {
    if (e.direction === 'add') c.liqAddUsd += e.usd ?? 0;
    else c.liqRemoveUsd += e.usd ?? 0;
  } else {
    c.launches++;
  }
}

/** Buy share of USD volume (0..1); by count when no USD is known; null when idle. */
export function buyPressure(c: Counts): number | null {
  const usd = c.buyUsd + c.sellUsd;
  if (usd > 0) return c.buyUsd / usd;
  if (c.trades > 0) return c.buys / c.trades;
  return null;
}

/** Fixed-size time buckets keyed by bucket start, pruned past `span`. */
class Series {
  readonly size: number;
  readonly span: number;
  readonly buckets = new Map<number, Counts>();

  constructor(size: number, span: number) {
    this.size = size;
    this.span = span;
  }

  bucket(t: number): Counts {
    const k = t - (t % this.size);
    let b = this.buckets.get(k);
    if (!b) {
      b = zero();
      this.buckets.set(k, b);
    }
    return b;
  }

  sum(now: number, window: number): Counts {
    const out = zero();
    const from = now - window;
    for (const [k, b] of this.buckets) if (k + this.size > from && k <= now) addInto(out, b);
    return out;
  }

  prune(now: number): void {
    for (const k of this.buckets.keys()) if (k + this.size <= now - this.span) this.buckets.delete(k);
  }
}

export interface WindowStats extends Counts {
  buyPressure: number | null;
  uniqueWallets: number;
  uniqueApprox: boolean;
}

export interface PoolRow {
  pool: string;
  mint: string;
  dex: string;
  symbol: string;
  firstSeen: number;
  lastSeen: number;
  priceUsd: number | null;
  m5: WindowStats;
  h1: WindowStats;
  h24: WindowStats;
}

const POOL_WALLET_CAP = 5000;

class PoolStats {
  readonly pool: string;
  mint = '';
  dex = '';
  symbol = '';
  firstSeen: number;
  lastSeen: number;
  priceUsd: number | null = null;
  readonly minutes = new Series(MIN, HOUR);
  readonly hours = new Series(HOUR, DAY);
  readonly wallets = new Map<string, number>(); // wallet -> last seen, capped

  constructor(pool: string, t: number) {
    this.pool = pool;
    this.firstSeen = t;
    this.lastSeen = t;
  }

  uniques(now: number, window: number): number {
    let n = 0;
    for (const t of this.wallets.values()) if (t > now - window) n++;
    return n;
  }
}

export interface Snapshot {
  at: number;
  m5: WindowStats;
  h1: WindowStats;
  h24: WindowStats;
  pools: PoolRow[];
  launches: (LaunchEvent & { seenAt: number })[];
  trackedPools: number;
  firstEventAt: number | null; // how much history the 24 h window really holds
}

export class Metrics {
  private readonly minutes = new Series(MIN, DAY);
  private readonly hllBuckets = new Map<number, HyperLogLog>(); // 10-minute buckets
  private readonly recentWallets = new Map<string, number>(); // exact, last hour
  private readonly pools = new Map<string, PoolStats>();
  private readonly launches: (LaunchEvent & { seenAt: number })[] = [];
  private firstEventAt: number | null = null;
  private lastPrune = 0;
  readonly maxPools: number;

  constructor(maxPools = 20_000) {
    this.maxPools = maxPools;
  }

  ingest(e: MarketEvent, t: number): void {
    if (this.firstEventAt === null) this.firstEventAt = t;
    apply(this.minutes.bucket(t), e);

    if (e.kind === 'launch') {
      this.launches.unshift({ ...e, seenAt: t });
      if (this.launches.length > 200) this.launches.length = 200;
    }

    if (e.kind === 'swap' && e.trader) {
      const k = t - (t % (10 * MIN));
      let h = this.hllBuckets.get(k);
      if (!h) {
        h = new HyperLogLog();
        this.hllBuckets.set(k, h);
      }
      h.add(e.trader);
      // backfill replays arrive out of order: never move a last-seen time backwards
      if ((this.recentWallets.get(e.trader) ?? -Infinity) < t) this.recentWallets.set(e.trader, t);
    }

    if (e.pool) {
      const p = this.poolFor(e.pool, t);
      if (t > p.lastSeen) p.lastSeen = t;
      if (e.mint && !p.mint) p.mint = e.mint;
      if (e.dex && !p.dex) p.dex = e.dex;
      if (e.kind === 'launch' && e.symbol) p.symbol = e.symbol;
      if (e.kind === 'swap') {
        if (e.priceUsd !== null) p.priceUsd = e.priceUsd;
        if (e.trader && (p.wallets.has(e.trader) || p.wallets.size < POOL_WALLET_CAP) && (p.wallets.get(e.trader) ?? -Infinity) < t) p.wallets.set(e.trader, t);
      }
      apply(p.minutes.bucket(t), e);
      apply(p.hours.bucket(t), e);
    }

    if (t - this.lastPrune > MIN) this.prune(t);
  }

  private poolFor(pool: string, t: number): PoolStats {
    let p = this.pools.get(pool);
    if (p) {
      // keep Map order = recency, so eviction drops the least recently active pool
      this.pools.delete(pool);
      this.pools.set(pool, p);
      return p;
    }
    p = new PoolStats(pool, t);
    this.pools.set(pool, p);
    if (this.pools.size > this.maxPools) {
      const oldest = this.pools.keys().next().value;
      if (oldest !== undefined) this.pools.delete(oldest);
    }
    return p;
  }

  prune(now: number): void {
    this.lastPrune = now;
    this.minutes.prune(now);
    for (const k of this.hllBuckets.keys()) if (k + 10 * MIN <= now - DAY) this.hllBuckets.delete(k);
    for (const [w, t] of this.recentWallets) if (t <= now - HOUR) this.recentWallets.delete(w);
    for (const [k, p] of this.pools) {
      if (p.lastSeen <= now - DAY) {
        this.pools.delete(k);
        continue;
      }
      p.minutes.prune(now);
      p.hours.prune(now);
      for (const [w, t] of p.wallets) if (t <= now - DAY) p.wallets.delete(w);
    }
  }

  private uniqueExact(now: number, window: number): number {
    let n = 0;
    for (const t of this.recentWallets.values()) if (t > now - window) n++;
    return n;
  }

  private unique24h(now: number): number {
    const merged = new HyperLogLog();
    for (const [k, h] of this.hllBuckets) if (k + 10 * MIN > now - DAY) merged.merge(h);
    return merged.estimate();
  }

  window(now: number, window: number): WindowStats {
    const c = this.minutes.sum(now, window);
    const approx = window > HOUR;
    return {
      ...c,
      buyPressure: buyPressure(c),
      uniqueWallets: approx ? this.unique24h(now) : this.uniqueExact(now, window),
      uniqueApprox: approx,
    };
  }

  poolRows(now: number, limit = 50): PoolRow[] {
    const rows: PoolRow[] = [];
    for (const p of this.pools.values()) {
      const m5 = p.minutes.sum(now, 5 * MIN);
      const h1 = p.minutes.sum(now, HOUR);
      const h24 = p.hours.sum(now, DAY);
      const stats = (c: Counts, w: number): WindowStats => ({
        ...c,
        buyPressure: buyPressure(c),
        uniqueWallets: p.uniques(now, w),
        uniqueApprox: w === DAY && p.wallets.size >= POOL_WALLET_CAP,
      });
      rows.push({
        pool: p.pool,
        mint: p.mint,
        dex: p.dex,
        symbol: p.symbol,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        priceUsd: p.priceUsd,
        m5: stats(m5, 5 * MIN),
        h1: stats(h1, HOUR),
        h24: stats(h24, DAY),
      });
    }
    rows.sort((a, b) => b.h1.volumeUsd - a.h1.volumeUsd || b.h1.trades - a.h1.trades || b.h24.volumeUsd - a.h24.volumeUsd);
    // a pool that was created but has no trade or liquidity move yet is listed under new pools, not here
    return rows.filter((r) => r.h24.trades > 0 || r.h24.liqAddUsd > 0 || r.h24.liqRemoveUsd > 0).slice(0, limit);
  }

  /** Per-pool windows for the alert engine (all tracked pools, unsorted). */
  *allPools(now: number): Generator<PoolRow> {
    for (const p of this.pools.values()) {
      if (p.lastSeen <= now - 5 * MIN) continue; // alerts look at the 5 m window
      const m5 = p.minutes.sum(now, 5 * MIN);
      yield {
        pool: p.pool,
        mint: p.mint,
        dex: p.dex,
        symbol: p.symbol,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        priceUsd: p.priceUsd,
        m5: { ...m5, buyPressure: buyPressure(m5), uniqueWallets: p.uniques(now, 5 * MIN), uniqueApprox: false },
        h1: { ...zero(), buyPressure: null, uniqueWallets: 0, uniqueApprox: false },
        h24: { ...zero(), buyPressure: null, uniqueWallets: 0, uniqueApprox: false },
      };
    }
  }

  snapshot(now: number, poolLimit = 25): Snapshot {
    return {
      at: now,
      m5: this.window(now, 5 * MIN),
      h1: this.window(now, HOUR),
      h24: this.window(now, DAY),
      pools: this.poolRows(now, poolLimit),
      launches: this.launches.slice(0, 50),
      trackedPools: this.pools.size,
      firstEventAt: this.firstEventAt,
    };
  }
}
