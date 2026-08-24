import { describe, expect, it } from 'vitest';
import { newGame } from '../src/index.js';
import { AC, depositCode, isDepositCode } from '../src/ledger/accounts.js';
import { accountsOf, entityTrialBalance, naturalBalance, ownerIds, trialBalance } from '../src/ledger/ledger.js';
import { load, save } from '../src/engine/snapshot.js';
import { Engine } from '../src/engine/engine.js';
import { entitiesOfKind, heldBy, type WorldState } from '../src/world/state.js';
import { hashString } from '../src/core/rng.js';

/** A cheap fingerprint of the whole world, for comparing runs. */
function digest(world: WorldState): string {
  return `${hashString(JSON.stringify(world))}:${JSON.stringify(world).length}`;
}

describe('simulation invariants', () => {
  it('keeps the books balanced over a long run', () => {
    const engine = newGame('uk2025');
    engine.run(400);
    expect(trialBalance(engine.world.ledger)).toBe(0);
  });

  it('keeps every entity individually balanced', () => {
    const engine = newGame('uk2025');
    engine.run(200);
    const offenders = ownerIds(engine.world.ledger)
      .map((id) => ({ id, residual: entityTrialBalance(engine.world.ledger, id) }))
      .filter((row) => row.residual !== 0);
    expect(offenders).toEqual([]);
  });

  it('reconciles the player bank loan book against its contracts', () => {
    const engine = newGame('uk2025');
    engine.run(200);
    const { world } = engine;
    const fromContracts = heldBy(world, world.playerBankId)
      .filter((inst) => inst.status === 'active' && inst.type.startsWith('loan.'))
      .reduce((total, inst) => total + inst.outstanding, 0);
    expect(naturalBalance(world.ledger, world.playerBankId, AC.LOANS)).toBe(fromContracts);
  });

  it('reconciles each bank deposit liability against its customers balances', () => {
    const engine = newGame('uk2025');
    engine.run(200);
    const { world, world: { ledger } } = engine;

    for (const bank of entitiesOfKind(world, 'bank')) {
      let customerHoldings = 0;
      for (const ownerId of ownerIds(ledger)) {
        if (ownerId === bank.id) continue;
        for (const account of accountsOf(ledger, ownerId)) {
          if (isDepositCode(account.code) && account.code.endsWith(`@${bank.id}`)) {
            customerHoldings += account.balance;
          }
        }
      }
      expect(naturalBalance(ledger, bank.id, AC.CUSTOMER_DEPOSITS)).toBe(customerHoldings);
    }
  });

  it('backs every reserve with a central bank liability', () => {
    const engine = newGame('uk2025');
    engine.run(200);
    const { world, world: { ledger } } = engine;

    let heldReserves = 0;
    for (const ownerId of ownerIds(ledger)) {
      if (ownerId === world.centralBankId) continue;
      heldReserves += naturalBalance(ledger, ownerId, AC.RESERVES);
    }
    expect(naturalBalance(ledger, world.centralBankId, AC.RESERVES_ISSUED)).toBe(heldReserves);
  });
});

describe('determinism', () => {
  it('produces identical worlds from identical seeds', () => {
    const a = newGame('uk2025', { seed: 4242 });
    const b = newGame('uk2025', { seed: 4242 });
    a.run(120);
    b.run(120);
    expect(digest(a.world)).toBe(digest(b.world));
  });

  it('produces different worlds from different seeds', () => {
    const a = newGame('uk2025', { seed: 1 });
    const b = newGame('uk2025', { seed: 2 });
    a.run(120);
    b.run(120);
    expect(a.world.economy.priceIndex).not.toBe(b.world.economy.priceIndex);
  });

  it('resumes a saved game exactly where it left off', () => {
    const original = newGame('uk2025', { seed: 77 });
    original.run(100);
    const snapshot = save(original.world);

    const resumed = new Engine(load(snapshot));
    original.run(60);
    resumed.run(60);

    expect(resumed.world.tick).toBe(original.world.tick);
    expect(resumed.world.economy.priceIndex).toBe(original.world.economy.priceIndex);
    expect(naturalBalance(resumed.world.ledger, resumed.world.playerBankId, AC.LOANS)).toBe(
      naturalBalance(original.world.ledger, original.world.playerBankId, AC.LOANS),
    );
  });

  /**
   * The journal is a log of what happened, not part of what is. Nothing reads
   * it back, so carrying it in every save was 40% of the file for no benefit.
   */
  it('leaves the audit log out of the save file', () => {
    const engine = newGame('uk2025', { checkInvariantsEvery: 30 });
    engine.run(200);
    expect(engine.world.ledger.journal.length).toBeGreaterThan(0);

    const blob = save(engine.world);
    const parsed = JSON.parse(blob) as { world: { ledger: { journal: unknown[] } } };
    expect(parsed.world.ledger.journal).toEqual([]);
    expect(blob.length).toBeLessThan(JSON.stringify(engine.world).length);
  });

  it('restores a usable ledger even though the log was dropped', () => {
    const engine = newGame('uk2025', { checkInvariantsEvery: 30 });
    engine.run(120);

    const resumed = new Engine(load(save(engine.world)), { checkInvariantsEvery: 1 });
    expect(resumed.world.ledger.journal).toEqual([]);

    resumed.run(30);
    expect(resumed.world.ledger.journal.length).toBeGreaterThan(0);
    expect(trialBalance(resumed.world.ledger)).toBe(0);
  });

  it('keeps the audit log bounded over a long game', () => {
    const engine = newGame('uk2025', { checkInvariantsEvery: 30 });
    engine.run(600);
    const { journal, journalCap } = engine.world.ledger;
    expect(journal.length).toBeLessThan(journalCap * 2);
  });

  it('rejects a save from an unknown version', () => {
    expect(() => load(JSON.stringify({ version: 99, world: {} }))).toThrow(/newer version/);
    expect(() => load('{}')).toThrow(/not a valid save file/i);
  });
});

describe('the bank stays a bank', () => {
  it('lends, takes deposits and holds gilts', () => {
    const engine = newGame('uk2025');
    engine.run(180);
    const { world, world: { ledger } } = engine;
    const bank = world.playerBankId;

    expect(naturalBalance(ledger, bank, AC.LOANS)).toBeGreaterThan(0);
    expect(naturalBalance(ledger, bank, AC.CUSTOMER_DEPOSITS)).toBeGreaterThan(0);
    expect(naturalBalance(ledger, bank, AC.BONDS)).toBeGreaterThan(0);
    expect(naturalBalance(ledger, bank, AC.INTEREST_INCOME)).toBeGreaterThan(0);
  });

  it('writes new loans that did not exist at the start', () => {
    const engine = newGame('uk2025');
    const before = heldBy(engine.world, engine.world.playerBankId).length;
    engine.run(120);
    const after = heldBy(engine.world, engine.world.playerBankId).length;
    expect(after).toBeGreaterThan(before);
  });
});
