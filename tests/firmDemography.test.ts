import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { isMonthEnd } from '../src/core/time.js';
import { trialBalance } from '../src/ledger/ledger.js';
import { spendable } from '../src/world/transfer.js';
import { cohorts, resolvedCompanies, type WorldState } from '../src/world/state.js';
import { firmDemographySystem } from '../src/systems/firmDemography.js';

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

    // At zero elasticity entry exactly replaces exit, whatever the economy is
    // doing, so the only drift left is resolved firms failing on their own.
    expect(deaths).toBeGreaterThan(0);
    expect(births).toBeCloseTo(deaths, 6);
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
