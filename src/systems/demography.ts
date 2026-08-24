import { isMonthEnd } from '../core/time.js';
import { personViews, type PersonView } from '../agents/views.js';
import type { WorldState } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

const MONTHS_PER_YEAR = 12;

/**
 * People are born, grow up, work, retire and die.
 *
 * Before this the population was a constant: one number per pool that never
 * moved, everybody of working age for ever. That is a strange thing for an
 * economy to be built on, and it made the labour supply -- the hard limit on
 * output, and the thing wages are bid against -- immovable by anything the
 * economy did.
 *
 * The flows run monthly at a twelfth of the annual rate rather than annually,
 * for the same reason pay settlements are staggered: an economy-wide step
 * applied to everybody on one tick is a synchronisation machine, and the last
 * one cost most of the model's inflation volatility.
 *
 * Money needs no special handling when somebody dies. A pool holds one account
 * between its members, so a death leaves the balance where it is and fewer
 * people sharing it -- the survivors inherit, which is what should happen, and
 * the ledger never sees a penny appear or vanish. A resolved person dying
 * would need `dissolveEntity` to move the balance first; none are ever
 * materialised today, and `forgetOwner` throws rather than destroy money if
 * that ever changes.
 */
export const demographySystem = defineSystem({
  id: 'people.demography',
  phase: PHASE.DEMOGRAPHY,
  description: 'Births, ageing between life stages, retirement and death',
  run(ctx) {
    if (!isMonthEnd(ctx.tick)) return;
    const { world } = ctx;
    const { config } = world;

    let births = 0;
    let deaths = 0;

    for (const person of personViews(world)) {
      if (!person.isCohort) continue;

      const children = person.children;
      const working = person.workingAge;
      const retired = person.retired;
      if (working <= 0 && children <= 0 && retired <= 0) continue;

      // A twelfth of a year's worth of each flow.
      const grewUp = children / (config.yearsAsChild * MONTHS_PER_YEAR);
      const retiredThisMonth = working / (config.yearsWorking * MONTHS_PER_YEAR);
      const died = retired / (config.yearsRetired * MONTHS_PER_YEAR);

      // One birth per worker per working lifetime is exactly replacement, so
      // the prosperity term is the whole of whether a population grows.
      const born =
        (working / (config.yearsWorking * MONTHS_PER_YEAR)) *
        Math.pow(prosperity(world, person), config.fertilityProsperity);

      person.children = children + born - grewUp;
      person.workingAge = working + grewUp - retiredThisMonth;
      person.retired = retired + retiredThisMonth - died;
      person.reconcileCount();

      births += born;
      deaths += died;
    }

    if (births > 0 || deaths > 0) {
      ctx.emit('people.populationChanged', {
        births: Math.round(births),
        deaths: Math.round(deaths),
      });
    }
  },
});

/**
 * How well off a pool's workers are against the living they have got used to.
 *
 * Deliberately measured against the pool's own moving average rather than any
 * fixed figure, so it is free of units, free of the price level, and means the
 * same thing in year one as in year forty. One is "no better off than usual",
 * which is exactly replacement.
 */
export function prosperity(world: WorldState, person: PersonView): number {
  const workers = Math.max(1, person.workingAge);
  const priceIndex = Math.max(1, world.economy.priceIndex);
  const real = person.incomeRate / workers / priceIndex;

  const remembered = person.prosperityReference;
  if (remembered <= 0) {
    person.prosperityReference = real;
    return 1;
  }
  person.prosperityReference = remembered + world.config.prosperityMemory * (real - remembered);
  // Bounded: a boom should not double the birth rate, and a slump should not
  // stop births altogether.
  return Math.max(0.5, Math.min(1.5, real / remembered));
}
