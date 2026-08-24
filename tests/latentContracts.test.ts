import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { ZERO, type Money } from '../src/core/money.js';
import { AC, depositCode } from '../src/ledger/accounts.js';
import { credit, debit, naturalBalance, post, trialBalance } from '../src/ledger/ledger.js';
import { load, save } from '../src/engine/snapshot.js';
import { DEPOSIT_INSTANT } from '../src/instruments/deposit.js';
import { LOAN_POOL } from '../src/instruments/poolLoan.js';
import { instrumentSystem } from '../src/systems/instruments.js';
import { promoteMember } from '../src/agents/lod.js';
import { cohorts, entitiesOfKind, heldBy, owedBy, type WorldState } from '../src/world/state.js';

const YEAR = 365;

const poolLoansOf = (world: WorldState, cohortId: string) =>
  owedBy(world, cohortId).filter((i) => i.type === LOAN_POOL);

const sectorInterestIncome = (world: WorldState) =>
  entitiesOfKind(world, 'bank')
    .filter((b) => !b.isPlayer)
    .reduce((t, b) => t + naturalBalance(world.ledger, b.id, AC.INTEREST_INCOME), 0);

/**
 * The largest inert thing in the model: billions of pooled borrowing that paid
 * nobody anything and looked entirely normal in the accounts, alongside
 * company-cohort cash that earned nothing because there was no account behind
 * it. A balance is not a behaviour -- see docs/FLOWS.md.
 */
describe('the latent balance sheet has contracts behind it', () => {
  it('gives every pool somewhere to keep its cash and somebody to owe', () => {
    const { world } = newGame('uk2025', { seed: 3 });

    for (const cohort of cohorts(world)) {
      const deposits = heldBy(world, cohort.id).filter(
        (i) => i.type === DEPOSIT_INSTANT && i.obligorId === cohort.bankId,
      );
      expect(deposits.length, cohort.id + ' deposit contract').toBe(1);

      const owed = naturalBalance(world.ledger, cohort.id, AC.BORROWINGS);
      const loans = poolLoansOf(world, cohort.id);
      expect(loans.length, cohort.id + ' borrowing contracts').toBeGreaterThan(0);
      // Every penny of the pool's debt is claimed by somebody, and no more.
      const claimed = loans.reduce((t, i) => t + i.outstanding, 0);
      expect(Math.abs(claimed - owed)).toBeLessThanOrEqual(loans.length);
    }
  });

  it('leaves the player out of it, so its book starts purely corporate', () => {
    const { world } = newGame('uk2025', { seed: 3 });
    expect(heldBy(world, world.playerBankId).filter((i) => i.type === LOAN_POOL)).toEqual([]);
  });

  /**
   * The test that would have caught the original defect: not "does a loan book
   * exist" but "is anything accruing on it".
   */
  it('actually earns the lenders money', () => {
    const engine = newGame('uk2025', { seed: 3 });
    const before = sectorInterestIncome(engine.world);
    engine.run(30);
    expect(sectorInterestIncome(engine.world)).toBeGreaterThan(before);

    const pool = cohorts(engine.world)[0]!;
    expect(naturalBalance(engine.world.ledger, pool.id, AC.INTEREST_EXPENSE)).toBeGreaterThan(0);
    expect(trialBalance(engine.world.ledger)).toBe(0);
  });

  it('creates and destroys no money over a decade', () => {
    const engine = newGame('uk2025', { seed: 3, checkInvariantsEvery: 365 });
    engine.run(YEAR * 10);
    expect(trialBalance(engine.world.ledger)).toBe(0);
  });
});

describe('what makes a pool loan different from a loan', () => {
  it('follows Bank Rate rather than the rate it was written at', () => {
    const dailyAccrual = (bankRate: number) => {
      const engine = newGame('uk2025', { seed: 3 });
      const { world } = engine;
      const cb = world.entities[world.centralBankId]!;
      if (cb.kind !== 'centralBank') throw new Error('no central bank');
      cb.bankRate = bankRate;

      const cohort = cohorts(world).find(
        (c) => naturalBalance(world.ledger, c.id, AC.BORROWINGS) > 0,
      )!;
      const loan = poolLoansOf(world, cohort.id)[0]!;
      const accrued = loan.accrued;
      world.tick += 1;
      instrumentSystem.run(engine.context());
      return loan.accrued - accrued;
    };

    // The whole point: a rate rise reaches the debt service of the entire
    // economy, not only of the handful of borrowers simulated in full.
    expect(dailyAccrual(0.09)).toBeGreaterThan(dailyAccrual(0.01));
  });

  it('reads what the pool owes from the ledger, so promotion does not double-count', () => {
    const engine = newGame('uk2025', { seed: 3 });
    const { world } = engine;
    const cohort = cohorts(world).find((c) => c.memberKind === 'company' && c.count > 100)!;
    const loan = poolLoansOf(world, cohort.id)[0]!;

    world.tick += 1;
    instrumentSystem.run(engine.context());
    const before = loan.outstanding;
    expect(before).toBeGreaterThan(0);

    // Carving a member out moves part of the pool's borrowings onto its own
    // books, where it gets a contract of its own.
    expect(promoteMember(engine.context(), cohort.id, 'test')).toBeDefined();
    world.tick += 1;
    instrumentSystem.run(engine.context());

    expect(loan.outstanding).toBeLessThan(before);
  });

  it('does not write off a whole sector because it was short one month', () => {
    const engine = newGame('uk2025', { seed: 3 });
    const { world } = engine;
    const cohort = cohorts(world).find(
      (c) => naturalBalance(world.ledger, c.id, AC.BORROWINGS) > 0,
    )!;
    const loan = poolLoansOf(world, cohort.id)[0]!;

    // Take every penny the pool has, so it cannot pay anybody anything.
    const bankId = cohort.bankId!;
    const cash = naturalBalance(world.ledger, cohort.id, depositCode(bankId)) as Money;
    post(world.ledger, {
      tick: world.tick,
      kind: 'test.drain',
      description: 'empty the pool',
      postings: [
        credit(cohort.id, depositCode(bankId), cash),
        debit(cohort.id, AC.RETAINED_EARNINGS, cash),
        debit(bankId, AC.CUSTOMER_DEPOSITS, cash),
        credit(bankId, AC.RETAINED_EARNINGS, cash),
      ],
    });

    for (let i = 0; i < 200; i++) {
      world.tick += 1;
      instrumentSystem.run(engine.context());
    }

    // Still owed, still accruing, still nobody's default.
    expect(loan.status).toBe('active');
    expect(loan.accrued).toBeGreaterThan(ZERO);
    expect(loan.outstanding).toBeGreaterThan(0);
  });
});

describe('a save from before the latent economy had contracts', () => {
  it('comes forward with them rather than staying inert', () => {
    const engine = newGame('uk2025', { seed: 3 });
    const snapshot = JSON.parse(save(engine.world)) as { version: number; world: WorldState };
    snapshot.version = 11;

    // Strip every contract the migration is meant to put back.
    for (const [id, inst] of Object.entries(snapshot.world.instruments)) {
      if (inst.type !== LOAN_POOL) continue;
      delete snapshot.world.instruments[id];
      const held = snapshot.world.instrumentsByHolder[inst.holderId] ?? [];
      snapshot.world.instrumentsByHolder[inst.holderId] = held.filter((x) => x !== id);
      const owes = snapshot.world.instrumentsByObligor[inst.obligorId] ?? [];
      snapshot.world.instrumentsByObligor[inst.obligorId] = owes.filter((x) => x !== id);
    }

    const world = load(JSON.stringify(snapshot));
    for (const cohort of cohorts(world)) {
      if (naturalBalance(world.ledger, cohort.id, AC.BORROWINGS) <= 0) continue;
      expect(poolLoansOf(world, cohort.id).length, cohort.id).toBeGreaterThan(0);
    }
  });
});
