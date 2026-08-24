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
