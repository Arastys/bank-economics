import { priceBond } from '../instruments/bond.js';
import { centralBank } from '../world/state.js';
import { CREDIT_GRADES, type CreditGrade } from '../world/types.js';
import { PHASE, defineSystem } from './system.js';

export const CURVE_TENORS = [0.25, 1, 2, 5, 10, 30];

/** Spread over the risk-free curve in normal conditions, by grade. */
const BASE_SPREAD: Record<CreditGrade, number> = {
  AAA: 0.004,
  AA: 0.006,
  A: 0.010,
  BBB: 0.018,
  BB: 0.035,
  B: 0.060,
  CCC: 0.110,
};

/**
 * Rates and prices.
 *
 * The curve is anchored at Bank Rate, pulled towards the long-run neutral rate
 * as tenor lengthens, plus a term premium. Credit spreads widen when the
 * economy is below potential.
 */
export const marketsSystem = defineSystem({
  id: 'markets.rates',
  phase: PHASE.MARKETS,
  description: 'Builds the yield curve, credit spreads and bond prices',
  run(ctx) {
    const { world } = ctx;
    const cb = centralBank(world);
    const { markets, economy, config } = world;

    markets.interbankRate = cb.bankRate + 0.0005;

    const neutralNominal = config.neutralRealRate + cb.inflationTarget;
    for (const tenor of CURVE_TENORS) {
      const meanReversion = 1 - Math.exp(-tenor / 5);
      const termPremium = 0.008 * (1 - Math.exp(-tenor / 4));
      markets.yieldCurve[tenor] = cb.bankRate + (neutralNominal - cb.bankRate) * meanReversion + termPremium;
    }

    // A weak economy makes lenders want more compensation for the same risk.
    const stress = Math.max(0, -economy.outputGap) * 4;
    for (const grade of CREDIT_GRADES) {
      const base = BASE_SPREAD[grade];
      markets.creditSpreads[grade] = base * (1 + stress);
    }

    for (const id in world.instruments) {
      const inst = world.instruments[id]!;
      if (inst.type.startsWith('bond.') && inst.status === 'active') {
        markets.bondPrices[id] = priceBond(world, inst, ctx.tick);
      }
    }
  },
});
