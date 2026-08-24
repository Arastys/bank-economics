import { registerBondTypes } from './bond.js';
import { registerDepositTypes } from './deposit.js';
import { registerLoanTypes } from './loan.js';
import { registerPoolLoanType } from './poolLoan.js';
import { instrumentTypes } from './registry.js';

let registered = false;

/** Register the built-in products. Safe to call more than once. */
export function registerBuiltinInstruments(): void {
  if (registered) return;
  registered = true;
  registerLoanTypes();
  registerPoolLoanType();
  registerDepositTypes();
  registerBondTypes();
}

export { instrumentTypes };
export * from './types.js';
export * from './loan.js';
export * from './poolLoan.js';
export * from './deposit.js';
export * from './bond.js';
