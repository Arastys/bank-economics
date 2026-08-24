import { Engine } from '../engine/engine.js';
import { buildWorld } from '../scenarios/build.js';
import { uk2025 } from '../scenarios/uk2025.js';
import type { ScenarioSpec } from '../scenarios/types.js';
import { seriesOf } from '../metrics/recorder.js';
import { AC } from '../ledger/accounts.js';
import { naturalBalance } from '../ledger/ledger.js';
import type { SimConfig, WorldState } from '../world/state.js';
import { annualPeaks, annualisedGrowth, settled, spread, type RunSummary } from './summary.js';

export interface CalibrationJob {
  seed: number;
  years: number;
  /** Config values to override for this run. */
  overrides?: Partial<SimConfig>;
  /**
   * Scenario fields to override: the shape of the starting world rather than
   * the rules it runs under. Needed for anything that varies how the economy
   * is built -- how finely cohorts are split, how many customers the bank
   * starts with -- which no amount of SimConfig can reach.
   */
  scenario?: Partial<ScenarioSpec>;
  /** Optional label carried through to the result. */
  label?: string;
}

export interface JobResult {
  job: CalibrationJob;
  summary: RunSummary;
}

/**
 * Run one configuration once and reduce it to a scorecard.
 *
 * Headless, deterministic and self-contained, so a batch of these can be
 * spread across worker threads without any shared state.
 */
export function runJob(job: CalibrationJob): JobResult {
  const spec: ScenarioSpec = {
    ...uk2025,
    ...job.scenario,
    seed: job.seed,
    config: { ...uk2025.config, ...job.scenario?.config, ...job.overrides },
  };
  const world = buildWorld(spec);
  // Balance still gets checked, just not on every one of several thousand
  // ticks: the whole-economy scan is the most expensive thing in a batch run.
  const engine = new Engine(world, { checkInvariantsEvery: 30, activityLimit: 1 });

  let failures = 0;
  let originations = 0;
  engine.bus.on('company.failed', () => {
    failures += 1;
  });
  engine.bus.on('loan.originated', () => {
    originations += 1;
  });

  const startedAt = Date.now();
  const ticks = Math.round(job.years * 365);
  engine.run(ticks);
  const elapsed = Math.max(1, Date.now() - startedAt);

  // Only firms simulated individually can fail: the rest of the economy is
  // latent inside cohorts, which have no failure process of their own yet.
  // Dividing by the whole population would understate the rate roughly
  // fifteen-fold and quietly bias the whole scorecard. When cohort demography
  // lands, this denominator becomes the whole population again.
  const atRisk = Math.max(1, average(seriesOf(world.metrics, 'resolvedFirms')));

  return { job, summary: summarise(world, job, ticks, elapsed, failures, originations, atRisk) };
}

function summarise(
  world: WorldState,
  job: CalibrationJob,
  ticks: number,
  elapsedMs: number,
  failures: number,
  originations: number,
  atRiskFirms: number,
): RunSummary {
  const metrics = world.metrics;
  const equity = seriesOf(metrics, 'equity').filter(Number.isFinite);
  const loans = seriesOf(metrics, 'loans').filter(Number.isFinite);
  const earningAssets = seriesOf(metrics, 'earningAssets').filter(Number.isFinite);

  const interestIncome = annualPeaks(metrics, 'interestIncome');
  const interestExpense = annualPeaks(metrics, 'interestExpense');
  const profits = annualPeaks(metrics, 'profitYtd');
  const impairments = annualPeaks(metrics, 'impairments');

  const averageEquity = average(equity);
  const averageLoans = average(loans);
  const averageEarning = average(earningAssets);

  // Drop the first year of each annual figure: it is a partial year of trading
  // from a standing start, not a representative one.
  const netInterest = interestIncome
    .map((income, i) => income - (interestExpense[i] ?? 0))
    .slice(1);

  return {
    seed: job.seed,
    years: job.years,
    ticks,
    ticksPerSecond: Math.round(ticks / (elapsedMs / 1000)),

    inflation: spread(settled(seriesOf(metrics, 'inflation'))),
    unemployment: spread(settled(seriesOf(metrics, 'unemployment'), 3)),
    bankRate: spread(settled(seriesOf(metrics, 'bankRate'), 3)),
    outputGrowth: annualisedGrowth(seriesOf(metrics, 'output'), job.years),
    priceDrift: annualisedGrowth(seriesOf(metrics, 'priceLevel'), job.years),
    insolvencyRate: failures / Math.max(1, job.years) / atRiskFirms,
    grossMargin: spread(settled(seriesOf(metrics, 'grossMargin'), 3)),

    nim: averageEarning > 0 ? average(netInterest) / averageEarning : 0,
    // Bounded: return on equity goes to infinity as equity approaches zero, and
    // one nearly-insolvent seed would otherwise swamp every other signal in the
    // score. Insolvency is already penalised on its own terms.
    roe: clampRatio(averageEquity > 0 ? average(profits.slice(1)) / averageEquity : 0),
    costOfRisk: averageLoans > 0 ? average(impairments.slice(1)) / averageLoans : 0,
    finalEquity: equity[equity.length - 1] ?? 0,
    minEquity: equity.length ? Math.min(...equity) : 0,
    survived: equity.every((value) => value > 0),
    originations: originations / Math.max(1, job.years),
  };
}

function clampRatio(value: number, limit = 1.5): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-limit, Math.min(limit, value));
}

function average(values: number[]): number {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : 0;
}

/** Loan book at the end of a run, for eyeballing a single result. */
export function finalLoanBook(world: WorldState): number {
  return naturalBalance(world.ledger, world.playerBankId, AC.LOANS);
}
