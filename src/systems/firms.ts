import { ZERO, add, scale, sub, type Money } from '../core/money.js';
import { isMonthEnd } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { naturalBalance } from '../ledger/ledger.js';
import { refreshFinancials } from '../agents/credit.js';
import { firmViews } from '../agents/views.js';
import { spendable } from '../world/transfer.js';
import { resolvedCompanies } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

/** Days of stock a firm is happy to hold before it starts cutting back. */
const TARGET_STOCK_DAYS = 8;
/** Share of the population available for work. */
const PARTICIPATION = 0.96;
/** Employment rate at which the labour market starts bidding wages up. */
const NEUTRAL_TIGHTNESS = 0.97;
/** How much of last month's inflation firms pass into pay. */
const WAGE_INDEXATION = 0.6;

/**
 * Firms look at their books once a month and decide whether to take people on
 * or let them go, and whether they need to raise money.
 */
export const firmDecisionSystem = defineSystem({
  id: 'firms.decisions',
  phase: PHASE.FIRM_DECISIONS,
  description: 'Monthly hiring, firing and funding decisions',
  run(ctx) {
    if (!isMonthEnd(ctx.tick)) return;
    const { world, ledger } = ctx;
    const step = world.config.hiringAdjustment;

    for (const firm of firmViews(world)) {
      // Against sales rather than output: dividing by the production a firm is
      // in the middle of cutting makes the signal chase its own tail.
      const sales = Math.max(1, firm.expectedSales);
      const stockDays = firm.inventoryUnits / sales;
      const wageBill = firm.employees * firm.wagePerEmployee;
      const cashMonths = wageBill > 0 ? spendable(world, ledger, firm.id) / (wageBill * 21) : 99;

      if (stockDays < TARGET_STOCK_DAYS * 0.5 && cashMonths > 1) {
        // Selling everything they make, and able to pay for it: expand.
        const hired = Math.max(1, Math.round(firm.employees * step));
        firm.employees += hired;
        if (firm.company) ctx.emit('company.hired', { companyId: firm.id, count: hired });
      } else if (stockDays > TARGET_STOCK_DAYS * 2 || cashMonths < 0.5) {
        const shed = Math.max(1, Math.round(firm.employees * step));
        firm.employees = Math.max(0, firm.employees - shed);
        if (firm.company) ctx.emit('company.laidOff', { companyId: firm.id, count: shed });
      }
    }

    for (const company of resolvedCompanies(world)) {
      if (company.status === 'defaulted') continue;
      refreshFinancials(ledger, company, ctx.tick);

      // Aim to hold roughly a month of wages in the bank; borrow the gap.
      const monthlyWages = scale(
        (company.employees * company.wagePerEmployee) as Money,
        21,
      );
      const cash = spendable(world, ledger, company.id);
      const gap = sub(monthlyWages, cash);
      const debt = naturalBalance(ledger, company.id, AC.BORROWINGS);
      // A firm that already owes three months of payroll is not looking for more.
      const headroom = sub(scale(monthlyWages, 3), debt);

      company.fundingNeed =
        gap > 0 && headroom > 0 ? (Math.min(gap, headroom) as Money) : ZERO;
      company.status =
        company.financials.interestCover < 1 && debt > 0 ? 'distressed' : 'active';
    }
  },
});

/** Price change over the last month, from the daily index history. */
function monthlyInflation(world: { economy: { priceIndexHistory: number[]; priceIndex: number } }): number {
  const history = world.economy.priceIndexHistory;
  if (history.length < 32) return 0;
  const monthAgo = history[history.length - 31]!;
  return monthAgo > 0 ? world.economy.priceIndex / monthAgo - 1 : 0;
}

function clampNumber(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export function totalDebt(ledger: Parameters<typeof naturalBalance>[0], id: string): Money {
  return add(naturalBalance(ledger, id, AC.BORROWINGS), naturalBalance(ledger, id, AC.DEBT_ISSUED));
}
