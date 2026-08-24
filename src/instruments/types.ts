import type { Money } from '../core/money.js';
import type { Posting } from '../ledger/ledger.js';
import type { Day } from '../core/time.js';
import type { CreditGrade, EntityId } from '../world/types.js';

export type InstrumentStatus = 'active' | 'matured' | 'defaulted' | 'closed';

/**
 * Every financial contract in the game -- loans, deposits, bonds, and whatever
 * gets added later -- is one of these. Behaviour lives in the registered
 * `InstrumentType` handler, so new products are new files, not new branches in
 * existing systems.
 */
export interface Instrument {
  id: string;
  /** Registry key of the handler that drives this contract. */
  type: string;
  /** The creditor: who owns the claim. */
  holderId: EntityId;
  /** The debtor: who owes. For deposits this is the bank. */
  obligorId: EntityId;

  principal: Money;
  outstanding: Money;
  /** Annual nominal rate. */
  rate: number;
  /** Interest accrued since the last payment date. */
  accrued: Money;

  openedOn: Day;
  maturesOn?: Day;
  nextPaymentOn?: Day;
  paymentIntervalMonths?: number;

  status: InstrumentStatus;
  grade?: CreditGrade;
  /** Handler-specific fields. */
  data: Record<string, number | string | boolean>;
}

export interface InstrumentType {
  key: string;
  category: 'loan' | 'deposit' | 'bond' | string;
  label: string;

  /** Called once when the contract is created, after the opening postings. */
  onOpen?(ctx: InstrumentContext, inst: Instrument): void;
  /**
   * Daily interest. Updates the contract's own `accrued` figure, but *returns*
   * its ledger postings rather than writing them, so the lifecycle system can
   * net every instrument in the economy into a single transaction.
   */
  accrue?(ctx: InstrumentContext, inst: Instrument): Posting[] | void;
  /** On `nextPaymentOn`. Moves cash and amortises principal. */
  onPayment?(ctx: InstrumentContext, inst: Instrument): void;
  /** On `maturesOn`. */
  onMature?(ctx: InstrumentContext, inst: Instrument): void;
  /** When the obligor defaults. */
  onDefault?(ctx: InstrumentContext, inst: Instrument): void;

  /** Basel-style risk weight for the holder's capital calculation. */
  riskWeight?(inst: Instrument): number;
  /** Share of the balance that counts as high-quality liquid assets. */
  hqlaFactor?(inst: Instrument): number;
  /** Share assumed to run off within 30 days, for the liquidity ratio. */
  outflowFactor?(inst: Instrument): number;
}

/** The slice of the simulation an instrument handler is allowed to see. */
export interface InstrumentContext {
  tick: Day;
  world: import('../world/state.js').WorldState;
  ledger: import('../ledger/ledger.js').LedgerState;
  emit: import('../world/events.js').Emitter;
  rng(stream: string): import('../core/rng.js').Rng;
}
