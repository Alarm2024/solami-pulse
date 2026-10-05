// Solami Blur frames -> a small set of typed market events.
//
// Blur sends one JSON object per frame with a string `type`. Field names below
// follow Solami's dashboard reference as used by public Blur clients. They are
// checked against a real capture by `npm run record` + `npm test`; any frame of
// a known type that lacks the fields we read is counted as schema drift and
// shown on the dashboard, so a renamed field is visible instead of silently zero.

export interface SwapEvent {
  kind: 'swap';
  id: string; // dedup key: signature + tx/ix indices
  signature: string;
  slot: number | null;
  blockTime: number | null; // unix seconds
  pool: string;
  mint: string;
  dex: string;
  side: 'buy' | 'sell';
  volumeUsd: number | null;
  priceUsd: number | null;
  trader: string;
}

export interface LiquidityEvent {
  kind: 'liquidity';
  id: string;
  signature: string;
  slot: number | null;
  blockTime: number | null;
  pool: string;
  mint: string;
  dex: string;
  direction: 'add' | 'remove';
  usd: number | null;
}

export interface LaunchEvent {
  kind: 'launch';
  id: string;
  signature: string;
  slot: number | null;
  blockTime: number | null;
  pool: string;
  mint: string;
  dex: string; // dex or launchpad label
  name: string;
  symbol: string;
  liquidityUsd: number | null;
}

export type MarketEvent = SwapEvent | LiquidityEvent | LaunchEvent;

export interface NormalizeResult {
  event: MarketEvent | null;
  type: string; // raw frame type ('unknown' if none)
  drift: string[]; // fields a known type was expected to carry but did not
}

const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

type Frame = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstStr(f: Frame, keys: string[]): string {
  for (const k of keys) {
    const v = str(f[k]);
    if (v) return v;
  }
  return '';
}

/** The token of interest: the first non-quote mint, else whatever exists. */
function tokenMint(f: Frame): string {
  const cands = ['mint', 'base_mint', 'token_mint', 'quote_mint'].map((k) => str(f[k])).filter(Boolean);
  return cands.find((c) => !QUOTE_MINTS.has(c)) ?? cands[0] ?? '';
}

function eventId(f: Frame): string {
  const sig = str(f.signature);
  return `${sig}:${str(f.tx_index)}:${str(f.ix_index)}:${str(f.inner_ix_index)}`;
}

function common(f: Frame) {
  return {
    id: eventId(f),
    signature: str(f.signature),
    slot: num(f.slot),
    blockTime: num(f.block_time),
    pool: str(f.pool),
    mint: tokenMint(f),
    dex: firstStr(f, ['dex', 'launchpad', 'program']),
  };
}

function need(f: Frame, keys: string[]): string[] {
  return keys.filter((k) => f[k] === undefined || f[k] === null || f[k] === '');
}

export function normalize(raw: unknown): NormalizeResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { event: null, type: 'unknown', drift: [] };
  }
  const f = raw as Frame;
  const type = typeof f.type === 'string' ? f.type : 'unknown';

  switch (type) {
    case 'swap': {
      const drift = need(f, ['signature', 'pool', 'side', 'volume_usd', 'trader']);
      const side = str(f.side).toLowerCase();
      if (side !== 'buy' && side !== 'sell') drift.push('side(buy|sell)');
      return {
        type,
        drift,
        event: {
          kind: 'swap',
          ...common(f),
          side: side === 'sell' ? 'sell' : 'buy',
          volumeUsd: num(f.volume_usd),
          priceUsd: num(f.price_usd),
          trader: firstStr(f, ['trader', 'wallet', 'owner', 'user']),
        },
      };
    }
    case 'liquidity': {
      const drift = need(f, ['signature', 'pool', 'kind']);
      const usd = num(f.volume_usd) ?? num(f.usd) ?? num(f.quote_amount_usd);
      if (usd === null) drift.push('volume_usd|usd|quote_amount_usd');
      return {
        type,
        drift,
        event: {
          kind: 'liquidity',
          ...common(f),
          direction: str(f.kind).toLowerCase() === 'remove' ? 'remove' : 'add',
          usd,
        },
      };
    }
    case 'pool_create': {
      const drift = need(f, ['pool']);
      return {
        type,
        drift,
        event: {
          kind: 'launch',
          ...common(f),
          name: str(f.name),
          symbol: str(f.symbol),
          liquidityUsd: num(f.liquidity_usd) ?? num(f.initial_liquidity_usd),
        },
      };
    }
    default:
      // token_create, metadata, candle, stats, trending ... are recorded as-is
      // by the recorder but are not needed for the metrics on the dashboard.
      return { event: null, type, drift: [] };
  }
}

/** Remembers recent event ids so Blur's backfill replay never counts twice. */
export class Dedup {
  private seen = new Set<string>();
  private order: string[] = [];
  private readonly cap: number;

  constructor(cap = 200_000) {
    this.cap = cap;
  }

  /** true the first time an id is offered; ids with no signature always pass. */
  fresh(id: string): boolean {
    if (id.startsWith(':')) return true;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.cap) {
      const drop = this.order.splice(0, this.order.length - this.cap);
      for (const d of drop) this.seen.delete(d);
    }
    return true;
  }
}
