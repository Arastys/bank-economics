import { ZERO, add, round, scale, sub, type Money } from '../core/money.js';
import { dailyRate, isMonthEnd } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { credit, debit, naturalBalance, post, type LedgerState } from '../ledger/ledger.js';
import { centralBank, entitiesOfKind } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

/** Funding is drawn in round amounts rather than to the penny. */
const FUNDING_STEP = 10_000_00 as Money; // £10,000

/**
 * Treasury.
 *
 * Every bank keeps a reserve buffer against its deposit base, topping up from
 * the central bank's lending facility when it runs short and repaying when it
 * has more than it needs. This is what makes deposits worth competing for:
 * losing them costs you reserves, and replacing reserves costs Bank Rate plus
 * the corridor.
 */
export const treasurySystem = defineSystem({
  id: 'bank.treasury',
  phase: PHASE.TREASURY,
  description: 'Manages each bank reserve position against the central bank',
  run(ctx) {
    const { world, ledger } = ctx;
    const cb = centralBank(world);
    const facilityRate = cb.bankRate + cb.corridor;

    for (const bank of entitiesOfKind(world, 'bank')) {
      payInterestOnReserves(ctx, bank.id, cb.id, cb.bankRate);
      const deposits = naturalBalance(ledger, bank.id, AC.CUSTOMER_DEPOSITS);
      const reserves = naturalBalance(ledger, bank.id, AC.RESERVES);
      const funding = naturalBalance(ledger, bank.id, AC.CENTRAL_BANK_FUNDING);
      const target = scale(deposits, bank.policy.targetLiquidityRatio);

      if (reserves < target) {
        const gap = roundUpTo(sub(target, reserves), FUNDING_STEP);
        drawFunding(ctx, bank.id, cb.id, gap);
      } else if (funding > 0 && reserves > add(target, FUNDING_STEP)) {
        const spare = roundDownTo(sub(reserves, target), FUNDING_STEP);
        const repayment = spare < funding ? spare : funding;
        if (repayment > 0) repayFunding(ctx, bank.id, cb.id, repayment);
      }

      // Interest on the facility accrues daily and settles monthly.
      const balanceNow = naturalBalance(ledger, bank.id, AC.CENTRAL_BANK_FUNDING);
      if (balanceNow > 0) {
        const interest = scale(balanceNow, dailyRate(facilityRate));
        if (interest > 0) {
          post(ledger, {
            tick: ctx.tick,
            kind: 'treasury.accrue',
            description: `Central bank funding interest for ${bank.id}`,
            postings: [
              debit(bank.id, AC.INTEREST_EXPENSE, interest),
              credit(bank.id, AC.INTEREST_PAYABLE, interest),
              debit(cb.id, AC.INTEREST_RECEIVABLE, interest),
              credit(cb.id, AC.INTEREST_INCOME, interest),
            ],
          });
        }
      }

      if (isMonthEnd(ctx.tick)) {
        const due = naturalBalance(ledger, bank.id, AC.INTEREST_PAYABLE);
        const owedToCb = naturalBalance(ledger, cb.id, AC.INTEREST_RECEIVABLE);
        const settle = due < owedToCb ? due : owedToCb;
        if (settle > 0) {
          post(ledger, {
            tick: ctx.tick,
            kind: 'treasury.settle',
            description: `Facility interest settled by ${bank.id}`,
            postings: [
              debit(bank.id, AC.INTEREST_PAYABLE, settle),
              credit(bank.id, AC.RESERVES, settle),
              debit(cb.id, AC.RESERVES_ISSUED, settle),
              credit(cb.id, AC.INTEREST_RECEIVABLE, settle),
            ],
          });
        }
      }
    }
  },
});

/**
 * The central bank remunerates reserves at Bank Rate. This is the anchor for
 * everything else the bank can earn: any asset yielding less than this is a
 * choice to lose money, and any deposit costing more is a choice to buy
 * market share.
 */
function payInterestOnReserves(
  ctx: { tick: number; ledger: LedgerState },
  bankId: string,
  cbId: string,
  bankRate: number,
): void {
  const reserves = naturalBalance(ctx.ledger, bankId, AC.RESERVES);
  if (reserves <= 0) return;
  const interest = scale(reserves, dailyRate(bankRate));
  if (interest <= 0) return;
  post(ctx.ledger, {
    tick: ctx.tick,
    kind: 'treasury.reserveInterest',
    description: `Interest on reserves for ${bankId}`,
    postings: [
      debit(bankId, AC.RESERVES, interest),
      credit(bankId, AC.INTEREST_INCOME, interest),
      debit(cbId, AC.INTEREST_EXPENSE, interest),
      credit(cbId, AC.RESERVES_ISSUED, interest),
    ],
  });
}

function drawFunding(
  ctx: { tick: number; ledger: LedgerState },
  bankId: string,
  cbId: string,
  amount: Money,
): void {
  if (amount <= 0) return;
  post(ctx.ledger, {
    tick: ctx.tick,
    kind: 'treasury.draw',
    description: `${bankId} draws central bank funding`,
    postings: [
      debit(bankId, AC.RESERVES, amount),
      credit(bankId, AC.CENTRAL_BANK_FUNDING, amount),
      debit(cbId, AC.LOANS, amount),
      credit(cbId, AC.RESERVES_ISSUED, amount),
    ],
  });
}

function repayFunding(
  ctx: { tick: number; ledger: LedgerState },
  bankId: string,
  cbId: string,
  amount: Money,
): void {
  if (amount <= 0) return;
  post(ctx.ledger, {
    tick: ctx.tick,
    kind: 'treasury.repay',
    description: `${bankId} repays central bank funding`,
    postings: [
      credit(bankId, AC.RESERVES, amount),
      debit(bankId, AC.CENTRAL_BANK_FUNDING, amount),
      credit(cbId, AC.LOANS, amount),
      debit(cbId, AC.RESERVES_ISSUED, amount),
    ],
  });
}

function roundUpTo(amount: Money, step: Money): Money {
  return (Math.ceil(amount / step) * step) as Money;
}

function roundDownTo(amount: Money, step: Money): Money {
  return (Math.floor(amount / step) * step) as Money;
}

export const NO_FUNDING = round(ZERO);
