/** Messages between the page and the simulation worker. */
import type { GameCommand } from '../src/commands/index.js';
import type { DashboardSnapshot } from './snapshot.js';

export type ToWorker =
  | { type: 'setSpeed'; daysPerSecond: number }
  | { type: 'command'; command: GameCommand };

export type FromWorker =
  | { type: 'snapshot'; snapshot: DashboardSnapshot }
  | { type: 'rejected'; reason: string };
