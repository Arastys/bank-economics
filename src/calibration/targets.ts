import type { RunSummary } from './summary.js';

/**
 * What "balanced" means, as numbers.
 *
 * Hand-tuning a simulation is guesswork until the goal is written down. These
 * are broadly UK figures over a normal cycle; they are a starting position for
 * a designer to argue with, not gospel.
 */
export interface Target {
  key: string;
  label: string;
  /** Where we want it. */
  target: number;
  /**
   * One unit of badness. Being this far off scores 1; twice as far scores 4,
   * because the penalty is squared.
   */
  tolerance: number;
  weight: number;
  read(summary: RunSummary): number;
  format?(value: number): string;
}

const asPercent = (value: number): string => `${(value * 100).toFixed(2)}%`;

export const DEFAULT_TARGETS: Target[] = [
  {
    key: 'inflation',
    label: 'Inflation',
    target: 0.02,
    tolerance: 0.01,
    weight: 2,
    read: (s) => s.inflation.mean,
    format: asPercent,
  },
  {
    key: 'inflationVolatility',
    label: 'Inflation volatility',
    target: 0.01,
    tolerance: 0.015,
    weight: 1.5,
    read: (s) => s.inflation.std,
    format: asPercent,
  },
  {
    key: 'unemployment',
    label: 'Unemployment',
    target: 0.045,
    tolerance: 0.015,
    weight: 2,
    read: (s) => s.unemployment.mean,
    format: asPercent,
  },
  {
    key: 'unemploymentVolatility',
    label: 'Unemployment volatility',
    target: 0.01,
    tolerance: 0.015,
    weight: 1,
    read: (s) => s.unemployment.std,
    format: asPercent,
  },
  {
    key: 'outputGrowth',
    label: 'Real output growth',
    target: 0.015,
    tolerance: 0.02,
    weight: 1,
    read: (s) => s.outputGrowth,
    format: asPercent,
  },
  {
    key: 'insolvencyRate',
    label: 'Corporate insolvency rate',
    target: 0.007,
    tolerance: 0.006,
    weight: 1.5,
    read: (s) => s.insolvencyRate,
    format: asPercent,
  },
  {
    key: 'nim',
    label: 'Net interest margin',
    target: 0.025,
    tolerance: 0.012,
    weight: 1,
    read: (s) => s.nim,
    format: asPercent,
  },
  {
    key: 'costOfRisk',
    label: 'Cost of risk',
    target: 0.01,
    tolerance: 0.01,
    weight: 1.5,
    read: (s) => s.costOfRisk,
    format: asPercent,
  },
  {
    key: 'roe',
    label: 'Return on equity',
    target: 0.1,
    tolerance: 0.08,
    weight: 1,
    read: (s) => s.roe,
    format: asPercent,
  },
];

/** A run where the bank went under is a failed run, whatever else it scored. */
export const INSOLVENCY_PENALTY = 50;

export interface ScoreComponent {
  key: string;
  label: string;
  observed: number;
  target: number;
  penalty: number;
  formatted: string;
}

/**
 * How much the runs behind an average disagreed with each other.
 *
 * Without this a score is a number with no error bar, and two configurations
 * that differ by less than the spread look meaningfully different when they
 * are not. Across eight seeds of the same configuration the total ranges from
 * 68 to 148, so this is not a small effect.
 */
export interface Spread {
  runs: number;
  sd: number;
  /** Uncertainty in the mean itself: sd / sqrt(runs). */
  standardError: number;
  min: number;
  max: number;
}

export interface Score {
  total: number;
  components: ScoreComponent[];
  spread: Spread;
}

/** Lower is better. Zero would be every target hit exactly. */
export function score(summary: RunSummary, targets: Target[] = DEFAULT_TARGETS): Score {
  const components = targets.map((target) => {
    const observed = target.read(summary);
    const deviation = Number.isFinite(observed) ? (observed - target.target) / target.tolerance : 10;
    return {
      key: target.key,
      label: target.label,
      observed,
      target: target.target,
      penalty: target.weight * deviation ** 2,
      formatted: (target.format ?? String)(observed),
    };
  });

  const total =
    components.reduce((sum, component) => sum + component.penalty, 0) +
    (summary.survived ? 0 : INSOLVENCY_PENALTY);

  return { total, components, spread: { runs: 1, sd: 0, standardError: 0, min: total, max: total } };
}

/** Average the score across seeds, so a config is judged on more than luck. */
export function scoreAll(summaries: RunSummary[], targets: Target[] = DEFAULT_TARGETS): Score {
  const scores = summaries.map((summary) => score(summary, targets));
  const components = (scores[0]?.components ?? []).map((_, index) => {
    const across = scores.map((s) => s.components[index]!);
    return {
      key: across[0]!.key,
      label: across[0]!.label,
      observed: mean(across.map((c) => c.observed)),
      target: across[0]!.target,
      penalty: mean(across.map((c) => c.penalty)),
      formatted: across[0]!.formatted,
    };
  });
  const totals = scores.map((s) => s.total);
  return { total: mean(totals), components, spread: spreadOf(totals) };
}

export function spreadOf(values: number[]): Spread {
  const usable = values.filter(Number.isFinite);
  if (usable.length === 0) return { runs: 0, sd: 0, standardError: 0, min: 0, max: 0 };
  const average = mean(usable);
  const variance = usable.reduce((total, value) => total + (value - average) ** 2, 0) / usable.length;
  const sd = Math.sqrt(variance);
  return {
    runs: usable.length,
    sd,
    standardError: sd / Math.sqrt(usable.length),
    min: Math.min(...usable),
    max: Math.max(...usable),
  };
}

function mean(values: number[]): number {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : 0;
}
