import { describe, expect, it } from 'vitest';
import { runJob } from '../src/calibration/harness.js';
import { DEFAULT_TARGETS, score, scoreAll, spreadOf } from '../src/calibration/targets.js';
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

  /**
   * A score with no error bar invites conclusions it cannot support. The same
   * configuration scores anywhere from 68 to 148 depending on the seed, so a
   * five-point difference between two configurations means nothing on its own.
   */
  it('reports how much the runs behind an average disagreed', () => {
    const combined = scoreAll(runs);
    expect(combined.spread.runs).toBe(runs.length);
    expect(combined.spread.min).toBeLessThanOrEqual(combined.total);
    expect(combined.spread.max).toBeGreaterThanOrEqual(combined.total);
    expect(combined.spread.standardError).toBeLessThanOrEqual(combined.spread.sd);
  });

  it('gives a single run no spread to hide behind', () => {
    const single = score(runs[0]!);
    expect(single.spread.runs).toBe(1);
    expect(single.spread.sd).toBe(0);
    expect(single.spread.min).toBe(single.total);
  });

  it('shrinks the uncertainty in the mean as runs are added', () => {
    // Same spread either way, so only the number of runs differs. Comparing
    // sets with different spreads would say nothing about sample size.
    const few = spreadOf([10, 20]);
    const many = spreadOf([10, 20, 10, 20, 10, 20, 10, 20]);
    expect(many.sd).toBeCloseTo(few.sd, 9);
    expect(many.standardError).toBeLessThan(few.standardError);
    expect(many.standardError).toBeCloseTo(few.sd / Math.sqrt(8), 9);
  });

  it('copes with no runs at all', () => {
    expect(spreadOf([]).runs).toBe(0);
    expect(spreadOf([]).standardError).toBe(0);
  });

  it('averages across seeds', () => {
    const combined = scoreAll(runs);
    const individually = runs.map((run) => score(run).total);
    const mean = individually.reduce((a, b) => a + b, 0) / individually.length;
    expect(combined.total).toBeCloseTo(mean, 6);
  });
});

describe('what a job can vary', () => {
  it('varies the rules through config overrides', () => {
    const base = runJob({ seed: 4242, years: 1 }).summary;
    const changed = runJob({ seed: 4242, years: 1, overrides: { investmentRate: 0.05 } }).summary;
    expect(changed.inflation.mean).not.toBe(base.inflation.mean);
  });

  /**
   * Some questions are about the shape of the starting world rather than the
   * rules it runs under -- how finely cohorts are split, how many customers
   * the bank opens with -- and no amount of SimConfig reaches those.
   */
  it('varies the starting world through scenario overrides', () => {
    const base = runJob({ seed: 4242, years: 1, scenario: { cohortSubdivision: 1 } }).summary;
    const split = runJob({ seed: 4242, years: 1, scenario: { cohortSubdivision: 8 } }).summary;
    expect(split.inflation.mean).not.toBe(base.inflation.mean);
  });

  it('leaves the scenario alone when nothing is overridden', () => {
    const a = runJob({ seed: 4242, years: 1 }).summary;
    const b = runJob({ seed: 4242, years: 1, scenario: {} }).summary;
    expect(b.inflation.mean).toBe(a.inflation.mean);
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
      // Months in a year, not a knob: it is tied to payReviewMonth being 1-12.
      'PAY_VINTAGES',
      // Also months in a year. The calendar is not a design decision.
      'MONTHS_PER_YEAR',
      'REVIEW_CYCLE',
      'SWEEP_INTERVAL',
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
