import { ZERO, add, scale, sub, type Money } from '../core/money.js';
import { isMonthEnd, toDate } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { naturalBalance } from '../ledger/ledger.js';
import { refreshFinancials } from '../agents/credit.js';
import { FirmView, abilityByRegion, abilityOf, firmViews, totalWageBill } from '../agents/views.js';
import { spendable } from '../world/transfer.js';
import { resolvedCompanies, type WorldState } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

/**
 * Firms look at their books once a month: whether to take people on or let
 * them go, what to pay them, and whether they need to raise money.
 *
 * The labour supply constraint here is the economy's hard limit. Without it,
 * firms hire without bound whenever demand is strong, output rises to meet any
 * amount of spending, and nothing anchors the price level. Wage indexation is
 * the other half: if pay never responds to prices, real wages drift and firms'
 * margins drift with them.
 */
export const firmDecisionSystem = defineSystem({
  id: 'firms.decisions',
  phase: PHASE.FIRM_DECISIONS,
  description: 'Monthly pay, hiring against the labour supply, and funding needs',
  run(ctx) {
    if (!isMonthEnd(ctx.tick)) return;
    const { world, ledger } = ctx;
    const { config } = world;
    const firms = firmViews(world);
    const ability = abilityByRegion(world);

    const workforce = world.economy.labourForce * config.labourParticipation;
    const employed = firms.reduce((total, firm) => total + firm.employees, 0);
    const tightness = workforce > 0 ? employed / workforce : 1;
    const slack = Math.max(0, workforce - employed);

    // Pay follows prices and the state of the labour market. The signal is
    // economy-wide and monthly, as it always was; what changed is that firms
    // no longer all act on it at the same moment.
    const wageGrowth = clamp(
      config.wageIndexation * monthlyInflation(world) +
        config.wageTightnessResponse * (tightness - config.neutralTightness),
      -config.maxMonthlyWageCut,
      config.maxMonthlyWageRise,
    );
    advanceWageIndex(world, wageGrowth);
    const month = toDate(ctx.tick).month;

    let wantedHires = 0;
    const hiring: { firm: FirmView; wanted: number }[] = [];

    for (const firm of firms) {
      if (firm.employees <= 0) continue;
      settlePay(world, firm, month);

      // Days of stock is measured against sales, not output: dividing by the
      // production a firm is in the middle of cutting makes the signal chase
      // its own tail.
      const sales = Math.max(1, firm.expectedSales);
      const stockDays = firm.inventoryUnits / sales;
      // In efficiency units, matching what production will actually pay out.
      const wageBill = totalWageBill(firm, abilityOf(ability, firm.region));
      const cashMonths = wageBill > 0 ? spendable(world, ledger, firm.id) / (wageBill * 21) : 99;

      if (stockDays < config.targetStockDays * 0.5 && cashMonths > 1) {
        // Selling everything they make, and able to pay for it: expand.
        const wanted = headcountStep(firm, config.hiringAdjustment);
        hiring.push({ firm, wanted });
        wantedHires += wanted;
      } else if (stockDays > config.targetStockDays * 2 || cashMonths < 0.5) {
        const shed = headcountStep(firm, config.hiringAdjustment);
        firm.employees = Math.max(0, firm.employees - shed);
        if (firm.company) ctx.emit('company.laidOff', { companyId: firm.id, count: Math.round(shed) });
      }
    }

    // Nobody can hire people who are not there. When demand for labour exceeds
    // the slack in the economy, everyone gets a proportionate share of what is
    // available and the shortfall shows up as wage and price pressure rather
    // than as extra output.
    const fill = wantedHires > 0 ? Math.min(1, slack / wantedHires) : 0;
    for (const { firm, wanted } of hiring) {
      const hired = firm.isCohort ? wanted * fill : Math.floor(wanted * fill);
      if (hired <= 0) continue;
      firm.employees += hired;
      if (firm.company) ctx.emit('company.hired', { companyId: firm.id, count: Math.round(hired) });
    }

    for (const company of resolvedCompanies(world)) {
      if (company.status === 'defaulted') continue;
      refreshFinancials(ledger, company, ctx.tick);

      // Aim to hold roughly a month of wages in the bank; borrow the gap.
      const monthlyWages = scale(
        totalWageBill(new FirmView(company), abilityOf(ability, company.region)),
        21,
      );
      const cash = spendable(world, ledger, company.id);
      const gap = sub(monthlyWages, cash);
      const debt = naturalBalance(ledger, company.id, AC.BORROWINGS);
      // A firm that already owes three months of payroll is not looking for more.
      const headroom = sub(scale(monthlyWages, 3), debt);

      company.fundingNeed = gap > 0 && headroom > 0 ? (Math.min(gap, headroom) as Money) : ZERO;
      company.status = company.financials.interestCover < 1 && debt > 0 ? 'distressed' : 'active';
    }
  },
});

/**
 * How many people a firm takes on or lets go.
 *
 * A real company hires whole people, so a resolved firm rounds and moves at
 * least one. A cohort is an aggregate over thousands of firms and must not:
 * rounding its headcount makes the economy's behaviour depend on how the
 * scenario happens to be partitioned. One pool of 27,780 sheds 556 at 2%;
 * twelve pools of 2,315 shed 46 each, which is 552. Four people a month,
 * compounding, purely from where the cohort boundaries were drawn.
 */
export function headcountStep(firm: FirmView, rate: number): number {
  const exact = firm.employees * rate;
  return firm.isCohort ? exact : Math.max(1, Math.round(exact));
}

/** How many monthly vintages of pay coexist in the economy at any moment. */
const PAY_VINTAGES = 12;

/**
 * Accumulate the economy-wide pay signal, and remember the last year of it.
 *
 * The index is what a wage settled today would be worth relative to one
 * settled at the start. Firms draw on it when their own review comes round.
 */
export function advanceWageIndex(world: WorldState, monthlyGrowth: number): void {
  const { economy } = world;
  economy.wageIndex *= 1 + monthlyGrowth;
  economy.wageIndexHistory.push(economy.wageIndex);
  while (economy.wageIndexHistory.length > PAY_VINTAGES) economy.wageIndexHistory.shift();
}

/**
 * Settle this firm's pay, if this is the month it settles pay.
 *
 * A resolved firm is one business and moves in one step: it applies all the
 * growth since its own last review and then holds that wage for a year.
 *
 * A cohort is thousands of businesses whose review months are spread across
 * the calendar, so its average wage is the average of twelve vintages. That is
 * not the same as the current index and must not be modelled as though it
 * were: a pool that moved in one step every year would be a bigger
 * synchronisation than the one this replaces, because the pools hold most of
 * the employment. It tracks the trailing mean instead, which is exactly what a
 * uniformly staggered population averages to.
 */
export function settlePay(world: WorldState, firm: FirmView, month: number): void {
  const history = world.economy.wageIndexHistory;
  if (firm.isCohort) {
    if (history.length < 2) return;
    const now = mean(history);
    const before = mean(history.slice(0, -1));
    if (before <= 0) return;
    firm.wagePerEmployee = Math.max(1, Math.round(firm.wagePerEmployee * (now / before))) as Money;
    return;
  }
  if (firm.company?.payReviewMonth !== month) return;
  const since = firm.company.wageIndexAtReview;
  if (since > 0) {
    firm.wagePerEmployee = Math.max(
      1,
      Math.round(firm.wagePerEmployee * (world.economy.wageIndex / since)),
    ) as Money;
  }
  firm.company.wageIndexAtReview = world.economy.wageIndex;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Price change over the last month, from the daily index history. */
function monthlyInflation(world: WorldState): number {
  const history = world.economy.priceIndexHistory;
  if (history.length < 32) return 0;
  const monthAgo = history[history.length - 31]!;
  return monthAgo > 0 ? world.economy.priceIndex / monthAgo - 1 : 0;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export function totalDebt(ledger: Parameters<typeof naturalBalance>[0], id: string): Money {
  return add(naturalBalance(ledger, id, AC.BORROWINGS), naturalBalance(ledger, id, AC.DEBT_ISSUED));
}
