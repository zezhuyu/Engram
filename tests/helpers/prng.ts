/** Seeded PRNG (mulberry32) so every fuzz/concurrency failure is replayable from its seed. */
export class Prng {
  private state: number;
  constructor(public readonly seed: number) { this.state = seed >>> 0; }
  next(): number { this.state = (this.state + 0x6d2b79f5) >>> 0; let t = this.state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  int(max: number): number { return Math.floor(this.next() * max); }
  pick<T>(items: readonly T[]): T { return items[this.int(items.length)]!; }
  word(): string { return this.pick(['alpha', 'beta', 'gamma', 'delta', 'épsilon', '知识', 'retrieval', 'cache', 'index', 'ログ', 'naïve', 'zeta']); }
  text(words = 12): string { return Array.from({ length: words }, () => this.word()).join(' '); }
}
