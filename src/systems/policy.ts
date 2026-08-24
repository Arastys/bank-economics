import { isBusinessDay, toDate } from '../core/time.js';
import { centralBank } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

/** Rate decisions are taken on the first business day of the month. */
function isDecisionDay(tick: number): boolean {
  const date = toDate(tick);
  if (!isBusinessDay(tick)) return false;
  for (let d = tick - 1; d >= tick - 6; d--) {
    if (toDate(d).month === date.month && isBusinessDay(d)) return false;
  }
  return true;
}

/**
 * The Monetary Policy Committee.
 *
 * A smoothed Taylor rule: the rate leans against inflation away from target
 * and against the output gap, and moves gradually rather than in one jump.
 */
export const monetaryPolicySystem = defineSystem({
  id: 'policy.monetary',
  phase: PHASE.POLICY,
  description: 'Sets Bank Rate from inflation and the output gap',
  run(ctx) {
    if (!isDecisionDay(ctx.tick)) return;
    const cb = centralBank(ctx.world);
    const { economy, config } = ctx.world;

    const target =
      config.neutralRealRate +
      economy.inflationAnnual +
      config.taylorInflationWeight * (economy.inflationAnnual - cb.inflationTarget) +
      config.taylorOutputWeight * economy.outputGap;

    // Rates move gradually. A committee that jumped straight to the rule's
    // answer every month would drive a policy cycle of its own.
    // Rates move gradually. A committee that jumped straight to the rule's
    // answer every month would drive a policy cycle of its own.
    const inertia = config.policySmoothing;
    const smoothed = inertia * cb.bankRate + (1 - inertia) * target;
    const next = Math.max(0, Math.min(config.maxBankRate, Math.round(smoothed * 10000) / 10000));

    if (Math.abs(next - cb.bankRate) >= 0.0005) {
      const from = cb.bankRate;
      cb.bankRate = next;
      ctx.emit('policy.rateChanged', {
        from,
        to: next,
        reason:
          next > from
            ? `Inflation at ${(economy.inflationAnnual * 100).toFixed(1)}%`
            : `Output gap at ${(economy.outputGap * 100).toFixed(1)}%`,
      });
      ctx.emit('notice', {
        severity: 'info',
        message: `Bank Rate ${next > from ? 'raised' : 'cut'} to ${(next * 100).toFixed(2)}%`,
      });
    }
  },
});
