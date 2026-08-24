import { ZERO, allocate, atLeastZero, min, scale, type Money } from '../core/money.js';
import { isMonthEnd, isYearEnd, toDate } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { closePeriod, incomeStatement } from '../ledger/statements.js';
import { personViews } from '../agents/views.js';
import { clearMarket, payBetween, spendable, type MarketLeg } from '../world/transfer.js';
import { entitiesOfKind, type WorldState } from '../world/state.js';
import { credit, debit, naturalBalance, ownerIds, post, type LedgerState } from '../ledger/ledger.js';
import { PHASE, defineSystem } from './system.js';

/**
 * Period end.
 *
 * Banks pay their running costs monthly. At the year end everyone pays tax on
 * their profit and closes the income statement into reserves, so the next year
 * starts from a clean P&L.
 */
export const accountingSystem = defineSystem({
  id: 'accounting.periods',
  phase: PHASE.ACCOUNTING,
  description: 'Operating costs, tax and period close',
  run(ctx) {
    const { world, ledger } = ctx;

    if (isMonthEnd(ctx.tick)) {
      depreciateFixedAssets(ctx);
      const people = personViews(world);
      const weights = people.map((h) => h.count);
      const payers: MarketLeg[] = [];
      const receipts = new Map<string, number>();

      for (const bank of entitiesOfKind(world, 'bank')) {
        const cost = bank.operatingCostPerMonth;
        if (cost <= 0) continue;
        // Running costs are somebody else's income.
        payers.push({ id: bank.id, amount: cost, contra: AC.OPERATING_EXPENSE });
        const shares = allocate(cost, weights);
        people.forEach((h, i) => {
          const share = shares[i] ?? ZERO;
          if (share > 0) receipts.set(h.id, (receipts.get(h.id) ?? 0) + share);
        });
      }

      if (payers.length > 0) {
        clearMarket(world, ledger, {
          tick: ctx.tick,
          kind: 'bank.operatingCosts',
          description: 'Bank operating costs',
          payers,
          payees: [...receipts].map(([id, amount]) => ({
            id,
            amount: amount as Money,
            contra: AC.WAGE_INCOME,
          })),
        });
      }

      ctx.emit('sim.monthEnded', {
        tick: ctx.tick,
        month: toDate(ctx.tick).month,
        year: toDate(ctx.tick).year,
      });
    }

  },
});

/**
 * The annual close, run after the metrics for the year have been sampled.
 *
 * Ordering matters: closing the income statement zeroes every P&L account, so
 * a December snapshot taken afterwards would report a year of trading as nil.
 */
export const yearEndSystem = defineSystem({
  id: 'accounting.yearEnd',
  phase: PHASE.CLOSE,
  description: 'Tax, public spending and the annual close',
  run(ctx) {
    const { world, ledger } = ctx;
    if (!isYearEnd(ctx.tick)) return;

    const taxRate = world.config.corporationTaxRate;
    const dividends: MarketLeg[] = [];
    for (const ownerId of ownerIds(ledger)) {
      const entity = world.entities[ownerId];
      if (!entity) continue;
      if (entity.kind === 'centralBank' || entity.kind === 'government') continue;

      const pl = incomeStatement(ledger, ownerId);
      if (pl.profit > 0 && taxRate > 0) {
        const tax = scale(pl.profit, taxRate);
        payBetween(world, ledger, {
          tick: ctx.tick,
          kind: 'tax.corporation',
          description: `Corporation tax from ${ownerId}`,
          amount: tax,
          fromId: ownerId,
          fromContra: AC.TAX,
          toId: world.governmentId,
          toContra: AC.REVENUE,
        });
      }

      const profit = closePeriod(ledger, ownerId, ctx.tick);
      if (entity.kind === 'bank') {
        ctx.emit('bank.periodClosed', { bankId: ownerId, profit });
      }

      const dividend = dividendFrom(world, ledger, entity, profit);
      if (dividend > 0) {
        dividends.push({ id: ownerId, amount: dividend, contra: AC.RETAINED_EARNINGS });
      }
    }

    const paid = payDividends(ctx, dividends);
    if (paid > 0) {
      ctx.emit('dividends.paid', { tick: ctx.tick, total: paid, payers: dividends.length });
    }

    spendPublicMoney(ctx);
    closePeriod(ledger, world.governmentId, ctx.tick);
    closePeriod(ledger, world.centralBankId, ctx.tick);
    ctx.emit('sim.yearEnded', { tick: ctx.tick, year: toDate(ctx.tick).year });
  },
});

/**
 * What one firm or bank hands to its owners out of the year just closed.
 *
 * Three limits, and all three are real ones. A loss pays nothing. A company
 * cannot distribute more than it has in reserves -- accumulated losses have
 * to be made good before anybody is paid again, which is what stops a bank
 * that is spending its way through its equity from also paying a dividend on
 * a good year. And a dividend is cash, so it cannot exceed the cash there is.
 *
 * Households and the state own things; they do not pay dividends themselves.
 */
export function dividendFrom(
  world: WorldState,
  ledger: LedgerState,
  entity: { id: string; kind: string; memberKind?: string },
  profit: Money,
): Money {
  if (profit <= 0) return ZERO;
  const distributes =
    entity.kind === 'bank' ||
    entity.kind === 'company' ||
    (entity.kind === 'cohort' && entity.memberKind === 'company');
  if (!distributes) return ZERO;

  const ratio =
    entity.kind === 'bank' ? world.config.bankDividendPayout : world.config.firmDividendPayout;
  if (ratio <= 0) return ZERO;

  const reserves = atLeastZero(naturalBalance(ledger, entity.id, AC.RETAINED_EARNINGS));
  return min(min(scale(profit, ratio), reserves), spendable(world, ledger, entity.id));
}

/**
 * Profit going back to the people who own the firms.
 *
 * Split by headcount, the same way bank running costs and public spending
 * are. Dividend income in the real economy is concentrated in wealth rather
 * than spread by head, and weighting it that way is a change worth making --
 * but it is a change to who gets richer, not to whether profit returns at
 * all, and those are two different questions.
 */
function payDividends(
  ctx: { tick: number; ledger: LedgerState; world: WorldState },
  payers: MarketLeg[],
): Money {
  const total = payers.reduce((t, leg) => (t + leg.amount) as Money, ZERO);
  if (total <= 0) return ZERO;

  const people = personViews(ctx.world);
  const shares = allocate(total, people.map((h) => h.count));
  const payees: MarketLeg[] = [];
  people.forEach((h, i) => {
    const share = shares[i] ?? ZERO;
    if (share > 0) payees.push({ id: h.id, amount: share, contra: AC.DIVIDEND_INCOME });
  });
  if (payees.length === 0) return ZERO;

  clearMarket(ctx.world, ctx.ledger, {
    tick: ctx.tick,
    kind: 'equity.dividends',
    description: 'Dividends',
    payers,
    payees,
  });
  return total;
}

/**
 * The state spends what it collects.
 *
 * Tax that is taken out of the circular flow and never returned is a slow
 * drain on demand, so the government runs a balanced budget and pays the year's
 * receipts straight back out as public pay and transfers. A proper fiscal
 * model -- deficits, gilt issuance to fund them, spending choices -- belongs
 * here later.
 */
function spendPublicMoney(ctx: {
  tick: number;
  ledger: LedgerState;
  world: import('../world/state.js').WorldState;
}): void {
  const { world, ledger } = ctx;
  const receipts = spendable(world, ledger, world.governmentId);
  if (receipts <= 0) return;

  const people = personViews(world);
  const weights = people.map((h) => h.count);
  const shares = allocate(receipts, weights);
  const payees: MarketLeg[] = [];
  people.forEach((h, i) => {
    const share = shares[i] ?? ZERO;
    if (share > 0) payees.push({ id: h.id, amount: share, contra: AC.WAGE_INCOME });
  });
  if (payees.length === 0) return;

  clearMarket(world, ledger, {
    tick: ctx.tick,
    kind: 'gov.spending',
    description: 'Public spending',
    payers: [{ id: world.governmentId, amount: receipts, contra: AC.OPERATING_EXPENSE }],
    payees,
  });
}

/**
 * Capital wears out. Without this, investment spending would inflate firms'
 * balance sheets for ever and the economy would look far richer than it is.
 */
function depreciateFixedAssets(ctx: { tick: number; ledger: LedgerState; world: import('../world/state.js').WorldState }): void {
  for (const ownerId of ownerIds(ctx.ledger)) {
    const assets = naturalBalance(ctx.ledger, ownerId, AC.FIXED_ASSETS);
    if (assets <= 0) continue;
    const charge = scale(assets, ctx.world.config.depreciationPerMonth);
    if (charge <= 0) continue;
    post(ctx.ledger, {
      tick: ctx.tick,
      kind: 'accounting.depreciation',
      description: `Depreciation for ${ownerId}`,
      postings: [debit(ownerId, AC.DEPRECIATION, charge), credit(ownerId, AC.FIXED_ASSETS, charge)],
    });
  }
}

export const NO_TAX: Money = ZERO;
