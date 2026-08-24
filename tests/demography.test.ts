import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { personViews } from '../src/agents/views.js';
import { spendable } from '../src/world/transfer.js';
import { trialBalance } from '../src/ledger/ledger.js';
import { resolvedPeople, type WorldState } from '../src/world/state.js';
import { load, save } from '../src/engine/snapshot.js';

const heads = (world: WorldState) => personViews(world).reduce((t, p) => t + p.count, 0);
const band = (world: WorldState, f: (p: ReturnType<typeof personViews>[number]) => number) =>
  personViews(world).reduce((t, p) => t + f(p), 0);

describe('people are born, grow up, work, retire and die', () => {
  it('starts in the shape a stationary population settles at', () => {
    const world = newGame('uk2025').world;
    const total = heads(world);
    // 18 as a child, 49 working, 15 retired: 22% / 60% / 18%.
    expect(band(world, (p) => p.children) / total).toBeCloseTo(18 / 82, 2);
    expect(band(world, (p) => p.workingAge) / total).toBeCloseTo(49 / 82, 2);
    expect(band(world, (p) => p.retired) / total).toBeCloseTo(15 / 82, 2);
  });

  it('counts only the working-age as labour supply', () => {
    const engine = newGame('uk2025');
    engine.run(30);
    expect(engine.world.economy.labourForce).toBeCloseTo(
      band(engine.world, (p) => p.workingAge),
      0,
    );
    expect(engine.world.economy.labourForce).toBeLessThan(heads(engine.world));
  }, 30_000);

  /**
   * Births run at one per worker per working lifetime, so the prosperity term
   * is the whole of whether a population grows. At zero it is exactly
   * replacement, which is the calibration this rests on.
   */
  it('holds the population exactly steady when births ignore prosperity', () => {
    const engine = newGame('uk2025');
    engine.world.config.fertilityProsperity = 0;
    const before = heads(engine.world);
    engine.run(365 * 10);
    expect(heads(engine.world) / before).toBeCloseTo(1, 2);
  }, 120_000);

  it('amplifies prosperity into the population, and is exactly replacement at zero', () => {
    const run = (fertilityProsperity: number) => {
      const engine = newGame('uk2025');
      Object.assign(engine.world.config, { fertilityProsperity });
      const before = heads(engine.world);
      engine.run(365 * 18);
      return heads(engine.world) / before;
    };

    // At zero the prosperity term is 1 whatever the economy does, so births are
    // one per worker per working lifetime: exact replacement.
    const neutral = run(0);
    expect(neutral).toBeGreaterThan(0.98);
    expect(neutral).toBeLessThan(1.02);

    // Which way prosperity sits is an emergent property of the economy and has
    // flipped before -- removing the job leak in `risk.credit` put more workers
    // against the same output, so real income per worker now drifts down where
    // it used to drift up. What the exponent must do is not flip: it amplifies
    // whatever direction prosperity is pointing, so a strong response has to be
    // further from replacement than a weak one on the same side.
    const weak = run(0.5);
    const strong = run(4);
    expect(Math.abs(strong - neutral)).toBeGreaterThan(Math.abs(weak - neutral));
    expect(Math.sign(strong - neutral)).toBe(Math.sign(weak - neutral));
  }, 240_000);

  /**
   * A pool holds one account between its members, so a death leaves the
   * balance where it is and fewer people to share it: the survivors inherit,
   * and the ledger never sees a penny appear or vanish.
   */
  it('leaves the money to the survivors rather than destroying it', () => {
    const engine = newGame('uk2025');
    engine.world.config.fertilityProsperity = 0.2; // shrink the population
    const before = personViews(engine.world).map((p) => ({
      id: p.id,
      heads: p.count,
      savings: spendable(engine.world, engine.world.ledger, p.id),
    }));
    engine.run(365 * 8);
    expect(trialBalance(engine.world.ledger)).toBe(0);

    let anyShrank = false;
    for (const was of before) {
      const now = personViews(engine.world).find((p) => p.id === was.id)!;
      if (now.count >= was.heads) continue;
      anyShrank = true;
      const savings = spendable(engine.world, engine.world.ledger, now.id);
      // Nobody's account was emptied by the deaths inside it.
      expect(savings).toBeGreaterThan(0);
    }
    expect(anyShrank).toBe(true);
  }, 180_000);

  it('carries an old save forward with everyone of working age', () => {
    const world = newGame('uk2025').world;
    const legacy = JSON.parse(save(world)) as { version: number; world: WorldState };
    legacy.version = 5;
    let workingBefore = 0;
    for (const entity of Object.values(legacy.world.entities)) {
      if (entity.kind !== 'cohort' || entity.memberKind !== 'person') continue;
      entity.count = entity.pool.workingAge!;
      workingBefore += entity.count;
      delete entity.pool.workingAge;
      delete entity.pool.children;
      delete entity.pool.retired;
    }
    expect(workingBefore).toBeGreaterThan(0);

    const migrated = load(JSON.stringify(legacy));
    // The old headcount becomes the working-age band, undisturbed, with
    // children and pensioners added around it.
    expect(band(migrated, (p) => p.workingAge)).toBe(workingBefore);
    expect(heads(migrated)).toBeGreaterThan(workingBefore);
    expect(resolvedPeople(migrated).length).toBe(0);
  });
});
