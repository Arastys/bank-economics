import { DEFAULT_CONFIG, WORLD_VERSION, type WorldState } from '../world/state.js';

export interface Snapshot {
  version: number;
  savedAt: string;
  world: WorldState;
}

/**
 * Save games are the world state, minus the audit log.
 *
 * Nothing in the world holds a function, a Map or a class instance, which is
 * what keeps this close to a one-liner -- and is a rule worth keeping as the
 * game grows. The single exception is the ledger journal, which is a log of
 * what happened rather than part of what is, and is restored empty.
 */
export function save(world: WorldState): string {
  const snapshot: Snapshot = {
    version: WORLD_VERSION,
    savedAt: new Date().toISOString(),
    // The ledger journal is an audit log rather than state -- nothing reads it
    // back and no outcome depends on it -- but it was 40% of the file. It is
    // dropped here and restored empty on load.
    world: { ...world, ledger: { ...world.ledger, journal: [] } },
  };
  return JSON.stringify(snapshot);
}

export type Migration = (world: WorldState) => WorldState;

/** Migrations by the version they upgrade *from*. */
export const migrations = new Map<number, Migration>();

/**
 * People used to save a fixed share of income and trickle it back out at
 * `dissavingRate`, which never balanced. They now save towards a buffer.
 * An old save has no buffer, so it takes the current default and starts from
 * whatever savings it had.
 */
migrations.set(1, (world) => {
  const config = world.config as unknown as Record<string, unknown>;
  delete config.dissavingRate;
  config.savingsBufferDays = DEFAULT_CONFIG.savingsBufferDays;
  config.savingsAdjustment = DEFAULT_CONFIG.savingsAdjustment;
  return world;
});

/**
 * Nothing in the world read Bank Rate on the demand side, so the policy rate
 * did not reach the economy. An old save gains the two transmission
 * sensitivities at their defaults, which changes how it behaves from the tick
 * it is loaded -- there is no way to carry forward a channel that was not
 * there.
 */
migrations.set(2, (world) => {
  const config = world.config as unknown as Record<string, unknown>;
  config.investmentRateSensitivity = DEFAULT_CONFIG.investmentRateSensitivity;
  config.savingsRateSensitivity = DEFAULT_CONFIG.savingsRateSensitivity;
  return world;
});

/**
 * Pay used to be re-set for every firm on the same monthly tick. Firms now
 * settle on their own month against a running wage index. An old save starts
 * that index at 1 with no history, and every firm is given a review month --
 * spread by id rather than drawn, so a loaded save does not put the whole
 * economy on the same review month and rebuild the synchronisation this
 * removes.
 */
migrations.set(3, (world) => {
  const economy = world.economy as unknown as Record<string, unknown>;
  economy.wageIndex = 1;
  economy.wageIndexHistory = [];
  let n = 0;
  for (const entity of Object.values(world.entities)) {
    if (entity.kind !== 'company') continue;
    entity.payReviewMonth = (n++ % 12) + 1;
    entity.wageIndexAtReview = 1;
  }
  return world;
});

/**
 * `household` became `person`. The entity always was one -- it earned one
 * wage, and the labour force was a straight count of them -- so this renames
 * the discriminator and changes nothing else.
 */
migrations.set(4, (world) => {
  for (const entity of Object.values(world.entities) as { kind: string; memberKind?: string }[]) {
    if (entity.kind === 'household') entity.kind = 'person';
    if (entity.memberKind === 'household') entity.memberKind = 'person';
  }
  return world;
});

/**
 * People have ages now. An old save has a population that was entirely of
 * working age, so its headcount becomes the working-age band and the children
 * and pensioners a stationary population carries are added around it -- the
 * same shape a new world starts in, so a loaded save does not hand the labour
 * market a shock.
 */
migrations.set(5, (world) => {
  const { yearsAsChild, yearsWorking, yearsRetired } = world.config;
  for (const entity of Object.values(world.entities)) {
    if (entity.kind !== 'cohort' || entity.memberKind !== 'person') continue;
    const workingAge = entity.count;
    entity.pool.workingAge = workingAge;
    entity.pool.children = Math.round((workingAge * yearsAsChild) / yearsWorking);
    entity.pool.retired = Math.round((workingAge * yearsRetired) / yearsWorking);
    entity.pool.prosperityReference = 0;
    entity.count = entity.pool.workingAge + entity.pool.children + entity.pool.retired;
  }
  return world;
});

/**
 * People differ in how good they are at the work. An old save has no such
 * distinction, so everybody comes forward as exactly average -- which is what
 * they were, and leaves the loaded economy producing and paying what it did.
 */
migrations.set(6, (world) => {
  for (const entity of Object.values(world.entities)) {
    if (entity.kind === 'person') entity.ability = 1;
    else if (entity.kind === 'cohort' && entity.memberKind === 'person') entity.pool.ability = 1;
  }
  return world;
});

/**
 * Firms have demography now. An old save has a latent population that could
 * neither enter nor fail, so it gets the knobs that govern both; the pools
 * pick up their remembered level of trade on the first month they are asked
 * for it, which reads as exact replacement until they have something to
 * compare to.
 */
migrations.set(7, (world) => {
  const config = world.config as unknown as Record<string, unknown>;
  config.firmExitRate = DEFAULT_CONFIG.firmExitRate;
  config.firmExitCyclicality = DEFAULT_CONFIG.firmExitCyclicality;
  config.firmEntryElasticity = DEFAULT_CONFIG.firmEntryElasticity;
  config.firmTradeMemory = DEFAULT_CONFIG.firmTradeMemory;
  return world;
});

/**
 * Entry answers how much business there is per firm, not the margin against
 * its own average. A version 8 save carries `firmMarginMemory`, which smoothed
 * the signal that was replaced; the successor smooths trade per firm, so the
 * knob is renamed and the remembered margin dropped. Pools pick up a
 * remembered level of trade the first month they are asked, which reads as
 * exact replacement until there is something to compare to.
 */
migrations.set(8, (world) => {
  const config = world.config as unknown as Record<string, unknown>;
  config.firmTradeMemory = config.firmMarginMemory ?? DEFAULT_CONFIG.firmTradeMemory;
  delete config.firmMarginMemory;
  for (const entity of Object.values(world.entities)) {
    if (entity.kind === 'cohort' && entity.memberKind === 'company') {
      delete entity.pool.marginReference;
    }
  }
  return world;
});

/**
 * Capital finally does something. An old save has firms whose productivity was
 * a constant from birth, so that constant becomes the base -- the level they
 * produce at the reference capital per worker -- and the first month end
 * rescales it by the capital each of them actually holds.
 */
migrations.set(9, (world) => {
  const config = world.config as unknown as Record<string, unknown>;
  config.capitalElasticity = DEFAULT_CONFIG.capitalElasticity;
  config.capitalPerWorkerReference = DEFAULT_CONFIG.capitalPerWorkerReference;
  for (const entity of Object.values(world.entities)) {
    if (entity.kind === 'company') entity.baseProductivity = entity.productivity;
  }
  return world;
});

/**
 * Profit has a way back to households. An old save has firms and banks that
 * have retained every penny they ever made, and nothing here tries to undo
 * that -- the accumulated reserves stand, and the first year end after the
 * load distributes out of them like any other.
 */
migrations.set(10, (world) => {
  const config = world.config as unknown as Record<string, unknown>;
  config.firmDividendPayout = DEFAULT_CONFIG.firmDividendPayout;
  config.bankDividendPayout = DEFAULT_CONFIG.bankDividendPayout;
  return world;
});

export function load(json: string): WorldState {
  const snapshot = JSON.parse(json) as Snapshot;
  if (typeof snapshot?.version !== 'number' || !snapshot.world) {
    throw new Error('Not a valid save file');
  }
  let world = snapshot.world;
  if (world.ledger && !Array.isArray(world.ledger.journal)) world.ledger.journal = [];
  let version = snapshot.version;
  while (version < WORLD_VERSION) {
    const migration = migrations.get(version);
    if (!migration) throw new Error(`No migration from save version ${version}`);
    world = migration(world);
    version += 1;
  }
  if (version > WORLD_VERSION) {
    throw new Error(`Save is from a newer version (${version}) than this build (${WORLD_VERSION})`);
  }
  return world;
}
