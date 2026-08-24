import type { Day } from '../core/time.js';
import type { MetricsState } from '../world/state.js';

export function createMetrics(capacity = 600): MetricsState {
  return { samples: [], series: {}, capacity };
}

/** Append one sample across a set of named series. */
export function record(metrics: MetricsState, tick: Day, values: Record<string, number>): void {
  metrics.samples.push(tick);
  for (const key in values) {
    const series = (metrics.series[key] ??= []);
    // Back-fill so every series stays the same length as `samples`.
    while (series.length < metrics.samples.length - 1) series.push(Number.NaN);
    series.push(values[key]!);
  }
  for (const key in metrics.series) {
    const series = metrics.series[key]!;
    while (series.length < metrics.samples.length) series.push(Number.NaN);
  }

  if (metrics.samples.length > metrics.capacity) {
    const excess = metrics.samples.length - metrics.capacity;
    metrics.samples.splice(0, excess);
    for (const key in metrics.series) metrics.series[key]!.splice(0, excess);
  }
}

export function seriesOf(metrics: MetricsState, key: string): number[] {
  return metrics.series[key] ?? [];
}

export function latest(metrics: MetricsState, key: string): number | undefined {
  const series = metrics.series[key];
  return series && series.length > 0 ? series[series.length - 1] : undefined;
}
