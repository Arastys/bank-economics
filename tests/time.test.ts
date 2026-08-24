import { describe, expect, it } from 'vitest';
import {
  addMonths,
  addYears,
  dailyRate,
  formatDay,
  fromDate,
  isBusinessDay,
  isMonthEnd,
  isQuarterEnd,
  isWeekend,
  isYearEnd,
  toDate,
  yearFraction,
} from '../src/core/time.js';

describe('time', () => {
  it('round-trips calendar dates', () => {
    for (const date of [
      { year: 2025, month: 1, day: 1 },
      { year: 2028, month: 2, day: 29 },
      { year: 2031, month: 12, day: 31 },
    ]) {
      expect(toDate(fromDate(date))).toEqual(date);
    }
  });

  it('knows period ends', () => {
    expect(isMonthEnd(fromDate({ year: 2025, month: 1, day: 31 }))).toBe(true);
    expect(isMonthEnd(fromDate({ year: 2025, month: 1, day: 30 }))).toBe(false);
    expect(isMonthEnd(fromDate({ year: 2028, month: 2, day: 29 }))).toBe(true);
    expect(isQuarterEnd(fromDate({ year: 2025, month: 3, day: 31 }))).toBe(true);
    expect(isQuarterEnd(fromDate({ year: 2025, month: 4, day: 30 }))).toBe(false);
    expect(isYearEnd(fromDate({ year: 2025, month: 12, day: 31 }))).toBe(true);
  });

  it('identifies weekends', () => {
    // 4 January 2025 was a Saturday.
    const saturday = fromDate({ year: 2025, month: 1, day: 4 });
    expect(isWeekend(saturday)).toBe(true);
    expect(isWeekend(saturday + 1)).toBe(true);
    expect(isBusinessDay(saturday + 2)).toBe(true);
  });

  it('clamps month arithmetic to the end of short months', () => {
    const jan31 = fromDate({ year: 2025, month: 1, day: 31 });
    expect(toDate(addMonths(jan31, 1))).toEqual({ year: 2025, month: 2, day: 28 });
    expect(toDate(addYears(jan31, 1))).toEqual({ year: 2026, month: 1, day: 31 });
  });

  it('uses ACT/365 fixed', () => {
    expect(yearFraction(0, 365)).toBe(1);
    expect(dailyRate(0.0365)).toBeCloseTo(0.0001, 8);
  });

  it('formats a readable date', () => {
    expect(formatDay(fromDate({ year: 2025, month: 3, day: 9 }))).toBe('09 Mar 2025');
  });
});
