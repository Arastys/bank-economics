import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { consumptionBudget, poolBudget } from '../src/systems/goodsMarket.js';
import { personViews, type PersonView } from '../src/agents/views.js';
import { DEFAULT_CONFIG } from '../src/world/state.js';
import { pounds, type Money } from '../src/core/money.js';
import { spendable } from '../src/world/transfer.js';

/** A stand-in pool: `heads` adults, `working` of them earning `income` between them. */
function pool(heads: number, working: number, income: Money, savings: Money) {
  const view = {
    count: heads,
    children: 0,
    employed: working,
    incomeRate: income,
    propensityToConsume: 0.95,
  } as unknown as PersonView;
  return { view, savings };
}

const asOne = (p: ReturnType<typeof pool>) =>
  consumptionBudget(0.95, p.view.incomeRate, p.view.incomeRate, p.savings, DEFAULT_CONFIG, 0);

describe('a pool is a population, not one average person', () => {
  it('matches the old rule exactly when everybody is working', () => {
    const p = pool(1000, 1000, pounds(100_000) as Money, pounds(18_000_000) as Money);
    expect(poolBudget(p.view, p.savings, DEFAULT_CONFIG, 0)).toBe(asOne(p));
  });

  /**
   * The defect this exists to prevent. Somebody out of work is far below the
   * cushion they are defending, so their savings term is negative -- and
   * pooling let that cancel out a working neighbour's spending, which is not
   * something that can happen. Nobody can un-buy the groceries.
   */
  it('does not let one member being short cancel another member spending', () => {
    // Savings below the buffer but not hopelessly: the idle want a negative
    // sum, the employed still want a positive one.
    const p = pool(1000, 900, pounds(100_000) as Money, pounds(12_000_000) as Money);
    expect(asOne(p)).toBeGreaterThan(0);
    expect(poolBudget(p.view, p.savings, DEFAULT_CONFIG, 0)).toBeGreaterThan(asOne(p));
  });

  /**
   * The exception that proves it. With savings exactly at the buffer nobody's
   * savings term pulls either way, so there is no shortfall to cancel and the
   * split makes no difference -- give or take a penny a head, since each
   * member's budget is rounded before being counted up.
   */
  it('is neutral when nobody is above or below their cushion', () => {
    const heads = 1000;
    const income = pounds(100_000) as Money;
    const atBuffer = (income * DEFAULT_CONFIG.savingsBufferDays) as Money;
    const p = pool(heads, 900, income, atBuffer);
    const diff = Math.abs(poolBudget(p.view, p.savings, DEFAULT_CONFIG, 0) - asOne(p));
    expect(diff).toBeLessThanOrEqual(heads);
  });

  it('gives the wage bill to the people actually earning it', () => {
    const heads = 1000;
    const income = pounds(100_000) as Money;
    const savings = pounds(12_000_000) as Money;
    // Same wage bill, fewer earners: each earner is on more.
    const many = poolBudget(pool(heads, 950, income, savings).view, savings, DEFAULT_CONFIG, 0);
    const few = poolBudget(pool(heads, 500, income, savings).view, savings, DEFAULT_CONFIG, 0);
    expect(few).not.toBe(many);
  });

  it('spends nothing for a pool with nobody in it', () => {
    const p = pool(0, 0, pounds(0) as Money, pounds(0) as Money);
    expect(poolBudget(p.view, p.savings, DEFAULT_CONFIG, 0)).toBe(0);
  });

  it('never spends a pool past its savings', () => {
    const p = pool(1000, 900, pounds(500_000) as Money, pounds(1000) as Money);
    expect(poolBudget(p.view, p.savings, DEFAULT_CONFIG, 0)).toBeLessThanOrEqual(p.savings);
  });

  it('leaves the real scenario spending a sane share of income', () => {
    const engine = newGame('uk2025');
    engine.run(120);
    for (const person of personViews(engine.world)) {
      const savings = spendable(engine.world, engine.world.ledger, person.id);
      const budget = poolBudget(person, savings, engine.world.config, 0);
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(savings);
    }
  }, 60_000);
});
