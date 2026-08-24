import { demoteEntity, dissolveEntity } from '../agents/lod.js';
import { pruneApplications, pruneInstruments, resolvedCompanies, resolvedHouseholds } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

/** Only sweep occasionally -- folding entities away is not urgent work. */
const SWEEP_INTERVAL = 30;

/**
 * Returns entities to their cohorts once the player has no reason to care
 * about them, which is what keeps the resolved population bounded no matter
 * how long the game runs.
 */
export const levelOfDetailSystem = defineSystem({
  id: 'lod.sweep',
  phase: PHASE.LOD,
  description: 'Folds idle resolved entities back into their cohorts',
  run(ctx) {
    if (ctx.tick % SWEEP_INTERVAL !== 0) return;
    const { world } = ctx;
    const cutoff = ctx.tick - world.config.demotionIdleDays;

    for (const company of resolvedCompanies(world)) {
      if (!company.originCohortId) continue;
      const last = world.lastInteraction[company.id] ?? company.createdOn;
      if (last > cutoff) continue;
      if (company.status === 'defaulted') {
        // A failed firm leaves the population rather than rejoining the pool,
        // and whatever is left of its balance sheet passes to its sector.
        dissolveEntity(ctx, company.id);
        continue;
      }
      demoteEntity(ctx, company.id);
    }

    for (const household of resolvedHouseholds(world)) {
      if (!household.originCohortId) continue;
      const last = world.lastInteraction[household.id] ?? household.createdOn;
      if (last <= cutoff) demoteEntity(ctx, household.id);
    }

    pruneInstruments(world, 90);
    pruneApplications(world, 90);
  },
});
