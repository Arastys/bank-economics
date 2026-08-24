import { ZERO, ratio, type Money } from '../core/money.js';
import { fromDate, toDate, type Day } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { naturalBalance, type LedgerState } from '../ledger/ledger.js';
import { incomeStatement } from '../ledger/statements.js';
import type { WorldState } from '../world/state.js';
import { CREDIT_GRADES, type Company, type CreditGrade } from '../world/types.js';

/** Upper bound on annual PD for each grade. */
const GRADE_PD_CEILING: [CreditGrade, number][] = [
  ['AAA', 0.0005],
  ['AA', 0.0015],
  ['A', 0.004],
  ['BBB', 0.012],
  ['BB', 0.035],
  ['B', 0.09],
  ['CCC', 1],
];

export function gradeFromPd(pd: number): CreditGrade {
  for (const [grade, ceiling] of GRADE_PD_CEILING) {
    if (pd <= ceiling) return grade;
  }
  return 'CCC';
}

export function gradeRank(grade: CreditGrade): number {
  return CREDIT_GRADES.indexOf(grade);
}

/** True when `grade` is at least as good as `minimum`. */
export function meetsGrade(grade: CreditGrade, minimum: CreditGrade): boolean {
  return gradeRank(grade) <= gradeRank(minimum);
}

/**
 * Refresh a firm's figures from its ledger, annualised.
 *
 * The income statement is year-to-date and resets each January, so raw figures
 * would make every firm look like it earns nothing in the spring. Scaling by
 * the elapsed year -- with a floor on the window so the first few weeks are
 * not wildly extrapolated -- gives a run rate that is comparable all year.
 */
export function refreshFinancials(ledger: LedgerState, company: Company, tick: Day): void {
  const pl = incomeStatement(ledger, company.id);
  const interestPaid = naturalBalance(ledger, company.id, AC.INTEREST_EXPENSE);
  const revenue = naturalBalance(ledger, company.id, AC.REVENUE);
  const costs = (pl.totalExpenses - interestPaid) as Money;
  const debt = naturalBalance(ledger, company.id, AC.BORROWINGS);

  const elapsed = Math.max(1, daysIntoYear(tick));
  const annualise = 365 / Math.max(MIN_WINDOW_DAYS, elapsed);

  // In January there is almost no trading history to work from, and the ratios
  // that matter compare an annual flow against a stock of debt. Extrapolating
  // a week into a year understates earnings by an order of magnitude and makes
  // every borrower in the economy look critically levered on the same morning.
  // So new figures are phased in over a quarter against the ones already held.
  const confidence = Math.min(1, elapsed / TRUST_WINDOW_DAYS);
  const prior = company.financials;
  const blend = (was: Money, now: number): Money =>
    Math.round(was * (1 - confidence) + now * confidence) as Money;

  const annualRevenue = blend(prior.revenue, revenue * annualise);
  const annualCosts = blend(prior.costs, costs * annualise);
  const annualInterest = blend(prior.interestPaid, interestPaid * annualise);
  const ebitda = (annualRevenue - annualCosts) as Money;

  company.financials = {
    revenue: annualRevenue,
    costs: annualCosts,
    ebitda,
    interestPaid: annualInterest,
    interestCover: annualInterest > 0 ? ratio(ebitda, annualInterest) : Number.POSITIVE_INFINITY,
    leverage: ebitda > 0 ? Math.min(25, ratio(debt, ebitda)) : debt > 0 ? 25 : 0,
  };
}

/** Never extrapolate a full year from less than this much trading. */
const MIN_WINDOW_DAYS = 60;
/** How long fresh figures take to fully displace the ones already on file. */
const TRUST_WINDOW_DAYS = 90;

/**
 * A firm's figures as they would have been before the game started. Used so
 * that a newly materialised company is assessed on its going rate rather than
 * on an empty income statement.
 */
export function goingRateFinancials(args: {
  employees: number;
  productivity: number;
  price: Money;
  wagePerEmployee: Money;
}): Company['financials'] {
  const revenue = Math.round(args.employees * args.productivity * args.price * BUSINESS_DAYS) as Money;
  const costs = Math.round(args.employees * args.wagePerEmployee * BUSINESS_DAYS) as Money;
  return {
    revenue,
    costs,
    ebitda: (revenue - costs) as Money,
    interestPaid: ZERO,
    interestCover: Number.POSITIVE_INFINITY,
    leverage: 0,
  };
}

const BUSINESS_DAYS = 260;

function daysIntoYear(tick: Day): number {
  const date = toDate(tick);
  return tick - fromDate({ year: date.year, month: 1, day: 1 });
}

/**
 * Annualised probability of default.
 *
 * Starts from the sector's baseline and is pushed around by how comfortably
 * the firm covers its interest, how levered it is, and where the economy is in
 * the cycle. Deliberately legible rather than sophisticated -- a proper hazard
 * model can replace this function without touching anything else.
 */
export function estimatePd(world: WorldState, company: Company): number {
  const sector = world.sectors[company.sector];
  const base = sector?.basePd ?? 0.02;

  // Stresses are added in log space and the total is capped, so a firm that
  // looks bad on every measure at once is a few times more likely to fail than
  // its peers -- not a hundred times. Multiplying raw factors together, which
  // is the obvious way to write this, puts a routine borrower at a 50% chance
  // of failing within the year.
  const cover = company.financials.interestCover;
  const coverStress = Number.isFinite(cover) ? clamp(0.9 - 0.3 * cover, -0.6, 0.9) : -0.5;
  const leverageStress = clamp(0.05 * company.financials.leverage - 0.1, -0.1, 0.7);
  const cyclicality = sector?.cyclicality ?? 1;
  const cycleStress = clamp(-2.5 * cyclicality * world.economy.outputGap, -0.5, 0.6);
  const distressStress = company.status === 'distressed' ? 0.35 : 0;

  const stress = clamp(coverStress + leverageStress + cycleStress + distressStress, -1.2, 1.1);
  return clamp(base * Math.exp(stress), 0.0005, 0.15);
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Expected loss on an exposure, the number underwriting should price against. */
export function expectedLoss(exposure: Money, pdAnnual: number, lgd: number): Money {
  return Math.round(exposure * pdAnnual * lgd) as Money;
}

export const NO_EXPOSURE = ZERO;
