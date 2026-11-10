// Deterministic PRNG (mulberry32). Never use Math.random inside the engine.
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 0x9e3779b9; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  exp(rate: number) { return -Math.log(1 - this.next()) / rate; }
  pick<T>(arr: T[], w: number[]): T {
    let tot = 0; for (const x of w) tot += x;
    let r = this.next() * tot;
    for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  }
}
