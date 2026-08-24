import { ZERO, add, atLeastZero, min, scale, sub, type Money } from '../core/money.js';
import { nextId } from '../core/ids.js';
import { addMonths, dailyRate, type Day } from '../core/time.js';
import { AC, depositCode } from '../ledger/accounts.js';
import { credit, debit, post, type LedgerState } from '../ledger/ledger.js';
import { addInstrument, owedBy, touch, type WorldState } from '../world/state.js';
import { paymentPostings, spendable } from '../world/transfer.js';
import { activeLoansOf, isInsolvent, isStillActive, liquidateAssets, raiseCash } from '../agents/insolvency.js';
import type { CreditGrade, EntityId } from '../world/types.js';
import { instrumentTypes } from './registry.js';
import type { Instrument, InstrumentContext, InstrumentType } from './types.js';

export const LOAN_AMORTISING = 'loan.amortising';
export const LOAN_BULLET = 'loan.bullet';

export interface OriginateLoanArgs {
  lenderId: EntityId;
  borrowerId: EntityId;
  amount: Money;
  /** Annual nominal rate. */
  rate: number;
  termMonths: number;
  grade?: CreditGrade;
  type?: typeof LOAN_AMORTISING | typeof LOAN_BULLET;
}

/**
 * Write a new loan.
 *
 * The bank credits the borrower's deposit account out of nothing and books a
 * matching asset -- which is how commercial bank money is actually created.
 */
export function originateLoan(ctx: InstrumentContext, args: OriginateLoanArgs): Instrument {
  const { world, ledger, tick } = ctx;
  const type = args.type ?? LOAN_AMORTISING;
  const id = nextId(world.ids, 'loan');
  const maturesOn = addMonths(tick, args.termMonths);

  post(ledger, {
    tick,
    kind: 'loan.originate',
    description: `Loan ${id} to ${args.borrowerId}`,
    refs: { loanId: id, lenderId: args.lenderId, borrowerId: args.borrowerId },
    postings: [
      debit(args.lenderId, AC.LOANS, args.amount),
      credit(args.lenderId, AC.CUSTOMER_DEPOSITS, args.amount),
      debit(args.borrowerId, depositCode(args.lenderId), args.amount),
      credit(args.borrowerId, AC.BORROWINGS, args.amount),
    ],
  });

  const monthlyRate = args.rate / 12;
  const monthlyPayment =
    type === LOAN_AMORTISING ? levelPayment(args.amount, monthlyRate, args.termMonths) : ZERO;

  const inst = addInstrument(world, {
    id,
    type,
    holderId: args.lenderId,
    obligorId: args.borrowerId,
    principal: args.amount,
    outstanding: args.amount,
    rate: args.rate,
    accrued: ZERO,
    openedOn: tick,
    maturesOn,
    nextPaymentOn: addMonths(tick, 1),
    paymentIntervalMonths: 1,
    status: 'active',
    ...(args.grade ? { grade: args.grade } : {}),
    data: { monthlyPayment, arrears: 0, termMonths: args.termMonths },
  });

  touch(world, args.borrowerId);
  ctx.emit('loan.originated', {
    loanId: id,
    lenderId: args.lenderId,
    borrowerId: args.borrowerId,
    amount: args.amount,
    rate: args.rate,
  });
  return inst;
}

/** Level monthly payment for a fully amortising loan. */
export function levelPayment(principal: Money, monthlyRate: number, months: number): Money {
  if (months <= 0) return principal;
  if (monthlyRate <= 0) return scale(principal, 1 / months);
  const factor = monthlyRate / (1 - Math.pow(1 + monthlyRate, -months));
  return scale(principal, factor);
}

function accrueInterest(ctx: InstrumentContext, inst: Instrument): void {
  const interest = scale(inst.outstanding, dailyRate(inst.rate));
  if (interest === 0) return;
  inst.accrued = add(inst.accrued, interest);
  post(ctx.ledger, {
    tick: ctx.tick,
    kind: 'loan.accrue',
    description: `Interest accrued on ${inst.id}`,
    refs: { loanId: inst.id },
    postings: [
      debit(inst.holderId, AC.INTEREST_RECEIVABLE, interest),
      credit(inst.holderId, AC.INTEREST_INCOME, interest),
      debit(inst.obligorId, AC.INTEREST_EXPENSE, interest),
      credit(inst.obligorId, AC.INTEREST_PAYABLE, interest),
    ],
  });
}

/**
 * What the borrower can actually pay today, from wherever it banks.
 *
 * Looking only at an account with the lending bank would be wrong the moment a
 * borrower moves its banking elsewhere: the debt does not vanish, and neither
 * does its ability to pay.
 */
function availableFunds(world: WorldState, ledger: LedgerState, obligorId: EntityId): Money {
  return spendable(world, ledger, obligorId);
}

function takePayment(ctx: InstrumentContext, inst: Instrument): void {
  const { ledger, tick } = ctx;
  const scheduled = scheduledPayment(inst);
  const funds = availableFunds(ctx.world, ledger, inst.obligorId);
  const paid = min(scheduled, funds);

  if (paid > 0) {
    // Interest is settled first, then whatever is left reduces principal.
    const interestPart = min(inst.accrued, paid);
    const principalPart = sub(paid, interestPart) as Money;

    post(ledger, {
      tick,
      kind: 'loan.payment',
      description: `Payment on ${inst.id}`,
      refs: { loanId: inst.id },
      postings: [
        ...paymentPostings(ctx.world, {
          amount: interestPart,
          fromId: inst.obligorId,
          fromContra: AC.INTEREST_PAYABLE,
          toId: inst.holderId,
          toContra: AC.INTEREST_RECEIVABLE,
        }),
        ...paymentPostings(ctx.world, {
          amount: principalPart,
          fromId: inst.obligorId,
          fromContra: AC.BORROWINGS,
          toId: inst.holderId,
          toContra: AC.LOANS,
        }),
      ],
    });

    inst.accrued = sub(inst.accrued, interestPart);
    inst.outstanding = sub(inst.outstanding, principalPart);
    ctx.emit('loan.repaid', { loanId: inst.id, amount: paid, principal: principalPart, interest: interestPart });
  }

  const shortfall = sub(scheduled, paid);
  if (shortfall > 0) {
    inst.data.arrears = Number(inst.data.arrears ?? 0) + 1;
    ctx.emit('loan.missedPayment', { loanId: inst.id, borrowerId: inst.obligorId, amount: shortfall });
    if (Number(inst.data.arrears) >= ctx.world.config.arrearsLimit) {
      defaultLoan(ctx, inst);
      return;
    }
  } else {
    inst.data.arrears = 0;
  }

  if (inst.outstanding <= 0) {
    inst.status = 'closed';
    ctx.emit('loan.matured', { loanId: inst.id });
    return;
  }
  inst.nextPaymentOn = addMonths(tick, inst.paymentIntervalMonths ?? 1);
}

function scheduledPayment(inst: Instrument): Money {
  if (inst.type === LOAN_BULLET) return inst.accrued;
  const level = Number(inst.data.monthlyPayment ?? 0) as Money;
  // Never ask for more than is owed.
  return min(add(inst.outstanding, inst.accrued), level);
}

/**
 * Write the loan off. Whatever the borrower can pay is recovered; the rest is
 * an impairment charge against the bank's profit.
 */
export function defaultLoan(ctx: InstrumentContext, inst: Instrument): void {
  const { ledger, world, tick } = ctx;
  const obligor = world.entities[inst.obligorId];
  const trading = obligor?.kind === 'company' && obligor.status !== 'defaulted' ? obligor : undefined;

  // Missing payments is not the same as being finished. A firm whose assets
  // still cover its debts is illiquid, not insolvent: it is made to sell
  // enough to clear the facility and carries on trading. Treating the two as
  // one thing is why a missed interest payment on a small third-party loan
  // used to take down every other lender with it.
  if (trading && !isInsolvent(ledger, trading.id) && workOut(ctx, inst)) return;

  // From here it is a wind-up: sell everything and write off what will not sell.
  if (trading) liquidateAssets(world, ledger, tick, trading.id);

  const exposure = add(inst.outstanding, inst.accrued);
  const recoverable = scale(exposure, 1 - world.config.lossGivenDefault);
  const funds = availableFunds(world, ledger, inst.obligorId);
  const recovery = min(min(recoverable, funds), inst.outstanding);
  const loss = sub(exposure, recovery);
  const remainingPrincipal = sub(inst.outstanding, recovery);

  post(ledger, {
    tick,
    kind: 'loan.default',
    description: `Write-off of ${inst.id}`,
    refs: { loanId: inst.id },
    postings: [
      // Whatever the borrower can find is handed over against the principal.
      ...paymentPostings(world, {
        amount: recovery,
        fromId: inst.obligorId,
        fromContra: AC.BORROWINGS,
        toId: inst.holderId,
        toContra: AC.LOANS,
      }),
      // The rest is an impairment charge for the lender and a windfall for the
      // borrower, who is about to cease trading anyway.
      credit(inst.holderId, AC.LOANS, remainingPrincipal),
      credit(inst.holderId, AC.INTEREST_RECEIVABLE, inst.accrued),
      debit(inst.holderId, AC.IMPAIRMENT, loss),
      debit(inst.obligorId, AC.BORROWINGS, remainingPrincipal),
      debit(inst.obligorId, AC.INTEREST_PAYABLE, inst.accrued),
      credit(inst.obligorId, AC.DEBT_FORGIVEN, loss),
    ],
  });

  inst.outstanding = ZERO;
  inst.accrued = ZERO;
  inst.status = 'defaulted';
  ctx.emit('loan.defaulted', { loanId: inst.id, borrowerId: inst.obligorId, exposure, loss });

  // An insolvent borrower has defaulted on all of its lenders, not just this one.
  if (trading && trading.status !== 'defaulted') {
    trading.status = 'defaulted';
    trading.employees = 0;
    for (const loanId of activeLoansOf(world, trading.id)) {
      if (loanId === inst.id || !isStillActive(world, loanId)) continue;
      defaultLoan(ctx, world.instruments[loanId]!);
    }
    ctx.emit('company.failed', { companyId: trading.id, sector: trading.sector });
  }
}

/**
 * Wind a firm up outright, whatever its balance sheet says.
 *
 * This is the other way a borrower can go: not "missed a payment" but "the
 * business has failed" -- the customer left, the fraud surfaced, the founder
 * walked. Assets are sold, every facility is written off, and the firm stops
 * trading.
 *
 * The status is set before the facilities are defaulted, so `defaultLoan` sees
 * a firm that has already gone and does not try to rescue it. Sale proceeds go
 * to whichever lender is reached first, which stands in for a creditor
 * hierarchy the model does not have yet.
 *
 * Lives here rather than in `agents/insolvency` only because it needs
 * `defaultLoan`, and that would close an import cycle.
 */
export function windUpBorrower(ctx: InstrumentContext, companyId: EntityId): Money {
  const { world, ledger, tick } = ctx;
  const company = world.entities[companyId];
  if (!company || company.kind !== 'company' || company.status === 'defaulted') return ZERO;

  let exposure: Money = ZERO;
  for (const inst of owedBy(world, companyId)) {
    if (inst.status === 'active') exposure = add(exposure, inst.outstanding);
  }

  liquidateAssets(world, ledger, tick, companyId);
  company.status = 'defaulted';
  company.employees = 0;
  company.inventoryUnits = 0;

  for (const loanId of activeLoansOf(world, companyId)) {
    const inst = world.instruments[loanId];
    if (inst?.status === 'active') defaultLoan(ctx, inst);
  }

  ctx.emit('company.failed', { companyId, sector: company.sector });
  return exposure;
}

/**
 * A solvent borrower that has run out of cash sells assets until it can clear
 * the facility outright. The lender is repaid in full and the loan closes
 * early; the firm keeps trading on a smaller balance sheet.
 *
 * Returns false if it could not raise enough, in which case it really is a
 * wind-up after all.
 */
function workOut(ctx: InstrumentContext, inst: Instrument): boolean {
  const { ledger, world, tick } = ctx;
  const owed = add(inst.outstanding, inst.accrued);
  const shortfall = sub(owed, availableFunds(world, ledger, inst.obligorId));
  if (shortfall > 0) raiseCash(world, ledger, tick, inst.obligorId, shortfall);
  if (availableFunds(world, ledger, inst.obligorId) < owed) return false;

  post(ledger, {
    tick,
    kind: 'loan.workout',
    description: `Forced repayment of ${inst.id}`,
    refs: { loanId: inst.id },
    postings: [
      ...paymentPostings(world, {
        amount: inst.accrued,
        fromId: inst.obligorId,
        fromContra: AC.INTEREST_PAYABLE,
        toId: inst.holderId,
        toContra: AC.INTEREST_RECEIVABLE,
      }),
      ...paymentPostings(world, {
        amount: inst.outstanding,
        fromId: inst.obligorId,
        fromContra: AC.BORROWINGS,
        toId: inst.holderId,
        toContra: AC.LOANS,
      }),
    ],
  });

  const borrower = world.entities[inst.obligorId];
  if (borrower?.kind === 'company') borrower.status = 'distressed';
  inst.outstanding = ZERO;
  inst.accrued = ZERO;
  inst.data.arrears = 0;
  inst.status = 'closed';
  ctx.emit('loan.workedOut', { loanId: inst.id, borrowerId: inst.obligorId, recovered: owed });
  return true;
}

/** Basel-ish standardised weights, deliberately simple and easy to replace. */
const RISK_WEIGHT_BY_GRADE: Record<CreditGrade, number> = {
  AAA: 0.2,
  AA: 0.2,
  A: 0.5,
  BBB: 0.75,
  BB: 1.0,
  B: 1.0,
  CCC: 1.5,
};

function loanBehaviour(key: string, label: string): InstrumentType {
  return {
    key,
    category: 'loan',
    label,
    accrue: accrueInterest,
    onPayment: takePayment,
    onMature(ctx, inst) {
      if (inst.status !== 'active') return;
      // A bullet loan repays principal in full at maturity.
      inst.data.monthlyPayment = add(inst.outstanding, inst.accrued);
      takePayment(ctx, inst);
      if (inst.status === 'active' && inst.outstanding <= 0) {
        inst.status = 'matured';
        ctx.emit('loan.matured', { loanId: inst.id });
      }
    },
    onDefault: defaultLoan,
    riskWeight(inst) {
      return RISK_WEIGHT_BY_GRADE[inst.grade ?? 'BB'] ?? 1;
    },
    hqlaFactor() {
      return 0;
    },
  };
}

export function registerLoanTypes(): void {
  instrumentTypes.register(LOAN_AMORTISING, loanBehaviour(LOAN_AMORTISING, 'Amortising loan'));
  instrumentTypes.register(LOAN_BULLET, loanBehaviour(LOAN_BULLET, 'Bullet loan'));
}
