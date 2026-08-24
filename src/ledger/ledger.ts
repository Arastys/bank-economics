import { ZERO, add, type Money } from '../core/money.js';
import { AC, accountId, kindOf, type Account, type AccountCode } from './accounts.js';

/** One leg of a transaction. Positive = debit, negative = credit. */
export interface Posting {
  ownerId: string;
  code: AccountCode;
  amount: Money;
}

export interface Transaction {
  id: number;
  tick: number;
  kind: string;
  description: string;
  postings: Posting[];
  /** Optional links back to the domain object that caused this (loan id, bond id...). */
  refs?: Record<string, string>;
}

export interface LedgerState {
  accounts: Record<string, Account>;
  /** Account ids grouped by owner. Scanning every account to find one
   *  entity's books is the single hottest thing a tick can do, so the index
   *  is maintained rather than derived. */
  accountsByOwner: Record<string, string[]>;
  /** Most recent transactions, capped so long games do not grow without bound. */
  journal: Transaction[];
  journalCap: number;
  nextTxId: number;
}

export function createLedger(journalCap = 2000): LedgerState {
  return { accounts: {}, accountsByOwner: {}, journal: [], journalCap, nextTxId: 1 };
}

export function ensureAccount(ledger: LedgerState, ownerId: string, code: AccountCode, name?: string): Account {
  const id = accountId(ownerId, code);
  let account = ledger.accounts[id];
  if (!account) {
    account = { id, ownerId, code, kind: kindOf(code), name: name ?? code, balance: ZERO };
    ledger.accounts[id] = account;
    (ledger.accountsByOwner[ownerId] ??= []).push(id);
  }
  return account;
}

export function getAccount(ledger: LedgerState, ownerId: string, code: AccountCode): Account | undefined {
  return ledger.accounts[accountId(ownerId, code)];
}

/** Debit-positive balance. Missing accounts read as zero. */
export function balance(ledger: LedgerState, ownerId: string, code: AccountCode): Money {
  return ledger.accounts[accountId(ownerId, code)]?.balance ?? ZERO;
}

/** Balance in the account's natural direction: a deposit liability reads positive. */
export function naturalBalance(ledger: LedgerState, ownerId: string, code: AccountCode): Money {
  const account = ledger.accounts[accountId(ownerId, code)];
  if (!account) return ZERO;
  return (account.kind === 'asset' || account.kind === 'expense' ? account.balance : -account.balance) as Money;
}

export function accountsOf(ledger: LedgerState, ownerId: string): Account[] {
  const ids = ledger.accountsByOwner[ownerId];
  if (!ids) return [];
  const out: Account[] = [];
  for (const id of ids) {
    const account = ledger.accounts[id];
    if (account) out.push(account);
  }
  return out;
}

/**
 * Drop an entity's accounts entirely.
 *
 * Only legitimate when the entity's own books balance, since deleting a set of
 * accounts that does not sum to zero would silently create or destroy money.
 * That is always a bug in the caller, so it is refused loudly.
 */
export function forgetOwner(ledger: LedgerState, ownerId: string): void {
  const residual = entityTrialBalance(ledger, ownerId);
  if (residual !== 0) {
    throw new Error(`Refusing to forget ${ownerId}: books are ${residual}p out of balance`);
  }
  for (const id of ledger.accountsByOwner[ownerId] ?? []) delete ledger.accounts[id];
  delete ledger.accountsByOwner[ownerId];
}

export class UnbalancedTransactionError extends Error {
  constructor(public readonly tx: Omit<Transaction, 'id'>, public readonly residual: Money) {
    super(`Unbalanced transaction "${tx.kind}": postings sum to ${residual}p, must be 0`);
    this.name = 'UnbalancedTransactionError';
  }
}

/**
 * Record a transaction. Postings must sum to zero across all legs -- this is
 * the invariant that makes money impossible to create or destroy by accident.
 */
export function post(ledger: LedgerState, tx: Omit<Transaction, 'id'>): Transaction {
  let residual = 0;
  for (const p of tx.postings) residual += p.amount;
  if (residual !== 0) throw new UnbalancedTransactionError(tx, residual as Money);

  for (const p of tx.postings) {
    if (p.amount === 0) continue;
    const account = ensureAccount(ledger, p.ownerId, p.code);
    account.balance = add(account.balance, p.amount);
  }

  const recorded: Transaction = { ...tx, id: ledger.nextTxId++ };
  ledger.journal.push(recorded);
  if (ledger.journal.length > ledger.journalCap) {
    ledger.journal.splice(0, ledger.journal.length - ledger.journalCap);
  }
  return recorded;
}

export function debit(ownerId: string, code: AccountCode, amount: Money): Posting {
  return { ownerId, code, amount };
}

export function credit(ownerId: string, code: AccountCode, amount: Money): Posting {
  return { ownerId, code, amount: -amount as Money };
}

/**
 * Move value between two parties, each booking it against their own contra
 * account, so both sets of books balance individually.
 */
export interface SettleSide {
  ownerId: string;
  /** The asset or liability that moves -- usually a deposit account. */
  valueCode: AccountCode;
  /** What the party books the other side against (revenue, expense, a loan...). */
  contraCode: AccountCode;
}

export function settle(
  ledger: LedgerState,
  args: {
    tick: number;
    kind: string;
    description: string;
    amount: Money;
    payer: SettleSide;
    payee: SettleSide;
    refs?: Record<string, string>;
  },
): Transaction {
  const { amount, payer, payee } = args;
  return post(ledger, {
    tick: args.tick,
    kind: args.kind,
    description: args.description,
    refs: args.refs,
    postings: [
      // Payer: value out, contra in.
      credit(payer.ownerId, payer.valueCode, amount),
      debit(payer.ownerId, payer.contraCode, amount),
      // Payee: value in, contra out.
      debit(payee.ownerId, payee.valueCode, amount),
      credit(payee.ownerId, payee.contraCode, amount),
    ],
  });
}

/** Sum of every balance in the ledger. Must always be exactly zero. */
export function trialBalance(ledger: LedgerState): Money {
  let total = 0;
  for (const id in ledger.accounts) total += ledger.accounts[id]!.balance;
  return total as Money;
}

/** Sum of one entity's balances. Also always zero for a well-formed entity. */
export function entityTrialBalance(ledger: LedgerState, ownerId: string): Money {
  let total = 0;
  for (const account of accountsOf(ledger, ownerId)) total += account.balance;
  return total as Money;
}

/** Every entity that has at least one account. */
export function ownerIds(ledger: LedgerState): string[] {
  return Object.keys(ledger.accountsByOwner);
}

/**
 * Seed an entity's opening balance sheet. Assets are debited, the balancing
 * credit goes to share capital, so the entity starts life balanced.
 */
export function openWithCapital(
  ledger: LedgerState,
  ownerId: string,
  tick: number,
  assets: Partial<Record<AccountCode, Money>>,
  liabilities: Partial<Record<AccountCode, Money>> = {},
): Transaction {
  const postings: Posting[] = [];
  let equity = 0;
  for (const [code, amount] of Object.entries(assets)) {
    if (!amount) continue;
    postings.push(debit(ownerId, code, amount));
    equity += amount;
  }
  for (const [code, amount] of Object.entries(liabilities)) {
    if (!amount) continue;
    postings.push(credit(ownerId, code, amount));
    equity -= amount;
  }
  postings.push(credit(ownerId, AC.SHARE_CAPITAL, equity as Money));
  return post(ledger, {
    tick,
    kind: 'entity.open',
    description: `Opening balance sheet for ${ownerId}`,
    postings,
  });
}
