/**
 * Bank Economics -- a UK bank simulation.
 *
 * The engine is headless: it has no DOM dependency and no rendering. Build a
 * world from a scenario, wrap it in an Engine, push commands in and read state
 * out.
 *
 *   const engine = newGame();
 *   engine.enqueue({ type: 'bank.setDepositRate', rate: 0.03 });
 *   engine.run(365);
 */
import { Engine, type EngineOptions } from './engine/engine.js';
import { buildWorld, scenarios } from './scenarios/index.js';

export function newGame(scenarioId = 'uk2025', options: EngineOptions & { seed?: number } = {}): Engine {
  const spec = scenarios.get(scenarioId);
  const world = buildWorld(options.seed === undefined ? spec : { ...spec, seed: options.seed });
  return new Engine(world, options);
}

export * from './core/money.js';
export * from './core/time.js';
export * from './core/result.js';
export { EventBus } from './core/events.js';
export { Registry } from './core/registry.js';
export * from './core/rng.js';

export * from './ledger/accounts.js';
export * from './ledger/ledger.js';
export * from './ledger/statements.js';
export * from './ledger/payments.js';

export * from './world/state.js';
export * from './world/types.js';
export * from './world/transfer.js';
export type { GameEvents } from './world/events.js';

export * from './instruments/index.js';
export * from './agents/views.js';
export * from './agents/credit.js';
export { promoteMember, demoteEntity, switchBank } from './agents/lod.js';

export * from './systems/index.js';
export * from './commands/index.js';

export { Engine, type EngineOptions, type TickReport } from './engine/engine.js';
export type { SimContext } from './engine/context.js';
export { save, load, migrations } from './engine/snapshot.js';

export * from './metrics/recorder.js';
export * from './metrics/regulatory.js';

export { buildWorld, scenarios, uk2025 } from './scenarios/index.js';
export type { ScenarioSpec } from './scenarios/types.js';
