import { ZERO, add, scale, sub, type Money } from '../core/money.js';
import { isMonthEnd } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { naturalBalance } from '../ledger/ledger.js';
import { refreshFinancials } from '../agents/credit.js';
import { firmViews, type FirmView } from '../agents/views.js';
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

    const workforce = world.economy.labourForce * config.labourParticipation;
    const employed = firms.reduce((total, firm) => total + firm.employees, 0);
    const tightness = workforce > 0 ? employed / workforce : 1;
    const slack = Math.max(0, workforce - employed);

    // Pay follows prices and the state of the labour market.
    const wageGrowth = clamp(
      config.wageIndexation * monthlyInflation(world) +
        config.wageTightnessResponse * (tightness - config.neutralTightness),
      -config.maxMonthlyWageCut,
      config.maxMonthlyWageRise,
    );

    let wantedHires = 0;
    const hiring: { firm: FirmView; wanted: number }[] = [];

    for (const firm of firms) {
      if (firm.employees <= 0) continue;
      firm.wagePerEmployee = Math.max(1, Math.round(firm.wagePerEmployee * (1 + wageGrowth))) as Money;

      // Days of stock is measured against sales, not output: dividing by the
      // production a firm is in the middle of cutting makes the signal chase
      // its own tail.
      const sales = Math.max(1, firm.expectedSales);
      const stockDays = firm.inventoryUnits / sales;
      const wageBill = firm.employees * firm.wagePerEmployee;
      const cashMonths = wageBill > 0 ? spendable(world, ledger, firm.id) / (wageBill * 21) : 99;

      if (stockDays < config.targetStockDays * 0.5 && cashMonths > 1) {
        // Selling everything they make, and able to pay for it: expand.
        const wanted = Math.max(1, Math.round(firm.employees * config.hiringAdjustment));
        hiring.push({ firm, wanted });
        wantedHires += wanted;
      } else if (stockDays > config.targetStockDays * 2 || cashMonths < 0.5) {
        const shed = Math.max(1, Math.round(firm.employees * config.hiringAdjustment));
        firm.employees = Math.max(0, firm.employees - shed);
        if (firm.company) ctx.emit('company.laidOff', { companyId: firm.id, count: shed });
      }
    }

    // Nobody can hire people who are not there. When demand for labour exceeds
    // the slack in the economy, everyone gets a proportionate share of what is
    // available and the shortfall shows up as wage and price pressure rather
    // than as extra output.
    const fill = wantedHires > 0 ? Math.min(1, slack / wantedHires) : 0;
    for (const { firm, wanted } of hiring) {
      const hired = Math.floor(wanted * fill);
      if (hired <= 0) continue;
      firm.employees += hired;
      if (firm.company) ctx.emit('company.hired', { companyId: firm.id, count: hired });
    }

    for (const company of resolvedCompanies(world)) {
      if (company.status === 'defaulted') continue;
      refreshFinancials(ledger, company, ctx.tick);

      // Aim to hold roughly a month of wages in the bank; borrow the gap.
      const monthlyWages = scale((company.employees * company.wagePerEmployee) as Money, 21);
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
