import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { firmViews, personViews } from '../src/agents/views.js';
import type { WorldState } from '../src/world/state.js';

const inWork = (world: WorldState) => personViews(world).reduce((t, p) => t + p.employed, 0);
const workingAge = (world: WorldState) => personViews(world).reduce((t, p) => t + p.workingAge, 0);

/**
 * The defect this exists to prevent: `pool.employed` was set once when the
 * scenario was built and only ever moved when somebody was materialised out of
 * a pool. Firms hired and fired for twenty simulated years and not one person
 * changed employment status. Wages were shared out by a fixed set of weights,
 * and a pool deciding what to spend could not tell a boom from a slump.
 */
describe('the people holding the jobs are the people doing them', () => {
  it('matches the jobs the firms are actually providing', () => {
    const engine = newGame('uk2025');
    engine.run(200);
    expect(inWork(engine.world)).toBeCloseTo(engine.world.economy.employed, 0);
  }, 60_000);

  it('moves when firms shed staff', () => {
    const engine = newGame('uk2025');
    engine.run(200);
    const before = inWork(engine.world);

    // Halve the firm sector's headcount and let a business day settle it.
    for (const firm of firmViews(engine.world)) firm.employees = firm.employees / 2;
    engine.run(7);

    expect(inWork(engine.world)).toBeLessThan(before * 0.75);
  }, 60_000);

  it('never has more people in work than there are adults of working age', () => {
    const engine = newGame('uk2025');
    // Far more jobs than there are people to fill them.
    for (const firm of firmViews(engine.world)) firm.employees = firm.employees * 10;
    engine.run(7);
    expect(inWork(engine.world)).toBeLessThanOrEqual(workingAge(engine.world) + 1);
  }, 60_000);

  it('empties the workforce when the firm sector has no jobs left', () => {
    const engine = newGame('uk2025');
    engine.run(30);
    const before = inWork(engine.world);
    for (const firm of firmViews(engine.world)) firm.employees = 0;
    engine.run(7);
    // Not zero: a week of credit applications materialises a few firms out of
    // the pools, and each arrives with staff.
    expect(inWork(engine.world)).toBeLessThan(before * 0.01);
  }, 60_000);

  /**
   * The point of fixing it: a pool's spending decision splits its members into
   * those drawing a wage and those drawing nothing, so that split has to be
   * something the economy can move.
   */
  it('leaves a downturn visible to the people budgeting through it', () => {
    const engine = newGame('uk2025');
    engine.run(200);
    const employedShare = () => inWork(engine.world) / workingAge(engine.world);
    const before = employedShare();
    for (const firm of firmViews(engine.world)) firm.employees = firm.employees * 0.6;
    engine.run(7);
    expect(employedShare()).toBeLessThan(before - 0.1);
  }, 60_000);
});
