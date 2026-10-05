import type { Input } from '../pipeline.ts';
import { reconnecting, type SocketHandle } from './socket.ts';

// Solami Blur: decoded market events over one WebSocket.
// wss://ws.solami.dev/data/subscribe?chain=solana&api_key=...
// After open we send the subscribe message (BLUR_SUBSCRIBE). `{}` is the full
// firehose; `{"backfill":N}` also replays the last N events per type, which the
// pipeline de-duplicates by signature and instruction index.

export function startBlur(url: string, subscribe: string, input: Input, now: () => number = Date.now): SocketHandle {
  return reconnecting(
    url,
    {
      onOpen: (send) => {
        input.open('blur', now());
        send(subscribe);
      },
      onText: (text, t) => {
        let frame: unknown;
        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }
        // Some deployments batch events in an array; accept both shapes.
        if (Array.isArray(frame)) for (const f of frame) input.blurFrame(f, t);
        else input.blurFrame(frame, t);
      },
      onClose: (reason) => input.close('blur', now(), reason),
    },
    now,
  );
}
