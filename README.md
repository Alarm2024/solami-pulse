# solami-pulse

A read-only pulse of Solana mainnet, built on [Solami](https://solami.dev) data.

- **Market**: volume, trade count, unique wallets, buy share of volume, liquidity
  added/removed and new pools over 5 minutes, 1 hour and 24 hours, market-wide and per pool.
- **Alerts** on rules you write (JSON), shown on the dashboard, logged to
  `data/alerts.jsonl`, and optionally POSTed to a URL of your own.
- **Stream health per provider**: Solami and RPC Fast measured side by side on the
  same messages: reconnects, message rate, slot lag, ms behind the first provider
  to report each slot, RPC latency, and an on-chain check of sampled Blur events.

It holds no wallet, signs nothing and sends no transaction. `test/readonly.test.ts`
fails the build if signing or sending code ever appears in `src/`.

<!-- A dashboard screenshot from the first mainnet run goes here (see PLAN.md). -->

## Run it

Needs Node 22.18 or newer (TypeScript runs directly; no build step, no runtime dependencies).

```bash
git clone https://github.com/Alarm2024/solami-pulse && cd solami-pulse
npm install            # dev tools: typescript, and ws for the socket test
cp .env.example .env   # add SOLAMI_API_KEY, and RPCFAST_URL if you have one
npm start              # dashboard on http://127.0.0.1:8787
```

| Variable | Meaning |
|---|---|
| `SOLAMI_API_KEY` | Solami key. Serves Blur, RPC and WebSocket. |
| `RPCFAST_URL` | RPC Fast Solana mainnet endpoint (HTTP). WebSocket URL is derived (https→wss) unless `RPCFAST_WS_URL` is set. |
| `RPC_PROVIDER` | `solami` (default) or `rpcfast`: which provider serves RPC calls (the on-chain check). Both providers' slot streams run whenever both are configured. |
| `BLUR_SUBSCRIBE` | JSON sent to Blur after connecting. `{}` = everything; `{"backfill":30}` (default) also replays recent events, which are de-duplicated. |
| `VERIFY_PER_MINUTE` | How many Blur signatures a minute to look up on chain (default 12). |
| `ALERT_RULES_FILE` | Rules file (default `alerts.example.json`). |
| `ALERT_WEBHOOK_URL` | Optional: your own URL that receives each alert as a JSON POST. Empty = off. |
| `HOST`, `PORT`, `DATA_DIR` | Dashboard bind address (default 127.0.0.1:8787) and where logs go. |

No key yet? Replay a recording: `npm run replay -- fixtures/<file>.jsonl --serve`.

## How it works

```
Solami Blur (wss, decoded events) ──┐
Solami  slotSubscribe (wss) ────────┤
RPC Fast slotSubscribe (wss) ───────┼─► Input ─► Pulse (normalize · dedup · metrics · health · alerts) ─► dashboard
getSlot every 5 s, each provider ───┤      │
getSignatureStatuses (RPC_PROVIDER) ┘      └─► Recorder (JSON Lines, when --record)
```

Every input carries its receipt time. The same `Input` interface is fed by the
sockets, by a recording during replay, and is tee'd to the recorder, so a replay
of a recording produces exactly the numbers the run showed.

### What the numbers mean

| Number | Definition |
|---|---|
| Volume | Sum of `volume_usd` on Blur `swap` events. Swaps without a USD value are counted as trades and listed as "swaps without USD", never priced at zero silently. |
| Trades | Count of `swap` events after de-duplication (signature + transaction/instruction index). |
| Unique wallets | Distinct `trader` addresses. Exact for 5 m and 1 h; over 24 h a HyperLogLog estimate (±0.8 %), shown with "≈". |
| Buy share | Buy USD ÷ (buy USD + sell USD). Falls back to buy count ÷ trades when no USD is known. |
| Liquidity + / − | Sum of USD on Blur `liquidity` events, by direction. |
| New pools | Count of Blur `pool_create` events. |
| Windows | Market-wide: 1-minute buckets. Per pool: 1-minute buckets for 5 m / 1 h, 1-hour buckets for 24 h. The dashboard says how much history the 24 h window really holds. |

### Stream health panel

| Column | Definition |
|---|---|
| msg/s | Messages received in the last 60 s ÷ 60. |
| last msg | Time since the newest message. |
| slot / lag | Newest slot this stream reported; lag = highest slot any stream reported − this one. |
| behind p50/p95 | For each slot: receipt time on this stream − first receipt of that slot on any stream. 0 = first. |
| RPC p50/p95 | Round trip of `getSlot` (every 5 s) and `getSignatureStatuses`. |
| reconnects | Socket opens after the first. |
| verified · missing · slot≠ | Sampled Blur swaps looked up with `getSignatureStatuses` on `RPC_PROVIDER`: found in the same slot · not found within 30 s · found in another slot. |

If a Blur frame of a type we use lacks a field we read, the **Frames** panel
counts it as "missing fields" instead of showing a quiet zero.

## Reproduce every number

```bash
npm run record -- --minutes 10          # writes fixtures/<date>-mainnet-<ms>.jsonl (5 000 Blur frames max by default)
npm run report -- fixtures/<file>.jsonl # prints every figure quoted below
npm run report -- fixtures/<file>.jsonl --write-expected   # pins them; `npm test` then checks the replay matches
npm test
```

A recording's first line says when it was taken, from which endpoints (keys
redacted) and with which subscribe message. Mainnet runs also append a health
snapshot every 10 s to `data/health-<date>.jsonl`.

## Results

> **Placeholder — no mainnet figures yet.** The first run (see PLAN.md, due 9 Oct)
> fills this table from `npm run report`. Nothing here is estimated.

| Figure | Value | From |
|---|---|---|
| Blur frames / duplicates dropped | — | — |
| 24 h volume, trades, unique wallets | — | — |
| Solami vs RPC Fast: ms behind leader p50/p95 | — | — |
| RPC p50/p95 per provider | — | — |
| Verified / missing / slot≠ | — | — |

## Tests

```bash
npm test          # 30+ tests: metrics, alerts, health, record/replay, read-only guard,
                  # end-to-end over local sockets, and every real recording in fixtures/
npm run typecheck
```

Tests with constructed inputs say so at the top of the file; they check
arithmetic and wiring, not the market. Market figures come from recordings in `fixtures/`.

## Hackathon

Built for the Colosseum Crypto World's Fair and submitted to two of its side tracks,
the Solami data track and the RPC Fast Infrastructure Sidetrack. Side-track prizes follow each track's own rules.

## Safety

- Read-only: WebSocket subscriptions and the RPC methods `getSlot`,
  `getSignatureStatuses`, `getHealth`, `getVersion`. The RPC client refuses anything else.
- Keys come from the environment and are redacted from every log line, recording and error.
- No wallet, no seed phrase, no private key is ever asked for or read.

## License

MIT — see [LICENSE](LICENSE). Made by [elghaly](https://elghaly.dev).
