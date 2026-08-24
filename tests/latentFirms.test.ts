import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { creditRiskSystem } from '../src/systems/creditRisk.js';
import { cohorts } from '../src/world/state.js';

const companyPools = (world: ReturnType<typeof newGame>['world']) =>
  cohorts(world).filter((c) => c.memberKind === 'company');

/**
 * Credit risk scores borrowers. It used to also reach into the company pools
 * and delete headcount, under a comment describing it as latent firms failing
 * — but it never touched `cohort.count`, so no firm ever died and the only
 * effect was that jobs disappeared out of the pools for no modelled reason.
 * Whether a latent firm lives is `firms.demography`'s business.
 */
describe('credit risk and the latent population', () => {
  it('leaves the pools alone', () => {
    const engine = newGame('uk2025', { seed: 7 });
    const { world } = engine;
    const pools = companyPools(world);
    expect(pools.length).toBeGreaterThan(0);

    const before = pools.map((c) => ({
      id: c.id,
      count: c.count,
      employees: c.pool.employees ?? 0,
    }));
    expect(before.some((p) => p.employees > 0)).toBe(true);

    // The tick has to really advance: `ctx.rng` is seeded from `world.tick`,
    // so replaying one tick would replay one draw and never fire the churn.
    for (let day = 0; day < 400; day++) {
      world.tick += 1;
      creditRiskSystem.run(engine.context());
    }

    for (const snapshot of before) {
      const pool = companyPools(world).find((c) => c.id === snapshot.id)!;
      expect(pool.count).toBe(snapshot.count);
      expect(pool.pool.employees ?? 0).toBe(snapshot.employees);
    }
  });
});
