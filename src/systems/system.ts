import { Registry } from '../core/registry.js';
import type { SimContext } from '../engine/context.js';

/**
 * Systems run in phase order every tick. Phases are spaced out so a new
 * system can be slotted between two existing ones without renumbering.
 */
export const PHASE = {
  COMMANDS: 0,
  POLICY: 100,
  MARKETS: 200,
  PRODUCTION: 300,
  GOODS_MARKET: 350,
  FIRM_DECISIONS: 400,
  CREDIT_DEMAND: 450,
  UNDERWRITING: 500,
  INSTRUMENTS: 600,
  CREDIT_RISK: 700,
  TREASURY: 800,
  LOD: 850,
  ACCOUNTING: 900,
  DEMOGRAPHY: 920,
  FIRM_DEMOGRAPHY: 930,
  METRICS: 950,
  CLOSE: 980,
} as const;

export interface System {
  id: string;
  phase: number;
  description?: string;
  run(ctx: SimContext): void;
}

export const systems = new Registry<System>('System');

export function defineSystem(system: System): System {
  systems.register(system.id, system);
  return system;
}

/** Systems in the order they run. Ties break on id so ordering is stable. */
export function orderedSystems(): System[] {
  return systems.values().sort((a, b) => a.phase - b.phase || a.id.localeCompare(b.id));
}
