import { describe, expect, it } from 'vitest';
import { buildWorld } from '../src/scenarios/build.js';
import { uk2025 } from '../src/scenarios/uk2025.js';
import { Engine } from '../src/engine/engine.js';
import { personViews, firmViews, totalWageBill, abilityByRegion, abilityOf } from '../src/agents/views.js';
import { unitProductionCost } from '../src/systems/goodsMarket.js';
import { DEFAULT_CONFIG, type SimConfig, type WorldState } from '../src/world/state.js';

function world(config: Partial<SimConfig> = {}, seed?: number): WorldState {
  return buildWorld({ ...uk2025, ...(seed === undefined ? {} : { seed }), config: { ...uk2025.config, ...config } });
}

const weightedMean = (w: WorldState) => {
  const pools = personViews(w);
  const heads = pools.reduce((t, p) => t + p.workingAge, 0);
  return pools.reduce((t, p) => t + p.ability * p.workingAge, 0) / heads;
};

describe('some people are better at the work than others', () => {
  it('gives the pools different abilities', () => {
    expect(new Set(personViews(world()).map((p) => p.ability)).size).toBeGreaterThan(3);
  });

  /**
   * The normalisation is the whole point. Five draws out of a log-normal have
   * a sample mean that is not one, and without correcting it the spread would
   * move total output -- reading as a productivity change rather than as the
   * dispersion it is meant to be.
   */
  it('averages to exactly one however the draw falls', () => {
    for (const seed of [1000, 80190, 103947, 96028]) {
      expect(weightedMean(world({}, seed))).toBeCloseTo(1, 9);
    }
  });

  it('makes everybody identical when the spread is switched off', () => {
    for (const pool of personViews(world({ personAbilitySpread: 0 }))) {
      expect(pool.ability).toBe(1);
    }
  });

  /**
   * The defect this exists to prevent, which cost four seeds out of
   * twenty-four: ability raised a firm's output without raising its wage bill,
   * so a region of below-average workers produced a third less for the same
   * payroll. Unit costs collapsed and its firms failed for a reason that had
   * nothing to do with how they were run -- scores of 1731 and 1455 against a
   * baseline of 66.
   */
  it('leaves what a unit costs to make untouched by who is making it', () => {
    const w = world();
    const firm = firmViews(w).find((f) => !f.isCohort)!;
    const cheap = totalWageBill(firm, 0.6) / (firm.employees * 0.6 * firm.productivity);
    const dear = totalWageBill(firm, 1.4) / (firm.employees * 1.4 * firm.productivity);
    expect(cheap).toBeCloseTo(dear, 6);
    expect(cheap).toBeCloseTo(unitProductionCost(firm), 2);
  });

  it('pays a wage bill in proportion to how good the staff are', () => {
    const w = world();
    const firm = firmViews(w).find((f) => !f.isCohort)!;
    expect(totalWageBill(firm, 1.5)).toBeCloseTo(totalWageBill(firm, 1) * 1.5, -2);
    expect(totalWageBill(firm, 0)).toBe(0);
  });

  it('reads one for a region with nobody working in it', () => {
    expect(abilityOf(abilityByRegion(world()), 'nowhere')).toBe(1);
  });

  /**
   * Built once for the economy rather than once per firm. `personViews` walks
   * every entity in the world to build its list, so asking per firm per
   * business day is thousands of full scans a day -- it made the test suite
   * eight times slower before anything else noticed.
   */
  it('measures every region in one pass', () => {
    const engine = new Engine(world());
    engine.run(40);
    const byRegion = abilityByRegion(engine.world);
    expect(byRegion.size).toBeGreaterThan(1);
    for (const [region, ability] of byRegion) {
      expect(ability).toBeGreaterThan(0.3);
      expect(ability).toBeLessThan(3);
      expect(abilityOf(byRegion, region)).toBe(ability);
    }
  }, 30_000);

  /**
   * What the whole thing is for: within one region, where people are competing
   * for the same wage bill, the abler pool takes more of it per head.
   */
  it('pays better people more where they work alongside worse ones', () => {
    const shared = (spread: number) => {
      const engine = new Engine(world({ personAbilitySpread: spread }));
      engine.run(240);
      const pools = personViews(engine.world).filter((p) => p.region === 'south');
      expect(pools.length).toBeGreaterThan(1);
      return pools
        .map((p) => ({ ability: p.ability, pay: p.incomeRate / Math.max(1, p.employed) }))
        .sort((a, b) => a.ability - b.ability);
    };

    // With everyone identical the two pools in a region are paid the same.
    const flat = shared(0);
    expect(flat[0]!.pay).toBeCloseTo(flat[flat.length - 1]!.pay, -2);

    // With a spread, the abler pool takes more per head.
    const spread = shared(DEFAULT_CONFIG.personAbilitySpread);
    expect(spread[spread.length - 1]!.pay).toBeGreaterThan(spread[0]!.pay);
  }, 90_000);
});
