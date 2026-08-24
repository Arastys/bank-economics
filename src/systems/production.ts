import { ZERO, allocate, atLeastZero, min, sub, type Money } from '../core/money.js';
import { isBusinessDay } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { clearMarket, spendable, type MarketLeg } from '../world/transfer.js';
import { firmViews, personViews, totalWageBill, type FirmView, type PersonView } from '../agents/views.js';
import { owedBy, type WorldState } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

/**
 * Firms produce and pay wages.
 *
 * Output is capitalised into inventory rather than expensed, so the cost of a
 * unit follows it through to the income statement when it is actually sold.
 * A firm that cannot meet its wage bill produces proportionately less and
 * registers a funding need -- which is where most credit demand comes from.
 */
/**
 * Put the economy's jobs into the hands of the people holding them.
 *
 * Shared across every pool in proportion to working-age population, and
 * deliberately not by region. Firms hire against one economy-wide slack
 * figure, so a region's firms can already take on more staff than that region
 * has people; filling jobs regionally on top of that would cap the excess and
 * quietly lose it, and the pools would then read 13% unemployment while the
 * economy read 0.75%. A regional labour market is a real thing to want, but it
 * has to start on the hiring side.
 */
function fillJobs(pools: PersonView[], jobs: number): void {
  const available = pools.reduce((total, p) => total + p.workingAge, 0);
  if (available <= 0) {
    for (const pool of pools) pool.employed = 0;
    return;
  }
  const fill = Math.min(1, jobs / available);
  for (const pool of pools) pool.employed = pool.workingAge * fill;
}

export const productionSystem = defineSystem({
  id: 'economy.production',
  phase: PHASE.PRODUCTION,
  description: 'Firms produce output and pay wages to people',
  run(ctx) {
    if (!isBusinessDay(ctx.tick)) return;
    const { world, ledger } = ctx;

    const people = personViews(world);
    const byRegion = new Map<string, PersonView[]>();
    for (const h of people) {
      const list = byRegion.get(h.region) ?? [];
      list.push(h);
      byRegion.set(h.region, list);
    }
    for (const h of people) h.lastIncome = ZERO;

    const payers: MarketLeg[] = [];
    const receipts = new Map<string, number>();
    let outputUnits = 0;
    let employed = 0;

    // Produce first, then work out who is in work, then pay them. The middle
    // step used to be missing: `pool.employed` was set once when the scenario
    // was built and only ever moved when somebody was materialised out of a
    // pool, so hiring and firing never reached the people doing the jobs.
    // Wages were shared out by a fixed set of weights and a pool's spending
    // decision could not tell a boom from a slump.
    const payrolls: { firm: FirmView; paid: Money }[] = [];

    for (const firm of firmViews(world)) {
      if (firm.employees <= 0) continue;
      const wageBill = totalWageBill(firm);
      // Hold back money for a loan payment falling due shortly. Wages are paid
      // before debt service in the tick, so without this a firm spends its way
      // into arrears on a bill it could easily have met -- and since a default
      // on any facility cross-defaults the rest, that one ordering quietly
      // drove most of the bank's credit losses.
      const funds = sub(spendable(world, ledger, firm.id), reservedForDebt(world, firm.id, ctx.tick));
      const paid = min(wageBill, atLeastZero(funds));
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

      if (paid > 0) payrolls.push({ firm, paid });
    }

    fillJobs(people, employed);

    for (const { firm, paid } of payrolls) {
      payers.push({ id: firm.id, amount: paid, contra: AC.INVENTORY });

      // Wages go to people where the firm actually is, weighted by how
      // many of them are in work.
      const recipients = byRegion.get(firm.region) ?? people;
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
    // Working age only. Children and the retired are in the population and in
    // the queue at the shops, but they are not labour supply, and counting
    // them as such was the whole reason `labourParticipation` had to sit at a
    // suspiciously round 0.96.
    world.economy.labourForce = people.reduce((total, h) => total + h.workingAge, 0);
    // Measured against the people actually in the labour market, not the whole
    // population, so a fully employed economy reads as zero rather than as the
    // participation gap.
    const workforce = world.economy.labourForce * world.config.labourParticipation;
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

/** Days of notice a firm gives itself before a payment falls due. */
const DEBT_SERVICE_HORIZON = 5;

/** What the firm owes lenders in the next few days, and must not spend. */
function reservedForDebt(world: WorldState, firmId: string, tick: number): Money {
  let due = 0;
  for (const inst of owedBy(world, firmId)) {
    if (inst.status !== 'active' || !inst.type.startsWith('loan.')) continue;
    if (inst.nextPaymentOn === undefined || inst.nextPaymentOn > tick + DEBT_SERVICE_HORIZON) continue;
    const scheduled = Number(inst.data.monthlyPayment ?? 0) || inst.accrued;
    due += Math.min(scheduled, inst.outstanding + inst.accrued);
  }
  return Math.round(due) as Money;
}

/** Exposed so the goods market can reuse the same affordability rule. */
export function affordable(amount: Money, available: Money): Money {
  return min(amount, atLeastZero(available));
}
