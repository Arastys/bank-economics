import { describe, expect, it } from 'vitest';
import { ZERO, add, allocate, format, formatShort, pence, pounds, scale, toPounds } from '../src/core/money.js';

describe('money', () => {
  it('stores pounds as whole pence', () => {
    expect(pounds(12.34)).toBe(1234);
    expect(pounds(0.1) + pounds(0.2)).toBe(pounds(0.3));
    expect(toPounds(pence(1999))).toBeCloseTo(19.99);
  });

  it('rounds half away from zero', () => {
    expect(scale(pence(101), 0.5)).toBe(51);
    expect(scale(pence(-101), 0.5)).toBe(-51);
  });

  it('allocates without losing or inventing a penny', () => {
    for (const weights of [[1, 1, 1], [2, 3, 5], [0.1, 0.9], [7]]) {
      const total = pence(1000);
      const parts = allocate(total, weights);
      expect(add(...parts)).toBe(total);
      expect(parts).toHaveLength(weights.length);
    }
  });

  it('allocates awkward remainders exactly', () => {
    const parts = allocate(pence(10), [1, 1, 1]);
    expect(add(...parts)).toBe(10);
    expect(parts.sort()).toEqual([3, 3, 4]);
  });

  it('handles zero weights and zero totals', () => {
    expect(add(...allocate(pence(100), [0, 0]))).toBe(100);
    expect(add(...allocate(ZERO, [1, 2]))).toBe(0);
  });

  it('formats for a UK audience', () => {
    expect(format(pounds(1234.5))).toBe('£1,234.50');
    expect(formatShort(pounds(2_400_000))).toBe('£2.40m');
    expect(formatShort(pounds(-1500))).toBe('-£1.5k');
  });
});
