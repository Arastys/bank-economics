import type { Result } from '../core/result.js';
import { Registry } from '../core/registry.js';
import type { SimContext } from '../engine/context.js';

/**
 * Player actions are data, not method calls.
 *
 * Everything the player can do arrives as one of these, is validated, and is
 * applied at a defined point in the tick. That single boundary is what later
 * gives replays, undo, scripted tutorials, AI-run rival banks and multiplayer
 * without reworking anything.
 */
export interface Command {
  type: string;
}

export interface CommandHandler<C extends Command = Command> {
  type: string;
  label: string;
  /** Checked before the command is queued, and again before it is applied. */
  validate(ctx: SimContext, command: C): Result;
  apply(ctx: SimContext, command: C): void;
}

export const commands = new Registry<CommandHandler<never>>('Command');

export function defineCommand<C extends Command>(handler: CommandHandler<C>): CommandHandler<C> {
  commands.register(handler.type, handler as unknown as CommandHandler<never>);
  return handler;
}

export function handlerFor(type: string): CommandHandler<never> {
  return commands.get(type);
}
