import { ZERO, scale, sub, type Money } from '../core/money.js';
import { err, ok, type Result } from '../core/result.js';
import { meetsGrade } from '../agents/credit.js';
import { switchBank } from '../agents/lod.js';
import type { SimContext } from '../engine/context.js';
import { LOAN_AMORTISING, levelPayment, originateLoan } from '../instruments/loan.js';
import { instrumentTypes } from '../instruments/registry.js';
import { capitalRatioAfter, regulatoryMetrics, type RegulatoryMetrics } from '../metrics/regulatory.js';
import { getEntity, owedBy, playerBank, type CreditApplication } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

export interface UnderwritingDecision {
  approve: boolean;
  rate: number;
  reason: string;
}

/**
 * The credit committee.
 *
 * Runs the bank's stated policy over every application on the desk. With
 * `autoUnderwrite` off, applications simply sit there until the player decides
 * them by command -- same code path, different trigger.
 */
export const underwritingSystem = defineSystem({
  id: 'credit.underwriting',
  phase: PHASE.UNDERWRITING,
  description: 'Decides pending credit applications against the bank credit policy',
  run(ctx) {
    const { world } = ctx;
    // The capital position is read once per pass rather than per application:
    // recomputing it for every case on the desk dominates the tick, and the
    // committee working from this morning's figures is realistic anyway.
    const snapshot = regulatoryMetrics(world, ctx.ledger, world.playerBankId, {
      includeDepositProtection: false,
    });

    for (const id of Object.keys(world.applications)) {
      const app = world.applications[id]!;
      if (app.status !== 'pending') continue;

      if (ctx.tick > app.expiresOn) {
        app.status = 'expired';
        clearApplicant(ctx, app);
        ctx.emit('credit.applicationExpired', { applicationId: app.id });
        continue;
      }

      const isPlayer = app.lenderId === world.playerBankId;
      if (isPlayer && !playerBank(world).policy.autoUnderwrite) continue;

      const decision = assessApplication(ctx, app, isPlayer ? snapshot : undefined);
      if (decision.approve) approveApplication(ctx, app, decision.rate);
      else declineApplication(ctx, app, decision.reason);
    }
  },
});

/** Run the bank's policy over an application without committing to anything. */
export function assessApplication(
  ctx: SimContext,
  app: CreditApplication,
  capital?: RegulatoryMetrics,
): UnderwritingDecision {
  const { world } = ctx;
  const lender = getEntity(world, app.lenderId);
  if (lender.kind !== 'bank') return { approve: false, rate: 0, reason: 'Lender is not a bank' };
  const policy = lender.policy;
  const bankRate = getEntity(world, world.centralBankId);
  const base = bankRate.kind === 'centralBank' ? bankRate.bankRate : 0.05;
  const spread = policy.lendingSpread[app.grade] ?? 0.05;
  const rate = base + spread;

  if (!meetsGrade(app.grade, policy.minimumGrade)) {
    return { approve: false, rate, reason: `Grade ${app.grade} is below policy minimum ${policy.minimumGrade}` };
  }
  if (app.amount > policy.maxSingleExposure) {
    return { approve: false, rate, reason: 'Exceeds single exposure limit' };
  }

  const affordability = assessAffordability(ctx, app, rate);
  if (!affordability.ok) return { approve: false, rate, reason: affordability.error };

  const metrics = capital ?? regulatoryMetrics(world, ctx.ledger, lender.id);
  const weight = instrumentTypes.get(LOAN_AMORTISING).riskWeight?.({ grade: app.grade } as never) ?? 1;
  const after = capitalRatioAfter(metrics, app.amount, weight);
  if (after < policy.targetCapitalRatio) {
    return {
      approve: false,
      rate,
      reason: `Would take capital ratio to ${(after * 100).toFixed(1)}%`,
    };
  }

  return { approve: true, rate, reason: 'Meets credit policy' };
}

/**
 * Can the borrower actually service this?
 *
 * Existing commitments plus the new loan, measured against monthly earnings.
 * A firm with no earnings cannot service anything, however good its grade
 * looks on paper.
 */
function assessAffordability(ctx: SimContext, app: CreditApplication, rate: number): Result {
  const lender = getEntity(ctx.world, app.lenderId);
  if (lender.kind !== 'bank') return err('Lender is not a bank');
  const applicant = ctx.world.entities[app.applicantId];
  if (!applicant || applicant.kind !== 'company') return ok();

  const monthlyEarnings = Math.round(applicant.financials.ebitda / 12);
  if (monthlyEarnings <= 0) return err('No earnings to service the debt');

  let committed = 0;
  for (const inst of owedBy(ctx.world, app.applicantId)) {
    if (inst.status !== 'active' || !inst.type.startsWith('loan.')) continue;
    committed += Number(inst.data.monthlyPayment ?? 0) || scale(inst.outstanding, inst.rate / 12);
  }
  const proposed = levelPayment(app.amount, rate / 12, app.termMonths);
  const ratio = (committed + proposed) / monthlyEarnings;

  if (ratio > lender.policy.maxDebtServiceRatio) {
    return err(
      `Debt service would be ${(ratio * 100).toFixed(0)}% of earnings, above the ${(
        lender.policy.maxDebtServiceRatio * 100
      ).toFixed(0)}% limit`,
    );
  }
  return ok();
}

export function approveApplication(ctx: SimContext, app: CreditApplication, rate: number): void {
  const { world } = ctx;
  const applicant = getEntity(world, app.applicantId);

  // Money is advanced into an account with the lending bank, so winning the
  // loan wins the banking relationship too.
  if ((applicant.kind === 'company' || applicant.kind === 'household') && applicant.bankId !== app.lenderId) {
    switchBank(ctx, applicant.id, app.lenderId);
  }

  const loan = originateLoan(
    { tick: ctx.tick, world, ledger: ctx.ledger, emit: ctx.emit, rng: ctx.rng },
    {
      lenderId: app.lenderId,
      borrowerId: app.applicantId,
      amount: app.amount,
      rate,
      termMonths: app.termMonths,
      grade: app.grade,
      type: LOAN_AMORTISING,
    },
  );

  app.status = 'approved';
  app.offeredRate = rate;
  app.decisionReason = 'Approved';
  if (applicant.kind === 'company') {
    applicant.fundingNeed = ZERO;
    delete applicant.applicationId;
  }
  ctx.emit('credit.applicationApproved', { applicationId: app.id, loanId: loan.id, rate });
}

export function declineApplication(ctx: SimContext, app: CreditApplication, reason: string): void {
  app.status = 'declined';
  app.decisionReason = reason;
  clearApplicant(ctx, app);
  ctx.emit('credit.applicationDeclined', { applicationId: app.id, reason });
}

function clearApplicant(ctx: SimContext, app: CreditApplication): void {
  const applicant = ctx.world.entities[app.applicantId];
  if (applicant?.kind === 'company' && applicant.applicationId === app.id) {
    delete applicant.applicationId;
  }
}

export const NO_OFFER: Money = sub(ZERO, ZERO);
