import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { pounds, type Money } from '../src/core/money.js';
import { promoteMember } from '../src/agents/lod.js';
import { isInsolvent } from '../src/agents/insolvency.js';
import { defaultLoan, originateLoan, windUpBorrower } from '../src/instruments/loan.js';
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

describe('outright business failure', () => {
  it('winds the firm up whatever its balance sheet says', () => {
    const { engine, ctx, company, loan } = borrower();
    // Solvent, and would be worked out if this were merely a missed payment.
    expect(isInsolvent(engine.world.ledger, company.id)).toBe(false);

    windUpBorrower(ctx, company.id);

    expect(company.status).toBe('defaulted');
    expect(company.employees).toBe(0);
    expect(loan.status).toBe('defaulted');
  });

  it('leaves no facility behind', () => {
    const { engine, ctx, company } = borrower();
    windUpBorrower(ctx, company.id);

    const live = Object.values(engine.world.instruments).filter(
      (i) => i.obligorId === company.id && i.status === 'active',
    );
    expect(live).toEqual([]);
  });

  it('does nothing to a firm that has already gone', () => {
    const { engine, ctx, company } = borrower();
    windUpBorrower(ctx, company.id);
    const before = trialBalance(engine.world.ledger);

    expect(windUpBorrower(ctx, company.id)).toBe(0);
    expect(trialBalance(engine.world.ledger)).toBe(before);
  });

  /**
   * A firm marked failed while still owing live debt is a zombie: no staff, no
   * output, and an exposure sitting on a lender's book that will never be
   * collected or written off. Twenty-one of these were being created every two
   * years before the wind-up path was separated from the work-out path.
   */
  it('leaves no dead firm still owing money over a long run', () => {
    const engine = newGame('uk2025', { checkInvariantsEvery: 30 });
    engine.run(500);

    const zombies = Object.values(engine.world.entities).filter(
      (entity) =>
        entity.kind === 'company' &&
        entity.status === 'defaulted' &&
        Object.values(engine.world.instruments).some(
          (inst) => inst.obligorId === entity.id && inst.status === 'active',
        ),
    );
    expect(zombies.map((z) => z.id)).toEqual([]);
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
