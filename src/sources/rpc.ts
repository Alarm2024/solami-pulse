import type { Input } from '../pipeline.ts';
import { redact } from '../redact.ts';

// Minimal JSON-RPC over HTTP. Read-only methods only: this file is the one
// place that talks to an RPC endpoint, and test/readonly.test.ts fails the
// build if a sending or signing method ever appears in src/.

export const ALLOWED_METHODS = new Set(['getSlot', 'getSignatureStatuses', 'getHealth', 'getVersion']);

export class Rpc {
  readonly name: string;
  private readonly url: string;
  private readonly input: Input;
  private readonly now: () => number;
  private id = 0;

  constructor(name: string, url: string, input: Input, now: () => number = Date.now) {
    this.name = name;
    this.url = url;
    this.input = input;
    this.now = now;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`refusing non-read RPC method ${method}`);
    const started = performance.now();
    try {
      const r = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      const ms = Math.round(performance.now() - started);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { result?: T; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message ?? 'rpc error');
      this.input.rpc(this.name, method, ms, true, this.now());
      return body.result as T;
    } catch (e) {
      const ms = Math.round(performance.now() - started);
      const msg = redact(e instanceof Error ? e.message : String(e));
      this.input.rpc(this.name, method, ms, false, this.now(), `${method}: ${msg}`);
      throw e;
    }
  }

  getSlot(): Promise<number> {
    return this.call<number>('getSlot', [{ commitment: 'processed' }]);
  }

  getSignatureStatuses(signatures: string[]): Promise<{ value: ({ slot: number; confirmationStatus?: string } | null)[] }> {
    return this.call('getSignatureStatuses', [signatures, { searchTransactionHistory: false }]);
  }
}
