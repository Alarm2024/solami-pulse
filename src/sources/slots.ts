import type { Input } from '../pipeline.ts';
import { reconnecting, type SocketHandle } from './socket.ts';

// Standard Solana JSON-RPC `slotSubscribe` on each provider's WebSocket. This is
// the cheapest stream there is, and it is enough to compare providers fairly:
// same message, same moment, who reports each slot first.

export function parseSlotNotification(text: string): number | null {
  try {
    const m = JSON.parse(text) as { method?: string; params?: { result?: { slot?: unknown } } };
    if (m.method !== 'slotNotification') return null;
    const s = Number(m.params?.result?.slot);
    return Number.isSafeInteger(s) && s > 0 ? s : null;
  } catch {
    return null;
  }
}

export function startSlots(name: string, wsUrl: string, input: Input, now: () => number = Date.now): SocketHandle {
  return reconnecting(
    wsUrl,
    {
      onOpen: (send) => {
        input.open(name, now());
        send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' }));
      },
      onText: (text, t) => {
        const slot = parseSlotNotification(text);
        if (slot !== null) input.slot(name, slot, t);
      },
      onClose: (reason) => input.close(name, now(), reason),
    },
    now,
  );
}
