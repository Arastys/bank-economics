import { describe, expect, it } from 'vitest';
import { pounds, type Money } from '../src/core/money.js';
import { AC } from '../src/ledger/accounts.js';
import {
  UnbalancedTransactionError,
  createLedger,
  credit,
  debit,
  entityTrialBalance,
  forgetOwner,
  naturalBalance,
  openWithCapital,
  post,
  trialBalance,
} from '../src/ledger/ledger.js';
import { balanceSheet, closePeriod, incomeStatement } from '../src/ledger/statements.js';

describe('ledger', () => {
  it('refuses a transaction that does not balance', () => {
    const ledger = createLedger();
    expect(() =>
      post(ledger, {
        tick: 0,
        kind: 'test',
        description: 'lopsided',
        postings: [debit('a', AC.CASH, pounds(10))],
      }),
    ).toThrow(UnbalancedTransactionError);
    expect(trialBalance(ledger)).toBe(0);
  });

  it('keeps the trial balance at zero through many transactions', () => {
    const ledger = createLedger();
    openWithCapital(ledger, 'firm', 0, { [AC.CASH]: pounds(1000) });
    for (let i = 1; i <= 50; i++) {
      post(ledger, {
        tick: i,
        kind: 'test',
        description: `move ${i}`,
        postings: [credit('firm', AC.CASH, pounds(1)), debit('firm', AC.OPERATING_EXPENSE, pounds(1))],
      });
    }
    expect(trialBalance(ledger)).toBe(0);
    expect(entityTrialBalance(ledger, 'firm')).toBe(0);
  });

  it('opens an entity with assets, liabilities and the balancing equity', () => {
    const ledger = createLedger();
    openWithCapital(ledger, 'firm', 0, { [AC.CASH]: pounds(1000) }, { [AC.BORROWINGS]: pounds(400) });
    const sheet = balanceSheet(ledger, 'firm');
    expect(sheet.totalAssets).toBe(pounds(1000));
    expect(sheet.totalLiabilities).toBe(pounds(400));
    expect(sheet.totalEquity).toBe(pounds(600));
    expect(sheet.totalAssets).toBe(sheet.totalLiabilities + sheet.totalEquity);
  });

  it('reports unclosed profit inside equity so the sheet always balances', () => {
    const ledger = createLedger();
    openWithCapital(ledger, 'firm', 0, { [AC.CASH]: pounds(1000) });
    post(ledger, {
      tick: 1,
      kind: 'sale',
      description: 'a sale',
      postings: [debit('firm', AC.CASH, pounds(250)), credit('firm', AC.REVENUE, pounds(250))],
    });

    const sheet = balanceSheet(ledger, 'firm');
    expect(sheet.totalAssets).toBe(pounds(1250));
    expect(sheet.totalEquity).toBe(pounds(1250));

    const pl = incomeStatement(ledger, 'firm');
    expect(pl.profit).toBe(pounds(250));
  });

  it('closes the period into retained earnings', () => {
    const ledger = createLedger();
    openWithCapital(ledger, 'firm', 0, { [AC.CASH]: pounds(1000) });
    post(ledger, {
      tick: 1,
      kind: 'sale',
      description: 'a sale',
      postings: [debit('firm', AC.CASH, pounds(250)), credit('firm', AC.REVENUE, pounds(250))],
    });

    const profit = closePeriod(ledger, 'firm', 2);
    expect(profit).toBe(pounds(250));
    expect(naturalBalance(ledger, 'firm', AC.RETAINED_EARNINGS)).toBe(pounds(250));
    expect(incomeStatement(ledger, 'firm').profit).toBe(0);
    expect(entityTrialBalance(ledger, 'firm')).toBe(0);
  });

  it('refuses to forget an entity whose books do not balance', () => {
    const ledger = createLedger();
    post(ledger, {
      tick: 0,
      kind: 'test',
      description: 'one-sided across two owners',
      postings: [debit('a', AC.CASH, pounds(5) as Money), credit('b', AC.REVENUE, pounds(5) as Money)],
    });
    expect(() => forgetOwner(ledger, 'a')).toThrow(/out of balance/);
  });
});
