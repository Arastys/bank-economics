import { instrumentTypes } from '../instruments/registry.js';
import type { InstrumentContext } from '../instruments/types.js';
import { PHASE, defineSystem } from './system.js';

/**
 * Drives every contract's daily life: accrue, pay, mature.
 *
 * The behaviour lives in the registered instrument type, so this system never
 * needs changing when a new product is added.
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
    for (const id of Object.keys(ctx.world.instruments)) {
      const inst = ctx.world.instruments[id];
      if (!inst || inst.status !== 'active') continue;
      const type = instrumentTypes.tryGet(inst.type);
      if (!type) continue;

      type.accrue?.(ictx, inst);
      if (inst.status !== 'active') continue;

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
