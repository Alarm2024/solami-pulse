import { redact } from '../redact.ts';

// A reconnecting WebSocket on the WebSocket client built into Node 22. It reads text frames;
// both Blur and Solana JSON-RPC subscriptions speak JSON.

export interface SocketHooks {
  onOpen(send: (text: string) => void): void;
  onText(text: string, t: number): void;
  onClose(reason: string): void;
}

export interface SocketHandle {
  stop(): void;
}

// Close codes Solami documents for its streams: back off for a minute on these.
const SLOW_RETRY = new Set([4002, 4029]); // bandwidth+balance empty, concurrent stream limit

export function reconnecting(url: string, hooks: SocketHooks, now: () => number = Date.now): SocketHandle {
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 500;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    const sock = new WebSocket(url);
    ws = sock;
    sock.addEventListener('open', () => {
      backoff = 500;
      hooks.onOpen((text) => {
        if (sock.readyState === WebSocket.OPEN) sock.send(text);
      });
    });
    sock.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data === 'string') hooks.onText(ev.data, now());
    });
    sock.addEventListener('close', (ev: CloseEvent) => {
      const reason = redact(`closed ${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`);
      hooks.onClose(reason);
      if (stopped) return;
      const delay = SLOW_RETRY.has(ev.code) ? 60_000 : backoff;
      backoff = Math.min(30_000, backoff * 2);
      timer = setTimeout(connect, delay);
    });
    sock.addEventListener('error', () => {
      // 'close' always follows; reconnect is handled there.
    });
  };

  connect();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // already closed
      }
    },
  };
}
