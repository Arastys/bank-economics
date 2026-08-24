import { ZERO, add, ratio, round, scale, type Money } from '../core/money.js';
import { AC, isDepositCode } from '../ledger/accounts.js';
import { accountsOf, naturalBalance, type LedgerState } from '../ledger/ledger.js';
import { balanceSheet } from '../ledger/statements.js';
import { instrumentTypes } from '../instruments/registry.js';
import { heldBy, owedBy, type WorldState } from '../world/state.js';
import type { EntityId } from '../world/types.js';

/**
 * The prudential view of the bank.
 *
 * These are computed and reported but not yet enforced -- the point of having
 * them from the start is that the hook exists, so adding consequences (a PRA
 * intervention, a dividend block, a resolution event) is a change of one
 * system rather than a change of the whole model.
 */
export interface RegulatoryMetrics {
  /** Common equity tier 1: the loss-absorbing capital. */
  cet1: Money;
  /** Risk-weighted assets. */
  rwa: Money;
  capitalRatio: number;
  totalAssets: Money;
  leverageRatio: number;
  /** High quality liquid assets. */
  hqla: Money;
  /** Assumed 30-day net outflow under stress. */
  netOutflows: Money;
  /** Liquidity coverage ratio. */
  lcr: number;
  /** Deposits inside the FSCS limit -- the bill the scheme would face. */
  protectedDeposits: Money;
  /** Bank's own funding from the central bank. */
  centralBankFunding: Money;
}

export function regulatoryMetrics(world: WorldState, ledger: LedgerState, bankId: EntityId): RegulatoryMetrics {
  const sheet = balanceSheet(ledger, bankId);
  const cet1 = sheet.totalEquity;

  let rwa = 0;
  let instrumentAssets = 0;
  let hqla = naturalBalance(ledger, bankId, AC.RESERVES) + naturalBalance(ledger, bankId, AC.CASH);

  for (const inst of heldBy(world, bankId)) {
    if (inst.status !== 'active') continue;
    const type = instrumentTypes.tryGet(inst.type);
    if (!type) continue;
    const exposure = add(inst.outstanding, inst.accrued);
    instrumentAssets += exposure;
    rwa += exposure * (type.riskWeight?.(inst) ?? 1);
    const liquidShare = type.hqlaFactor?.(inst) ?? 0;
    if (liquidShare > 0) {
      const price = world.markets.bondPrices[inst.id] ?? 1;
      hqla += exposure * liquidShare * price;
    }
  }

  // Anything on the balance sheet that is not an instrument or reserves gets a
  // flat 100% weight, which is the conservative default.
  const otherAssets = Math.max(
    0,
    sheet.totalAssets - instrumentAssets - naturalBalance(ledger, bankId, AC.RESERVES) - naturalBalance(ledger, bankId, AC.CASH),
  );
  rwa += otherAssets;

  let netOutflows = 0;
  for (const inst of owedBy(world, bankId)) {
    if (inst.status !== 'active') continue;
    const type = instrumentTypes.tryGet(inst.type);
    netOutflows += inst.outstanding * (type?.outflowFactor?.(inst) ?? 0);
  }
  // Deposits with no explicit product record still run in a stress.
  const bookedDeposits = owedBy(world, bankId)
    .filter((i) => i.status === 'active' && i.type.startsWith('deposit.'))
    .reduce((total, i) => total + i.outstanding, 0);
  const totalDeposits = naturalBalance(ledger, bankId, AC.CUSTOMER_DEPOSITS);
  netOutflows += Math.max(0, totalDeposits - bookedDeposits) * 0.1;

  return {
    cet1,
    rwa: round(rwa),
    capitalRatio: rwa > 0 ? cet1 / rwa : cet1 > 0 ? 1 : 0,
    totalAssets: sheet.totalAssets,
    leverageRatio: sheet.totalAssets > 0 ? ratio(cet1, sheet.totalAssets) : 0,
    hqla: round(hqla),
    netOutflows: round(netOutflows),
    lcr: netOutflows > 0 ? hqla / netOutflows : hqla > 0 ? 10 : 0,
    protectedDeposits: protectedDeposits(world, ledger, bankId),
    centralBankFunding: naturalBalance(ledger, bankId, AC.CENTRAL_BANK_FUNDING),
  };
}

/** Total covered by the FSCS: each depositor protected up to the limit. */
export function protectedDeposits(world: WorldState, ledger: LedgerState, bankId: EntityId): Money {
  const limit = world.config.depositProtectionLimit;
  let total = 0;
  for (const id in world.entities) {
    const entity = world.entities[id]!;
    if (entity.kind === 'bank' || entity.kind === 'centralBank') continue;
    let held = 0;
    for (const account of accountsOf(ledger, id)) {
      if (isDepositCode(account.code) && account.code.endsWith(`@${bankId}`)) held += account.balance;
    }
    if (held <= 0) continue;
    // A cohort stands for many depositors, so the limit applies per member.
    const perDepositor = entity.kind === 'cohort' && entity.count > 0 ? held / entity.count : held;
    const covered = Math.min(perDepositor, limit) * (entity.kind === 'cohort' ? entity.count : 1);
    total += covered;
  }
  return round(total);
}

/** What one more loan would do to the capital ratio. */
export function capitalRatioAfter(current: RegulatoryMetrics, exposure: Money, riskWeight: number): number {
  const rwa = add(current.rwa, scale(exposure, riskWeight));
  return rwa > 0 ? current.cet1 / rwa : current.cet1 > 0 ? 1 : 0;
}

export const NO_CAPITAL = ZERO;
