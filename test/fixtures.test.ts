import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecording } from '../src/recorder.ts';
import { summarize } from '../scripts/report.ts';

// Real recordings are kept in fixtures/ (made with `npm run record`). For each one:
// - the header says when and from where it was recorded;
// - Blur frames of the types we use carry the fields we read (no schema drift);
// - if fixtures/<name>.expected.json exists, a replay reproduces every number in it.

const DIR = 'fixtures';
const recordings = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.jsonl')) : [];

if (recordings.length === 0) {
  test('real mainnet recording', { skip: 'no recording in fixtures/ yet — run `npm run record -- --minutes 10` with SOLAMI_API_KEY set' }, () => {});
}

for (const f of recordings) {
  const path = join(DIR, f);

  test(`${f}: header names date and source`, () => {
    const r = readRecording(path);
    assert.match(r.meta.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(r.meta.source.length > 0);
    assert.ok(!JSON.stringify(r.meta).match(/api_key=(?!\*\*\*)/), 'keys must be redacted');
  });

  test(`${f}: frames carry the fields the pipeline reads`, () => {
    const s = summarize(path);
    assert.ok(s.frames > 0, 'recording has Blur frames');
    assert.deepEqual(s.schema_drift, {}, 'a field we read is missing from real frames — update src/normalize.ts');
  });

  const expected = path.replace(/\.jsonl$/, '.expected.json');
  if (existsSync(expected)) {
    test(`${f}: replay reproduces ${expected}`, () => {
      assert.deepEqual(summarize(path), JSON.parse(readFileSync(expected, 'utf8')));
    });
  }
}
