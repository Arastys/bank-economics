import { isMonthEnd } from '../core/time.js';
import { FirmView } from '../agents/views.js';
import { cohorts, type WorldState } from '../world/state.js';
import type { Cohort } from '../world/types.js';
import { PHASE, defineSystem } from './system.js';

const MONTHS_PER_YEAR = 12;

/**
 * Firms are founded and firms fail.
 *
 * Before this the latent population was immortal and barren. Only firms the
 * player had lent to could fail, and nothing anywhere created a firm, so the
 * 22,000 companies inside the pools were scenery: the whole corporate sector
 * could not enter, could not exit, and could not respond to whether being in
 * business was worth it.
 *
 * That distorted the one number it touched most. Insolvency could only be
 * measured against the few hundred firms that had borrowed -- a population
 * selected precisely for having debt to default on -- and read at 3.8% a year
 * against a whole-economy target of 0.7%. The rate was not wrong so much as
 * about a different population. Giving latent firms a failure process is what
 * makes the economy-wide denominator mean anything.
 *
 * Flows run monthly at a twelfth of the annual rate, for the reason given in
 * `people.demography`: an economy-wide step applied on one tick is a
 * synchronisation machine.
 *
 * Money needs no handling here, exactly as for people. A pool holds one
 * account between its members, so a failure leaves the balance where it is and
 * fewer firms sharing it, and an entrant dilutes it. Nothing is created or
 * destroyed and the ledger never sees any of it. A resolved firm failing is a
 * different matter entirely -- it has its own books and its own creditors --
 * and that stays with `windUpBorrower`.
 */
export const firmDemographySystem = defineSystem({
  id: 'firms.demography',
  phase: PHASE.FIRM_DEMOGRAPHY,
  description: 'Firms enter when there is money in it and fail when there is not',
  run(ctx) {
    if (!isMonthEnd(ctx.tick)) return;
    const { world } = ctx;
    const { config } = world;

    let births = 0;
    let deaths = 0;

    for (const cohort of cohorts(world)) {
      if (cohort.memberKind !== 'company' || cohort.count <= 0) continue;

      const exitRate = config.firmExitRate * cycle(world);
      const died = (cohort.count * exitRate) / MONTHS_PER_YEAR;
      const born = died * entryAppetite(world, cohort);

      const before = cohort.count;
      const after = Math.max(0, before + born - died);
      cohort.count = after;

      // Headcount and stock move with the firm count, so the average firm is
      // the same size before and after. Entry and exit reach the economy
      // through how many firms there are -- what they produce, what they
      // charge, how they compete -- and deliberately not through a net drain
      // on employment. A demographic process that quietly sheds jobs is the
      // defect this system replaced, and the labour block is 3 points below
      // its unemployment target already; giving entrants a realistic
      // (smaller-than-average) headcount is worth doing once that is retuned.
      const scale = before > 0 ? after / before : 0;
      cohort.pool.employees = (cohort.pool.employees ?? 0) * scale;
      cohort.pool.inventoryUnits = (cohort.pool.inventoryUnits ?? 0) * scale;

      births += born;
      deaths += died;
    }

    if (births > 0 || deaths > 0) {
      ctx.emit('firms.populationChanged', { births, deaths });
    }
  },
});

/**
 * How much the cycle is killing firms. One is neutral.
 *
 * Bounded below at zero because a boom cannot make firms immortal, and above
 * at three because a slump in this model can drive the output gap a long way
 * negative and failures should not run away with it.
 */
function cycle(world: WorldState): number {
  const factor = 1 - world.config.firmExitCyclicality * world.economy.outputGap;
  return Math.max(0, Math.min(3, factor));
}

/**
 * How keen firms are to enter, as a multiple of the rate they are leaving at.
 * One is exact replacement.
 *
 * Measured on how much business there is per firm against how much the cohort
 * is used to. The point of that choice is that it corrects itself: entry adds
 * firms, which divides the same trade more ways, which closes the gap that
 * caused the entry. A signal the population cannot affect -- the margin
 * against its own moving average, which is what this used to be -- does the
 * opposite. The reference catches up with whatever the margin does, the gap
 * averages to zero, and births equal deaths for ever whatever the economy is
 * doing. That is a stationary population by construction, and an economy that
 * grows should be gaining firms.
 *
 * Against its own past rather than any fixed figure, for the reason
 * `prosperity` is: free of units, free of the price level, and it means the
 * same thing in year one as in year forty. Safe as a ratio here where the
 * margin was not, because trade per firm cannot go negative.
 *
 * It is not unit-elastic. Steady demand growth leaves the count growing more
 * slowly than demand, because a closed gap means exact replacement, so some of
 * the growth has to keep showing up as trade per firm to sustain any entry at
 * all. Faster memory and a higher elasticity get closer.
 */
export function entryAppetite(world: WorldState, cohort: Cohort): number {
  if (cohort.count <= 0) return 1;

  // Nobody starts a business to sell at a loss, whatever the order book looks
  // like. Exit still runs, so a sector under water shrinks.
  const view = new FirmView(cohort);
  const price = view.price;
  const productivity = view.productivity;
  if (price <= 0 || productivity <= 0) return 1;
  if (price - view.wagePerEmployee / productivity <= 0) return 0;

  const perFirm = view.lastSoldUnits / cohort.count;
  if (perFirm <= 0) return 1;

  const remembered = cohort.pool.tradeReference;
  if (remembered === undefined || remembered <= 0) {
    cohort.pool.tradeReference = perFirm;
    return 1;
  }
  cohort.pool.tradeReference = remembered + world.config.firmTradeMemory * (perFirm - remembered);

  const appetite = 1 + world.config.firmEntryElasticity * (perFirm / remembered - 1);
  // Bounded so a good month cannot double the firm population and a bad one
  // cannot stop entry dead.
  return Math.max(0, Math.min(2, appetite));
}
