import { ZERO, add, atLeastZero, min, scale, sub, type Money } from '../core/money.js';
import { addMonths, dailyRate } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { credit, debit, naturalBalance, post, type Posting } from '../ledger/ledger.js';
import { paymentPostings, spendable } from '../world/transfer.js';
import { riskWeightForGrade } from './loan.js';
import { instrumentTypes } from './registry.js';
import type { Instrument, InstrumentContext, InstrumentType } from './types.js';

export const LOAN_POOL = 'loan.pool';

/**
 * What a pool of thousands of borrowers owes a bank.
 *
 * The latent economy carried billions of `BORROWINGS` with no contract behind
 * it: a balance that looked entirely normal in the accounts and accrued
 * nothing for a century. This is the contract. It is not an ordinary loan, and
 * the differences are the point rather than simplifications:
 *
 * - **It reads its balance from the ledger** rather than carrying its own.
 *   A pool's debt moves every day as members are promoted out of it and folded
 *   back into it, and a cached figure would drift away from the accounts
 *   within a month. `deposit.instant` reads its balance the same way and for
 *   the same reason.
 * - **It is interest-only and never matures.** Thousands of firms do not repay
 *   a stock of debt to zero; they refinance it. Amortising the aggregate would
 *   be a decade-long deleveraging nobody chose.
 * - **It floats.** The rate is Bank Rate plus a spread, re-read daily, which
 *   is what makes monetary policy reach the debt service of the whole economy
 *   rather than only of the handful of borrowers simulated in full.
 * - **It cannot default.** A pool is not a borrower; it is a population. Some
 *   of its members fail, and that is `firms.demography`'s business, not this
 *   contract's. Writing off the aggregate would take out a whole sector's
 *   lending on one missed payment.
 */

/** The pool's own share of what its members collectively owe. */
function currentBalance(ctx: InstrumentContext, inst: Instrument): Money {
  const owed = atLeastZero(naturalBalance(ctx.ledger, inst.obligorId, AC.BORROWINGS));
  return scale(owed, Number(inst.data.share ?? 1));
}

function currentRate(ctx: InstrumentContext, inst: Instrument): number {
  const cb = ctx.world.entities[ctx.world.centralBankId];
  const base = cb?.kind === 'centralBank' ? cb.bankRate : undefined;
  return base === undefined ? inst.rate : base + Number(inst.data.spread ?? 0);
}

function accruePoolInterest(ctx: InstrumentContext, inst: Instrument): Posting[] {
  inst.outstanding = currentBalance(ctx, inst);
  inst.rate = currentRate(ctx, inst);

  const interest = scale(inst.outstanding, dailyRate(inst.rate));
  if (interest === 0) return [];
  inst.accrued = add(inst.accrued, interest);

  return [
    debit(inst.holderId, AC.INTEREST_RECEIVABLE, interest),
    credit(inst.holderId, AC.INTEREST_INCOME, interest),
    debit(inst.obligorId, AC.INTEREST_EXPENSE, interest),
    credit(inst.obligorId, AC.INTEREST_PAYABLE, interest),
  ];
}

/**
 * Interest, monthly, out of whatever the pool has.
 *
 * A shortfall stays accrued rather than counting towards arrears. It is still
 * owed and still on both sets of books; what it is not is grounds for writing
 * off the borrowing of an entire sector because it was short one month.
 */
function takePoolPayment(ctx: InstrumentContext, inst: Instrument): void {
  const due = inst.accrued;
  const paid = min(due, spendable(ctx.world, ctx.ledger, inst.obligorId));

  if (paid > 0) {
    post(ctx.ledger, {
      tick: ctx.tick,
      kind: 'loan.pool.interest',
      description: `Interest on ${inst.id}`,
      refs: { loanId: inst.id },
      postings: paymentPostings(ctx.world, {
        amount: paid,
        fromId: inst.obligorId,
        fromContra: AC.INTEREST_PAYABLE,
        toId: inst.holderId,
        toContra: AC.INTEREST_RECEIVABLE,
      }),
    });
    inst.accrued = sub(due, paid);
    ctx.emit('loan.repaid', {
      loanId: inst.id,
      amount: paid,
      principal: ZERO,
      interest: paid,
    });
  }

  inst.nextPaymentOn = addMonths(ctx.tick, inst.paymentIntervalMonths ?? 1);
}

const poolLoan: InstrumentType = {
  key: LOAN_POOL,
  category: 'loan',
  label: 'Pooled borrowing',
  accrue: accruePoolInterest,
  onPayment: takePoolPayment,
  riskWeight(inst) {
    return riskWeightForGrade(inst.grade);
  },
  hqlaFactor() {
    return 0;
  },
};

export function registerPoolLoanType(): void {
  instrumentTypes.register(LOAN_POOL, poolLoan);
}
