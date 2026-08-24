import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { ZERO, type Money } from '../src/core/money.js';
import { AC } from '../src/ledger/accounts.js';
import { naturalBalance, trialBalance } from '../src/ledger/ledger.js';
import { personViews } from '../src/agents/views.js';
import { load, save } from '../src/engine/snapshot.js';
import { dividendFrom } from '../src/systems/accounting.js';
import { entitiesOfKind, type WorldState } from '../src/world/state.js';

const YEAR = 365;

/**
 * What households hold in this year's dividend income. The year end closes
 * every P&L account, so this is the most recent distribution rather than a
 * running total -- which is exactly what it should be compared against.
 */
const householdDividends = (world: WorldState) =>
  personViews(world).reduce((t, h) => t + naturalBalance(world.ledger, h.id, AC.DIVIDEND_INCOME), 0);

/**
 * Profit used to close to retained earnings and stay there. Household income
 * was wages, deposit interest, bank running costs and recycled tax -- owning
 * something paid nothing -- so the economy was only stable while nobody made
 * money. See docs/FLOWS.md.
 */
describe('profit goes back to the people who own the firms', () => {
  it('pays households what the firms and banks distribute', () => {
    const engine = newGame('uk2025', { seed: 2 });
    let latest = ZERO;
    let events = 0;
    engine.bus.on('dividends.paid', (e) => {
      latest = e.total;
      events += 1;
      expect(e.payers).toBeGreaterThan(0);
    });

    engine.run(YEAR * 3);

    expect(events).toBe(3);
    expect(latest).toBeGreaterThan(0);
    // Every penny announced landed on a household, and none was invented.
    expect(householdDividends(engine.world)).toBe(latest);
    expect(trialBalance(engine.world.ledger)).toBe(0);
  });

  it('pays nothing at all when the payout is set to zero', () => {
    const engine = newGame('uk2025', { seed: 2 });
    engine.world.config.firmDividendPayout = 0;
    engine.world.config.bankDividendPayout = 0;

    let events = 0;
    engine.bus.on('dividends.paid', () => {
      events += 1;
    });
    engine.run(YEAR * 3);

    expect(events).toBe(0);
    expect(householdDividends(engine.world)).toBe(0);
  });

  /**
   * A knob nothing reads reports as having no influence in the sweep, and you
   * conclude the mechanism does not matter. Both of these are read.
   */
  it('distributes more when the payout is raised', () => {
    const paid = (firm: number, bank: number) => {
      const engine = newGame('uk2025', { seed: 2 });
      engine.world.config.firmDividendPayout = firm;
      engine.world.config.bankDividendPayout = bank;
      engine.run(YEAR);
      return householdDividends(engine.world);
    };

    expect(paid(0.8, 0.4)).toBeGreaterThan(paid(0.2, 0.4));
    expect(paid(0.5, 0.9)).toBeGreaterThan(paid(0.5, 0.1));
  });
});

describe('what a firm is allowed to distribute', () => {
  /** A year in, so there are reserves to distribute out of. */
  const settled = () => {
    const engine = newGame('uk2025', { seed: 2 });
    engine.run(YEAR);
    const { world } = engine;
    return {
      world,
      firm: entitiesOfKind(world, 'cohort').find((c) => c.memberKind === 'company')!,
      person: entitiesOfKind(world, 'cohort').find((c) => c.memberKind === 'person')!,
      bank: entitiesOfKind(world, 'bank')[0]!,
    };
  };

  it('pays nothing on a loss', () => {
    const { world, firm } = settled();
    expect(dividendFrom(world, world.ledger, firm, -1 as Money)).toBe(0);
    expect(dividendFrom(world, world.ledger, firm, ZERO)).toBe(0);
  });

  it('never pays more than the reserves it has to pay from', () => {
    const { world, firm } = settled();
    const reserves = naturalBalance(world.ledger, firm.id, AC.RETAINED_EARNINGS);
    expect(reserves).toBeGreaterThan(0);
    // A profit far larger than anything the firm has ever accumulated: it is
    // accumulated reserves that are distributable, not this year's paper gain.
    const huge = (reserves * 10) as Money;
    expect(dividendFrom(world, world.ledger, firm, huge)).toBeLessThanOrEqual(reserves);
  });

  it('leaves households and the state out of it -- they own, they do not pay', () => {
    const { world, person } = settled();
    const profit = 1_000_000 as Money;
    expect(dividendFrom(world, world.ledger, person, profit)).toBe(0);
    expect(dividendFrom(world, world.ledger, world.entities[world.governmentId]!, profit)).toBe(0);
  });

  it('uses the bank rate for banks and the firm rate for firms', () => {
    const { world, firm, bank } = settled();
    world.config.firmDividendPayout = 0;
    world.config.bankDividendPayout = 0.5;
    const profit = 100_000 as Money;
    expect(dividendFrom(world, world.ledger, firm, profit)).toBe(0);
    expect(dividendFrom(world, world.ledger, bank, profit)).toBeGreaterThan(0);
  });
});

describe('a save from before dividends existed', () => {
  it('comes forward with a payout policy rather than a NaN', () => {
    const engine = newGame('uk2025', { seed: 2 });
    const snapshot = JSON.parse(save(engine.world)) as { version: number; world: WorldState };
    snapshot.version = 10;
    delete (snapshot.world.config as unknown as Record<string, unknown>).firmDividendPayout;
    delete (snapshot.world.config as unknown as Record<string, unknown>).bankDividendPayout;

    const world = load(JSON.stringify(snapshot));
    expect(world.config.firmDividendPayout).toBeGreaterThan(0);
    expect(world.config.bankDividendPayout).toBeGreaterThan(0);
  });
});
