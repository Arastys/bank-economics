import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { pounds } from '../src/core/money.js';
import { playerBank } from '../src/world/state.js';

describe('commands', () => {
  it('rejects a deposit rate outside sane bounds', () => {
    const engine = newGame('uk2025');
    expect(engine.enqueue({ type: 'bank.setDepositRate', rate: -0.01 }).ok).toBe(false);
    expect(engine.enqueue({ type: 'bank.setDepositRate', rate: 0.9 }).ok).toBe(false);
    expect(engine.enqueue({ type: 'bank.setDepositRate', rate: 0.035 }).ok).toBe(true);
  });

  it('rejects an unknown command', () => {
    const engine = newGame('uk2025');
    const result = engine.enqueue({ type: 'bank.nonsense' } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown command/i);
  });

  it('applies a queued command on the next tick, not before', () => {
    const engine = newGame('uk2025');
    engine.enqueue({ type: 'bank.setDepositRate', rate: 0.045 });
    expect(playerBank(engine.world).policy.depositRate).not.toBe(0.045);
    engine.tick();
    expect(playerBank(engine.world).policy.depositRate).toBe(0.045);
  });

  it('changes credit policy', () => {
    const engine = newGame('uk2025');
    engine.enqueue({
      type: 'bank.setCreditPolicy',
      minimumGrade: 'BBB',
      maxSingleExposure: pounds(1_000_000),
      autoUnderwrite: false,
    });
    engine.tick();
    const policy = playerBank(engine.world).policy;
    expect(policy.minimumGrade).toBe('BBB');
    expect(policy.maxSingleExposure).toBe(pounds(1_000_000));
    expect(policy.autoUnderwrite).toBe(false);
  });

  it('leaves applications on the desk when underwriting is manual', () => {
    const engine = newGame('uk2025');
    engine.enqueue({ type: 'bank.setCreditPolicy', autoUnderwrite: false });
    engine.run(30);
    const pending = Object.values(engine.world.applications).filter((a) => a.status === 'pending');
    expect(pending.length).toBeGreaterThan(0);
  });

  it('lets the player approve an application by hand', () => {
    const engine = newGame('uk2025');
    engine.enqueue({ type: 'bank.setCreditPolicy', autoUnderwrite: false });
    engine.run(20);

    const application = Object.values(engine.world.applications).find((a) => a.status === 'pending')!;
    expect(engine.enqueue({ type: 'credit.approve', applicationId: application.id }).ok).toBe(true);
    engine.tick();

    expect(engine.world.applications[application.id]!.status).toBe('approved');
    const loan = Object.values(engine.world.instruments).find(
      (inst) => inst.obligorId === application.applicantId && inst.holderId === engine.world.playerBankId,
    );
    expect(loan).toBeDefined();
  });

  it('lets the player decline an application, with a reason', () => {
    const engine = newGame('uk2025');
    engine.enqueue({ type: 'bank.setCreditPolicy', autoUnderwrite: false });
    engine.run(20);

    const application = Object.values(engine.world.applications).find((a) => a.status === 'pending')!;
    engine.enqueue({ type: 'credit.decline', applicationId: application.id, reason: 'Sector concentration' });
    engine.tick();

    const decided = engine.world.applications[application.id]!;
    expect(decided.status).toBe('declined');
    expect(decided.decisionReason).toBe('Sector concentration');
  });

  it('refuses to decide the same application twice', () => {
    const engine = newGame('uk2025');
    engine.enqueue({ type: 'bank.setCreditPolicy', autoUnderwrite: false });
    engine.run(20);

    const application = Object.values(engine.world.applications).find((a) => a.status === 'pending')!;
    engine.enqueue({ type: 'credit.decline', applicationId: application.id });
    engine.tick();
    expect(engine.enqueue({ type: 'credit.decline', applicationId: application.id }).ok).toBe(false);
  });

  it('will not sell a bond the bank does not hold', () => {
    const engine = newGame('uk2025');
    const foreign = Object.values(engine.world.instruments).find(
      (inst) => inst.type.startsWith('bond.') && inst.holderId !== engine.world.playerBankId,
    )!;
    expect(engine.enqueue({ type: 'bond.sell', bondId: foreign.id }).ok).toBe(false);
  });

  it('sells a gilt the bank does hold', () => {
    const engine = newGame('uk2025');
    const own = Object.values(engine.world.instruments).find(
      (inst) => inst.type.startsWith('bond.') && inst.holderId === engine.world.playerBankId,
    )!;
    expect(engine.enqueue({ type: 'bond.sell', bondId: own.id }).ok).toBe(true);
    engine.tick();
    expect(engine.world.instruments[own.id]!.holderId).toBe(engine.world.otherBanksId);
  });

  it('will not issue the bank own paper below the market rate', () => {
    const engine = newGame('uk2025');
    engine.run(2);
    expect(
      engine.enqueue({ type: 'bond.issueOwn', amount: pounds(10_000_000), couponRate: 0.001, termYears: 5 }).ok,
    ).toBe(false);
    expect(
      engine.enqueue({ type: 'bond.issueOwn', amount: pounds(10_000_000), couponRate: 0.08, termYears: 5 }).ok,
    ).toBe(true);
  });
});
