import { ZERO, allocate, type Money } from '../core/money.js';
import { nextId } from '../core/ids.js';
import { identityRng } from '../core/rng.js';
import { addMonths } from '../core/time.js';
import { AC, depositCode } from '../ledger/accounts.js';
import { naturalBalance } from '../ledger/ledger.js';
import { DEPOSIT_INSTANT } from '../instruments/deposit.js';
import { LOAN_POOL } from '../instruments/poolLoan.js';
import { addInstrument, cohorts, entitiesOfKind, heldBy, owedBy, type WorldState } from '../world/state.js';
import type { Cohort, CompanyArchetype, CreditGrade, PersonArchetype } from '../world/types.js';

/**
 * Contracts behind the latent economy's balance sheet.
 *
 * A cohort's deposits and borrowings are real ledger balances, and until this
 * they were the largest inert thing in the model: £7.6bn of borrowing that
 * paid nobody anything, next to deposits that mostly did earn. The banking
 * sector paid for its funding and earned nothing on its lending, which is not
 * a calibration problem but a missing contract. See `docs/FLOWS.md`.
 *
 * Idempotent, so a save that predates it can be brought forward by calling it
 * again.
 */
export function seedLatentContracts(world: WorldState): void {
  const rivals = entitiesOfKind(world, 'bank').filter((bank) => !bank.isPlayer);
  const weights = rivals.map((bank) => naturalBalance(world.ledger, bank.id, AC.CUSTOMER_DEPOSITS));

  for (const cohort of cohorts(world)) {
    if (!cohort.bankId) continue;
    openPoolDeposit(world, cohort);
    openPoolBorrowing(world, cohort, rivals, weights);
  }
}

/**
 * Somewhere for the pool's cash to earn. Company cohorts had no deposit
 * contract at all, which is half of why the asymmetry ran the way it did.
 */
function openPoolDeposit(world: WorldState, cohort: Cohort): void {
  const bankId = cohort.bankId!;
  const already = heldBy(world, cohort.id).some(
    (inst) => inst.type === DEPOSIT_INSTANT && inst.obligorId === bankId && inst.status === 'active',
  );
  if (already) return;

  addInstrument(world, {
    id: nextId(world.ids, 'dep'),
    type: DEPOSIT_INSTANT,
    holderId: cohort.id,
    obligorId: bankId,
    principal: ZERO,
    outstanding: ZERO,
    rate: depositRate(world, bankId),
    accrued: ZERO,
    openedOn: world.tick,
    nextPaymentOn: addMonths(world.tick, 1),
    paymentIntervalMonths: 1,
    status: 'active',
    data: {},
  });
}

/**
 * The pool's borrowing, split across the rest of the market in proportion to
 * the deposits each rival funds itself with.
 *
 * Which rival carries which pool is arbitrary -- this debt predates the game
 * and has no history to consult -- but the split is not: any other one hands
 * a bank a loan book with no funding behind it. The player is left out
 * deliberately, so its book starts purely corporate and retail lending stays
 * an extension point rather than an opening position.
 */
function openPoolBorrowing(
  world: WorldState,
  cohort: Cohort,
  rivals: { id: string }[],
  weights: number[],
): void {
  if (owedBy(world, cohort.id).some((inst) => inst.type === LOAN_POOL && inst.status === 'active')) {
    return;
  }
  const owed = naturalBalance(world.ledger, cohort.id, AC.BORROWINGS);
  if (owed <= 0 || rivals.length === 0) return;

  const shares = allocate(owed as Money, weights);
  rivals.forEach((bank, i) => {
    const amount = shares[i] ?? ZERO;
    if (amount <= 0) return;
    // Priced the way a promoted member's carved-out debt is priced, so a firm
    // does not get a different rate for being looked at more closely.
    const rng = identityRng(world.seed, `pool:${cohort.id}:${bank.id}`);
    const spread = 0.015 + rng() * 0.02;

    addInstrument(world, {
      id: nextId(world.ids, 'loan'),
      type: LOAN_POOL,
      holderId: bank.id,
      obligorId: cohort.id,
      principal: amount,
      outstanding: amount,
      rate: bankRate(world) + spread,
      accrued: ZERO,
      openedOn: world.tick,
      nextPaymentOn: addMonths(world.tick, 1),
      paymentIntervalMonths: 1,
      status: 'active',
      grade: gradeOf(cohort),
      data: { share: amount / owed, spread, legacy: true },
    });
  });
}

function gradeOf(cohort: Cohort): CreditGrade {
  return cohort.memberKind === 'company'
    ? (cohort.archetype as CompanyArchetype).creditGrade
    : (cohort.archetype as PersonArchetype).creditGrade;
}

function bankRate(world: WorldState): number {
  const cb = world.entities[world.centralBankId];
  return cb?.kind === 'centralBank' ? cb.bankRate : 0.05;
}

/**
 * What a bank pays a pool on its cash. The rest of the market pays a fraction
 * of Bank Rate; the player pays whatever the player has set.
 */
function depositRate(world: WorldState, bankId: string): number {
  const bank = world.entities[bankId];
  if (bank?.kind === 'bank' && bank.isPlayer) return bank.policy.depositRate;
  return bankRate(world) * 0.6;
}
