import { ZERO, allocate, atLeastZero, min, sub, type Money } from '../core/money.js';
import { isBusinessDay } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { clearMarket, spendable, type MarketLeg } from '../world/transfer.js';
import { firmViews, householdViews, totalWageBill, type HouseholdView } from '../agents/views.js';
import { PHASE, defineSystem } from './system.js';

/** Share of the population in the labour market. Mirrors the hiring system. */
const PARTICIPATION = 0.96;

/**
 * Firms produce and pay wages.
 *
 * Output is capitalised into inventory rather than expensed, so the cost of a
 * unit follows it through to the income statement when it is actually sold.
 * A firm that cannot meet its wage bill produces proportionately less and
 * registers a funding need -- which is where most credit demand comes from.
 */
export const productionSystem = defineSystem({
  id: 'economy.production',
  phase: PHASE.PRODUCTION,
  description: 'Firms produce output and pay wages to households',
  run(ctx) {
    if (!isBusinessDay(ctx.tick)) return;
    const { world, ledger } = ctx;

    const households = householdViews(world);
    const byRegion = new Map<string, HouseholdView[]>();
    for (const h of households) {
      const list = byRegion.get(h.region) ?? [];
      list.push(h);
      byRegion.set(h.region, list);
    }
    for (const h of households) h.lastIncome = ZERO;

    const payers: MarketLeg[] = [];
    const receipts = new Map<string, number>();
    let outputUnits = 0;
    let employed = 0;

    for (const firm of firmViews(world)) {
      if (firm.employees <= 0) continue;
      const wageBill = totalWageBill(firm);
      const funds = spendable(world, ledger, firm.id);
      const paid = min(wageBill, funds);
      const coverage = wageBill > 0 ? paid / wageBill : 1;

      const produced = firm.employees * firm.productivity * coverage;
      firm.inventoryUnits += produced;
      outputUnits += produced;
      employed += firm.employees * coverage;

      const company = firm.company;
      if (company) {
        const shortfall = sub(wageBill, paid);
        // An unmet wage bill is the firm's most urgent reason to borrow.
        company.fundingNeed = shortfall > 0 ? (Math.max(company.fundingNeed, shortfall * 20) as Money) : ZERO;
      }

      if (paid <= 0) continue;
      payers.push({ id: firm.id, amount: paid, contra: AC.INVENTORY });

      // Wages go to households where the firm actually is, weighted by how
      // many of them are in work.
      const recipients = byRegion.get(firm.region) ?? households;
      const weights = recipients.map((h) => Math.max(0, h.employed));
      const shares = allocate(paid, weights);
      recipients.forEach((h, i) => {
        const share = shares[i] ?? ZERO;
        if (share <= 0) return;
        receipts.set(h.id, (receipts.get(h.id) ?? 0) + share);
        h.lastIncome = (h.lastIncome + share) as Money;
      });
    }

    if (payers.length > 0) {
      const payees: MarketLeg[] = [];
      for (const [id, amount] of receipts) {
        payees.push({ id, amount: amount as Money, contra: AC.WAGE_INCOME });
      }
      clearMarket(world, ledger, {
        tick: ctx.tick,
        kind: 'economy.wages',
        description: 'Wage payments',
        payers,
        payees,
      });
    }

    world.economy.outputUnits = outputUnits;
    world.economy.employed = employed;
    world.economy.labourForce = households.reduce((total, h) => total + h.count, 0);
    // Measured against the people actually in the labour market, not the whole
    // population, so a fully employed economy reads as zero rather than as the
    // participation gap.
    const workforce = world.economy.labourForce * PARTICIPATION;
    world.economy.unemployment = workforce > 0 ? Math.max(0, 1 - employed / workforce) : 0;

    // Potential output drifts towards what the economy has actually been
    // producing, so the output gap measures deviation rather than level.
    const potential = world.economy.potentialOutput;
    world.economy.potentialOutput = potential <= 0 ? outputUnits : potential * 0.999 + outputUnits * 0.001;
    world.economy.outputGap =
      world.economy.potentialOutput > 0
        ? (outputUnits - world.economy.potentialOutput) / world.economy.potentialOutput
        : 0;
  },
});

/** Exposed so the goods market can reuse the same affordability rule. */
export function affordable(amount: Money, available: Money): Money {
  return min(amount, atLeastZero(available));
}
