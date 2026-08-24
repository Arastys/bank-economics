import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { adjustPrice, unitProductionCost } from '../src/systems/goodsMarket.js';
import { FirmView } from '../src/agents/views.js';
import { resolvedCompanies } from '../src/world/state.js';
import { pounds, type Money } from '../src/core/money.js';
import type { SimConfig } from '../src/world/state.js';

function firm(price: Money, wage = pounds(120) as Money, quality = 1) {
  const world = newGame('uk2025').world;
  const company = resolvedCompanies(world)[0]!;
  company.price = price;
  company.wagePerEmployee = wage;
  company.quality = quality;
  company.productivity = 1.5 * quality;
  company.employees = 10;
  company.expectedSales = 15;
  company.inventoryUnits = 120; // eight days at target, so stock is neutral
  return { world, view: new FirmView(company), config: world.config };
}

/** Sold exactly the target share, so only the cost anchor is pulling. */
function nudge(view: FirmView, config: SimConfig, offered = 100) {
  adjustPrice(view, offered * config.targetSellThrough, offered, view.inventoryUnits, config);
}

describe('pricing against cost', () => {
  it('knows what a unit costs to make', () => {
    const { view } = firm(pounds(100) as Money, pounds(120) as Money);
    expect(unitProductionCost(view)).toBe(pounds(80));
  });

  /**
   * The failure this exists to prevent: with no cost anchor, pay can rise
   * straight through the price and leave the firm sector selling below cost.
   */
  it('pulls a price up towards cost when it is too low', () => {
    const { view, config } = firm(pounds(60) as Money);
    const before = view.price;
    nudge(view, config);
    expect(view.price).toBeGreaterThan(before);
  });

  it('pulls a price down when it is far above cost', () => {
    const { view, config } = firm(pounds(400) as Money);
    const before = view.price;
    nudge(view, config);
    expect(view.price).toBeLessThan(before);
  });

  it('converges on the target markup when trading is neutral', () => {
    const { view, config } = firm(pounds(60) as Money);
    for (let day = 0; day < 4000; day++) nudge(view, config);
    const expected = unitProductionCost(view) * (1 + config.targetMarkup * view.pricingDiscipline);
    expect(view.price / expected).toBeGreaterThan(0.9);
    expect(view.price / expected).toBeLessThan(1.1);
  });

  it('never sells further below cost than the floor allows', () => {
    const { view, config } = firm(pounds(90) as Money);
    // Nothing sells, ever: the strongest possible downward pressure.
    for (let day = 0; day < 3000; day++) adjustPrice(view, 0, 100, 100_000, config);
    expect(view.price).toBeGreaterThanOrEqual(unitProductionCost(view) * (1 + config.minMarkup) - 1);
  });

  it('leaves pricing to trading conditions when the anchor is switched off', () => {
    // Well clear of the floor, so a markdown is actually available.
    const { view, config } = firm(pounds(200) as Money);
    const loose = { ...config, costAnchorWeight: 0 };
    const before = view.price;
    // Sold nothing, so trading conditions alone should mark it down.
    adjustPrice(view, 0, 100, view.inventoryUnits, loose);
    expect(view.price).toBeLessThan(before);
    // The anchor would have pulled the other way: proof the switch did something.
    const anchored = firm(pounds(200) as Money);
    adjustPrice(anchored.view, 0, 100, anchored.view.inventoryUnits, config);
    expect(anchored.view.price).toBeGreaterThan(view.price);
  });

  it('lets a better-run firm make the same goods for less', () => {
    const good = firm(pounds(100) as Money, pounds(120) as Money, 1.3);
    const poor = firm(pounds(100) as Money, pounds(120) as Money, 0.8);
    expect(unitProductionCost(good.view)).toBeLessThan(unitProductionCost(poor.view));
    expect(good.view.pricingDiscipline).toBeGreaterThan(poor.view.pricingDiscipline);
  });
});
