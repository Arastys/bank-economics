import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { isMonthEnd } from '../src/core/time.js';
import { AC } from '../src/ledger/accounts.js';
import { post, debit, credit } from '../src/ledger/ledger.js';
import { pounds, type Money } from '../src/core/money.js';
import { firmViews } from '../src/agents/views.js';
import { load, save } from '../src/engine/snapshot.js';
import { capitalFactor, capitalSystem } from '../src/systems/capital.js';

function runOneMonthEnd(engine: ReturnType<typeof newGame>): void {
  do {
    engine.world.tick += 1;
  } while (!isMonthEnd(engine.world.tick));
  capitalSystem.run(engine.context());
}

/** Give a firm capital without inventing money: the seller is the government. */
function addCapital(engine: ReturnType<typeof newGame>, id: string, amount: Money): void {
  post(engine.world.ledger, {
    tick: engine.world.tick,
    kind: 'test.capital',
    description: 'capital injection',
    postings: [debit(id, AC.FIXED_ASSETS, amount), credit(id, AC.SHARE_CAPITAL, amount)],
  });
}

describe('capital deepening', () => {
  it('makes a worker with more behind them produce more, with diminishing returns', () => {
    const engine = newGame('uk2025', { seed: 4 });
    const firm = firmViews(engine.world)[0]!;
    const world = engine.world;
    const ledger = world.ledger;

    const at = (perWorker: number) => {
      world.config.capitalPerWorkerReference = perWorker;
      return capitalFactor(world, ledger, firm);
    };

    // Halving the reference is the same as doubling the capital per worker.
    const base = at(4_144_600);
    const doubled = at(4_144_600 / 2);
    const quadrupled = at(4_144_600 / 4);

    expect(doubled).toBeGreaterThan(base);
    expect(quadrupled).toBeGreaterThan(doubled);
    // Diminishing in the sense that matters: twice the capital is a long way
    // short of twice the output, and four times is short of twice again.
    expect(doubled).toBeLessThan(2 * base);
    expect(quadrupled).toBeLessThan(2 * doubled);
    // Constant elasticity, so each doubling is worth the same multiple:
    // 2^0.3 = 1.23.
    expect(doubled / base).toBeCloseTo(Math.pow(2, 0.3), 2);
    expect(quadrupled / doubled).toBeCloseTo(doubled / base, 6);
  });

  it('leaves productivity exactly at base when the elasticity is zero', () => {
    const engine = newGame('uk2025', { seed: 4 });
    engine.world.config.capitalElasticity = 0;
    const before = firmViews(engine.world).map((f) => ({ id: f.id, p: f.productivity }));

    runOneMonthEnd(engine);

    for (const was of before) {
      const now = firmViews(engine.world).find((f) => f.id === was.id)!;
      expect(now.productivity).toBe(now.baseProductivity);
      expect(now.productivity).toBeCloseTo(was.p, 9);
    }
  });

  it('raises output per head when capital is added', () => {
    const engine = newGame('uk2025', { seed: 4 });
    runOneMonthEnd(engine);
    const firm = firmViews(engine.world)[0]!;
    const before = firm.productivity;

    addCapital(engine, firm.id, pounds(500_000_000));
    runOneMonthEnd(engine);

    expect(firmViews(engine.world)[0]!.productivity).toBeGreaterThan(before);
  });

  it('refuses to hand out unbounded output for absurd capital', () => {
    const engine = newGame('uk2025', { seed: 4 });
    const firm = firmViews(engine.world)[0]!;
    addCapital(engine, firm.id, pounds(500_000_000_000));

    const factor = capitalFactor(engine.world, engine.world.ledger, firm);
    expect(factor).toBeLessThanOrEqual(4);
    expect(factor).toBeGreaterThan(1);
  });

  it('survives a firm with no workers at all', () => {
    const engine = newGame('uk2025', { seed: 4 });
    const firm = firmViews(engine.world)[0]!;
    firm.employees = 0;

    expect(capitalFactor(engine.world, engine.world.ledger, firm)).toBe(1);
    expect(() => runOneMonthEnd(engine)).not.toThrow();
    expect(Number.isFinite(firmViews(engine.world)[0]!.productivity)).toBe(true);
  });

  /**
   * A version 9 save has productivity as the constant it was written with and
   * no base at all. That constant is what the firm produced, so it becomes the
   * base and the first month end rescales it by the capital actually held.
   */
  it('carries a version 9 save onto a base productivity', () => {
    const world = newGame('uk2025', { seed: 4 }).world;
    const snapshot = JSON.parse(save(world));
    snapshot.version = 9;
    delete snapshot.world.config.capitalElasticity;
    delete snapshot.world.config.capitalPerWorkerReference;
    let checked = 0;
    for (const entity of Object.values(snapshot.world.entities) as any[]) {
      if (entity.kind !== 'company') continue;
      delete entity.baseProductivity;
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);

    const restored = load(JSON.stringify(snapshot));

    expect(restored.config.capitalElasticity).toBe(0.3);
    for (const entity of Object.values(restored.entities)) {
      if (entity.kind !== 'company') continue;
      expect(entity.baseProductivity).toBe(entity.productivity);
    }
  });
});
