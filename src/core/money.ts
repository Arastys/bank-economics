/**
 * Money is stored as a whole number of pence, never as floating-point pounds.
 *
 * The brand stops raw numbers being used as money by accident, and stops money
 * being used with `+` / `*` directly -- all arithmetic goes through the helpers
 * below so that rounding is explicit and consistent everywhere.
 */
declare const MoneyBrand: unique symbol;
export type Money = number & { readonly [MoneyBrand]: true };

export type Rounding = 'half-up' | 'floor' | 'ceil' | 'half-even';

/** Construct money from a whole number of pence. */
export function pence(n: number): Money {
  if (!Number.isFinite(n)) throw new RangeError(`Money must be finite, got ${n}`);
  return Math.round(n) as Money;
}

/** Construct money from pounds. `pounds(12.34)` is 1234p. */
export function pounds(n: number): Money {
  return pence(n * 100);
}

export const ZERO: Money = 0 as Money;

export function add(...values: Money[]): Money {
  let total = 0;
  for (const v of values) total += v;
  return total as Money;
}

export function sub(a: Money, b: Money): Money {
  return (a - b) as Money;
}

export function neg(a: Money): Money {
  return -a as Money;
}

export function abs(a: Money): Money {
  return Math.abs(a) as Money;
}

/** Multiply money by a dimensionless factor (a rate, a share, a growth multiple). */
export function scale(a: Money, factor: number, rounding: Rounding = 'half-up'): Money {
  return round(a * factor, rounding);
}

/** The ratio between two amounts, as a plain number. Zero denominator yields 0. */
export function ratio(a: Money, b: Money): number {
  return b === 0 ? 0 : a / b;
}

export function round(raw: number, rounding: Rounding = 'half-up'): Money {
  switch (rounding) {
    case 'floor':
      return Math.floor(raw) as Money;
    case 'ceil':
      return Math.ceil(raw) as Money;
    case 'half-even': {
      const floor = Math.floor(raw);
      const diff = raw - floor;
      if (diff > 0.5) return (floor + 1) as Money;
      if (diff < 0.5) return floor as Money;
      return (floor % 2 === 0 ? floor : floor + 1) as Money;
    }
    case 'half-up':
    default:
      // Round half away from zero so that -0.5 -> -1, matching intuition for debits.
      return (raw < 0 ? -Math.round(-raw) : Math.round(raw)) as Money;
  }
}

/**
 * Split an amount across weights without losing or inventing a single penny.
 * Largest-remainder method: the residual pennies go to the largest fractions.
 */
export function allocate(total: Money, weights: number[]): Money[] {
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (weightSum === 0) {
    const even = Array<Money>(weights.length).fill(ZERO);
    return distributeRemainder(even, total);
  }
  const exact = weights.map((w) => (total * w) / weightSum);
  const floors = exact.map((x) => Math.floor(x) as Money);
  const allocated = floors.reduce((a, b) => a + b, 0);
  const remainders = exact.map((x, i) => ({ i, frac: x - (floors[i] ?? 0) }));
  remainders.sort((a, b) => b.frac - a.frac);
  let residual = total - allocated;
  const out = [...floors];
  let cursor = 0;
  while (residual !== 0 && remainders.length > 0) {
    const target = remainders[cursor % remainders.length]!;
    const step = residual > 0 ? 1 : -1;
    out[target.i] = ((out[target.i] ?? 0) + step) as Money;
    residual -= step;
    cursor++;
  }
  return out;
}

function distributeRemainder(base: Money[], total: Money): Money[] {
  const out = [...base];
  let residual: number = total;
  let cursor = 0;
  while (residual !== 0) {
    const step = residual > 0 ? 1 : -1;
    out[cursor % out.length] = ((out[cursor % out.length] ?? 0) + step) as Money;
    residual -= step;
    cursor++;
  }
  return out;
}

export function min(a: Money, b: Money): Money {
  return (a < b ? a : b);
}

export function max(a: Money, b: Money): Money {
  return (a > b ? a : b);
}

/** Clamp to zero -- useful when a payment must not exceed what is actually owed. */
export function atLeastZero(a: Money): Money {
  return (a < 0 ? ZERO : a);
}

export function isZero(a: Money): boolean {
  return a === 0;
}

export function toPounds(a: Money): number {
  return a / 100;
}

const GBP = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function format(a: Money): string {
  return GBP.format(toPounds(a));
}

/** Compact form for dashboards: £1.2m, £340k. */
export function formatShort(a: Money): string {
  const p = toPounds(a);
  const sign = p < 0 ? '-' : '';
  const v = Math.abs(p);
  if (v >= 1e9) return `${sign}£${(v / 1e9).toFixed(2)}bn`;
  if (v >= 1e6) return `${sign}£${(v / 1e6).toFixed(2)}m`;
  if (v >= 1e3) return `${sign}£${(v / 1e3).toFixed(1)}k`;
  return `${sign}£${v.toFixed(2)}`;
}
