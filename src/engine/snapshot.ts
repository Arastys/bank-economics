import { WORLD_VERSION, type WorldState } from '../world/state.js';

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
