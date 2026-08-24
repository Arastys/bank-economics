import { type Money } from '../core/money.js';
import { AC, depositCode, type AccountCode } from './accounts.js';
import { credit, debit, post, type LedgerState, type Posting, type Transaction } from './ledger.js';
import type { EntityId } from '../world/types.js';

/**
 * Where a party holds its spendable money.
 *
 * Banked parties hold a deposit claim on a specific bank; the bank itself and
 * the state hold central bank reserves; anyone else holds notes.
 */
export interface Wallet {
  ownerId: EntityId;
  /** The account the money actually sits in. */
  code: AccountCode;
  /** The bank holding the deposit, when the party is banked. */
  bankId?: EntityId;
}

export function walletCode(wallet: Wallet): AccountCode {
  return wallet.code;
}

/** A banked party's everyday current account. */
export function depositWallet(ownerId: EntityId, bankId: EntityId): Wallet {
  return { ownerId, code: depositCode(bankId), bankId };
}

/** Banks, the central bank and the state settle in central bank reserves. */
export function reserveWallet(ownerId: EntityId): Wallet {
  return { ownerId, code: AC.RESERVES };
}

export function cashWallet(ownerId: EntityId): Wallet {
  return { ownerId, code: AC.CASH };
}

export interface PaymentArgs {
  tick: number;
  kind: string;
  description: string;
  amount: Money;
  payer: Wallet;
  /** What the payer books the outflow against: an expense, a loan repayment, an asset. */
  payerContra: AccountCode;
  payee: Wallet;
  /** What the payee books the inflow against: revenue, a liability, an asset sold. */
  payeeContra: AccountCode;
  refs?: Record<string, string>;
}

/**
 * A payment between two parties, settled through the banking system.
 *
 * Both parties' books balance individually. When the parties bank with
 * different institutions, reserves move between those banks too, so the
 * payment system itself is modelled rather than assumed.
 */
export function makePayment(ledger: LedgerState, args: PaymentArgs): Transaction {
  const { amount, payer, payee } = args;
  if (payee.ownerId === payer.bankId || payer.ownerId === payee.bankId) {
    throw new Error(
      'makePayment is for third-party payments; when a bank is principal to its own customer use bankBooksPayment',
    );
  }
  const postings: Posting[] = [
    credit(payer.ownerId, walletCode(payer), amount),
    debit(payer.ownerId, args.payerContra, amount),
    debit(payee.ownerId, walletCode(payee), amount),
    credit(payee.ownerId, args.payeeContra, amount),
  ];

  // Settlement legs for the banks in the middle.
  if (payer.bankId && payer.bankId !== payee.bankId) {
    // Payer's bank loses a deposit and settles in reserves.
    postings.push(debit(payer.bankId, AC.CUSTOMER_DEPOSITS, amount));
    postings.push(credit(payer.bankId, AC.RESERVES, amount));
  }
  if (payee.bankId && payee.bankId !== payer.bankId) {
    postings.push(credit(payee.bankId, AC.CUSTOMER_DEPOSITS, amount));
    postings.push(debit(payee.bankId, AC.RESERVES, amount));
  }
  // Same bank on both sides: the deposit liability simply moves between
  // customers, so the bank needs no postings at all.

  return post(ledger, {
    tick: args.tick,
    kind: args.kind,
    description: args.description,
    refs: args.refs,
    postings,
  });
}

/**
 * A payment where one side is the bank itself acting as principal -- paying
 * deposit interest, or receiving loan interest from its own customer.
 */
export function bankBooksPayment(
  ledger: LedgerState,
  args: {
    tick: number;
    kind: string;
    description: string;
    amount: Money;
    bankId: EntityId;
    customerId: EntityId;
    /** 'toCustomer' credits the customer's deposit; 'fromCustomer' debits it. */
    direction: 'toCustomer' | 'fromCustomer';
    /** The bank's income or expense account. */
    bankContra: AccountCode;
    /** The customer's income or expense account. */
    customerContra: AccountCode;
    refs?: Record<string, string>;
  },
): Transaction {
  const { amount, bankId, customerId } = args;
  const dc = depositCode(bankId);
  const postings: Posting[] =
    args.direction === 'toCustomer'
      ? [
          credit(bankId, AC.CUSTOMER_DEPOSITS, amount),
          debit(bankId, args.bankContra, amount),
          debit(customerId, dc, amount),
          credit(customerId, args.customerContra, amount),
        ]
      : [
          debit(bankId, AC.CUSTOMER_DEPOSITS, amount),
          credit(bankId, args.bankContra, amount),
          credit(customerId, dc, amount),
          debit(customerId, args.customerContra, amount),
        ];

  return post(ledger, {
    tick: args.tick,
    kind: args.kind,
    description: args.description,
    refs: args.refs,
    postings,
  });
}
