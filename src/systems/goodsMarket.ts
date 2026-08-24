import { ZERO, add, allocate, atLeastZero, min, round, scale, type Money } from '../core/money.js';
import { isBusinessDay } from '../core/time.js';
import { AC, type AccountCode } from '../ledger/accounts.js';
import { balance, credit, debit, post, type LedgerState } from '../ledger/ledger.js';
import { clearMarket, spendable, type MarketLeg } from '../world/transfer.js';
import { realRateGap, type SimConfig, type WorldState } from '../world/state.js';
import {
  firmViews,
  personViews,
  totalWageBill,
  abilityByRegion,
  abilityOf,
  type FirmView,
  type PersonView,
} from '../agents/views.js';
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
 * Two kinds of demand meet one pool of output: people spending wages and
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
  description: 'Clears person and investment demand against firm output',
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
    for (const person of personViews(world)) person.lastIncome = ZERO;

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
  const rateGap = realRateGap(world);
  const ability = abilityByRegion(world);

  for (const person of personViews(world)) {
    // People budget from a smoothed income figure rather than from what
    // landed today. Otherwise spending collapses every weekend, firms see
    // wild swings in sell-through, and prices oscillate for no real reason.
    person.incomeRate = round(
      person.incomeRate * (1 - world.config.incomeSmoothing) +
        person.lastIncome * world.config.incomeSmoothing,
    );
    const savings = spendable(world, ledger, person.id);
    const budget = poolBudget(person, savings, world.config, rateGap);
    if (budget > 0) buyers.push({ id: person.id, budget, contra: AC.CONSUMPTION });
  }

  const appetite = investmentAppetite(world);
  for (const firm of firms) {
    // Only firms with a month of wages in hand put money into capacity.
    const monthlyWages = scale(totalWageBill(firm, abilityOf(ability, firm.region)), 21);
    const cash = spendable(world, ledger, firm.id);
    if (cash <= monthlyWages) continue;
    const budget = min(
      round(firm.recentRevenue * world.config.investmentRate * appetite),
      (cash - monthlyWages) as Money,
    );
    if (budget > 0) buyers.push({ id: firm.id, budget, contra: AC.FIXED_ASSETS });
  }

  return buyers;
}

/**
 * What a person puts on the counter today.
 *
 * Saving is the gap to a target buffer, not a fixed share of income. A fixed
 * share never stops: people hold back the same slice of every wage packet
 * and only trickle the pot back out, so the firm sector hands over more cash
 * than it takes, every day, for ever. Nothing in a year or two of trading
 * shows it -- it took eight simulated years for firm cash to fall from £2.9bn
 * to £90m and unemployment to reach 61% with nothing else wrong.
 *
 * With a buffer, saving is zero once the buffer is full, and a person
 * sitting on more than it wants spends the excess down.
 */
export function consumptionBudget(
  propensityToConsume: number,
  incomeRate: Money,
  bufferBase: Money,
  savings: Money,
  config: SimConfig,
  rateGap = 0,
): Money {
  // `bufferBase` is the income the cushion is measured against, which is not
  // always the income being spent from: somebody out of work still defends a
  // cushion sized to the living they are used to. It must stay a fast-moving
  // figure. Keying the buffer to a slow one -- a year's smoothing, so it holds
  // its level through a downturn -- looks like prudence and behaves like a long
  // lag in a feedback loop: spending fell against a cushion that had not
  // noticed, and inflation volatility went from 4.4 to 59.6.
  const buffer = bufferBase * config.savingsBufferDays;
  const wanted = round(
    propensityOutOfIncome(propensityToConsume, config, rateGap) * incomeRate +
      config.savingsAdjustment * (savings - buffer),
  );
  // Nobody spends money they do not have, and nobody spends less than nothing.
  return min(atLeastZero(wanted), atLeastZero(savings));
}

/**
 * What a person -- or a pool of them -- puts on the counter today.
 *
 * A pool is not one average person, and averaging its members is not a
 * harmless simplification. Its employed members draw a wage and its unemployed
 * members draw nothing, and the two spend very differently: somebody out of
 * work is a long way below the cushion they are defending, so the savings term
 * turns sharply negative and they cut hard. Blending them into one imaginary
 * person on the mean income hides that entirely, which is most of why a
 * downturn here used to cost output without anybody visibly tightening their
 * belt.
 *
 * Savings are assumed shared evenly per head within a pool, which is a
 * simplification and a generous one: in reality the newly unemployed hold less
 * than average.
 */
export function poolBudget(
  person: PersonView,
  savings: Money,
  config: SimConfig,
  rateGap: number,
): Money {
  // Adults only. A child has no finances of its own: it eats out of the same
  // budget as the adults it lives with, so it is a mouth rather than a
  // separate decision. Counting children as budget units of their own made
  // each of them defend a cushion nobody was saving for, and since a shortfall
  // is floored at zero rather than netted off, a hundred thousand of those
  // floors was pure demand out of nowhere -- inflation volatility went from
  // 4.2 to 39.0 when demography first arrived.
  const heads = Math.max(0, person.count - person.children);
  if (heads <= 0) return ZERO;
  const working = Math.max(0, Math.min(heads, person.employed));
  const idle = heads - working;
  if (idle <= 0.5 || working <= 0) {
    return consumptionBudget(
      person.propensityToConsume,
      person.incomeRate,
      person.incomeRate,
      savings,
      config,
      rateGap,
    );
  }

  const perHeadSavings = (savings / heads) as Money;
  // The wage bill lands on the employed, so they each draw more than the pool
  // average. The cushion is per head either way: being out of work does not
  // lower the living somebody is used to.
  const perHeadIncome = (person.incomeRate / heads) as Money;
  const perWorkerIncome = (person.incomeRate / working) as Money;

  const employedEach = consumptionBudget(
    person.propensityToConsume,
    perWorkerIncome,
    perHeadIncome,
    perHeadSavings,
    config,
    rateGap,
  );
  const idleEach = consumptionBudget(
    person.propensityToConsume,
    ZERO,
    perHeadIncome,
    perHeadSavings,
    config,
    rateGap,
  );
  return atLeastZero(round(working * employedEach + idle * idleEach));
}

/**
 * The share of income a person spends rather than saves, once the return on
 * saving is taken into account. This is the consumption half of monetary
 * transmission.
 *
 * It shifts the saving *rate*, which is a flow, and deliberately not the
 * target buffer, which is a stock. Re-targeting a stock looks equivalent and
 * is not: asking for a tenth more buffer asks people to withhold eighteen
 * days of income, all at once, and hand it back just as abruptly when rates
 * fall. Built that way first, it gave the committee real traction and wrecked
 * the economy doing it -- 8% unemployment at a sensitivity of 1 and 21% at 4,
 * because a persistently positive real rate gap holds the stock target
 * permanently high and that is a level effect, not a stabiliser.
 *
 * Bounded because the committee must not be able to switch spending off.
 */
export function propensityOutOfIncome(
  base: number,
  config: SimConfig,
  rateGap: number,
): number {
  return Math.max(0.3, Math.min(1.2, base - config.savingsRateSensitivity * rateGap));
}

/**
 * How keen firms are to put money into capacity, as a multiple of normal.
 *
 * Dear money postpones a capacity decision and cheap money brings it forward.
 * Floored at zero because a firm cannot invest a negative amount, and capped
 * because free money is not infinite appetite.
 */
export function investmentAppetite(world: WorldState): number {
  const factor = 1 - world.config.investmentRateSensitivity * realRateGap(world);
  return Math.max(0, Math.min(2, factor));
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
 * Prices respond to three things: what the goods cost to make, whether today's
 * stock cleared, and whether the stockroom is filling or emptying.
 *
 * The cost anchor is the one that stops the economy dying. Trading conditions
 * alone say nothing about whether a price covers the wages that went into the
 * goods, so pay -- which is indexed to inflation and to how tight the labour
 * market is -- could rise straight through the price and leave the entire firm
 * sector selling below cost. Nobody with negative earnings can service a loan,
 * so the credit market then closes, firms cannot fund payroll, and the whole
 * thing unwinds. It took ten simulated years to become obvious and was
 * invisible at three.
 *
 * Trading conditions still decide how fast a firm moves and how far it strays,
 * so this is a target to be pulled towards rather than a price to be posted.
 */
export function adjustPrice(
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

  const unitCost = unitProductionCost(firm);
  const target = unitCost * (1 + config.targetMarkup * firm.pricingDiscipline);
  const costGap = clampUnit((target - firm.price) / Math.max(1, firm.price));

  const trading = config.demandPriceWeight * demandGap + (1 - config.demandPriceWeight) * stockGap;
  const move = config.costAnchorWeight * costGap + (1 - config.costAnchorWeight) * trading;

  const floor = Math.max(1, Math.round(unitCost * (1 + config.minMarkup)));
  firm.price = Math.max(floor, Math.round(firm.price * (1 + config.priceAdjustment * move))) as Money;
}

/** What one unit costs to make, in wages. */
export function unitProductionCost(firm: FirmView): number {
  return firm.productivity > 0 ? firm.wagePerEmployee / firm.productivity : firm.wagePerEmployee;
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
