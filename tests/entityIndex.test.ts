import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { load, save } from '../src/engine/snapshot.js';
import {
  addEntity,
  cohorts,
  entitiesOfKind,
  removeEntity,
  resolvedCompanies,
  resolvedPeople,
} from '../src/world/state.js';

/**
 * `entitiesOfKind` caches its answer, so the interesting cases are all about
 * the cache going stale rather than about the scan itself.
 */
describe('entity index', () => {
  it('sees an entity added after the index was built', () => {
    const world = newGame('uk2025').world;
    const before = resolvedCompanies(world).length;
    const template = structuredClone(resolvedCompanies(world)[0]!);

    addEntity(world, { ...template, id: 'co:added', name: 'Added Ltd' });

    expect(resolvedCompanies(world).length).toBe(before + 1);
    expect(resolvedCompanies(world).map((c) => c.id)).toContain('co:added');
  });

  it('forgets an entity removed after the index was built', () => {
    const world = newGame('uk2025').world;
    const victim = resolvedCompanies(world)[0]!;
    const before = resolvedCompanies(world).length;

    removeEntity(world, victim.id);

    expect(resolvedCompanies(world).length).toBe(before - 1);
    expect(resolvedCompanies(world).map((c) => c.id)).not.toContain(victim.id);
  });

  it('keeps one kind current when another kind changes', () => {
    const world = newGame('uk2025').world;
    const companiesBefore = resolvedCompanies(world).length;
    const cohortsBefore = cohorts(world).length;
    expect(cohortsBefore).toBeGreaterThan(0);

    removeEntity(world, resolvedCompanies(world)[0]!.id);

    expect(resolvedCompanies(world).length).toBe(companiesBefore - 1);
    expect(cohorts(world).length).toBe(cohortsBefore);
  });

  /**
   * The LOD sweep iterates `resolvedCompanies(world)` while dissolving and
   * demoting the firms inside it. That only works because the array it walks
   * is a snapshot; an index edited in place would splice entities out from
   * under the loop and skip their neighbours.
   */
  it('hands out a snapshot that stays safe to iterate while removing', () => {
    const world = newGame('uk2025').world;
    const expected = resolvedCompanies(world).map((c) => c.id);
    expect(expected.length).toBeGreaterThan(2);

    const visited: string[] = [];
    for (const company of resolvedCompanies(world)) {
      visited.push(company.id);
      removeEntity(world, company.id);
    }

    expect(visited).toEqual(expected);
    expect(resolvedCompanies(world).length).toBe(0);
  });

  /**
   * A restored world is a separate object graph, so it must get its own index
   * rather than inheriting the answers cached against the world it was saved
   * from. This also covers the one place `kind` is rewritten in place: the
   * migrations, which run on that fresh graph before anything can read it.
   */
  it('indexes a restored world separately from the one it was saved from', () => {
    const world = newGame('uk2025').world;
    const companies = resolvedCompanies(world).length;
    expect(companies).toBeGreaterThan(0);

    const restored = load(save(world));
    expect(entitiesOfKind(restored, 'company').length).toBe(companies);
    expect(entitiesOfKind(restored, 'person').length).toBe(resolvedPeople(world).length);

    // Emptying one world must not empty the other's index.
    for (const company of resolvedCompanies(world)) removeEntity(world, company.id);
    expect(resolvedCompanies(world).length).toBe(0);
    expect(entitiesOfKind(restored, 'company').length).toBe(companies);
  });
});
