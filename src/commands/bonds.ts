import { type Money } from '../core/money.js';
import { err, ok } from '../core/result.js';
import { issueBond, tradeBond } from '../instruments/bond.js';
import { spendable } from '../world/transfer.js';
import { playerBank } from '../world/state.js';
import { defineCommand, type Command } from './types.js';

export interface BuyBond extends Command {
  type: 'bond.buy';
  bondId: string;
}

export const buyBond = defineCommand<BuyBond>({
  type: 'bond.buy',
  label: 'Buy bond',
  validate(ctx, command) {
    const bond = ctx.world.instruments[command.bondId];
    if (!bond) return err('No such bond');
    if (!bond.type.startsWith('bond.')) return err('That instrument is not a bond');
    if (bond.status !== 'active') return err('Bond is no longer trading');
    if (bond.holderId === ctx.world.playerBankId) return err('You already hold this bond');

    const price = ctx.world.markets.bondPrices[command.bondId] ?? 1;
    const cost = Math.round(bond.outstanding * price) + bond.accrued;
    if (cost > spendable(ctx.world, ctx.ledger, ctx.world.playerBankId)) {
      return err('Not enough liquidity to settle the trade');
    }
    return ok();
  },
  apply(ctx, command) {
    const price = ctx.world.markets.bondPrices[command.bondId] ?? 1;
    tradeBond(
      { tick: ctx.tick, world: ctx.world, ledger: ctx.ledger, emit: ctx.emit, rng: ctx.rng },
      { bondId: command.bondId, buyerId: ctx.world.playerBankId, cleanPrice: price },
    );
  },
});

export interface SellBond extends Command {
  type: 'bond.sell';
  bondId: string;
  /** Defaults to the aggregate rival bank, which always makes a price. */
  buyerId?: string;
}

export const sellBond = defineCommand<SellBond>({
  type: 'bond.sell',
  label: 'Sell bond',
  validate(ctx, command) {
    const bond = ctx.world.instruments[command.bondId];
    if (!bond) return err('No such bond');
    if (bond.holderId !== ctx.world.playerBankId) return err('You do not hold this bond');
    if (bond.status !== 'active') return err('Bond is no longer trading');
    return ok();
  },
  apply(ctx, command) {
    const price = ctx.world.markets.bondPrices[command.bondId] ?? 1;
    tradeBond(
      { tick: ctx.tick, world: ctx.world, ledger: ctx.ledger, emit: ctx.emit, rng: ctx.rng },
      {
        bondId: command.bondId,
        buyerId: command.buyerId ?? ctx.world.otherBanksId,
        cleanPrice: price,
      },
    );
  },
});

export interface IssueOwnBond extends Command {
  type: 'bond.issueOwn';
  amount: Money;
  /** Annual coupon. Priced too low and the market will not take it. */
  couponRate: number;
  termYears: number;
}

/**
 * Wholesale funding: the bank issues its own paper. Cheaper than chasing
 * retail deposits when rates are low, but it runs off at maturity whether or
 * not that is convenient.
 */
export const issueOwnBond = defineCommand<IssueOwnBond>({
  type: 'bond.issueOwn',
  label: 'Issue bank bond',
  validate(ctx, command) {
    if (command.amount <= 0) return err('Issue size must be positive');
    if (command.termYears < 1 || command.termYears > 30) return err('Term must be 1 to 30 years');
    const fair = fairCoupon(ctx.world, command.termYears);
    if (command.couponRate < fair - 0.005) {
      return err(`Investors will not take this below about ${((fair - 0.005) * 100).toFixed(2)}%`);
    }
    return ok();
  },
  apply(ctx, command) {
    const bank = playerBank(ctx.world);
    issueBond(
      { tick: ctx.tick, world: ctx.world, ledger: ctx.ledger, emit: ctx.emit, rng: ctx.rng },
      {
        issuerId: bank.id,
        holderId: ctx.world.otherBanksId,
        nominal: command.amount,
        couponRate: command.couponRate,
        termYears: command.termYears,
        grade: 'A',
      },
    );
  },
});

/** What the market would want for the bank's own paper at this tenor. */
export function fairCoupon(world: import('../world/state.js').WorldState, termYears: number): number {
  const tenors = Object.keys(world.markets.yieldCurve).map(Number).sort((a, b) => a - b);
  let riskFree = world.markets.yieldCurve[tenors[tenors.length - 1] ?? 10] ?? 0.04;
  for (const tenor of tenors) {
    if (tenor >= termYears) {
      riskFree = world.markets.yieldCurve[tenor]!;
      break;
    }
  }
  return riskFree + (world.markets.creditSpreads.A ?? 0.01);
}
