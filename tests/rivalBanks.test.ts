import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { buildWorld } from '../src/scenarios/build.js';
import { uk2025 } from '../src/scenarios/uk2025.js';
import { isMonthEnd } from '../src/core/time.js';
import { AC } from '../src/ledger/accounts.js';
import { naturalBalance, trialBalance } from '../src/ledger/ledger.js';
import { personViews } from '../src/agents/views.js';
import { accountingSystem } from '../src/systems/accounting.js';
import { cohorts, entitiesOfKind, type WorldState } from '../src/world/state.js';

const build = (count: number, seed = 11) =>
  buildWorld({ ...uk2025, seed, otherBanks: { ...uk2025.otherBanks, count } });

const rivals = (world: WorldState) => entitiesOfKind(world, 'bank').filter((b) => !b.isPlayer);

const sector = (world: WorldState, code: (typeof AC)[keyof typeof AC]) =>
  rivals(world).reduce((t, b) => t + naturalBalance(world.ledger, b.id, code), 0);

describe('the rest of the market is several banks', () => {
  it('creates as many rivals as the scenario asks for', () => {
    expect(rivals(build(1)).length).toBe(1);
    expect(rivals(build(4)).length).toBe(4);
    expect(rivals(build(7)).length).toBe(7);
  });

  /**
   * Dividing the rest of the market up must not create or destroy any of it.
   * The same deposits, the same loan book, the same gilts — held by more
   * balance sheets.
   */
  it('divides the same market rather than adding to it', () => {
    const one = build(1);
    const many = build(4);

    for (const code of [AC.CUSTOMER_DEPOSITS, AC.LOANS, AC.BONDS, AC.RESERVES] as const) {
      expect(sector(many, code)).toBe(sector(one, code));
    }
    expect(trialBalance(one.ledger)).toBe(0);
    expect(trialBalance(many.ledger)).toBe(0);
  });

  it('funds every one of them', () => {
    const world = build(6);
    for (const bank of rivals(world)) {
      expect(naturalBalance(world.ledger, bank.id, AC.RESERVES)).toBeGreaterThanOrEqual(0);
      expect(naturalBalance(world.ledger, bank.id, AC.CUSTOMER_DEPOSITS)).toBeGreaterThan(0);
    }
  });

  it('spreads the pools between them rather than piling them on one', () => {
    const world = build(4);
    const banked = new Set(
      cohorts(world)
        .map((c) => c.bankId)
        .filter((id) => id !== world.playerBankId),
    );
    expect(banked.size).toBe(4);
  });

  /**
   * The first rival keeps the old id, so a saved game that predates the split
   * and the bond-market counterparty both still point at a bank that exists.
   */
  it('keeps the original id on the first of them', () => {
    const world = build(4);
    expect(world.otherBanksId).toBe('bank:market');
    expect(rivals(world).map((b) => b.id)).toContain(world.otherBanksId);
  });
});

/**
 * A bank employs people. The player pays for staff, premises and systems every
 * month and that money lands in households as income; until this, the rest of
 * the market -- four fifths of the sector -- ran on nothing and paid nobody.
 */
describe('the rest of the market costs something to run', () => {
  const costRate = (world: WorldState, id: string) => {
    const bank = entitiesOfKind(world, 'bank').find((b) => b.id === id)!;
    return bank.operatingCostPerMonth / naturalBalance(world.ledger, id, AC.CUSTOMER_DEPOSITS);
  };

  it('charges a rival what a pound of deposits costs the player to run', () => {
    const world = build(4);
    const player = costRate(world, world.playerBankId);
    expect(player).toBeGreaterThan(0);

    for (const bank of rivals(world)) {
      expect(bank.operatingCostPerMonth).toBeGreaterThan(0);
      // Within a penny of the player rate: the same cost base, a bigger book.
      const expected = naturalBalance(world.ledger, bank.id, AC.CUSTOMER_DEPOSITS) * player;
      expect(Math.abs(bank.operatingCostPerMonth - expected)).toBeLessThanOrEqual(1);
    }
  });

  it('pays them out to households as income', () => {
    const engine = newGame('uk2025', { seed: 5 });
    const { world } = engine;
    const income = () =>
      personViews(world).reduce((t, h) => t + naturalBalance(world.ledger, h.id, AC.WAGE_INCOME), 0);

    const before = income();
    do {
      world.tick += 1;
    } while (!isMonthEnd(world.tick));
    accountingSystem.run(engine.context());

    // Nothing else pays households on a bare month end, so the whole rise is
    // bank running costs: the player's and the rivals' together.
    const banks = entitiesOfKind(world, 'bank');
    const wageBill = banks.reduce((t, b) => t + b.operatingCostPerMonth, 0);
    const rivalShare = rivals(world).reduce((t, b) => t + b.operatingCostPerMonth, 0);

    expect(rivalShare).toBeGreaterThan(0);
    expect(income() - before).toBe(wageBill);
    expect(trialBalance(world.ledger)).toBe(0);
  });
});
