import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { realisedHaircut } from '../src/agents/insolvency.js';
import { resolvedCompanies } from '../src/world/state.js';

function world() {
  const engine = newGame('uk2025');
  const company = resolvedCompanies(engine.world)[0]!;
  return { world: engine.world, companyId: company.id };
}

describe('recovery in liquidation', () => {
  it('is better when the economy is strong', () => {
    const { world: w, companyId } = world();

    w.economy.outputGap = -0.05;
    const slump = realisedHaircut(w, companyId, w.tick, 'windUp');
    w.economy.outputGap = 0.05;
    const boom = realisedHaircut(w, companyId, w.tick, 'windUp');

    expect(boom).toBeLessThan(slump);
  });

  it('varies between one failure and the next', () => {
    const { world: w } = world();
    const companies = resolvedCompanies(w).slice(0, 12).map((c) => c.id);
    const haircuts = companies.map((id) => realisedHaircut(w, id, w.tick, 'windUp'));
    expect(new Set(haircuts).size).toBeGreaterThan(1);
  });

  it('gives the same answer for the same failure every time', () => {
    const { world: w, companyId } = world();
    const first = realisedHaircut(w, companyId, w.tick, 'windUp');
    const second = realisedHaircut(w, companyId, w.tick, 'windUp');
    expect(second).toBe(first);
  });

  it('does better on an orderly sale than a fire sale', () => {
    const { world: w, companyId } = world();
    const orderly = realisedHaircut(w, companyId, w.tick, 'workout');
    const forced = realisedHaircut(w, companyId, w.tick, 'windUp');
    expect(orderly).toBeLessThan(forced);
  });

  it('recovers more from asset-heavy sectors', () => {
    const { world: w } = world();
    // Compare two firms that differ only in the capital intensity of their
    // sector, holding the luck draw constant by reusing one identity.
    const company = resolvedCompanies(w)[0]!;
    w.sectors[company.sector]!.capitalIntensity = 0.2;
    const light = realisedHaircut(w, company.id, w.tick, 'windUp');
    w.sectors[company.sector]!.capitalIntensity = 1.2;
    const heavy = realisedHaircut(w, company.id, w.tick, 'windUp');

    expect(heavy).toBeLessThan(light);
  });

  it('stays inside sane bounds however extreme the cycle', () => {
    const { world: w, companyId } = world();
    for (const gap of [-2, -0.5, 0, 0.5, 2]) {
      w.economy.outputGap = gap;
      const haircut = realisedHaircut(w, companyId, w.tick, 'windUp');
      expect(haircut).toBeGreaterThanOrEqual(0.02);
      expect(haircut).toBeLessThanOrEqual(0.95);
    }
  });

  it('collapses to a fixed rate when variability is switched off', () => {
    const engine = newGame('uk2025');
    const w = engine.world;
    w.config.liquidationCyclicality = 0;
    w.config.liquidationVariance = 0;
    w.config.liquidationCapitalIntensityBenefit = 0;
    w.economy.outputGap = -0.03;

    const haircuts = resolvedCompanies(w)
      .slice(0, 5)
      .map((c) => realisedHaircut(w, c.id, w.tick, 'windUp'));
    expect(new Set(haircuts)).toEqual(new Set([w.config.liquidationHaircut]));
  });
});
