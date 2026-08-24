import { ZERO, add, allocate, atLeastZero, min, round, scale, type Money } from '../core/money.js';
import { isBusinessDay } from '../core/time.js';
import { AC, type AccountCode } from '../ledger/accounts.js';
import { balance, credit, debit, post, type LedgerState } from '../ledger/ledger.js';
import { clearMarket, spendable, type MarketLeg } from '../world/transfer.js';
import type { SimConfig, WorldState } from '../world/state.js';
import { firmViews, householdViews, type FirmView } from '../agents/views.js';
import { PHASE, defineSystem } from './system.js';

/** Five working days in seven. */
const BUSINESS_DAY_SHARE = 5 / 7;
/** History kept for year-on-year inflation. */
const PRICE_HISTORY = 400;

interface Buyer {
  id: string;
  budget: Money;
  /** What the buyer books the purchase against. */
  contra: AccountCode;
}

/**
 * The goods market.
 *
 * Two kinds of demand meet one pool of output: households spending wages and
 * savings, and firms reinvesting takings in capacity. The cheapest goods sell
 * first; firms that clear their shelves raise prices and firms left holding
 * stock cut them. That is where the price level -- and so inflation, and so
 * Bank Rate -- ultimately comes from.
 *
 * Investment demand matters more than it looks: without firms buying from each
 * other, wages are the only source of spending and no firm can be profitable
 * in aggregate, so the whole economy grinds down.
 */
export const goodsMarketSystem = defineSystem({
  id: 'economy.goodsMarket',
  phase: PHASE.GOODS_MARKET,
  description: 'Clears household and investment demand against firm output',
  run(ctx) {
    const { world, ledger, tick } = ctx;
    const firms = firmViews(world);
    const buyers = collectBuyers(ctx.world, ledger, firms);
    const budgets = buyers.map((b) => b.budget);
    const totalBudget = budgets.reduce((a, b) => add(a, b), ZERO);

    // Each firm puts out roughly what it expects to sell, not everything it
    // owns: judging prices against the whole warehouse would have every shop
    // marking down every day simply for holding stock.
    const offers = firms
      .filter((f) => f.inventoryUnits > 0 && f.price > 0 && f.expectedSales > 0)
      .map((firm) => ({
        firm,
        stock: firm.inventoryUnits,
        // At least what the firm makes in an average day: offering less than
        // that guarantees stock piles up no matter what demand does.
        offered: Math.min(
          firm.inventoryUnits,
          Math.max(
            firm.expectedSales / world.config.targetSellThrough,
            firm.employees * firm.productivity * BUSINESS_DAY_SHARE,
          ),
        ),
      }))
      .filter((o) => o.offered > 0);

    const wanted = shareDemand(offers, totalBudget, world.config.priceElasticity);

    let unitsSold = 0;
    let priceWeightedUnits = 0;
    let totalRevenue: Money = ZERO;
    const payees: MarketLeg[] = [];

    offers.forEach(({ firm, stock, offered }, index) => {
      const units = Math.min(offered, wanted[index] ?? 0);
      const revenue = round(units * firm.price);

      if (revenue > 0) {
        payees.push({ id: firm.id, amount: revenue, contra: AC.REVENUE });
        recogniseCostOfSales(ledger, tick, firm.id, units, stock);
        totalRevenue = add(totalRevenue, revenue);
      }

      firm.inventoryUnits = stock - units;
      firm.lastSoldUnits = units;
      firm.expectedSales = firm.expectedSales * 0.85 + units * 0.15;
      firm.recentRevenue = round(firm.recentRevenue * 0.8 + revenue * 0.2);
      unitsSold += units;
      priceWeightedUnits += units * firm.price;
      if (isBusinessDay(tick)) adjustPrice(firm, units, offered, stock, world.config);
    });

    if (totalRevenue > 0) {
      // Buyers fund the day's takings in proportion to their budgets. One
      // allocation across the whole market, rather than one per seller.
      const contributions = allocate(totalRevenue, budgets as number[]);
      const payers: MarketLeg[] = [];
      buyers.forEach((buyer, i) => {
        const amount = contributions[i] ?? ZERO;
        if (amount > 0) payers.push({ id: buyer.id, amount, contra: buyer.contra });
      });
      clearMarket(world, ledger, {
        tick,
        kind: 'economy.demand',
        description: 'Consumption and investment spending',
        payers,
        payees,
      });
    }

    // Income is spent once. Anything left over stays as savings rather than
    // being counted again tomorrow.
    for (const household of householdViews(world)) household.lastIncome = ZERO;

    const averagePrice = unitsSold > 0 ? priceWeightedUnits / unitsSold : world.economy.priceIndex;
    updatePriceLevel(world, averagePrice, averagePrice > 0 ? totalBudget / averagePrice : 0);
  },
});

/**
 * Split the day's spending across sellers.
 *
 * Buyers prefer cheaper firms, but not exclusively: each firm's pull is its
 * stock on offer weighted by how its price compares with the market. If the
 * budget cannot cover what everyone would like to sell, every firm is scaled
 * back by the same factor, and the cheap ones hit their stock limit first --
 * which is exactly the signal that tells them to put their prices up.
 */
function shareDemand(
  offers: { firm: FirmView; offered: number }[],
  budget: Money,
  elasticity: number,
): number[] {
  if (offers.length === 0 || budget <= 0) return offers.map(() => 0);

  let offeredUnits = 0;
  let offeredValue = 0;
  for (const { firm, offered } of offers) {
    offeredUnits += offered;
    offeredValue += offered * firm.price;
  }
  const averagePrice = offeredUnits > 0 ? offeredValue / offeredUnits : 0;
  if (averagePrice <= 0) return offers.map(() => 0);

  const desired = offers.map(({ firm, offered }) =>
    offered * Math.pow(averagePrice / firm.price, elasticity),
  );
  let desiredValue = 0;
  offers.forEach(({ firm }, i) => {
    desiredValue += (desired[i] ?? 0) * firm.price;
  });
  if (desiredValue <= 0) return offers.map(() => 0);

  const ratio = Math.min(1, budget / desiredValue);
  return desired.map((units) => units * ratio);
}

function collectBuyers(world: WorldState, ledger: LedgerState, firms: FirmView[]): Buyer[] {
  const buyers: Buyer[] = [];

  for (const household of householdViews(world)) {
    // Households budget from a smoothed income figure rather than from what
    // landed today. Otherwise spending collapses every weekend, firms see
    // wild swings in sell-through, and prices oscillate for no real reason.
    household.incomeRate = round(
      household.incomeRate * (1 - world.config.incomeSmoothing) +
        household.lastIncome * world.config.incomeSmoothing,
    );
    const savings = spendable(world, ledger, household.id);
    const wanted = round(
      household.propensityToConsume * household.incomeRate + world.config.dissavingRate * savings,
    );
    const budget = min(wanted, atLeastZero(savings));
    if (budget > 0) buyers.push({ id: household.id, budget, contra: AC.CONSUMPTION });
  }

  for (const firm of firms) {
    // Only firms with a month of wages in hand put money into capacity.
    const monthlyWages = scale((firm.employees * firm.wagePerEmployee) as Money, 21);
    const cash = spendable(world, ledger, firm.id);
    if (cash <= monthlyWages) continue;
    const budget = min(round(firm.recentRevenue * world.config.investmentRate), (cash - monthlyWages) as Money);
    if (budget > 0) buyers.push({ id: firm.id, budget, contra: AC.FIXED_ASSETS });
  }

  return buyers;
}

/**
 * Move the cost of the units sold out of inventory and into cost of sales, at
 * the average cost of the stock on hand.
 */
function recogniseCostOfSales(
  ledger: LedgerState,
  tick: number,
  firmId: string,
  unitsSold: number,
  unitsHeld: number,
): void {
  if (unitsHeld <= 0 || unitsSold <= 0) return;
  const stockValue = balance(ledger, firmId, AC.INVENTORY);
  if (stockValue <= 0) return;
  const cost = scale(stockValue, Math.min(1, unitsSold / unitsHeld));
  if (cost <= 0) return;
  post(ledger, {
    tick,
    kind: 'economy.costOfSales',
    description: `Cost of goods sold by ${firmId}`,
    postings: [debit(firmId, AC.COST_OF_SALES, cost), credit(firmId, AC.INVENTORY, cost)],
  });
}

/**
 * Prices respond to two things: whether today's stock cleared, and whether the
 * stockroom is filling up or emptying out. The first is the fast signal, the
 * second stops a firm holding a price that is quietly building a mountain of
 * unsold goods.
 */
function adjustPrice(
  firm: FirmView,
  sold: number,
  offered: number,
  stock: number,
  config: SimConfig,
): void {
  const sellThrough = offered > 0 ? sold / offered : 1;
  const demandGap = clampUnit((sellThrough - config.targetSellThrough) / config.targetSellThrough);

  // Days of stock is measured against what the firm sells, not what it makes.
  // Against output it would be self-reinforcing: cutting production raises the
  // ratio, which calls for cutting production again.
  const stockDays = firm.expectedSales > 0 ? stock / firm.expectedSales : config.targetStockDays;
  const stockGap = clampUnit((config.targetStockDays - stockDays) / config.targetStockDays);

  const move = config.demandPriceWeight * demandGap + (1 - config.demandPriceWeight) * stockGap;
  firm.price = Math.max(1, Math.round(firm.price * (1 + config.priceAdjustment * move))) as Money;
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function updatePriceLevel(world: WorldState, averagePrice: number, demandUnits: number): void {
  const { economy } = world;
  economy.priceIndex = averagePrice;
  economy.demandUnits = demandUnits;

  economy.priceIndexHistory.push(averagePrice);
  if (economy.priceIndexHistory.length > PRICE_HISTORY) economy.priceIndexHistory.shift();

  const history = economy.priceIndexHistory;
  if (history.length > 365) {
    const yearAgo = history[history.length - 366]!;
    economy.inflationAnnual = yearAgo > 0 ? averagePrice / yearAgo - 1 : 0;
  } else if (history.length > 45) {
    const first = history[0]!;
    const days = history.length - 1;
    economy.inflationAnnual = first > 0 ? Math.pow(averagePrice / first, 365 / days) - 1 : 0;
  }
}
