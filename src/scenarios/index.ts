import { Registry } from '../core/registry.js';
import { uk2025 } from './uk2025.js';
import type { ScenarioSpec } from './types.js';

export const scenarios = new Registry<ScenarioSpec>('Scenario');
scenarios.register(uk2025.id, uk2025);

export { buildWorld } from './build.js';
export * from './types.js';
export { uk2025 };
