import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { pounds, type Money } from '../src/core/money.js';
import { promoteMember } from '../src/agents/lod.js';
import { isInsolvent } from '../src/agents/insolvency.js';
import { defaultLoan, originateLoan } from '../src/instruments/loan.js';
import { AC } from '../src/ledger/accounts.js';
import { credit, debit, naturalBalance, post, trialBalance } from '../src/ledger/ledger.js';
import { balanceSheet } from '../src/ledger/statements.js';
import { payBetween, spendable } from '../src/world/transfer.js';
import { cohorts } from '../src/world/state.js';
import type { Company } from '../src/world/types.js';

/** A borrower with a loan from the player, materialised out of a cohort. */
function borrower() {
  const engine = newGame('uk2025');
  const ctx = engine.context();
  const cohort = cohorts(engine.world).find((c) => c.memberKind === 'company' && c.count > 1000)!;
  const company = promoteMember(ctx, cohort.id, 'test')!.entity as Company;

  const loan = originateLoan(ctx, {
    lenderId: engine.world.playerBankId,
    borrowerId: company.id,
    amount: pounds(20_000),
    rate: 0.07,
    termMonths: 36,
    grade: 'BB',
  });
  return { engine, ctx, cohort, company, loan };
}

/** Spend the firm's cash on fixed assets: illiquid, but still solvent. */
function tieUpCashInAssets(world: ReturnType<typeof borrower>['engine']['world'], companyId: string, cohortId: string) {
  const cash = spendable(world, world.ledger, companyId);
  payBetween(world, world.ledger, {
    tick: world.tick,
    kind: 'test.buyAssets',
    description: 'Firm sinks its cash into equipment',
    amount: cash,
    fromId: companyId,
    fromContra: AC.FIXED_ASSETS,
    toId: cohortId,
    toContra: AC.FIXED_ASSETS,
  });
}

/** Saddle the firm with debt it cannot possibly cover. */
function makeInsolvent(world: ReturnType<typeof borrower>['engine']['world'], companyId: string) {
  const assets = balanceSheet(world.ledger, companyId).totalAssets;
  const crushing = (assets * 3) as Money;
  post(world.ledger, {
    tick: world.tick,
    kind: 'test.ruin',
    description: 'A very bad year',
    postings: [credit(companyId, AC.BORROWINGS, crushing), debit(companyId, AC.OPERATING_EXPENSE, crushing)],
  });
}

describe('illiquid but solvent', () => {
  it('is worked out rather than wound up', () => {
    const { engine, ctx, cohort, company, loan } = borrower();
    tieUpCashInAssets(engine.world, company.id, cohort.id);
    expect(isInsolvent(engine.world.ledger, company.id)).toBe(false);

    defaultLoan(ctx, loan);

    expect(loan.status).toBe('closed');
    expect(company.status).not.toBe('defaulted');
    expect(engine.world.entities[company.id]).toBeDefined();
  });

  it('repays the lender in full, so nothing is impaired', () => {
    const { engine, ctx, cohort, company, loan } = borrower();
    const bank = engine.world.playerBankId;
    tieUpCashInAssets(engine.world, company.id, cohort.id);
    const impairedBefore = naturalBalance(engine.world.ledger, bank, AC.IMPAIRMENT);

    defaultLoan(ctx, loan);

    expect(naturalBalance(engine.world.ledger, bank, AC.IMPAIRMENT)).toBe(impairedBefore);
  });

  it('leaves the firm smaller, having sold assets to raise the money', () => {
    const { engine, ctx, cohort, company, loan } = borrower();
    tieUpCashInAssets(engine.world, company.id, cohort.id);
    const assetsBefore = naturalBalance(engine.world.ledger, company.id, AC.FIXED_ASSETS);

    defaultLoan(ctx, loan);

    expect(naturalBalance(engine.world.ledger, company.id, AC.FIXED_ASSETS)).toBeLessThan(assetsBefore);
    expect(company.status).toBe('distressed');
  });

  it('does not touch the other lenders it owes', () => {
    const { engine, ctx, cohort, company, loan } = borrower();
    const others = Object.values(engine.world.instruments).filter(
      (i) => i.obligorId === company.id && i.id !== loan.id && i.status === 'active',
    );
    tieUpCashInAssets(engine.world, company.id, cohort.id);

    defaultLoan(ctx, loan);

    for (const other of others) expect(other.status).toBe('active');
  });
});

describe('genuinely insolvent', () => {
  it('is wound up and stops trading', () => {
    const { engine, ctx, company, loan } = borrower();
    makeInsolvent(engine.world, company.id);
    expect(isInsolvent(engine.world.ledger, company.id)).toBe(true);

    defaultLoan(ctx, loan);

    expect(loan.status).toBe('defaulted');
    expect(company.status).toBe('defaulted');
    expect(company.employees).toBe(0);
  });

  it('takes its other lenders down with it', () => {
    const { engine, ctx, company, loan } = borrower();
    const others = Object.values(engine.world.instruments).filter(
      (i) => i.obligorId === company.id && i.id !== loan.id && i.status === 'active',
    );
    makeInsolvent(engine.world, company.id);

    defaultLoan(ctx, loan);

    for (const other of others) expect(other.status).toBe('defaulted');
  });

  it('charges the shortfall to the lender', () => {
    const { engine, ctx, company, loan } = borrower();
    const bank = engine.world.playerBankId;
    makeInsolvent(engine.world, company.id);
    const impairedBefore = naturalBalance(engine.world.ledger, bank, AC.IMPAIRMENT);

    defaultLoan(ctx, loan);

    expect(naturalBalance(engine.world.ledger, bank, AC.IMPAIRMENT)).toBeGreaterThan(impairedBefore);
  });
});

describe('either way', () => {
  it('keeps the books balanced', () => {
    for (const ruin of [false, true]) {
      const { engine, ctx, cohort, company, loan } = borrower();
      if (ruin) makeInsolvent(engine.world, company.id);
      else tieUpCashInAssets(engine.world, company.id, cohort.id);

      defaultLoan(ctx, loan);

      expect(trialBalance(engine.world.ledger)).toBe(0);
    }
  });
});
