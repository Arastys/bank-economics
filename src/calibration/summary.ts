import { toDate, type Day } from '../core/time.js';
import { seriesOf } from '../metrics/recorder.js';
import type { MetricsState } from '../world/state.js';

export interface Spread {
  mean: number;
  std: number;
  min: number;
  max: number;
}

/**
 * What one simulated run looked like, reduced to the handful of numbers a
 * calibration run can actually be scored on.
 */
export interface RunSummary {
  seed: number;
  years: number;
  ticks: number;
  ticksPerSecond: number;

  inflation: Spread;
  unemployment: Spread;
  bankRate: Spread;
  /** Annualised growth in real output. */
  outputGrowth: number;
  /** Annualised drift in the price level. */
  priceDrift: number;
  /** Share of firms failing per year. */
  insolvencyRate: number;
  /**
   * Price less unit wage cost, across the economy. Nothing in the model
   * defends this, and once it goes negative no borrower can service anything.
   */
  grossMargin: Spread;

  /** Net interest margin: net interest income over average earning assets. */
  nim: number;
  /** Return on equity. */
  roe: number;
  /** Impairments as a share of the loan book, per year. */
  costOfRisk: number;
  finalEquity: number;
  minEquity: number;
  /** False if the bank was ever insolvent. */
  survived: boolean;
  /** Loans written per year. */
  originations: number;
}

export function spread(values: number[]): Spread {
  const usable = values.filter(Number.isFinite);
  if (usable.length === 0) return { mean: 0, std: 0, min: 0, max: 0 };
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  const variance = usable.reduce((total, v) => total + (v - mean) ** 2, 0) / usable.length;
  return { mean, std: Math.sqrt(variance), min: Math.min(...usable), max: Math.max(...usable) };
}

/**
 * Year-to-date series reset every January, so the largest reading inside each
 * calendar year is that year's full figure. Taken this way the annual close
 * cannot swallow it.
 */
export function annualPeaks(metrics: MetricsState, key: string): number[] {
  const series = seriesOf(metrics, key);
  const byYear = new Map<number, number>();
  metrics.samples.forEach((tick: Day, index) => {
    const value = series[index];
    if (value === undefined || !Number.isFinite(value)) return;
    const year = toDate(tick).year;
    byYear.set(year, Math.max(byYear.get(year) ?? Number.NEGATIVE_INFINITY, value));
  });
  return [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
}

/** Skip the opening months, where year-on-year figures have no history yet. */
export function settled(values: number[], skipMonths = 13): number[] {
  return values.length > skipMonths ? values.slice(skipMonths) : values;
}

export function annualisedGrowth(values: number[], years: number): number {
  const usable = values.filter((v) => Number.isFinite(v) && v > 0);
  if (usable.length < 2 || years <= 0) return 0;
  return Math.pow(usable[usable.length - 1]! / usable[0]!, 1 / years) - 1;
}
