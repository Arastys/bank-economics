import { ZERO, add, round, scale, sub, type Money } from '../core/money.js';
import { nextId } from '../core/ids.js';
import { addMonths, addYears, dailyRate, yearFraction, type Day } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { credit, debit, post, type Posting } from '../ledger/ledger.js';
import { addInstrument, transferHolder, touch, type WorldState } from '../world/state.js';
import { payBetween } from '../world/transfer.js';
import { walletOf } from '../world/wallet.js';
import type { CreditGrade, EntityId } from '../world/types.js';
import { instrumentTypes } from './registry.js';
import type { Instrument, InstrumentContext, InstrumentType } from './types.js';

export const BOND_FIXED = 'bond.fixed';

export interface IssueBondArgs {
  issuerId: EntityId;
  /** The initial investor. */
  holderId: EntityId;
  nominal: Money;
  couponRate: number;
  termYears: number;
  grade?: CreditGrade;
  /** Gilts get a zero risk weight and count fully as liquid assets. */
  sovereign?: boolean;
}

/** Issue a bond at par and place it with the initial investor. */
export function issueBond(ctx: InstrumentContext, args: IssueBondArgs): Instrument {
  const { world, ledger, tick } = ctx;
  const id = nextId(world.ids, 'bond');
  const maturesOn = addYears(tick, args.termYears);

  payBetween(world, ledger, {
    tick,
    kind: 'bond.issue',
    description: `Issue of ${id}`,
    amount: args.nominal,
    fromId: args.holderId,
    fromContra: AC.BONDS,
    toId: args.issuerId,
    toContra: AC.DEBT_ISSUED,
    refs: { bondId: id },
  });

  const inst = addInstrument(world, {
    id,
    type: BOND_FIXED,
    holderId: args.holderId,
    obligorId: args.issuerId,
    principal: args.nominal,
    outstanding: args.nominal,
    rate: args.couponRate,
    accrued: ZERO,
    openedOn: tick,
    maturesOn,
    nextPaymentOn: addMonths(tick, 6),
    paymentIntervalMonths: 6,
    status: 'active',
    ...(args.grade ? { grade: args.grade } : {}),
    data: { sovereign: args.sovereign ?? false, termYears: args.termYears },
  });

  world.markets.bondPrices[id] = 1;
  ctx.emit('bond.issued', {
    bondId: id,
    issuerId: args.issuerId,
    amount: args.nominal,
    couponRate: args.couponRate,
    maturesOn,
  });
  return inst;
}

function accrueCoupon(_ctx: InstrumentContext, inst: Instrument): Posting[] {
  const interest = scale(inst.outstanding, dailyRate(inst.rate));
  if (interest === 0) return [];
  inst.accrued = add(inst.accrued, interest);
  return [
    debit(inst.holderId, AC.INTEREST_RECEIVABLE, interest),
    credit(inst.holderId, AC.INTEREST_INCOME, interest),
    debit(inst.obligorId, AC.INTEREST_EXPENSE, interest),
    credit(inst.obligorId, AC.INTEREST_PAYABLE, interest),
  ];
}

function payCoupon(ctx: InstrumentContext, inst: Instrument): void {
  const amount = inst.accrued;
  if (amount > 0) {
    payBetween(ctx.world, ctx.ledger, {
      tick: ctx.tick,
      kind: 'bond.coupon',
      description: `Coupon on ${inst.id}`,
      amount,
      fromId: inst.obligorId,
      fromContra: AC.INTEREST_PAYABLE,
      toId: inst.holderId,
      toContra: AC.INTEREST_RECEIVABLE,
      refs: { bondId: inst.id },
    });
    inst.accrued = ZERO;
    ctx.emit('bond.couponPaid', { bondId: inst.id, amount });
  }
  inst.nextPaymentOn = addMonths(ctx.tick, inst.paymentIntervalMonths ?? 6);
}

function redeem(ctx: InstrumentContext, inst: Instrument): void {
  payCoupon(ctx, inst);
  const amount = inst.outstanding;
  if (amount > 0) {
    payBetween(ctx.world, ctx.ledger, {
      tick: ctx.tick,
      kind: 'bond.redeem',
      description: `Redemption of ${inst.id}`,
      amount,
      fromId: inst.obligorId,
      fromContra: AC.DEBT_ISSUED,
      toId: inst.holderId,
      toContra: AC.BONDS,
      refs: { bondId: inst.id },
    });
  }
  inst.outstanding = ZERO;
  inst.status = 'matured';
  delete ctx.world.markets.bondPrices[inst.id];
  ctx.emit('bond.redeemed', { bondId: inst.id, amount });
}

/**
 * Sell a whole holding to another investor at the given clean price.
 *
 * Bonds are carried at nominal, so any premium or discount is taken through
 * trading income on the trade date rather than amortised over the remaining
 * life. That is a deliberate simplification; amortised cost would slot in here.
 */
export function tradeBond(
  ctx: InstrumentContext,
  args: { bondId: string; buyerId: EntityId; cleanPrice: number },
): Money {
  const { world, ledger, tick } = ctx;
  const inst = world.instruments[args.bondId];
  if (!inst) throw new Error(`No bond "${args.bondId}"`);
  if (inst.status !== 'active') throw new Error(`Bond ${inst.id} is not tradeable`);

  const sellerId = inst.holderId;
  const nominal = inst.outstanding;
  const accrued = inst.accrued;
  const consideration = add(round(nominal * args.cleanPrice), accrued);
  const gain = sub(add(nominal, accrued), consideration);

  const buyerWallet = walletOf(world, args.buyerId);
  const sellerWallet = walletOf(world, sellerId);

  post(ledger, {
    tick,
    kind: 'bond.trade',
    description: `Trade in ${inst.id}`,
    refs: { bondId: inst.id, buyerId: args.buyerId, sellerId },
    postings: [
      credit(args.buyerId, buyerWallet.code, consideration),
      debit(args.buyerId, AC.BONDS, nominal),
      debit(args.buyerId, AC.INTEREST_RECEIVABLE, accrued),
      credit(args.buyerId, AC.TRADING_INCOME, gain),
      debit(sellerId, sellerWallet.code, consideration),
      credit(sellerId, AC.BONDS, nominal),
      credit(sellerId, AC.INTEREST_RECEIVABLE, accrued),
      debit(sellerId, AC.TRADING_INCOME, gain),
      ...settlementLegs(world, buyerWallet.bankId, sellerWallet.bankId, consideration),
    ],
  });

  transferHolder(world, inst.id, args.buyerId);
  touch(world, args.buyerId);
  ctx.emit('bond.traded', {
    bondId: inst.id,
    buyerId: args.buyerId,
    sellerId,
    nominal,
    price: args.cleanPrice,
    consideration,
  });
  return consideration;
}

/** Reserve movements when the two sides of a trade bank in different places. */
function settlementLegs(world: WorldState, buyerBank: EntityId | undefined, sellerBank: EntityId | undefined, amount: Money) {
  const legs = [];
  if (buyerBank && buyerBank !== sellerBank) {
    legs.push(debit(buyerBank, AC.CUSTOMER_DEPOSITS, amount));
    legs.push(credit(buyerBank, AC.RESERVES, amount));
  }
  if (sellerBank && sellerBank !== buyerBank) {
    legs.push(credit(sellerBank, AC.CUSTOMER_DEPOSITS, amount));
    legs.push(debit(sellerBank, AC.RESERVES, amount));
  }
  return legs;
}

/**
 * Clean price per £1 nominal: coupons and principal discounted at the
 * risk-free curve plus the issuer's credit spread.
 */
export function priceBond(world: WorldState, inst: Instrument, tick: Day): number {
  if (!inst.maturesOn || inst.status !== 'active') return 1;
  const years = Math.max(0, yearFraction(tick, inst.maturesOn));
  if (years <= 0) return 1;

  const riskFree = interpolateCurve(world.markets.yieldCurve, years);
  const spread = inst.data.sovereign ? 0 : world.markets.creditSpreads[inst.grade ?? 'BBB'] ?? 0.02;
  const y = Math.max(0.0001, riskFree + spread);

  // Semi-annual coupons, valued as a continuous approximation at long tenors.
  const periods = Math.max(1, Math.round(years * 2));
  const couponPerPeriod = inst.rate / 2;
  const yPerPeriod = y / 2;
  let pv = 0;
  for (let k = 1; k <= periods; k++) {
    pv += couponPerPeriod / Math.pow(1 + yPerPeriod, k);
  }
  pv += 1 / Math.pow(1 + yPerPeriod, periods);
  return pv;
}

export function interpolateCurve(curve: Record<number, number>, years: number): number {
  const tenors = Object.keys(curve)
    .map(Number)
    .sort((a, b) => a - b);
  if (tenors.length === 0) return 0;
  const first = tenors[0]!;
  const last = tenors[tenors.length - 1]!;
  if (years <= first) return curve[first]!;
  if (years >= last) return curve[last]!;
  for (let i = 0; i < tenors.length - 1; i++) {
    const lo = tenors[i]!;
    const hi = tenors[i + 1]!;
    if (years >= lo && years <= hi) {
      const t = (years - lo) / (hi - lo);
      return curve[lo]! * (1 - t) + curve[hi]! * t;
    }
  }
  return curve[last]!;
}

const RISK_WEIGHT_BY_GRADE: Record<CreditGrade, number> = {
  AAA: 0.2,
  AA: 0.2,
  A: 0.5,
  BBB: 0.5,
  BB: 1.0,
  B: 1.0,
  CCC: 1.5,
};

const fixedRateBond: InstrumentType = {
  key: BOND_FIXED,
  category: 'bond',
  label: 'Fixed rate bond',
  accrue: accrueCoupon,
  onPayment: payCoupon,
  onMature: redeem,
  riskWeight(inst) {
    if (inst.data.sovereign) return 0;
    return RISK_WEIGHT_BY_GRADE[inst.grade ?? 'BBB'] ?? 1;
  },
  hqlaFactor(inst) {
    if (inst.data.sovereign) return 1;
    const grade = inst.grade ?? 'BBB';
    return grade === 'AAA' || grade === 'AA' || grade === 'A' ? 0.85 : 0;
  },
};

export function registerBondTypes(): void {
  instrumentTypes.register(BOND_FIXED, fixedRateBond);
}
