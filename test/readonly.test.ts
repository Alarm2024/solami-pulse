import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWED_METHODS } from '../src/sources/rpc.ts';
import { redact } from '../src/redact.ts';

// The build fails if this project ever learns to sign or send.

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const FORBIDDEN = [
  /sendTransaction/i,
  /sendRawTransaction/i,
  /sendBundle/i,
  /signTransaction/i,
  /signAllTransactions/i,
  /Keypair/,
  /secretKey/i,
  /privateKey/i,
  /seed ?phrase/i,
  /mnemonic/i,
  /\bbeam\b/i, // Solami's transaction-sending product: not used here
  /requestAirdrop/i,
];

test('no source file can sign or send a transaction', () => {
  for (const f of [...files('src'), ...files('public')]) {
    const text = readFileSync(f, 'utf8');
    for (const re of FORBIDDEN) assert.ok(!re.test(text), `${f} matches ${re}`);
  }
});

test('the RPC client allows read methods only', () => {
  assert.deepEqual([...ALLOWED_METHODS].sort(), ['getHealth', 'getSignatureStatuses', 'getSlot', 'getVersion']);
});

test('package.json has no wallet or signing dependency', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string> };
  const deps = Object.keys(pkg.dependencies ?? {});
  for (const d of deps) assert.ok(!/web3|wallet|anchor|kit|signer/i.test(d), `unexpected dependency ${d}`);
});

test('keys are redacted from URLs and error text', () => {
  assert.equal(redact('wss://ws.solami.dev/data/subscribe?chain=solana&api_key=abc123'), 'wss://ws.solami.dev/data/subscribe?chain=solana&api_key=***');
  assert.equal(redact('https://rpc.example.com/v1/AbCdEfGhIjKlMnOpQrStUvWx'), 'https://rpc.example.com/v1/***');
  assert.equal(redact('https://x.io/?token=t0k&x=1'), 'https://x.io/?token=***&x=1');
  assert.equal(redact('https://rpc.solami.dev/sol'), 'https://rpc.solami.dev/sol');
});

test('.env.example holds placeholders only', () => {
  for (const line of readFileSync('.env.example', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2] ?? '';
    assert.ok(!/[A-Za-z0-9]{24,}/.test(value), `${m[1]} looks like a real secret`);
  }
});
