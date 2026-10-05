import { readFileSync, existsSync } from 'node:fs';

// Configuration comes from the environment. `.env` is read if present so
// `npm start` works without a dotenv dependency; real values never belong in git.

export type ProviderName = 'solami' | 'rpcfast';

export interface ProviderConfig {
  name: ProviderName;
  httpUrl: string; // JSON-RPC over HTTP
  wsUrl: string; // JSON-RPC over WebSocket (slotSubscribe)
}

export interface Config {
  solamiApiKey: string;
  blurUrl: string;
  blurSubscribe: string; // raw JSON sent after the socket opens
  providers: ProviderConfig[]; // every provider with a URL; all are measured
  rpcProvider: ProviderName; // the one that serves RPC calls (verification)
  verifyPerMinute: number;
  alertRulesFile: string;
  alertWebhookUrl: string;
  port: number;
  host: string;
  dataDir: string;
}

export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, k, raw] = m as unknown as [string, string, string];
    if (process.env[k] !== undefined) continue;
    process.env[k] = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
}

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function withKey(url: string, key: string): string {
  if (!key || /[?&]api_key=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key);
}

export function wsFromHttp(url: string): string {
  return url.replace(/^http(s?):\/\//, 'ws$1://');
}

export function loadConfig(): Config {
  const key = env('SOLAMI_API_KEY');
  const providers: ProviderConfig[] = [];
  if (key) {
    providers.push({
      name: 'solami',
      httpUrl: withKey(env('SOLAMI_RPC_URL', 'https://rpc.solami.dev/sol'), key),
      wsUrl: withKey(env('SOLAMI_WS_URL', 'wss://ws.solami.dev/ws/sol'), key),
    });
  }
  const fastHttp = env('RPCFAST_URL');
  if (fastHttp) {
    providers.push({
      name: 'rpcfast',
      httpUrl: fastHttp,
      wsUrl: env('RPCFAST_WS_URL', wsFromHttp(fastHttp)),
    });
  }
  const want = env('RPC_PROVIDER', 'solami');
  if (want !== 'solami' && want !== 'rpcfast') {
    throw new Error(`RPC_PROVIDER must be solami or rpcfast, got "${want}"`);
  }
  const blurBase = env('SOLAMI_BLUR_URL', 'wss://ws.solami.dev/data/subscribe');
  return {
    solamiApiKey: key,
    blurUrl: withKey(blurBase.includes('chain=') ? blurBase : blurBase + (blurBase.includes('?') ? '&' : '?') + 'chain=solana', key),
    blurSubscribe: env('BLUR_SUBSCRIBE', '{"backfill":30}'),
    providers,
    rpcProvider: want,
    verifyPerMinute: Number(env('VERIFY_PER_MINUTE', '12')),
    alertRulesFile: env('ALERT_RULES_FILE', 'alerts.example.json'),
    alertWebhookUrl: env('ALERT_WEBHOOK_URL'),
    port: Number(env('PORT', '8787')),
    host: env('HOST', '127.0.0.1'),
    dataDir: env('DATA_DIR', 'data'),
  };
}
