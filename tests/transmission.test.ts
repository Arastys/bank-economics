import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import {
  consumptionBudget,
  investmentAppetite,
  propensityOutOfIncome,
} from '../src/systems/goodsMarket.js';
import { DEFAULT_CONFIG, centralBank, realRateGap, resolvedCompanies } from '../src/world/state.js';
import { balance } from '../src/ledger/ledger.js';
import { AC } from '../src/ledger/accounts.js';
import { pounds, type Money } from '../src/core/money.js';

/** The consumption channel is off by default, so exercising it needs it on. */
const SAVERS = { ...DEFAULT_CONFIG, savingsRateSensitivity: 2 };

function worldAtRate(bankRate: number, inflation = 0.02) {
  const world = newGame('uk2025').world;
  centralBank(world).bankRate = bankRate;
  world.economy.inflationAnnual = inflation;
  return world;
}

describe('the policy rate reaches the economy', () => {
  it('reads zero when money is priced where the economy expects it', () => {
    const world = worldAtRate(0.02 + DEFAULT_CONFIG.neutralRealRate);
    expect(realRateGap(world)).toBeCloseTo(0, 10);
  });

  it('is positive for tight money and negative for loose', () => {
    expect(realRateGap(worldAtRate(0.10))).toBeGreaterThan(0);
    expect(realRateGap(worldAtRate(0.00))).toBeLessThan(0);
  });

  /** Inflation, not the headline rate, is what makes money dear. */
  it('is about the real rate, not the nominal one', () => {
    expect(realRateGap(worldAtRate(0.10, 0.09))).toBeLessThan(realRateGap(worldAtRate(0.03, 0.00)));
  });

  it('makes firms postpone capacity when money is dear', () => {
    expect(investmentAppetite(worldAtRate(0.12))).toBeLessThan(1);
    expect(investmentAppetite(worldAtRate(0.00))).toBeGreaterThan(1);
  });

  it('makes households hold back more of their pay when saving pays better', () => {
    expect(propensityOutOfIncome(0.95, SAVERS, 0.025)).toBeLessThan(0.95);
    expect(propensityOutOfIncome(0.95, SAVERS, -0.025)).toBeGreaterThan(0.95);
  });

  it('spends less today when saving pays better', () => {
    const income = pounds(100) as Money;
    const savings = (income * SAVERS.savingsBufferDays) as Money;
    expect(consumptionBudget(0.95, income, savings, SAVERS, 0.025)).toBeLessThan(
      consumptionBudget(0.95, income, savings, SAVERS, -0.025),
    );
  });

  /**
   * Off by default, and not by oversight. Restraining consumption here raises
   * unemployment without lowering inflation, because the price level is set by
   * costs rather than by demand. Turning it on is a decision that needs
   * numbers behind it, so this fails if someone flips it without them.
   */
  it('ships with the consumption channel switched off', () => {
    expect(DEFAULT_CONFIG.savingsRateSensitivity).toBe(0);
    const income = pounds(100) as Money;
    const savings = (income * DEFAULT_CONFIG.savingsBufferDays) as Money;
    expect(consumptionBudget(0.95, income, savings, DEFAULT_CONFIG, 0.025)).toBe(
      consumptionBudget(0.95, income, savings, DEFAULT_CONFIG, -0.025),
    );
  });

  /**
   * The committee must not be able to switch the economy off, however far the
   * rate strays. Both channels are bounded for that reason.
   */
  it('cannot be driven to an absurd place by an absurd rate', () => {
    for (const rate of [0, 0.5, 2]) {
      expect(investmentAppetite(worldAtRate(rate))).toBeGreaterThanOrEqual(0);
      expect(investmentAppetite(worldAtRate(rate))).toBeLessThanOrEqual(2);
    }
    for (const gap of [-5, -0.5, 0.5, 5]) {
      const p = propensityOutOfIncome(0.95, DEFAULT_CONFIG, gap);
      expect(p).toBeGreaterThanOrEqual(0.3);
      expect(p).toBeLessThanOrEqual(1.2);
    }
  });

  /**
   * The defect this exists to prevent, and the only test here that runs the
   * economy to catch it: Bank Rate spanned 900 basis points and *nothing*
   * changed, because no spending decision anywhere read it.
   *
   * This asserts the channel is connected, not that the committee controls
   * inflation -- it does not, and pretending otherwise in a test would bake in
   * a claim the numbers refuse. Restraint reaches output here, not prices.
   */
  it('makes cheap money actually buy more capacity than dear money', () => {
    const cheap = capacityBuilt({ maxBankRate: 0.001 });
    const dear = capacityBuilt({ neutralRealRate: -0.04 });
    expect(dear).toBeLessThan(cheap);
  }, 120_000);

  /**
   * Switching the channel off must leave the appetite flat whatever the rate.
   *
   * This asserts it where the mechanism lives rather than out at the far end
   * of a three-year run: Bank Rate also reaches firms' cash through interest
   * paid and earned, and investment is capped by cash on hand, so two rate
   * regimes are never identical in aggregate however the demand channel is
   * set. An earlier version of this test compared those aggregates and was
   * measuring that residue rather than the channel.
   */
  it('leaves investment appetite flat when the channel is switched off', () => {
    const off = { ...DEFAULT_CONFIG, investmentRateSensitivity: 0 };
    for (const rate of [0, 0.02, 0.08, 0.2]) {
      const world = worldAtRate(rate);
      world.config = off;
      expect(investmentAppetite(world)).toBe(1);
    }
  });
});

/** Fixed assets the firm sector has accumulated after three years. */
function capacityBuilt(overrides: Partial<typeof DEFAULT_CONFIG>): number {
  const engine = newGame('uk2025');
  Object.assign(engine.world.config, overrides);
  engine.run(3 * 365);
  return resolvedCompanies(engine.world).reduce(
    (total, c) => total + balance(engine.world.ledger, c.id, AC.FIXED_ASSETS),
    0,
  );
}
