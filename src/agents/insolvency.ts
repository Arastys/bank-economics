import { ZERO, add, min, scale, sub, type Money } from '../core/money.js';
import type { Day } from '../core/time.js';
import { AC, type AccountCode } from '../ledger/accounts.js';
import { credit, debit, naturalBalance, post, type LedgerState, type Posting } from '../ledger/ledger.js';
import { balanceSheet } from '../ledger/statements.js';
import { getInstrument, owedBy, type WorldState } from '../world/state.js';
import { paymentPostings, spendable } from '../world/transfer.js';
import type { EntityId } from '../world/types.js';

/**
 * Is the firm actually finished, or just short of cash today?
 *
 * The distinction is the whole point. A business can miss a payment because
 * its money is tied up in stock and still be worth more than it owes; that is
 * illiquidity, and it ends in a forced sale, not a funeral. Insolvency is when
 * the assets genuinely do not cover the debts.
 */
export function isInsolvent(ledger: LedgerState, companyId: EntityId): boolean {
  return balanceSheet(ledger, companyId).totalEquity <= 0;
}

export interface SaleOptions {
  /** Stop once this much has been raised. Omit to sell everything. */
  target?: Money;
  /** Whether assets left unsold are written off the books entirely. */
  writeOffRemainder: boolean;
  /** Share of book value lost in the sale. */
  haircut: number;
}

/**
 * Sell a firm's assets to the pool of firms it came from -- the rest of its
 * sector -- at a forced-sale discount.
 *
 * This matters more than it looks. Without it a bust firm has only its bank
 * balance to hand over, which is usually nothing, so every default is a total
 * loss and no loan book can ever be profitable. Recoveries in real insolvencies
 * come from assets.
 */
export function sellAssets(
  world: WorldState,
  ledger: LedgerState,
  tick: Day,
  companyId: EntityId,
  options: SaleOptions,
): Money {
  const company = world.entities[companyId];
  if (!company || company.kind !== 'company') return ZERO;
  const buyerId = company.originCohortId;
  const buyer = buyerId ? world.entities[buyerId] : undefined;
  if (!buyer || buyer.kind !== 'cohort') return ZERO;

  let budget = spendable(world, ledger, buyerId!);
  let raised: Money = ZERO;
  let inventorySold = 0;
  const postings: Posting[] = [];

  // Fixed assets go first in a work-out: a firm that still has a future needs
  // its stock to trade out of trouble. In a wind-up the order stops mattering.
  for (const code of [AC.FIXED_ASSETS, AC.INVENTORY] as AccountCode[]) {
    const book = naturalBalance(ledger, companyId, code);
    if (book <= 0) continue;

    const stillNeeded = options.target === undefined ? book : sub(options.target, raised);
    if (options.target !== undefined && stillNeeded <= 0) break;

    // Work back from what the lender needs to how much book value to sell.
    const bookToSell =
      options.target === undefined ? book : min(book, scale(stillNeeded, 1 / (1 - options.haircut)));
    const asking = scale(bookToSell, 1 - options.haircut);
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
      raised = add(raised, proceeds);
      if (code === AC.INVENTORY && book > 0) {
        inventorySold += company.inventoryUnits * (bookToSell / book);
      }
    }

    if (options.writeOffRemainder) {
      // Whatever the sale did not cover leaves the books as a write-down.
      const writtenOff = sub(book, proceeds);
      if (writtenOff > 0) {
        postings.push(debit(companyId, AC.OPERATING_EXPENSE, writtenOff));
        postings.push(credit(companyId, code, writtenOff));
        if (code === AC.INVENTORY) inventorySold = company.inventoryUnits;
      }
    }
  }

  if (postings.length === 0) return ZERO;

  // The stock changes hands physically as well as financially.
  const unitsMoved = Math.min(company.inventoryUnits, inventorySold);
  if (unitsMoved > 0) {
    buyer.pool.inventoryUnits = (buyer.pool.inventoryUnits ?? 0) + unitsMoved;
    company.inventoryUnits -= unitsMoved;
  }

  post(ledger, {
    tick,
    kind: options.writeOffRemainder ? 'insolvency.liquidation' : 'insolvency.assetSale',
    description: `Assets of ${companyId} sold into ${buyerId}`,
    refs: { companyId, buyerId: buyerId! },
    postings,
  });
  return raised;
}

/** Wind a firm up: everything goes, and what will not sell is written off. */
export function liquidateAssets(
  world: WorldState,
  ledger: LedgerState,
  tick: Day,
  companyId: EntityId,
  haircut = world.config.liquidationHaircut,
): Money {
  return sellAssets(world, ledger, tick, companyId, { writeOffRemainder: true, haircut });
}

/**
 * Raise cash without winding the firm up, by selling only as much as the
 * lender is owed. The firm keeps trading with a smaller balance sheet.
 */
export function raiseCash(
  world: WorldState,
  ledger: LedgerState,
  tick: Day,
  companyId: EntityId,
  needed: Money,
  haircut = world.config.liquidationHaircut,
): Money {
  if (needed <= 0) return ZERO;
  return sellAssets(world, ledger, tick, companyId, { target: needed, writeOffRemainder: false, haircut });
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
