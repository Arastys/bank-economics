import type { Money } from '../core/money.js';

export type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface Account {
  /** `${ownerId}/${code}` */
  id: string;
  ownerId: string;
  code: string;
  kind: AccountKind;
  name: string;
  /**
   * Running balance, debit-positive. Assets and expenses sit positive here;
   * liabilities, equity and income sit negative. Use `normalBalance` for display.
   */
  balance: Money;
}

/**
 * Standard account codes. Codes are plain strings so that new products can
 * introduce new accounts (and so per-counterparty accounts can be generated)
 * without changing this file.
 */
export const AC = {
  // Assets
  CASH: 'cash',
  RESERVES: 'reserves',
  LOANS: 'loans',
  BONDS: 'bonds',
  INTEREST_RECEIVABLE: 'interestReceivable',
  INVENTORY: 'inventory',
  FIXED_ASSETS: 'fixedAssets',
  TRADE_RECEIVABLES: 'tradeReceivables',
  LOAN_LOSS_ALLOWANCE: 'loanLossAllowance', // contra-asset, credit balance

  // Liabilities
  CUSTOMER_DEPOSITS: 'customerDeposits',
  BORROWINGS: 'borrowings',
  DEBT_ISSUED: 'debtIssued',
  CENTRAL_BANK_FUNDING: 'centralBankFunding',
  INTEREST_PAYABLE: 'interestPayable',
  TRADE_PAYABLES: 'tradePayables',
  BANKNOTES_ISSUED: 'banknotesIssued',
  RESERVES_ISSUED: 'reservesIssued', // central bank's liability for bank reserves

  // Equity
  SHARE_CAPITAL: 'shareCapital',
  RETAINED_EARNINGS: 'retainedEarnings',

  // Income
  INTEREST_INCOME: 'interestIncome',
  FEE_INCOME: 'feeIncome',
  TRADING_INCOME: 'tradingIncome',
  REVENUE: 'revenue',
  WAGE_INCOME: 'wageIncome',
  DIVIDEND_INCOME: 'dividendIncome',
  DEBT_FORGIVEN: 'debtForgiven',

  // Expenses
  INTEREST_EXPENSE: 'interestExpense',
  OPERATING_EXPENSE: 'operatingExpense',
  IMPAIRMENT: 'impairment',
  COST_OF_SALES: 'costOfSales',
  WAGES: 'wages',
  CONSUMPTION: 'consumption',
  DEPRECIATION: 'depreciation',
  TAX: 'tax',
} as const;

export type AccountCode = string;

/** A customer's deposit claim on a specific bank. */
export function depositCode(bankId: string): AccountCode {
  return `deposit@${bankId}`;
}

/** A customer's term deposit with a specific bank. */
export function termDepositCode(bankId: string): AccountCode {
  return `termDeposit@${bankId}`;
}

export function isDepositCode(code: AccountCode): boolean {
  return code.startsWith('deposit@') || code.startsWith('termDeposit@');
}

export function bankIdFromDepositCode(code: AccountCode): string {
  return code.slice(code.indexOf('@') + 1);
}

const KIND_BY_CODE: Record<string, AccountKind> = {
  [AC.CASH]: 'asset',
  [AC.RESERVES]: 'asset',
  [AC.LOANS]: 'asset',
  [AC.BONDS]: 'asset',
  [AC.INTEREST_RECEIVABLE]: 'asset',
  [AC.INVENTORY]: 'asset',
  [AC.FIXED_ASSETS]: 'asset',
  [AC.TRADE_RECEIVABLES]: 'asset',
  [AC.LOAN_LOSS_ALLOWANCE]: 'asset',
  [AC.CUSTOMER_DEPOSITS]: 'liability',
  [AC.BORROWINGS]: 'liability',
  [AC.DEBT_ISSUED]: 'liability',
  [AC.CENTRAL_BANK_FUNDING]: 'liability',
  [AC.INTEREST_PAYABLE]: 'liability',
  [AC.TRADE_PAYABLES]: 'liability',
  [AC.BANKNOTES_ISSUED]: 'liability',
  [AC.RESERVES_ISSUED]: 'liability',
  [AC.SHARE_CAPITAL]: 'equity',
  [AC.RETAINED_EARNINGS]: 'equity',
  [AC.INTEREST_INCOME]: 'income',
  [AC.FEE_INCOME]: 'income',
  [AC.TRADING_INCOME]: 'income',
  [AC.REVENUE]: 'income',
  [AC.WAGE_INCOME]: 'income',
  [AC.DIVIDEND_INCOME]: 'income',
  [AC.DEBT_FORGIVEN]: 'income',
  [AC.INTEREST_EXPENSE]: 'expense',
  [AC.OPERATING_EXPENSE]: 'expense',
  [AC.IMPAIRMENT]: 'expense',
  [AC.COST_OF_SALES]: 'expense',
  [AC.WAGES]: 'expense',
  [AC.CONSUMPTION]: 'expense',
  [AC.DEPRECIATION]: 'expense',
  [AC.TAX]: 'expense',
};

export function kindOf(code: AccountCode): AccountKind {
  if (isDepositCode(code)) return 'asset';
  const kind = KIND_BY_CODE[code];
  if (!kind) throw new Error(`Unknown account code "${code}" -- register it in accounts.ts`);
  return kind;
}

/** Display balance in the account's natural direction (positive = normal). */
export function normalBalance(account: Account): Money {
  return (account.kind === 'asset' || account.kind === 'expense'
    ? account.balance
    : -account.balance) as Money;
}

export function accountId(ownerId: string, code: AccountCode): string {
  return `${ownerId}/${code}`;
}
