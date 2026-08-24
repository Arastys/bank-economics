import type { Rng } from '../core/rng.js';
import type { Day } from '../core/time.js';
import type { LedgerState } from '../ledger/ledger.js';
import type { GameEventBus, Emitter } from '../world/events.js';
import type { WorldState } from '../world/state.js';

/**
 * Everything a system is given for one tick. Systems receive this and nothing
 * else -- no globals, no imports of each other.
 */
export interface SimContext {
  tick: Day;
  world: WorldState;
  ledger: LedgerState;
  bus: GameEventBus;
  emit: Emitter;
  /** A generator for a named stream, deterministic in (seed, stream, tick). */
  rng(stream: string): Rng;
}
