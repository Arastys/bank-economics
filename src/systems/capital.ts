import { isMonthEnd } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { naturalBalance } from '../ledger/ledger.js';
import { firmViews, type FirmView } from '../agents/views.js';
import type { LedgerState } from '../ledger/ledger.js';
import type { WorldState } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

/**
 * Capital deepening: what a worker produces depends on what they have to work
 * with.
 *
 * Before this, `productivity` was written once when a firm was born and never
 * again. Fixed assets were bought, depreciated, and counted up in a
 * liquidation, but nothing read them: a firm could double its capital and
 * produce exactly what it did before. That left the model with no route to
 * growth in output per head at all, so an economy could only grow by hiring,
 * against a population that is close to stationary. Trend growth was
 * consequently about zero -- measured at -0.26% a year against a 1.5% target.
 *
 * It also gives the player's lending somewhere to land. Firms fund capacity
 * partly out of borrowing, so credit that is extended today shows up as output
 * for years afterwards, and a credit crunch costs real growth rather than
 * merely rearranging balance sheets.
 *
 * Monthly, because the capital stock moves at the speed depreciation and
 * investment move it and there is nothing to be gained from recomputing a
 * ten-year asset life every day.
 */
export const capitalSystem = defineSystem({
  id: 'economy.capital',
  phase: PHASE.CAPITAL,
  description: 'Sets what a worker produces from the capital behind them',
  run(ctx) {
    if (!isMonthEnd(ctx.tick)) return;
    const { world, ledger } = ctx;
    for (const firm of firmViews(world)) {
      firm.productivity = firm.baseProductivity * capitalFactor(world, ledger, firm);
    }
  },
});

/**
 * How much more (or less) a worker produces than they would at the reference
 * capital per worker.
 *
 * Diminishing returns, at `capitalElasticity` -- roughly the capital share of
 * income, so a doubling of capital per worker is worth about a quarter more
 * output per head rather than twice as much.
 *
 * Bounded either side. A firm that has just been founded, or one whose
 * headcount has collapsed faster than its balance sheet, can show an absurd
 * capital per worker for a month, and an unbounded power of it would hand the
 * economy free output out of an accounting artefact.
 */
export function capitalFactor(world: WorldState, ledger: LedgerState, firm: FirmView): number {
  const workers = firm.employees;
  if (workers <= 0) return 1;

  const capital = naturalBalance(ledger, firm.id, AC.FIXED_ASSETS);
  if (capital <= 0) return MIN_FACTOR;

  const perWorker = capital / workers;
  const reference = world.config.capitalPerWorkerReference;
  if (reference <= 0) return 1;

  const factor = Math.pow(perWorker / reference, world.config.capitalElasticity);
  return Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, factor));
}

/** A firm with no capital at all still has hands, and is not infinitely poor. */
const MIN_FACTOR = 0.25;
/** Nor is one with a warehouse full of machines infinitely productive. */
const MAX_FACTOR = 4;
