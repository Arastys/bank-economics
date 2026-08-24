import { describe, expect, it } from 'vitest';
import { headcountStep } from '../src/systems/firms.js';
import { FirmView } from '../src/agents/views.js';
import { newGame } from '../src/index.js';
import { cohorts, resolvedCompanies } from '../src/world/state.js';

const world = newGame('uk2025').world;
const aCohort = () => new FirmView(cohorts(world).find((c) => c.memberKind === 'company')!);
const aCompany = () => new FirmView(resolvedCompanies(world)[0]!);

describe('headcount adjustment', () => {
  it('moves whole people at a real company', () => {
    const firm = aCompany();
    const step = headcountStep(firm, 0.02);
    expect(Number.isInteger(step)).toBe(true);
  });

  it('never leaves a real company adjusting by nobody', () => {
    const firm = aCompany();
    firm.employees = 4;
    expect(headcountStep(firm, 0.001)).toBe(1);
  });

  /**
   * A cohort is an aggregate over thousands of firms, so its headcount must
   * move by the exact fraction. Rounding it makes the economy's behaviour
   * depend on where the cohort boundaries happen to be drawn: one pool of
   * 27,780 sheds 556 at 2%, twelve pools of 2,315 shed 46 each, which is 552.
   */
  it('moves the exact fraction for a pool', () => {
    const pool = aCohort();
    pool.employees = 27_780;
    expect(headcountStep(pool, 0.02)).toBeCloseTo(555.6, 6);
  });

  it('gives the same total however the pool is partitioned', () => {
    const pool = aCohort();
    const rate = 0.02;
    const whole = 27_780;

    pool.employees = whole;
    const asOne = headcountStep(pool, rate);

    let asMany = 0;
    for (let i = 0; i < 12; i++) {
      pool.employees = whole / 12;
      asMany += headcountStep(pool, rate);
    }
    expect(asMany).toBeCloseTo(asOne, 6);
  });
});
