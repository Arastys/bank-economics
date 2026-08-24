import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { pounds, type Money } from '../src/core/money.js';
import { credit, debit, netPostings, trialBalance } from '../src/ledger/ledger.js';
import { AC } from '../src/ledger/accounts.js';
import { instrumentTypes } from '../src/instruments/registry.js';
import type { InstrumentContext } from '../src/instruments/types.js';

describe('netPostings', () => {
  it('collapses many movements on one account into a single line', () => {
    const netted = netPostings([
      debit('bank', AC.INTEREST_RECEIVABLE, pounds(10)),
      debit('bank', AC.INTEREST_RECEIVABLE, pounds(5)),
      credit('bank', AC.INTEREST_INCOME, pounds(15)),
    ]);
    expect(netted).toHaveLength(2);
    expect(netted.find((p) => p.code === AC.INTEREST_RECEIVABLE)!.amount).toBe(pounds(15));
  });

  it('conserves the total, so a balanced set stays balanced', () => {
    const postings = [
      debit('a', AC.INTEREST_RECEIVABLE, pounds(7)),
      credit('a', AC.INTEREST_INCOME, pounds(7)),
      debit('b', AC.INTEREST_EXPENSE, pounds(7)),
      credit('b', AC.INTEREST_PAYABLE, pounds(7)),
    ];
    const sum = (list: { amount: Money }[]) => list.reduce((t, p) => t + p.amount, 0);
    expect(sum(netPostings(postings))).toBe(sum(postings));
    expect(sum(netPostings(postings))).toBe(0);
  });

  it('drops lines that cancel out entirely', () => {
    const netted = netPostings([
      debit('a', AC.CASH, pounds(4)),
      credit('a', AC.CASH, pounds(4)),
      debit('b', AC.CASH, pounds(1)),
      credit('c', AC.REVENUE, pounds(1)),
    ]);
    expect(netted.map((p) => p.ownerId).sort()).toEqual(['b', 'c']);
  });

  it('handles an empty set', () => {
    expect(netPostings([])).toEqual([]);
  });

  it('nets per account, so the same code on two owners stays two lines', () => {
    const netted = netPostings([
      debit('a', AC.CASH, pounds(3)),
      debit('b', AC.CASH, pounds(4)),
      debit('a', AC.CASH, pounds(1)),
    ]);
    expect(netted).toHaveLength(2);
    expect(netted.find((p) => p.ownerId === 'a')!.amount).toBe(pounds(4));
    expect(netted.find((p) => p.ownerId === 'b')!.amount).toBe(pounds(4));
  });

  /**
   * Netting groups by owner, so an owner's lines arrive together however the
   * caller interleaved them. Nothing in the simulation depends on the order --
   * `post` only sums and adds -- but the journal shows it, so it is worth
   * pinning rather than leaving to the shape of the map.
   */
  it('groups an owner\'s lines together however they were interleaved', () => {
    const netted = netPostings([
      debit('a', AC.CASH, pounds(1)),
      debit('b', AC.CASH, pounds(1)),
      credit('a', AC.REVENUE, pounds(1)),
      credit('b', AC.REVENUE, pounds(1)),
    ]);
    expect(netted.map((p) => p.ownerId)).toEqual(['a', 'a', 'b', 'b']);
  });

  it('leaves every line a whole number of pence', () => {
    const netted = netPostings([
      debit('a', AC.CASH, pounds(0.01)),
      debit('a', AC.CASH, pounds(0.02)),
    ]);
    expect(netted[0]!.amount).toBe(3);
    expect(Number.isInteger(netted[0]!.amount)).toBe(true);
  });
});

describe('interest accrual', () => {
  /**
   * The handlers must not write to the ledger themselves. If one does, its
   * postings are both written individually and returned for batching, which
   * would double-count the interest.
   */
  it('returns postings rather than writing them', () => {
    const engine = newGame('uk2025');
    const ctx: InstrumentContext = {
      tick: engine.world.tick,
      world: engine.world,
      ledger: engine.world.ledger,
      emit: engine.context().emit,
      rng: engine.context().rng,
    };

    const instrument = Object.values(engine.world.instruments).find(
      (inst) => inst.status === 'active' && inst.type.startsWith('loan.') && inst.outstanding > 0,
    )!;
    const transactionsBefore = engine.world.ledger.nextTxId;
    const accruedBefore = instrument.accrued;

    const postings = instrumentTypes.get(instrument.type).accrue!(ctx, instrument);

    expect(engine.world.ledger.nextTxId).toBe(transactionsBefore);
    expect(instrument.accrued).toBeGreaterThan(accruedBefore);
    expect(postings && postings.length).toBeGreaterThan(0);
  });

  /**
   * Interest on thousands of contracts lands on a handful of accounts. Writing
   * one transaction per contract was over two thirds of the entire tick.
   */
  it('writes one transaction for the whole economy, not one per contract', () => {
    const engine = newGame('uk2025');
    engine.run(400);

    const active = Object.values(engine.world.instruments).filter((i) => i.status === 'active').length;
    const before = engine.world.ledger.nextTxId;
    engine.tick();
    const written = engine.world.ledger.nextTxId - before;

    expect(active).toBeGreaterThan(200);
    expect(written).toBeLessThan(active / 4);
  });

  it('still tracks what each contract is owed individually', () => {
    const engine = newGame('uk2025');
    engine.run(40);

    const loans = Object.values(engine.world.instruments).filter(
      (i) => i.status === 'active' && i.type.startsWith('loan.') && i.outstanding > 0,
    );
    const accrued = loans.map((l) => l.accrued);
    expect(accrued.every((a) => a >= 0)).toBe(true);
    expect(new Set(accrued).size).toBeGreaterThan(1);
  });

  it('keeps the books balanced while batching', () => {
    const engine = newGame('uk2025');
    engine.run(200);
    expect(trialBalance(engine.world.ledger)).toBe(0);
  });

  it('leaves the journal covering a useful stretch of history', () => {
    const engine = newGame('uk2025');
    engine.run(400);
    const journal = engine.world.ledger.journal;
    const span = engine.world.tick - journal[0]!.tick;
    // Before batching this was under two days, which is no use to anyone.
    expect(span).toBeGreaterThan(5);
  });
});
