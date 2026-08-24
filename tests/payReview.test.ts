import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { drawPayReviewMonth } from '../src/agents/lod.js';
import { advanceWageIndex } from '../src/systems/firms.js';
import { FirmView } from '../src/agents/views.js';
import { resolvedCompanies } from '../src/world/state.js';
import { load, save } from '../src/engine/snapshot.js';
import type { WorldState } from '../src/world/state.js';

/**
 * The defect this exists to prevent: every firm in the economy settled pay on
 * the same monthly tick, by the same percentage, from one economy-wide
 * tightness number. One shock moved every wage at once, and the boom-bust
 * cycle that produced is most of the model's inflation volatility -- 15.8 of a
 * baseline score of 69.5, against 6.3 for the inflation level itself.
 */
describe('firms settle pay on their own schedule', () => {
  it('spreads review months across the calendar', () => {
    const months = new Set(resolvedCompanies(newGame('uk2025').world).map((c) => c.payReviewMonth));
    expect(months.size).toBeGreaterThan(6);
    for (const m of months) {
      expect(m).toBeGreaterThanOrEqual(1);
      expect(m).toBeLessThanOrEqual(12);
    }
  });

  it('gives the same firm the same review month every time', () => {
    const world = newGame('uk2025').world;
    expect(drawPayReviewMonth(world, 'coh:cmp:0#7')).toBe(drawPayReviewMonth(world, 'coh:cmp:0#7'));
  });

  /**
   * The point of the whole change. Twelve vintages of pay coexist, so a shock
   * reaches the wage bill over a year rather than all at once.
   */
  it('leaves the wage bill a mix of vintages rather than one number', () => {
    const engine = newGame('uk2025');
    engine.run(400);
    const wages = new Set(resolvedCompanies(engine.world).map((c) => c.wagePerEmployee));
    expect(wages.size).toBeGreaterThan(3);
  }, 60_000);

  /**
   * A cohort is thousands of firms whose reviews are spread across the year,
   * so its average must track the trailing mean of the index. Moving a pool in
   * one annual step would be a bigger synchronisation than the one this
   * replaces, because the pools hold most of the employment.
   */
  it('moves a pool by the trailing mean, not by the latest settlement', () => {
    const world = newGame('uk2025').world;
    for (let m = 0; m < 12; m++) advanceWageIndex(world, 0.01);
    const history = world.economy.wageIndexHistory;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    const latestStep = world.economy.wageIndex / history[history.length - 2]!;
    const pooledStep = mean(history) / mean(history.slice(0, -1));
    // Both move up, but the pool lags the firm that just settled.
    expect(pooledStep).toBeGreaterThan(1);
    expect(pooledStep).toBeLessThan(latestStep * 1.001);
    expect(world.economy.wageIndexHistory.length).toBe(12);
  });

  it('keeps only a year of vintages however long it runs', () => {
    const world = newGame('uk2025').world;
    for (let m = 0; m < 60; m++) advanceWageIndex(world, 0.005);
    expect(world.economy.wageIndexHistory.length).toBe(12);
  });

  it('spreads an old save across the calendar rather than onto one month', () => {
    const world = newGame('uk2025').world;
    const legacy = JSON.parse(save(world)) as { version: number; world: WorldState };
    legacy.version = 3;
    for (const entity of Object.values(legacy.world.entities)) {
      if (entity.kind !== 'company') continue;
      delete (entity as Partial<typeof entity>).payReviewMonth;
      delete (entity as Partial<typeof entity>).wageIndexAtReview;
    }
    delete (legacy.world.economy as Partial<typeof legacy.world.economy>).wageIndex;

    const migrated = load(JSON.stringify(legacy));
    const months = new Set(resolvedCompanies(migrated).map((c) => c.payReviewMonth));
    expect(months.size).toBe(12);
    expect(migrated.economy.wageIndex).toBe(1);
  });
});
