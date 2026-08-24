import { netPostings, post, type Posting } from '../ledger/ledger.js';
import { instrumentTypes } from '../instruments/registry.js';
import type { InstrumentContext } from '../instruments/types.js';
import { PHASE, defineSystem } from './system.js';

/**
 * Drives every contract's daily life: accrue, pay, mature.
 *
 * Behaviour lives in the registered instrument type, so this system never
 * needs changing when a new product is added.
 *
 * Accrual is done for the whole economy first and written as a single netted
 * transaction. Interest on thousands of contracts lands on a handful of
 * accounts, so writing one transaction per contract was both enormously
 * wasteful -- it was over two thirds of the entire tick -- and drowned the
 * journal, which held barely a day of history as a result.
 *
 * Doing all accrual before any payment is also more correct than interleaving
 * the two: previously the five-hundredth contract accrued after the first one
 * had already been paid.
 */
export const instrumentSystem = defineSystem({
  id: 'instruments.lifecycle',
  phase: PHASE.INSTRUMENTS,
  description: 'Accrues interest and runs payment and maturity schedules',
  run(ctx) {
    const ictx: InstrumentContext = {
      tick: ctx.tick,
      world: ctx.world,
      ledger: ctx.ledger,
      emit: ctx.emit,
      rng: ctx.rng,
    };

    // Snapshot the ids: handlers may open new contracts, which should not be
    // processed until the next tick.
    const ids = Object.keys(ctx.world.instruments);

    const accruals: Posting[] = [];
    for (const id of ids) {
      const inst = ctx.world.instruments[id];
      if (!inst || inst.status !== 'active') continue;
      const postings = instrumentTypes.tryGet(inst.type)?.accrue?.(ictx, inst);
      if (postings && postings.length > 0) accruals.push(...postings);
    }

    if (accruals.length > 0) {
      post(ctx.ledger, {
        tick: ctx.tick,
        kind: 'instruments.accrual',
        description: 'Daily interest across every contract',
        postings: netPostings(accruals),
      });
    }

    for (const id of ids) {
      const inst = ctx.world.instruments[id];
      if (!inst || inst.status !== 'active') continue;
      const type = instrumentTypes.tryGet(inst.type);
      if (!type) continue;

      if (inst.nextPaymentOn !== undefined && ctx.tick >= inst.nextPaymentOn) {
        type.onPayment?.(ictx, inst);
      }
      if (inst.status !== 'active') continue;

      if (inst.maturesOn !== undefined && ctx.tick >= inst.maturesOn) {
        type.onMature?.(ictx, inst);
      }
    }
  },
});
