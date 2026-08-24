import { ZERO, add, atLeastZero, min, scale, sub, type Money } from '../core/money.js';
import { nextId } from '../core/ids.js';
import { addMonths, dailyRate } from '../core/time.js';
import { AC, depositCode, termDepositCode } from '../ledger/accounts.js';
import { balance, credit, debit, post } from '../ledger/ledger.js';
import { addInstrument, touch } from '../world/state.js';
import type { EntityId } from '../world/types.js';
import { instrumentTypes } from './registry.js';
import type { Instrument, InstrumentContext, InstrumentType } from './types.js';

export const DEPOSIT_INSTANT = 'deposit.instant';
export const DEPOSIT_TERM = 'deposit.term';

export interface OpenDepositArgs {
  bankId: EntityId;
  customerId: EntityId;
  /** Annual nominal rate. */
  rate: number;
  /** Term deposits only. */
  termMonths?: number;
  /** Term deposits only: the amount locked away. */
  amount?: Money;
}

/**
 * Open an instant-access account. This only establishes the relationship --
 * the balance itself lives in the customer's ledger account, so paying wages
 * into it needs no further product plumbing.
 */
export function openInstantDeposit(ctx: InstrumentContext, args: OpenDepositArgs): Instrument {
  const { world, tick } = ctx;
  const id = nextId(world.ids, 'dep');
  const inst = addInstrument(world, {
    id,
    type: DEPOSIT_INSTANT,
    holderId: args.customerId,
    obligorId: args.bankId,
    principal: ZERO,
    outstanding: balance(ctx.ledger, args.customerId, depositCode(args.bankId)),
    rate: args.rate,
    accrued: ZERO,
    openedOn: tick,
    nextPaymentOn: addMonths(tick, 1),
    paymentIntervalMonths: 1,
    status: 'active',
    data: {},
  });
  touch(world, args.customerId);
  ctx.emit('deposit.opened', {
    depositId: id,
    bankId: args.bankId,
    customerId: args.customerId,
    amount: inst.outstanding,
  });
  return inst;
}

/** Lock money away for a fixed term at a better rate. */
export function openTermDeposit(ctx: InstrumentContext, args: OpenDepositArgs & { amount: Money }): Instrument {
  const { world, ledger, tick } = ctx;
  const available = atLeastZero(balance(ledger, args.customerId, depositCode(args.bankId)));
  const amount = min(args.amount, available);
  if (amount <= 0) throw new Error(`${args.customerId} has nothing to place on term deposit`);

  const id = nextId(world.ids, 'dep');
  post(ledger, {
    tick,
    kind: 'deposit.term.place',
    description: `Term deposit ${id}`,
    refs: { depositId: id },
    postings: [
      // Only the customer's own accounts move; for the bank this is still the
      // same deposit liability, just on different terms.
      credit(args.customerId, depositCode(args.bankId), amount),
      debit(args.customerId, termDepositCode(args.bankId), amount),
    ],
  });

  const inst = addInstrument(world, {
    id,
    type: DEPOSIT_TERM,
    holderId: args.customerId,
    obligorId: args.bankId,
    principal: amount,
    outstanding: amount,
    rate: args.rate,
    accrued: ZERO,
    openedOn: tick,
    maturesOn: addMonths(tick, args.termMonths ?? 12),
    status: 'active',
    data: { termMonths: args.termMonths ?? 12 },
  });
  touch(world, args.customerId);
  ctx.emit('deposit.opened', { depositId: id, bankId: args.bankId, customerId: args.customerId, amount });
  return inst;
}

function accrueDepositInterest(ctx: InstrumentContext, inst: Instrument): void {
  const bankId = inst.obligorId;
  const customerId = inst.holderId;
  const code = inst.type === DEPOSIT_TERM ? termDepositCode(bankId) : depositCode(bankId);
  // Instant-access balances move every day, so read the live figure rather
  // than trusting a cached one.
  inst.outstanding = atLeastZero(balance(ctx.ledger, customerId, code));

  const interest = scale(inst.outstanding, dailyRate(inst.rate));
  if (interest === 0) return;
  inst.accrued = add(inst.accrued, interest);

  post(ctx.ledger, {
    tick: ctx.tick,
    kind: 'deposit.accrue',
    description: `Deposit interest accrued on ${inst.id}`,
    refs: { depositId: inst.id },
    postings: [
      debit(bankId, AC.INTEREST_EXPENSE, interest),
      credit(bankId, AC.INTEREST_PAYABLE, interest),
      debit(customerId, AC.INTEREST_RECEIVABLE, interest),
      credit(customerId, AC.INTEREST_INCOME, interest),
    ],
  });
}

/** Capitalise accrued interest into the customer's balance. */
function payDepositInterest(ctx: InstrumentContext, inst: Instrument): void {
  const bankId = inst.obligorId;
  const customerId = inst.holderId;
  const amount = inst.accrued;
  if (amount > 0) {
    post(ctx.ledger, {
      tick: ctx.tick,
      kind: 'deposit.interest',
      description: `Interest paid on ${inst.id}`,
      refs: { depositId: inst.id },
      postings: [
        debit(bankId, AC.INTEREST_PAYABLE, amount),
        credit(bankId, AC.CUSTOMER_DEPOSITS, amount),
        debit(customerId, depositCode(bankId), amount),
        credit(customerId, AC.INTEREST_RECEIVABLE, amount),
      ],
    });
    inst.accrued = ZERO;
  }
  if (inst.paymentIntervalMonths) {
    inst.nextPaymentOn = addMonths(ctx.tick, inst.paymentIntervalMonths);
  }
}

/** Release a matured term deposit back to instant access. */
function releaseTermDeposit(ctx: InstrumentContext, inst: Instrument): void {
  const bankId = inst.obligorId;
  const customerId = inst.holderId;
  payDepositInterest(ctx, inst);
  if (inst.outstanding > 0) {
    post(ctx.ledger, {
      tick: ctx.tick,
      kind: 'deposit.term.release',
      description: `Term deposit ${inst.id} matured`,
      refs: { depositId: inst.id },
      postings: [
        credit(customerId, termDepositCode(bankId), inst.outstanding),
        debit(customerId, depositCode(bankId), inst.outstanding),
      ],
    });
  }
  inst.outstanding = ZERO;
  inst.status = 'matured';
  ctx.emit('deposit.closed', { depositId: inst.id, reason: 'matured' });
}

const instantDeposit: InstrumentType = {
  key: DEPOSIT_INSTANT,
  category: 'deposit',
  label: 'Instant access account',
  accrue: accrueDepositInterest,
  onPayment: payDepositInterest,
  // Retail instant access is sticky, but some of it walks out the door in a
  // stress. This factor is what the liquidity ratio is built on.
  outflowFactor() {
    return 0.1;
  },
};

const termDeposit: InstrumentType = {
  key: DEPOSIT_TERM,
  category: 'deposit',
  label: 'Term deposit',
  accrue: accrueDepositInterest,
  onMature: releaseTermDeposit,
  outflowFactor() {
    return 0;
  },
};

export function registerDepositTypes(): void {
  instrumentTypes.register(DEPOSIT_INSTANT, instantDeposit);
  instrumentTypes.register(DEPOSIT_TERM, termDeposit);
}

/** Total deposit balances a bank owes, read straight from the ledger. */
export function depositsAtBank(ctx: InstrumentContext, bankId: EntityId): Money {
  return sub(ZERO, balance(ctx.ledger, bankId, AC.CUSTOMER_DEPOSITS)) as Money;
}
