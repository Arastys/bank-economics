import { ZERO, type Money } from '../core/money.js';
import { AC, type AccountCode } from './accounts.js';
import { accountsOf, credit, debit, post, type LedgerState, type Posting } from './ledger.js';

export interface LineItem {
  code: AccountCode;
  name: string;
  amount: Money;
}

export interface BalanceSheet {
  ownerId: string;
  assets: LineItem[];
  liabilities: LineItem[];
  equity: LineItem[];
  totalAssets: Money;
  totalLiabilities: Money;
  /** Book equity including profit not yet closed to reserves. */
  totalEquity: Money;
}

export interface IncomeStatement {
  ownerId: string;
  income: LineItem[];
  expenses: LineItem[];
  totalIncome: Money;
  totalExpenses: Money;
  profit: Money;
}

export function balanceSheet(ledger: LedgerState, ownerId: string): BalanceSheet {
  const assets: LineItem[] = [];
  const liabilities: LineItem[] = [];
  const equity: LineItem[] = [];
  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;

  for (const account of accountsOf(ledger, ownerId)) {
    if (account.balance === 0) continue;
    const natural = (account.kind === 'asset' || account.kind === 'expense'
      ? account.balance
      : -account.balance) as Money;
    const item: LineItem = { code: account.code, name: account.name, amount: natural };
    switch (account.kind) {
      case 'asset':
        assets.push(item);
        totalAssets += natural;
        break;
      case 'liability':
        liabilities.push(item);
        totalLiabilities += natural;
        break;
      case 'equity':
        equity.push(item);
        totalEquity += natural;
        break;
      // Income and expenses are unclosed profit; they belong to equity until
      // the period is closed, which keeps A = L + E true on any given day.
      case 'income':
        totalEquity += natural;
        break;
      case 'expense':
        totalEquity -= natural;
        break;
    }
  }

  const retained = totalEquity - equity.reduce((a, b) => a + b.amount, 0);
  if (retained !== 0) {
    equity.push({ code: 'profitForPeriod', name: 'Profit for period', amount: retained as Money });
  }

  return {
    ownerId,
    assets: sortLines(assets),
    liabilities: sortLines(liabilities),
    equity: sortLines(equity),
    totalAssets: totalAssets as Money,
    totalLiabilities: totalLiabilities as Money,
    totalEquity: totalEquity as Money,
  };
}

export function incomeStatement(ledger: LedgerState, ownerId: string): IncomeStatement {
  const income: LineItem[] = [];
  const expenses: LineItem[] = [];
  let totalIncome = 0;
  let totalExpenses = 0;

  for (const account of accountsOf(ledger, ownerId)) {
    if (account.balance === 0) continue;
    if (account.kind === 'income') {
      const amount = -account.balance as Money;
      income.push({ code: account.code, name: account.name, amount });
      totalIncome += amount;
    } else if (account.kind === 'expense') {
      const amount = account.balance;
      expenses.push({ code: account.code, name: account.name, amount });
      totalExpenses += amount;
    }
  }

  return {
    ownerId,
    income: sortLines(income),
    expenses: sortLines(expenses),
    totalIncome: totalIncome as Money,
    totalExpenses: totalExpenses as Money,
    profit: (totalIncome - totalExpenses) as Money,
  };
}

function sortLines(lines: LineItem[]): LineItem[] {
  return lines.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

/**
 * Close income and expense accounts into retained earnings. Run at period end
 * so the next period's P&L starts from zero.
 */
export function closePeriod(ledger: LedgerState, ownerId: string, tick: number): Money {
  const postings: Posting[] = [];
  let profit = 0;

  for (const account of accountsOf(ledger, ownerId)) {
    if (account.balance === 0) continue;
    if (account.kind === 'income') {
      profit += -account.balance;
      postings.push(debit(ownerId, account.code, -account.balance as Money));
    } else if (account.kind === 'expense') {
      profit -= account.balance;
      postings.push(credit(ownerId, account.code, account.balance));
    }
  }

  if (postings.length === 0) return ZERO;
  postings.push(credit(ownerId, AC.RETAINED_EARNINGS, profit as Money));
  post(ledger, {
    tick,
    kind: 'period.close',
    description: `Close income statement for ${ownerId}`,
    postings,
  });
  return profit as Money;
}
