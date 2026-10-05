// HyperLogLog for "unique wallets in 24 hours" without holding every address.
// p = 14 -> 16 384 one-byte registers, standard error 1.04 / sqrt(2^14) ≈ 0.81 %.

const P = 14;
const M = 1 << P;
const ALPHA = 0.7213 / (1 + 1.079 / M);

/** cyrb53: a fast 53-bit string hash with good spread (public domain). */
export function hash53(s: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export class HyperLogLog {
  readonly registers = new Uint8Array(M);

  add(value: string): void {
    const h = hash53(value);
    const idx = h % M; // low P bits
    let rest = Math.floor(h / M); // remaining 39 bits
    let rank = 1;
    while (rank <= 39 && (rest & 1) === 0) {
      rank++;
      rest = Math.floor(rest / 2);
    }
    if (rank > (this.registers[idx] ?? 0)) this.registers[idx] = rank;
  }

  merge(other: HyperLogLog): void {
    const a = this.registers;
    const b = other.registers;
    for (let i = 0; i < M; i++) if ((b[i] ?? 0) > (a[i] ?? 0)) a[i] = b[i] ?? 0;
  }

  estimate(): number {
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < M; i++) {
      const r = this.registers[i] ?? 0;
      sum += 2 ** -r;
      if (r === 0) zeros++;
    }
    const raw = (ALPHA * M * M) / sum;
    if (raw <= 2.5 * M && zeros > 0) return Math.round(M * Math.log(M / zeros)); // linear counting
    return Math.round(raw);
  }
}
