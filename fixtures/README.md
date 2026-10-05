# fixtures

Real mainnet recordings made with `npm run record`. Each `.jsonl` starts with a
header line (`recorded_at`, `source`, redacted endpoints, subscribe message).
`<name>.expected.json` holds the figures `npm run report` printed for it;
`npm test` replays the recording and fails if any figure changes.

No recording is committed yet (see PLAN.md).
