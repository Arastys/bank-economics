/**
 * Deterministic randomness.
 *
 * Nothing in the simulation may call `Math.random()`. Every draw comes from a
 * generator derived from (world seed, named stream, tick). Deriving rather than
 * sharing one global generator matters for expandability: adding a new system
 * that consumes randomness cannot shift the number sequence seen by any
 * existing system, so old scenarios keep replaying identically.
 */
export type Rng = () => number;

/** FNV-1a, used to fold stream names into the seed. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mixSeeds(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for a game, trivially reproducible. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The generator a system should use on a given tick. */
export function streamRng(worldSeed: number, stream: string, tick: number): Rng {
  return makeRng(mixSeeds(worldSeed, hashString(stream), tick));
}

/**
 * A generator tied to a stable identity rather than to time. Used to give a
 * latent agent the same characteristics every time it is materialised.
 */
export function identityRng(worldSeed: number, identity: string): Rng {
  return makeRng(mixSeeds(worldSeed, hashString(identity)));
}

export function randInt(rng: Rng, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function bernoulli(rng: Rng, p: number): boolean {
  return rng() < p;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('pick from empty array');
  return items[Math.floor(rng() * items.length)]!;
}

export function weightedPick<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i] ?? 0;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

/** Standard normal via Box-Muller. */
export function normal(rng: Rng, mean = 0, stdDev = 1): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Log-normal -- the workhorse for firm sizes, incomes and other positive skewed quantities. */
export function logNormal(rng: Rng, mu: number, sigma: number): number {
  return Math.exp(normal(rng, mu, sigma));
}

export function exponential(rng: Rng, rate: number): number {
  return -Math.log(1 - rng()) / rate;
}

/** Fisher-Yates, non-mutating. */
export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
