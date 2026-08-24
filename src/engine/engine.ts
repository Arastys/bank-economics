import { EventBus, type EmittedEvent } from '../core/events.js';
import { streamRng, type Rng } from '../core/rng.js';
import { isOk, type Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import type { Day } from '../core/time.js';
import { trialBalance } from '../ledger/ledger.js';
import { registerBuiltinInstruments } from '../instruments/index.js';
import { handlerFor, type Command, type GameCommand } from '../commands/index.js';
import { orderedSystems } from '../systems/index.js';
import type { GameEvents } from '../world/events.js';
import type { WorldState } from '../world/state.js';
import type { SimContext } from './context.js';

export interface TickReport {
  tick: Day;
  events: EmittedEvent[];
  /** Commands that failed revalidation at the moment they were applied. */
  rejected: { command: Command; error: string }[];
}

export interface EngineOptions {
  /**
   * Check that the books balance after every tick. Cheap enough to leave on;
   * it turns an accounting mistake into an immediate, located failure rather
   * than a slow drift nobody notices for an hour.
   */
  checkInvariants?: boolean;
  /** How many recent events to keep for the activity feed. */
  activityLimit?: number;
}

export class LedgerImbalanceError extends Error {
  constructor(public readonly tick: Day, public readonly residual: number) {
    super(`Ledger does not balance after tick ${tick}: residual ${residual}p`);
    this.name = 'LedgerImbalanceError';
  }
}

/**
 * Runs the world forward.
 *
 * One tick is one day: apply whatever the player asked for, run every system
 * in phase order, then check the books still balance.
 */
export class Engine {
  readonly bus = new EventBus<GameEvents>();
  private queue: Command[] = [];
  private activity: EmittedEvent[] = [];
  private readonly options: Required<EngineOptions>;

  constructor(public readonly world: WorldState, options: EngineOptions = {}) {
    registerBuiltinInstruments();
    this.options = {
      checkInvariants: options.checkInvariants ?? true,
      activityLimit: options.activityLimit ?? 200,
    };
  }

  context(): SimContext {
    const world = this.world;
    const bus = this.bus;
    return {
      tick: world.tick,
      world,
      ledger: world.ledger,
      bus,
      emit: (type, payload) => bus.emit(type, payload),
      rng: (stream: string): Rng => streamRng(world.seed, stream, world.tick),
    };
  }

  /** Validate and queue a player action for the next tick. */
  enqueue(command: GameCommand): Result {
    const handler = tryHandler(command.type);
    if (!handler) return err(`Unknown command "${command.type}"`);
    const check = handler.validate(this.context(), command as never);
    if (!check.ok) return check;
    this.queue.push(command);
    return ok();
  }

  /** Queue length, for a UI that wants to show pending orders. */
  get pending(): number {
    return this.queue.length;
  }

  tick(): TickReport {
    const world = this.world;
    world.tick += 1;
    this.bus.beginTick(world.tick);
    const ctx = this.context();
    this.bus.emit('sim.tickStarted', { tick: world.tick });

    const rejected = this.applyCommands(ctx);
    for (const system of orderedSystems()) system.run(ctx);

    this.bus.emit('sim.tickEnded', { tick: world.tick });
    const events = this.bus.drainJournal();
    this.remember(events);

    if (this.options.checkInvariants) {
      const residual = trialBalance(world.ledger);
      if (residual !== 0) throw new LedgerImbalanceError(world.tick, residual);
    }

    return { tick: world.tick, events, rejected };
  }

  /** Advance several days. Returns the report for the final tick. */
  run(days: number): TickReport {
    let report: TickReport = { tick: this.world.tick, events: [], rejected: [] };
    for (let i = 0; i < days; i++) report = this.tick();
    return report;
  }

  /** The most recent events, newest last. */
  recentActivity(limit = 50): EmittedEvent[] {
    return this.activity.slice(-limit);
  }

  private applyCommands(ctx: SimContext): { command: Command; error: string }[] {
    const rejected: { command: Command; error: string }[] = [];
    const queued = this.queue;
    this.queue = [];
    for (const command of queued) {
      const handler = tryHandler(command.type);
      if (!handler) {
        rejected.push({ command, error: `Unknown command "${command.type}"` });
        continue;
      }
      // Revalidate: the world has moved on since the command was queued.
      const check = handler.validate(ctx, command as never);
      if (!isOk(check)) {
        rejected.push({ command, error: String(check.error) });
        continue;
      }
      handler.apply(ctx, command as never);
    }
    return rejected;
  }

  private remember(events: EmittedEvent[]): void {
    for (const event of events) {
      if (event.type === 'sim.tickStarted' || event.type === 'sim.tickEnded') continue;
      this.activity.push(event);
    }
    if (this.activity.length > this.options.activityLimit) {
      this.activity.splice(0, this.activity.length - this.options.activityLimit);
    }
  }
}

function tryHandler(type: string) {
  try {
    return handlerFor(type);
  } catch {
    return undefined;
  }
}
