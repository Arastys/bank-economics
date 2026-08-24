import { describe, expect, it } from 'vitest';
import { buildWorld } from '../src/scenarios/build.js';
import { uk2025 } from '../src/scenarios/uk2025.js';
import { trialBalance } from '../src/ledger/ledger.js';
import type { Cohort, CompanyArchetype } from '../src/world/types.js';
import type { WorldState } from '../src/world/state.js';

function build(subdivision: number, dispersion = 0.02): WorldState {
  return buildWorld({ ...uk2025, cohortSubdivision: subdivision, cohortDispersion: dispersion });
}

function companyCohorts(world: WorldState): Cohort[] {
  return Object.values(world.entities).filter(
    (e): e is Cohort => e.kind === 'cohort' && e.memberKind === 'company',
  );
}

function population(world: WorldState) {
  let firms = 0;
  let employees = 0;
  let capacity = 0;
  for (const cohort of companyCohorts(world)) {
    const archetype = cohort.archetype as CompanyArchetype;
    firms += cohort.count;
    employees += cohort.pool.employees ?? 0;
    capacity += (cohort.pool.employees ?? 0) * archetype.meanProductivity;
  }
  for (const entity of Object.values(world.entities)) {
    if (entity.kind !== 'company') continue;
    firms += 1;
    employees += entity.employees;
    capacity += entity.employees * entity.productivity;
  }
  return { firms, employees, capacity };
}

describe('cohort subdivision', () => {
  it('is off by default and leaves one cohort per specification', () => {
    const world = build(1);
    expect(companyCohorts(world)).toHaveLength(uk2025.companyCohorts.length);
  });

  it('gives the latent economy many more price-setters', () => {
    const coarse = new Set(companyCohorts(build(1)).map((c) => c.pool.price));
    const fine = new Set(companyCohorts(build(12)).map((c) => c.pool.price));
    expect(fine.size).toBeGreaterThan(coarse.size * 5);
  });

  it('does not change how many firms exist', () => {
    expect(population(build(12)).firms).toBe(population(build(1)).firms);
    expect(population(build(30)).firms).toBe(population(build(1)).firms);
  });

  /**
   * Slicing a specification must not quietly resize the economy. Aggregate
   * headcount and output capacity have to survive it, or the calibration is
   * measuring a different economy from the one it was tuned against.
   */
  it('keeps aggregate employment and capacity within a whisker', () => {
    const coarse = population(build(1));
    const fine = population(build(12));
    expect(Math.abs(fine.employees / coarse.employees - 1)).toBeLessThan(0.03);
    expect(Math.abs(fine.capacity / coarse.capacity - 1)).toBeLessThan(0.03);
  });

  /**
   * A cohort of three firms costs exactly what a cohort of three thousand
   * costs and represents its members far worse, so small specifications are
   * split less than large ones.
   */
  it('never splits a specification into pools too small to be pools', () => {
    for (const cohort of companyCohorts(build(40))) {
      expect(cohort.count).toBeGreaterThan(20);
    }
  });

  /**
   * Price has to follow from pay and output per head. Varying it independently
   * leaves some cohorts unable to cover their wage bill at any volume, which
   * is not variety -- it is a broken economy that shrinks for three years.
   */
  it('leaves every cohort able to cover its wage bill', () => {
    for (const cohort of companyCohorts(build(20, 0.09))) {
      const archetype = cohort.archetype as CompanyArchetype;
      const revenuePerHead = archetype.meanProductivity * archetype.meanPrice;
      expect(revenuePerHead).toBeGreaterThan(archetype.meanWagePerEmployee);
    }
  });

  it('builds the same economy every time from the same seed', () => {
    const a = companyCohorts(build(12)).map((c) => `${c.id}:${c.count}:${c.pool.price}`);
    const b = companyCohorts(build(12)).map((c) => `${c.id}:${c.count}:${c.pool.price}`);
    expect(a).toEqual(b);
  });

  it('opens with balanced books however finely it is sliced', () => {
    for (const subdivision of [1, 12, 30]) {
      expect(trialBalance(build(subdivision).ledger)).toBe(0);
    }
  });
});
