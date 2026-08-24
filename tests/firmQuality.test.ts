import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { drawQuality } from '../src/agents/lod.js';
import { resolvedCompanies } from '../src/world/state.js';

describe('some firms are better run than others', () => {
  it('gives every firm its own quality', () => {
    const world = newGame('uk2025').world;
    const firms = resolvedCompanies(world);
    expect(new Set(firms.map((f) => f.quality)).size).toBeGreaterThan(firms.length / 2);
    expect(new Set(firms.map((f) => f.productivity)).size).toBeGreaterThan(firms.length / 2);
  });

  /**
   * Mean one, or materialising members out of a cohort would quietly make the
   * economy more productive than the pool they came from.
   */
  it('averages out to the sector, so promotion does not shift the economy', () => {
    const world = newGame('uk2025').world;
    const draws = Array.from({ length: 4000 }, (_, i) => drawQuality(world, `firm#${i}`));
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.97);
    expect(mean).toBeLessThan(1.03);
  });

  it('gives the same firm the same quality every time', () => {
    const world = newGame('uk2025').world;
    expect(drawQuality(world, 'coh:cmp:0#7')).toBe(drawQuality(world, 'coh:cmp:0#7'));
    expect(drawQuality(world, 'coh:cmp:0#7')).not.toBe(drawQuality(world, 'coh:cmp:0#8'));
  });

  it('makes every firm identical when the spread is switched off', () => {
    const world = newGame('uk2025').world;
    world.config.firmQualitySpread = 0;
    expect(drawQuality(world, 'a')).toBe(1);
    expect(drawQuality(world, 'b')).toBe(1);
  });

  /**
   * Quality is a multiple of the sector average, so stripping it back out must
   * return the plain archetype figure every firm in a band started from.
   */
  it('bakes quality into productivity, so a better firm gets more from the same people', () => {
    const bands = new Map<string, number[]>();
    for (const company of resolvedCompanies(newGame('uk2025').world)) {
      const base = company.productivity / company.quality;
      bands.set(company.sizeBand, [...(bands.get(company.sizeBand) ?? []), base]);
    }
    expect(bands.size).toBeGreaterThan(1);
    for (const [, bases] of bands) {
      for (const base of bases) expect(base).toBeCloseTo(bases[0]!, 6);
    }
  });
});
