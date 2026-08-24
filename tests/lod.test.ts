import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { demoteEntity, promoteMember, switchBank } from '../src/agents/lod.js';
import { AC, depositCode } from '../src/ledger/accounts.js';
import { entityTrialBalance, naturalBalance, trialBalance } from '../src/ledger/ledger.js';
import { cohorts, resolvedPeople, type WorldState } from '../src/world/state.js';
import { load, save } from '../src/engine/snapshot.js';

function firstCompanyCohort(world: ReturnType<typeof newGame>['world']) {
  const cohort = cohorts(world).find((c) => c.memberKind === 'company' && c.count > 10);
  if (!cohort) throw new Error('scenario has no company cohort to promote from');
  return cohort;
}

describe('level of detail', () => {
  it('creates a full entity out of a cohort without creating money', () => {
    const engine = newGame('uk2025');
    const ctx = engine.context();
    const cohort = firstCompanyCohort(engine.world);
    const countBefore = cohort.count;

    expect(trialBalance(engine.world.ledger)).toBe(0);
    const promoted = promoteMember(ctx, cohort.id, 'test');

    expect(promoted).toBeDefined();
    expect(cohort.count).toBe(countBefore - 1);
    expect(trialBalance(engine.world.ledger)).toBe(0);
  });

  it('gives the new entity books that balance on their own', () => {
    const engine = newGame('uk2025');
    const ctx = engine.context();
    const cohort = firstCompanyCohort(engine.world);
    const promoted = promoteMember(ctx, cohort.id, 'test')!;

    expect(entityTrialBalance(engine.world.ledger, promoted.entity.id)).toBe(0);
    expect(entityTrialBalance(engine.world.ledger, cohort.id)).toBe(0);
  });

  it('carves a real share of the pool balance sheet', () => {
    const engine = newGame('uk2025');
    const ctx = engine.context();
    const cohort = firstCompanyCohort(engine.world);
    const bankId = cohort.bankId!;
    const poolCashBefore = naturalBalance(engine.world.ledger, cohort.id, depositCode(bankId));

    const promoted = promoteMember(ctx, cohort.id, 'test')!;
    const memberCash = naturalBalance(engine.world.ledger, promoted.entity.id, depositCode(bankId));
    const poolCashAfter = naturalBalance(engine.world.ledger, cohort.id, depositCode(bankId));

    expect(memberCash).toBeGreaterThan(0);
    expect(memberCash + poolCashAfter).toBe(poolCashBefore);
  });

  it('folds an idle entity back with nothing lost', () => {
    const engine = newGame('uk2025');
    const ctx = engine.context();
    const cohort = firstCompanyCohort(engine.world);
    const countBefore = cohort.count;
    const promoted = promoteMember(ctx, cohort.id, 'test')!;

    // Promotion attaches a contract for debt carved out of the pool; clear it
    // so the entity is genuinely idle and eligible to fold back.
    for (const id in engine.world.instruments) {
      const inst = engine.world.instruments[id]!;
      if (inst.obligorId === promoted.entity.id) inst.status = 'closed';
    }

    expect(demoteEntity(ctx, promoted.entity.id)).toBe(true);
    expect(cohort.count).toBe(countBefore);
    expect(trialBalance(engine.world.ledger)).toBe(0);
    expect(engine.world.entities[promoted.entity.id]).toBeUndefined();
  });

  it('refuses to fold an entity that still owes money', () => {
    const engine = newGame('uk2025');
    const ctx = engine.context();
    const cohort = firstCompanyCohort(engine.world);
    const promoted = promoteMember(ctx, cohort.id, 'test')!;
    const owesSomething = Object.values(engine.world.instruments).some(
      (inst) => inst.obligorId === promoted.entity.id && inst.status === 'active',
    );
    if (!owesSomething) return;
    expect(demoteEntity(ctx, promoted.entity.id)).toBe(false);
  });

  it('moves deposits and reserves when a customer switches bank', () => {
    const engine = newGame('uk2025');
    const ctx = engine.context();
    const { world, world: { ledger } } = engine;
    const cohort = firstCompanyCohort(world);
    const promoted = promoteMember(ctx, cohort.id, 'test')!;
    const oldBank = promoted.entity.bankId!;
    const newBank = world.playerBankId;

    const moving = naturalBalance(ledger, promoted.entity.id, depositCode(oldBank));
    const oldDepositsBefore = naturalBalance(ledger, oldBank, AC.CUSTOMER_DEPOSITS);
    const newDepositsBefore = naturalBalance(ledger, newBank, AC.CUSTOMER_DEPOSITS);
    const newReservesBefore = naturalBalance(ledger, newBank, AC.RESERVES);

    switchBank(ctx, promoted.entity.id, newBank);

    expect(naturalBalance(ledger, oldBank, AC.CUSTOMER_DEPOSITS)).toBe(oldDepositsBefore - moving);
    expect(naturalBalance(ledger, newBank, AC.CUSTOMER_DEPOSITS)).toBe(newDepositsBefore + moving);
    expect(naturalBalance(ledger, newBank, AC.RESERVES)).toBe(newReservesBefore + moving);
    expect(trialBalance(ledger)).toBe(0);
  });

  it('keeps the resolved population bounded over a long game', () => {
    const engine = newGame('uk2025');
    engine.run(400);
    const resolved = Object.values(engine.world.entities).filter(
      (e) => e.kind === 'company' || e.kind === 'person',
    ).length;
    expect(resolved).toBeLessThanOrEqual(engine.world.config.maxResolvedEntities);
  });
});

/**
 * The rename was a rename. The entity earned one wage and the labour force was
 * a straight count of them, so it always was a person rather than a spending
 * unit shared by several.
 */
describe('households became people', () => {
  it('carries an old save forward onto the new name', () => {
    const world = newGame('uk2025').world;
    const legacy = JSON.parse(save(world)) as { version: number; world: WorldState };
    legacy.version = 4;
    // The opening world keeps people latent inside pools, so the discriminator
    // that matters here is the pool's memberKind rather than an entity kind.
    let renamed = 0;
    for (const entity of Object.values(legacy.world.entities) as { kind: string; memberKind?: string }[]) {
      if (entity.kind === 'person') { entity.kind = 'household'; renamed++; }
      if (entity.memberKind === 'person') { entity.memberKind = 'household'; renamed++; }
    }
    expect(renamed).toBeGreaterThan(0);

    const migrated = load(JSON.stringify(legacy));
    expect(cohorts(migrated).filter((c) => c.memberKind === 'person').length).toBe(
      cohorts(world).filter((c) => c.memberKind === 'person').length,
    );
    expect(resolvedPeople(migrated).length).toBe(resolvedPeople(world).length);
    for (const entity of Object.values(migrated.entities) as { kind: string; memberKind?: string }[]) {
      expect(entity.kind).not.toBe('household');
      expect(entity.memberKind ?? 'person').not.toBe('household');
    }
  });
});
