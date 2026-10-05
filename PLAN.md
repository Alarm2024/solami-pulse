# PLAN — solami-pulse

A read-only market pulse for Solana mainnet, built on Solami data, with a
stream-health panel that compares RPC providers (Solami and RPC Fast) on the
same messages at the same moment.

## Dates (UTC)

| When | What |
|---|---|
| Sun 5 Oct | Code, tests and docs in this repo (done: see "Status"). |
| by Thu 9 Oct | **MVP on mainnet**: Wyndham's Solami key and RPC Fast endpoint in `.env`, `npm start` runs for 24 h, first real recording committed to `fixtures/` with its `.expected.json`. |
| by Sat 11 Oct | **Demo**: 2–3 min screen recording from a mainnet run (script written after the first mainnet recording), numbers in the README replaced by figures from that run. |
| Sun 12 Oct | Colosseum Crypto World's Fair submission (main hackathon) — confirm the hour on colosseum.com. |
| Mon 13 Oct, 06:59 | Superteam deadline for both side tracks (Solami, RPC Fast). |

## Scope

In:
- Solami **Blur** decoded events (swaps, liquidity, new pools) over one WebSocket.
- Market metrics over 5 m / 1 h / 24 h: volume (USD), trade count, unique wallets,
  buy share of volume (buy/sell pressure), liquidity added/removed, new pools.
- Per-pool table, new-pool feed, user alert rules (JSON), alert log and an optional
  webhook to the user's own URL.
- **Pluggable RPC**: Solami is the default; `RPC_PROVIDER=rpcfast` moves RPC calls
  (on-chain verification of sampled Blur events) to RPC Fast. Both providers'
  slot streams run side by side whenever both are configured.
- **Stream health panel** from receipt timestamps: connected, reconnects, msg/s,
  age of last message, newest slot, slot lag, ms behind the first provider per
  slot (p50/p95), RPC latency (p50/p95), verified / missing / slot-mismatch counts.
- Record and replay: every input is written to JSON Lines with a dated, redacted
  header; a replay reproduces every number (`npm run report`).

Out (on purpose):
- No Beam, no transaction building, no signing, no sending, no wallet. A test fails
  the build if any of that appears in `src/`.
- No Telegram/Discord bot. Alerts stay on the user's machine unless they set
  their own webhook.

## How each listing is met

**Solami data track** (judged on Solami usage,
working demo, build quality, usefulness, creativity)
- Solami does the real work: Blur is the data source for every market number;
  Solami RPC/WS is one of the measured providers and the default RPC backend.
- Runnable: `npm install && npm start` with one key; Node 22, no runtime dependencies.
- Build quality: typed TypeScript, 30+ tests including an end-to-end socket test,
  CI, deterministic replay of real recordings.
- Usefulness: the per-provider health panel answers "can I trust this stream right
  now?", and the verification column checks Blur against the chain.

**RPC Fast — Infrastructure Sidetrack** (judged on project, real infra use,
community, impact)
- RPC Fast endpoint (Frankfurt) as a first-class backend (`RPC_PROVIDER=rpcfast`),
  measured on the same panel as Solami from real runs.
- Owner actions (not code): claim the free Focus plan, follow @rpcfast, join their
  community, post 2–3 times a month for two months (drafts written from the first mainnet recording).

## Open questions for Wyndham

1. Both listings were not readable from the build machine (network policy). Before
   submitting, check on each listing page that one project may enter both side
   tracks, and whether a main Colosseum submission is required (the brief says yes).
2. Does the Focus plan include WebSocket subscriptions? If not, set `RPCFAST_WS_URL`
   empty and the panel shows RPC Fast as HTTP: latency and verification, no slot stream.

## Status (5 Oct)

- [x] Code: Blur source, slot streams, read-only RPC, verifier, metrics, alerts, dashboard.
- [x] Tests: unit, record/replay round trip, read-only guard, end-to-end over local sockets.
- [ ] First mainnet recording (needs `SOLAMI_API_KEY`; the build machine cannot reach mainnet).
- [ ] 24 h run and numbers in README.
- [ ] Demo video.
