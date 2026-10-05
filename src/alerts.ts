import { readFileSync } from 'node:fs';
import type { WindowStats, PoolRow } from './metrics.ts';
import type { LaunchEvent } from './normalize.ts';
import type { ProviderHealth } from './health.ts';

// User rules, from a JSON file (ALERT_RULES_FILE). Alerts go to the dashboard,
// to data/alerts.jsonl, and — if ALERT_WEBHOOK_URL is set — as a JSON POST
// to the user's own endpoint. Nothing is posted anywhere else.

export type Scope = 'market' | 'pool' | 'launch' | 'provider';
export type Op = '>' | '>=' | '<' | '<=';

export interface Rule {
  id: string;
  scope: Scope;
  metric: string;
  op: Op;
  value: number;
  min_trades_5m?: number; // guard for ratio metrics on thin pools
  cooldown_s?: number; // per rule and subject; default 600
}

export interface Alert {
  at: number;
  rule: string;
  scope: Scope;
  subject: string; // pool address, provider name, 'market'
  label: string; // human label for the subject
  metric: string;
  value: number;
  threshold: string;
}

export const METRICS: Record<Scope, string[]> = {
  market: ['volume_5m_usd', 'trades_5m', 'buy_pressure_5m', 'unique_wallets_5m', 'new_pools_5m', 'liq_removed_5m_usd'],
  pool: ['volume_5m_usd', 'trades_5m', 'buy_pressure_5m', 'unique_wallets_5m', 'liq_added_5m_usd', 'liq_removed_5m_usd'],
  launch: ['liquidity_usd'],
  provider: ['slot_lag', 'last_msg_age_ms', 'reconnects', 'rpc_p50_ms'],
};

export function validateRules(input: unknown): Rule[] {
  if (!Array.isArray(input)) throw new Error('alert rules must be a JSON array');
  const ids = new Set<string>();
  return input.map((r, i) => {
    const rule = r as Rule;
    const where = `rule #${i + 1}${rule?.id ? ` (${rule.id})` : ''}`;
    if (!rule || typeof rule.id !== 'string' || !rule.id) throw new Error(`${where}: id is required`);
    if (ids.has(rule.id)) throw new Error(`${where}: duplicate id`);
    ids.add(rule.id);
    if (!(rule.scope in METRICS)) throw new Error(`${where}: scope must be one of ${Object.keys(METRICS).join(', ')}`);
    if (!METRICS[rule.scope].includes(rule.metric)) {
      throw new Error(`${where}: metric for scope ${rule.scope} must be one of ${METRICS[rule.scope].join(', ')}`);
    }
    if (!['>', '>=', '<', '<='].includes(rule.op)) throw new Error(`${where}: op must be >, >=, < or <=`);
    if (typeof rule.value !== 'number' || !Number.isFinite(rule.value)) throw new Error(`${where}: value must be a number`);
    return rule;
  });
}

export function loadRules(path: string): Rule[] {
  return validateRules(JSON.parse(readFileSync(path, 'utf8')));
}

function cmp(op: Op, a: number, b: number): boolean {
  return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b;
}

function windowMetric(w: WindowStats, metric: string): number | null {
  switch (metric) {
    case 'volume_5m_usd':
      return w.volumeUsd;
    case 'trades_5m':
      return w.trades;
    case 'buy_pressure_5m':
      return w.buyPressure;
    case 'unique_wallets_5m':
      return w.uniqueWallets;
    case 'new_pools_5m':
      return w.launches;
    case 'liq_added_5m_usd':
      return w.liqAddUsd;
    case 'liq_removed_5m_usd':
      return w.liqRemoveUsd;
    default:
      return null;
  }
}

function providerMetric(h: ProviderHealth, metric: string): number | null {
  switch (metric) {
    case 'slot_lag':
      return h.slotLag;
    case 'last_msg_age_ms':
      return h.lastMsgAgeMs;
    case 'reconnects':
      return h.reconnects;
    case 'rpc_p50_ms':
      return h.rpcP50Ms;
    default:
      return null;
  }
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

export class AlertEngine {
  readonly rules: Rule[];
  private readonly last = new Map<string, number>(); // rule|subject -> fired at

  constructor(rules: Rule[]) {
    this.rules = rules;
  }

  private fire(out: Alert[], now: number, rule: Rule, subject: string, label: string, value: number | null, gateTrades?: number): void {
    if (value === null) return;
    if (rule.min_trades_5m !== undefined && (gateTrades ?? 0) < rule.min_trades_5m) return;
    if (!cmp(rule.op, value, rule.value)) return;
    const key = `${rule.id}|${subject}`;
    const cooldown = (rule.cooldown_s ?? 600) * 1000;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < cooldown) return;
    this.last.set(key, now);
    out.push({ at: now, rule: rule.id, scope: rule.scope, subject, label, metric: rule.metric, value, threshold: `${rule.op} ${rule.value}` });
  }

  /** Periodic evaluation of market, pool and provider rules. */
  evaluate(now: number, market5m: WindowStats, pools: Iterable<PoolRow>, providers: ProviderHealth[]): Alert[] {
    const out: Alert[] = [];
    const poolRules = this.rules.filter((r) => r.scope === 'pool');
    for (const rule of this.rules) {
      if (rule.scope === 'market') this.fire(out, now, rule, 'market', 'market', windowMetric(market5m, rule.metric), market5m.trades);
      if (rule.scope === 'provider') for (const h of providers) this.fire(out, now, rule, h.name, h.name, providerMetric(h, rule.metric));
    }
    if (poolRules.length) {
      for (const p of pools) {
        const label = p.symbol || short(p.mint || p.pool);
        for (const rule of poolRules) this.fire(out, now, rule, p.pool, label, windowMetric(p.m5, rule.metric), p.m5.trades);
      }
    }
    return out;
  }

  /** Launch rules run once per new pool, as it arrives. */
  onLaunch(now: number, e: LaunchEvent): Alert[] {
    const out: Alert[] = [];
    for (const rule of this.rules) {
      if (rule.scope !== 'launch') continue;
      this.fire(out, now, rule, e.pool, e.symbol || short(e.mint || e.pool), e.liquidityUsd);
    }
    return out;
  }
}
