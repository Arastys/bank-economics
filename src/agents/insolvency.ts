import { ZERO, min, scale, sub, type Money } from '../core/money.js';
import type { Day } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { credit, debit, naturalBalance, post, type LedgerState, type Posting } from '../ledger/ledger.js';
import { getInstrument, owedBy, type WorldState } from '../world/state.js';
import { paymentPostings, spendable } from '../world/transfer.js';
import type { EntityId } from '../world/types.js';

/**
 * Wind up a failing firm.
 *
 * Its stock and equipment are sold to the pool of firms it came from -- the
 * rest of its sector -- at a forced-sale discount. This matters more than it
 * looks: without it a bust firm has only its bank balance to hand over, which
 * is usually nothing, so every default is a total loss and no loan book can
 * ever be profitable. Recoveries in real insolvencies come from assets.
 */
export function liquidateAssets(
  world: WorldState,
  ledger: LedgerState,
  tick: Day,
  companyId: EntityId,
): Money {
  const company = world.entities[companyId];
  if (!company || company.kind !== 'company') return ZERO;
  const buyerId = company.originCohortId;
  const buyer = buyerId ? world.entities[buyerId] : undefined;
  if (!buyer || buyer.kind !== 'cohort') return ZERO;

  let budget = spendable(world, ledger, buyerId!);
  let raised: Money = ZERO;
  const postings: Posting[] = [];

  for (const code of [AC.INVENTORY, AC.FIXED_ASSETS]) {
    const book = naturalBalance(ledger, companyId, code);
    if (book <= 0) continue;

    const asking = scale(book, 1 - world.config.liquidationHaircut);
    const proceeds = min(asking, budget);
    if (proceeds > 0) {
      postings.push(
        ...paymentPostings(world, {
          amount: proceeds,
          fromId: buyerId!,
          fromContra: code,
          toId: companyId,
          toContra: code,
        }),
      );
      budget = sub(budget, proceeds);
      raised = (raised + proceeds) as Money;
    }

    // Whatever the sale did not cover leaves the books as a write-down.
    const writtenOff = sub(book, proceeds);
    if (writtenOff > 0) {
      postings.push(debit(companyId, AC.OPERATING_EXPENSE, writtenOff));
      postings.push(credit(companyId, code, writtenOff));
    }
  }

  if (postings.length === 0) return ZERO;

  // The stock changes hands physically as well as financially.
  if (company.inventoryUnits > 0) {
    buyer.pool.inventoryUnits = (buyer.pool.inventoryUnits ?? 0) + company.inventoryUnits;
    company.inventoryUnits = 0;
  }

  post(ledger, {
    tick,
    kind: 'insolvency.liquidation',
    description: `Assets of ${companyId} sold into ${buyerId}`,
    refs: { companyId, buyerId: buyerId! },
    postings,
  });
  return raised;
}

/** Every loan the entity still owes. */
export function activeLoansOf(world: WorldState, obligorId: EntityId): string[] {
  return owedBy(world, obligorId)
    .filter((inst) => inst.status === 'active' && inst.type.startsWith('loan.'))
    .map((inst) => inst.id);
}

export function isStillActive(world: WorldState, instrumentId: string): boolean {
  try {
    return getInstrument(world, instrumentId).status === 'active';
  } catch {
    return false;
  }
}
