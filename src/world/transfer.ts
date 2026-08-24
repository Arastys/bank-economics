import { atLeastZero, type Money } from '../core/money.js';
import { AC, depositCode, type AccountCode } from '../ledger/accounts.js';
import { balance, credit, debit, post, type LedgerState, type Posting } from '../ledger/ledger.js';
import type { WorldState } from './state.js';
import type { EntityId } from './types.js';
import { bankOf, walletOf } from './wallet.js';

export interface TransferArgs {
  amount: Money;
  fromId: EntityId;
  /** What the payer books the outflow against. */
  fromContra: AccountCode;
  toId: EntityId;
  /** What the payee books the inflow against. */
  toContra: AccountCode;
}

/**
 * The postings for one payment, routed correctly for who is paying whom.
 *
 * Three cases: a customer paying its own bank, a bank paying its own customer,
 * and everything else, which settles through the payment system (moving
 * reserves between banks when the two sides bank in different places).
 */
export function paymentPostings(world: WorldState, args: TransferArgs): Posting[] {
  const { amount, fromId, toId, fromContra, toContra } = args;
  if (amount === 0) return [];

  const payerBank = bankOf(world, fromId);
  const payeeBank = bankOf(world, toId);

  // Customer pays its own bank: the bank's deposit liability simply shrinks.
  if (payerBank && toId === payerBank) {
    return [
      credit(fromId, depositCode(payerBank), amount),
      debit(fromId, fromContra, amount),
      debit(payerBank, AC.CUSTOMER_DEPOSITS, amount),
      credit(payerBank, toContra, amount),
    ];
  }

  // Bank pays its own customer: the deposit liability grows.
  if (payeeBank && fromId === payeeBank) {
    return [
      credit(payeeBank, AC.CUSTOMER_DEPOSITS, amount),
      debit(payeeBank, fromContra, amount),
      debit(toId, depositCode(payeeBank), amount),
      credit(toId, toContra, amount),
    ];
  }

  const payerWallet = walletOf(world, fromId);
  const payeeWallet = walletOf(world, toId);
  const postings: Posting[] = [
    credit(fromId, payerWallet.code, amount),
    debit(fromId, fromContra, amount),
    debit(toId, payeeWallet.code, amount),
    credit(toId, toContra, amount),
  ];

  if (payerBank && payerBank !== payeeBank) {
    postings.push(debit(payerBank, AC.CUSTOMER_DEPOSITS, amount));
    postings.push(credit(payerBank, AC.RESERVES, amount));
  }
  if (payeeBank && payeeBank !== payerBank) {
    postings.push(credit(payeeBank, AC.CUSTOMER_DEPOSITS, amount));
    postings.push(debit(payeeBank, AC.RESERVES, amount));
  }
  return postings;
}

/** Move money between two entities as a single transaction. */
export function payBetween(
  world: WorldState,
  ledger: LedgerState,
  args: TransferArgs & { tick: number; kind: string; description: string; refs?: Record<string, string> },
): void {
  const postings = paymentPostings(world, args);
  if (postings.length === 0) return;
  post(ledger, {
    tick: args.tick,
    kind: args.kind,
    description: args.description,
    refs: args.refs,
    postings,
  });
}

/**
 * Accumulates many small flows into one transaction.
 *
 * Wages and consumption touch every firm and every household cohort on every
 * tick. Batching keeps the journal readable and the tick cheap, without giving
 * up the guarantee that each flow is individually balanced.
 */
export class FlowBatch {
  private postings: Posting[] = [];
  private count = 0;

  constructor(private readonly world: WorldState, private readonly ledger: LedgerState) {}

  add(args: TransferArgs): this {
    const legs = paymentPostings(this.world, args);
    if (legs.length > 0) {
      this.postings.push(...legs);
      this.count++;
    }
    return this;
  }

  get size(): number {
    return this.count;
  }

  /** Post everything accumulated so far. Returns the number of flows written. */
  commit(tick: number, kind: string, description: string): number {
    if (this.postings.length === 0) return 0;
    // Net the postings by account so one transaction carries one line per account.
    const netted = new Map<string, Posting>();
    for (const p of this.postings) {
      const key = `${p.ownerId}/${p.code}`;
      const existing = netted.get(key);
      if (existing) existing.amount = (existing.amount + p.amount) as Money;
      else netted.set(key, { ...p });
    }
    post(this.ledger, {
      tick,
      kind,
      description,
      postings: [...netted.values()].filter((p) => p.amount !== 0),
    });
    const written = this.count;
    this.postings = [];
    this.count = 0;
    return written;
  }
}

export interface MarketLeg {
  id: EntityId;
  amount: Money;
  /** What this party books its side against: an expense, revenue, an asset. */
  contra: AccountCode;
}

/**
 * Settle a whole market in one netted transaction.
 *
 * Wages and the goods market each involve thousands of participants paying
 * thousands of others. Writing every pair as its own flow is both unreadable
 * and quadratic, so instead each participant gets one leg and each bank in the
 * middle gets a single net movement in deposits and reserves.
 *
 * The identity each bank has to satisfy is:
 *
 *   change in reserves = change in deposits - what the bank itself paid
 *                        + what the bank itself received
 *
 * which is what keeps every set of books balanced whether the bank is merely
 * clearing its customers' payments or is a party to the trade itself.
 */
export function clearMarket(
  world: WorldState,
  ledger: LedgerState,
  args: {
    tick: number;
    kind: string;
    description: string;
    payers: MarketLeg[];
    payees: MarketLeg[];
  },
): void {
  const postings: Posting[] = [];
  const depositChange = new Map<EntityId, number>();
  const reserveChange = new Map<EntityId, number>();

  const bump = (map: Map<EntityId, number>, key: EntityId, delta: number): void => {
    map.set(key, (map.get(key) ?? 0) + delta);
  };

  let paid = 0;
  for (const leg of args.payers) {
    if (leg.amount === 0) continue;
    paid += leg.amount;
    const settlement = settlementBank(world, leg.id);
    postings.push(debit(leg.id, leg.contra, leg.amount));
    if (settlement === leg.id) {
      // The bank is paying out of its own pocket.
      bump(reserveChange, settlement, -leg.amount);
    } else {
      postings.push(credit(leg.id, depositCode(settlement), leg.amount));
      bump(depositChange, settlement, -leg.amount);
      bump(reserveChange, settlement, -leg.amount);
    }
  }

  let received = 0;
  for (const leg of args.payees) {
    if (leg.amount === 0) continue;
    received += leg.amount;
    const settlement = settlementBank(world, leg.id);
    postings.push(credit(leg.id, leg.contra, leg.amount));
    if (settlement === leg.id) {
      bump(reserveChange, settlement, leg.amount);
    } else {
      postings.push(debit(leg.id, depositCode(settlement), leg.amount));
      bump(depositChange, settlement, leg.amount);
      bump(reserveChange, settlement, leg.amount);
    }
  }

  if (paid !== received) {
    throw new Error(`clearMarket "${args.kind}": payers total ${paid}p but payees total ${received}p`);
  }

  for (const [bankId, delta] of depositChange) {
    if (delta !== 0) postings.push(credit(bankId, AC.CUSTOMER_DEPOSITS, delta as Money));
  }
  for (const [bankId, delta] of reserveChange) {
    if (delta !== 0) postings.push(debit(bankId, AC.RESERVES, delta as Money));
  }

  if (postings.length === 0) return;
  post(ledger, {
    tick: args.tick,
    kind: args.kind,
    description: args.description,
    postings: postings.filter((p) => p.amount !== 0),
  });
}

/**
 * Which account settles for this party: its bank, or its own reserve account
 * if it holds one. Market clearing needs every participant inside the
 * settlement system, so a party with neither is refused rather than quietly
 * leaking money out of the ledger.
 */
function settlementBank(world: WorldState, id: EntityId): EntityId {
  const bank = bankOf(world, id);
  if (bank) return bank;
  const entity = world.entities[id];
  if (entity && (entity.kind === 'bank' || entity.kind === 'government' || entity.kind === 'centralBank')) {
    return id;
  }
  throw new Error(`${id} holds neither a bank account nor reserves, so it cannot settle in a cleared market`);
}

/** Money the entity could spend today. */
export function spendable(world: WorldState, ledger: LedgerState, id: EntityId): Money {
  const wallet = walletOf(world, id);
  return atLeastZero(balance(ledger, id, wallet.code));
}
