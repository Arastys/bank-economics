import { describe, expect, it } from 'vitest';
import { runJob } from '../src/calibration/harness.js';
import { DEFAULT_TARGETS, score, scoreAll } from '../src/calibration/targets.js';
import { PARAMETERS } from '../src/calibration/parameters.js';
import { DEFAULT_CONFIG } from '../src/world/state.js';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * Guard rails, not a tuning lock.
 *
 * The bands are deliberately wide: their job is to catch a change that sends
 * the economy into a spiral or bankrupts the bank, not to freeze the current
 * calibration in place. Tightening them is what you do once the numbers are
 * where you want them.
 */
const SEEDS = [1000, 8919];
const YEARS = 3;

const runs = SEEDS.map((seed) => runJob({ seed, years: YEARS }).summary);

describe('macroeconomic guard rails', () => {
  it('does not run away in either direction on prices', () => {
    for (const run of runs) {
      expect(run.inflation.mean).toBeGreaterThan(-0.2);
      expect(run.inflation.mean).toBeLessThan(0.3);
    }
  });

  it('does not collapse employment', () => {
    for (const run of runs) {
      expect(run.unemployment.mean).toBeLessThan(0.35);
      expect(run.unemployment.max).toBeLessThan(0.6);
    }
  });

  it('keeps the price level within an order of magnitude', () => {
    for (const run of runs) {
      expect(Math.abs(run.priceDrift)).toBeLessThan(0.5);
    }
  });

  it('leaves the bank solvent under its default policy', () => {
    for (const run of runs) {
      expect(run.survived).toBe(true);
      expect(run.finalEquity).toBeGreaterThan(0);
    }
  });

  it('keeps the bank actually lending', () => {
    for (const run of runs) {
      expect(run.originations).toBeGreaterThan(0);
      expect(run.nim).toBeGreaterThan(0);
    }
  });

  it('keeps corporate failures in a plausible range', () => {
    for (const run of runs) {
      expect(run.insolvencyRate).toBeGreaterThan(0);
      expect(run.insolvencyRate).toBeLessThan(0.1);
    }
  });
});

describe('scoring', () => {
  it('scores a perfect run at zero', () => {
    const perfect = { ...runs[0]!, survived: true };
    for (const target of DEFAULT_TARGETS) {
      Object.assign(perfect, projectOnto(perfect, target.key, target.target));
    }
    expect(score(perfect).total).toBeCloseTo(0, 6);
  });

  it('punishes an insolvent bank heavily', () => {
    const failed = { ...runs[0]!, survived: false };
    expect(score(failed).total).toBeGreaterThan(score(runs[0]!).total + 40);
  });

  it('averages across seeds', () => {
    const combined = scoreAll(runs);
    const individually = runs.map((run) => score(run).total);
    const mean = individually.reduce((a, b) => a + b, 0) / individually.length;
    expect(combined.total).toBeCloseTo(mean, 6);
  });
});

describe('parameter definitions', () => {
  it('only sweeps parameters that exist, with the baseline inside its range', () => {
    for (const parameter of PARAMETERS) {
      const value = DEFAULT_CONFIG[parameter.key];
      expect(typeof value, `${parameter.key} should be a config number`).toBe('number');
      expect(value as number).toBeGreaterThanOrEqual(parameter.min);
      expect(value as number).toBeLessThanOrEqual(parameter.max);
      expect(parameter.max).toBeGreaterThan(parameter.min);
    }
  });

  /**
   * A parameter that nothing reads is worse than no parameter at all: the
   * sweep dutifully reports it as having no influence, and you conclude the
   * mechanism does not matter when in fact it was never connected. This has
   * already happened once, to eight of them at the same time.
   */
  it('has every swept parameter actually read by the simulation', () => {
    const source = readSource(new URL('../src/', import.meta.url));
    const orphans = PARAMETERS.filter((parameter) => !source.includes(`config.${parameter.key}`));
    expect(orphans.map((p) => p.key)).toEqual([]);
  });

  it('leaves no tuning constant stranded inside a system', () => {
    // Anything a designer would reach for belongs in SimConfig, where the
    // sweep can find it. Structural constants are named in the allowlist.
    const allowed = new Set([
      'BUSINESS_DAY_SHARE',
      'PRICE_HISTORY',
      'REVIEW_CYCLE',
      'SWEEP_INTERVAL',
      'COHORT_CHURN',
      'DEBT_SERVICE_HORIZON',
      'MIN_WINDOW_DAYS',
      'TRUST_WINDOW_DAYS',
      'BUSINESS_DAYS',
      'FUNDING_STEP',
      'CURVE_TENORS',
      'INSOLVENCY_PENALTY',
      'PARAMETERS',
      'DEFAULT_TARGETS',
    ]);
    const stranded: string[] = [];
    for (const [file, text] of sourceFiles(new URL('../src/systems/', import.meta.url))) {
      for (const match of text.matchAll(/^const ([A-Z][A-Z0-9_]+) = [-\d]/gm)) {
        if (!allowed.has(match[1]!)) stranded.push(`${file}: ${match[1]}`);
      }
    }
    expect(stranded).toEqual([]);
  });
});

function sourceFiles(dir: URL): [string, string][] {
  const out: [string, string][] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) out.push(...sourceFiles(child));
    else if (entry.name.endsWith('.ts')) out.push([entry.name, readFileSync(child, 'utf8')]);
  }
  return out;
}

function readSource(dir: URL): string {
  return sourceFiles(dir)
    .map(([, text]) => text)
    .join('\n');
}

/** Set whichever summary field a target reads, so it lands exactly on target. */
function projectOnto(summary: ReturnType<typeof runJob>['summary'], key: string, value: number) {
  switch (key) {
    case 'inflation':
      return { inflation: { ...summary.inflation, mean: value } };
    case 'inflationVolatility':
      return { inflation: { ...summary.inflation, std: value } };
    case 'unemployment':
      return { unemployment: { ...summary.unemployment, mean: value } };
    case 'unemploymentVolatility':
      return { unemployment: { ...summary.unemployment, std: value } };
    case 'outputGrowth':
      return { outputGrowth: value };
    case 'insolvencyRate':
      return { insolvencyRate: value };
    case 'nim':
      return { nim: value };
    case 'costOfRisk':
      return { costOfRisk: value };
    case 'roe':
      return { roe: value };
    default:
      return {};
  }
}
