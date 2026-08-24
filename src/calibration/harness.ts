import { Engine } from '../engine/engine.js';
import { buildWorld } from '../scenarios/build.js';
import { uk2025 } from '../scenarios/uk2025.js';
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
  const spec = {
    ...uk2025,
    seed: job.seed,
    config: { ...uk2025.config, ...job.overrides },
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

  const firmsAtStart = countFirms(world);
  const startedAt = Date.now();
  const ticks = Math.round(job.years * 365);
  engine.run(ticks);
  const elapsed = Math.max(1, Date.now() - startedAt);

  const firmsAtEnd = countFirms(world);
  const averageFirms = Math.max(1, (firmsAtStart + firmsAtEnd) / 2);

  return { job, summary: summarise(world, job, ticks, elapsed, failures, originations, averageFirms) };
}

function summarise(
  world: WorldState,
  job: CalibrationJob,
  ticks: number,
  elapsedMs: number,
  failures: number,
  originations: number,
  averageFirms: number,
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
    insolvencyRate: failures / Math.max(1, job.years) / averageFirms,

    nim: averageEarning > 0 ? average(netInterest) / averageEarning : 0,
    roe: averageEquity > 0 ? average(profits.slice(1)) / averageEquity : 0,
    costOfRisk: averageLoans > 0 ? average(impairments.slice(1)) / averageLoans : 0,
    finalEquity: equity[equity.length - 1] ?? 0,
    minEquity: equity.length ? Math.min(...equity) : 0,
    survived: equity.every((value) => value > 0),
    originations: originations / Math.max(1, job.years),
  };
}

function countFirms(world: WorldState): number {
  let total = 0;
  for (const id in world.entities) {
    const entity = world.entities[id]!;
    if (entity.kind === 'company') total += 1;
    else if (entity.kind === 'cohort' && entity.memberKind === 'company') total += entity.count;
  }
  return total;
}

function average(values: number[]): number {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : 0;
}

/** Loan book at the end of a run, for eyeballing a single result. */
export function finalLoanBook(world: WorldState): number {
  return naturalBalance(world.ledger, world.playerBankId, AC.LOANS);
}
