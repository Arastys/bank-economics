import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { pounds } from '../src/core/money.js';
import { AC } from '../src/ledger/accounts.js';
import {
  balance,
  createLedger,
  credit,
  debit,
  ensureAccount,
  forgetOwner,
  getAccount,
  naturalBalance,
  post,
  trialBalance,
} from '../src/ledger/ledger.js';
import { load, save } from '../src/engine/snapshot.js';

/**
 * Balances are read through an index that holds the same `Account` objects the
 * flat record does, so the cases worth covering are the ones where the two
 * could drift apart.
 */
describe('account index', () => {
  it('reads back what was posted', () => {
    const ledger = createLedger();
    post(ledger, {
      tick: 1,
      kind: 'test',
      description: 'sale',
      postings: [debit('a', AC.CASH, pounds(30)), credit('a', AC.REVENUE, pounds(30))],
    });

    expect(balance(ledger, 'a', AC.CASH)).toBe(pounds(30));
    expect(naturalBalance(ledger, 'a', AC.REVENUE)).toBe(pounds(30));
    expect(trialBalance(ledger)).toBe(0);
  });

  it('hands out the one account object, so a posting is visible through both paths', () => {
    const ledger = createLedger();
    const account = ensureAccount(ledger, 'a', AC.CASH);

    post(ledger, {
      tick: 1,
      kind: 'test',
      description: 'sale',
      postings: [debit('a', AC.CASH, pounds(12)), credit('a', AC.REVENUE, pounds(12))],
    });

    expect(getAccount(ledger, 'a', AC.CASH)).toBe(account);
    expect(account.balance).toBe(pounds(12));
    expect(ledger.accounts[account.id]).toBe(account);
  });

  it('reads zero once an owner is forgotten, and does not resurrect them', () => {
    const ledger = createLedger();
    post(ledger, {
      tick: 1,
      kind: 'test',
      description: 'sale',
      postings: [debit('a', AC.CASH, pounds(9)), credit('a', AC.REVENUE, pounds(9))],
    });
    expect(balance(ledger, 'a', AC.CASH)).toBe(pounds(9));

    forgetOwner(ledger, 'a');

    expect(balance(ledger, 'a', AC.CASH)).toBe(0);
    expect(getAccount(ledger, 'a', AC.CASH)).toBeUndefined();

    // An id that comes round again starts clean rather than inheriting a
    // stale entry from the index.
    const fresh = ensureAccount(ledger, 'a', AC.CASH);
    expect(fresh.balance).toBe(0);
    expect(ledger.accounts[fresh.id]).toBe(fresh);
    expect(ledger.accountsByOwner['a']).toEqual([fresh.id]);
  });

  it('forgets an owner whose index was never built', () => {
    const ledger = createLedger();
    ensureAccount(ledger, 'a', AC.CASH);
    // Rebuild from the flat record after the deletion rather than before it.
    const rebuilt = createLedger();
    Object.assign(rebuilt, {
      accounts: { ...ledger.accounts },
      accountsByOwner: { ...ledger.accountsByOwner },
    });

    forgetOwner(rebuilt, 'a');

    expect(balance(rebuilt, 'a', AC.CASH)).toBe(0);
    expect(getAccount(rebuilt, 'a', AC.CASH)).toBeUndefined();
  });

  /**
   * A restored save arrives as a fresh object graph with no index, so every
   * balance has to come back from the flat record it was serialised as.
   */
  it('rebuilds itself for a restored save', () => {
    const world = newGame('uk2025').world;
    const funded = Object.values(world.ledger.accounts).filter((a) => a.balance !== 0);
    expect(funded.length).toBeGreaterThan(10);

    const restored = load(save(world));

    for (const account of funded) {
      expect(balance(restored.ledger, account.ownerId, account.code)).toBe(account.balance);
      expect(getAccount(restored.ledger, account.ownerId, account.code)).toBeDefined();
    }
    expect(trialBalance(restored.ledger)).toBe(0);
  });
});
