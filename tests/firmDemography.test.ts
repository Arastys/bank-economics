import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { isMonthEnd } from '../src/core/time.js';
import { trialBalance } from '../src/ledger/ledger.js';
import { spendable } from '../src/world/transfer.js';
import { cohorts, resolvedCompanies, type WorldState } from '../src/world/state.js';
import { load, save } from '../src/engine/snapshot.js';
import { entryAppetite, firmDemographySystem } from '../src/systems/firmDemography.js';

const firmPools = (world: WorldState) => cohorts(world).filter((c) => c.memberKind === 'company');
/** Latent and resolved together: the LOD moves firms between the two freely. */
const firms = (world: WorldState) =>
  firmPools(world).reduce((t, c) => t + c.count, 0) + resolvedCompanies(world).length;

/** Advance the world to the next month end and run only firm demography. */
function runOneMonthEnd(engine: ReturnType<typeof newGame>): void {
  do {
    engine.world.tick += 1;
  } while (!isMonthEnd(engine.world.tick));
  firmDemographySystem.run(engine.context());
}

describe('firms are founded and firms fail', () => {
  it('holds the population steady when entry ignores profit', () => {
    const engine = newGame('uk2025', { seed: 3 });
    engine.world.config.firmEntryElasticity = 0;
    const before = firms(engine.world);

    let births = 0;
    let deaths = 0;
    engine.bus.on('firms.populationChanged', (e) => {
      births += e.births;
      deaths += e.deaths;
    });
    engine.run(365 * 5);

    // At zero elasticity entry replaces exit whatever the economy is doing.
    // Not to the last decimal: the below-cost gate is unconditional, so a
    // cohort caught selling under water still stops founding firms for a
    // month. That is worth a hundredth of a percent here.
    expect(deaths).toBeGreaterThan(0);
    expect(Math.abs(births - deaths) / deaths).toBeLessThan(0.001);
    expect(firms(engine.world) / before).toBeGreaterThan(0.99);
  }, 120_000);

  it('does nothing at all when the exit rate is zero', () => {
    const engine = newGame('uk2025', { seed: 3 });
    engine.world.config.firmExitRate = 0;
    const before = firmPools(engine.world).map((c) => ({ id: c.id, count: c.count }));

    let fired = false;
    engine.bus.on('firms.populationChanged', () => {
      fired = true;
    });
    // Only this system, so the LOD promoting members out of the pools cannot
    // be mistaken for demography moving them.
    for (let month = 0; month < 12; month++) runOneMonthEnd(engine);

    expect(fired).toBe(false);
    for (const was of before) {
      expect(firmPools(engine.world).find((c) => c.id === was.id)!.count).toBe(was.count);
    }
  });

  it('kills more firms in a downturn than in a boom', () => {
    // Deaths, not the net change. Entry is quoted as a multiple of exit, so the
    // cycle moves both ends together and the net can be flat while the churn
    // underneath it doubles.
    const measure = (outputGap: number) => {
      const engine = newGame('uk2025', { seed: 3 });
      engine.world.economy.outputGap = outputGap;
      let deaths = 0;
      engine.bus.on('firms.populationChanged', (e) => {
        deaths += e.deaths;
      });
      runOneMonthEnd(engine);
      return deaths;
    };

    const slump = measure(-0.05);
    const boom = measure(0.05);
    expect(slump).toBeGreaterThan(0);
    expect(slump).toBeGreaterThan(boom);
  });

  it('leaves the average firm the same size', () => {
    const engine = newGame('uk2025', { seed: 3 });
    const pools = firmPools(engine.world);
    const before = pools.map((c) => ({
      id: c.id,
      perFirm: (c.pool.employees ?? 0) / Math.max(1, c.count),
    }));

    runOneMonthEnd(engine);

    for (const was of before) {
      const now = firmPools(engine.world).find((c) => c.id === was.id)!;
      expect((now.pool.employees ?? 0) / Math.max(1, now.count)).toBeCloseTo(was.perFirm, 6);
    }
  });

  /**
   * A pool holds one account between its members, exactly as for people, so a
   * failure leaves the balance where it is with fewer firms sharing it and an
   * entrant dilutes it. The ledger must never see any of that.
   */
  it('creates and destroys no money', () => {
    const engine = newGame('uk2025', { seed: 3 });
    const before = firmPools(engine.world).map((c) => ({
      id: c.id,
      cash: spendable(engine.world, engine.world.ledger, c.id),
    }));

    engine.run(365 * 3);

    expect(trialBalance(engine.world.ledger)).toBe(0);
    for (const was of before) {
      const pool = firmPools(engine.world).find((c) => c.id === was.id);
      if (!pool) continue;
      // Demography moved firms in and out of this pool without emptying it.
      expect(spendable(engine.world, engine.world.ledger, pool.id)).toBeGreaterThan(0);
    }
  }, 120_000);

  /**
   * The point of measuring entry on trade per firm rather than on the margin
   * against its own average: a signal the population can move closes its own
   * gap, so the firm count tracks the amount of business going. The margin
   * against its own average could not do this — the reference caught up with
   * whatever the margin did, so births equalled deaths for ever.
   */
  it('gains firms when there is more business per firm, and loses them when there is less', () => {
    const trend = (perMonth: number) => {
      const engine = newGame('uk2025', { seed: 3 });
      // A year of trading first: nothing has been sold in a brand new world,
      // and a cohort with no trade to report gives no signal at all.
      engine.run(365);
      const pools = firmPools(engine.world);
      let births = 0;
      let deaths = 0;
      engine.bus.on('firms.populationChanged', (e) => {
        births += e.births;
        deaths += e.deaths;
      });
      // Hold everything else still and move only the amount of trade, so what
      // is being measured is the response and not the economy.
      const sold = pools.map((c) => c.pool.lastSoldUnits ?? 0);
      expect(sold.every((s) => s > 0)).toBe(true);
      // Start from equilibrium. A year of real trading leaves each pool
      // remembering an average of its daily sales, and `lastSoldUnits` is one
      // day of them, so measuring from here would be reading the step between
      // the two rather than the trend applied to it.
      for (const c of pools) delete c.pool.tradeReference;
      for (let month = 0; month < 24; month++) {
        pools.forEach((c, i) => {
          sold[i]! *= perMonth;
          c.pool.lastSoldUnits = sold[i]!;
        });
        runOneMonthEnd(engine);
      }
      return births - deaths;
    };

    expect(trend(1.004)).toBeGreaterThan(0);
    expect(trend(0.996)).toBeLessThan(0);
  });

  it('will not found a firm into a sector selling below cost', () => {
    const engine = newGame('uk2025', { seed: 3 });
    const pool = firmPools(engine.world)[0]!;
    // Trade is booming and the price is under what it costs to make.
    pool.pool.tradeReference = 1;
    pool.pool.lastSoldUnits = pool.count * 1000;
    pool.pool.price = 1;
    expect(entryAppetite(engine.world, pool)).toBe(0);
  });

  /**
   * Version 8 saves carry `firmMarginMemory` and a remembered margin per pool,
   * from when entry answered the margin against its own average. Both are
   * replaced rather than reinterpreted: the knob keeps its value under the new
   * name, and the stale reference goes so the pool re-anchors on the trade it
   * is actually doing.
   */
  it('carries a version 8 save onto the trade signal', () => {
    const world = newGame('uk2025', { seed: 3 }).world;
    const snapshot = JSON.parse(save(world));

    snapshot.version = 8;
    const config = snapshot.world.config;
    config.firmMarginMemory = 0.037;
    delete config.firmTradeMemory;
    const pool = Object.values(snapshot.world.entities).find(
      (e: any) => e.kind === 'cohort' && e.memberKind === 'company',
    ) as any;
    pool.pool.marginReference = 0.19;

    const restored = load(JSON.stringify(snapshot));

    expect(restored.config.firmTradeMemory).toBe(0.037);
    expect((restored.config as Record<string, unknown>).firmMarginMemory).toBeUndefined();
    const migrated = firmPools(restored).find((c) => c.id === pool.id)!;
    expect(migrated.pool.marginReference).toBeUndefined();
    expect(migrated.pool.tradeReference).toBeUndefined();
  });

  it('reaches the whole-economy insolvency rate it is set to', () => {
    const engine = newGame('uk2025', { seed: 3 });
    const years = 5;
    let deaths = 0;
    engine.bus.on('firms.populationChanged', (e) => {
      deaths += e.deaths;
    });
    engine.run(365 * years);

    const rate = deaths / years / firms(engine.world);
    // The knob is the annual share of latent firms that fail, so the realised
    // rate has to land on it once the cycle is averaged out.
    expect(rate).toBeGreaterThan(engine.world.config.firmExitRate * 0.7);
    expect(rate).toBeLessThan(engine.world.config.firmExitRate * 1.4);
  }, 120_000);
});
