import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { firmViews } from '../src/agents/views.js';
import { spendable } from '../src/world/transfer.js';
import { consumptionBudget } from '../src/systems/goodsMarket.js';
import { ZERO, pounds, type Money } from '../src/core/money.js';
import { DEFAULT_CONFIG, type WorldState } from '../src/world/state.js';
import { load, save } from '../src/engine/snapshot.js';

function sectorCash(world: WorldState, ids: string[]): number {
  return ids.reduce((total, id) => total + spendable(world, world.ledger, id), 0);
}

/**
 * The defect this exists to prevent.
 *
 * People used to spend a fixed share of income and run savings down at a
 * flat daily rate, which do not balance: the savings stock has to reach five
 * hundred days of income before the two flows meet. Until then the firm sector
 * hands over more cash than it gets back, every day, for ever. It took eight
 * simulated years to show: firm cash fell from £2.9bn to £90m, and
 * unemployment reached 61% with nothing else wrong with the model.
 */
describe('people save towards a buffer, not for ever', () => {
  it('does not drain the firm sector over a decade', () => {
    const engine = newGame('uk2025');
    const world = engine.world;
    const firmIds = firmViews(world).map((f) => f.id);
    const opening = sectorCash(world, firmIds);

    engine.run(10 * 365);

    // Not a target, a floor: firms may hold less than they started with, but
    // a sector down to a rounding error of its opening cash is the runaway.
    expect(sectorCash(world, firmIds)).toBeGreaterThan(opening * 0.2);
    expect(world.economy.unemployment).toBeLessThan(0.25);
  }, 120_000);

  it('spends more than it earns when savings are above the buffer', () => {
    expect(budgetAt(400)).toBeGreaterThan(1);
  });

  it('holds back when savings are below the buffer', () => {
    const { config } = newGame('uk2025').world;
    // At the buffer a person saves the share it does not consume...
    expect(budgetAt(config.savingsBufferDays)).toBeLessThan(1);
    // ...and below it, harder still.
    expect(budgetAt(60)).toBeLessThan(budgetAt(config.savingsBufferDays));
  });

  it('carries an old save forward onto a buffer', () => {
    const world = newGame('uk2025').world;
    const legacy = JSON.parse(save(world)) as { version: number; world: WorldState };
    legacy.version = 1;
    const config = legacy.world.config as unknown as Record<string, unknown>;
    delete config.savingsBufferDays;
    delete config.savingsAdjustment;
    config.dissavingRate = 0.0001;

    const migrated = load(JSON.stringify(legacy));
    expect(migrated.config.savingsBufferDays).toBe(DEFAULT_CONFIG.savingsBufferDays);
    expect(migrated.config.savingsAdjustment).toBe(DEFAULT_CONFIG.savingsAdjustment);
    expect(migrated.config).not.toHaveProperty('dissavingRate');
  });

  it('never spends money it does not have', () => {
    const { config } = newGame('uk2025').world;
    expect(consumptionBudget(0.95, pounds(100) as Money, ZERO, config)).toBe(ZERO);
  });
});

/** Spending as a multiple of income, for a person holding `days` of income. */
function budgetAt(days: number): number {
  const { config } = newGame('uk2025').world;
  const income = pounds(100) as Money;
  const savings = (income * days) as Money;
  return consumptionBudget(0.95, income, savings, config) / income;
}
