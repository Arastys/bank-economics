import './bank.js';
import './credit.js';
import './bonds.js';

import type { SetCreditPolicy, SetDepositRate, SetLendingSpread } from './bank.js';
import type { ApproveCredit, DeclineCredit } from './credit.js';
import type { BuyBond, IssueOwnBond, SellBond } from './bonds.js';

/**
 * Everything the player can ask the bank to do.
 *
 * Keeping this as a union rather than a loose `{ type: string }` means a
 * mistyped payload is a compile error at the call site -- including from the
 * dashboard, which is otherwise the easiest place to get one wrong.
 */
export type GameCommand =
  | SetDepositRate
  | SetLendingSpread
  | SetCreditPolicy
  | ApproveCredit
  | DeclineCredit
  | BuyBond
  | SellBond
  | IssueOwnBond;

export * from './types.js';
export * from './bank.js';
export * from './credit.js';
export * from './bonds.js';
