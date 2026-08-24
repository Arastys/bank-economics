import { ZERO, scale, type Money } from '../core/money.js';
import { nextId } from '../core/ids.js';
import { bernoulli, randInt } from '../core/rng.js';
import { addMonths, isBusinessDay } from '../core/time.js';
import { promoteMember } from '../agents/lod.js';
import type { SimContext } from '../engine/context.js';
import { cohorts, resolvedCompanies, touch } from '../world/state.js';
import type { CreditApplication } from '../world/state.js';
import type { CompanyArchetype, EntityId } from '../world/types.js';
import { PHASE, defineSystem } from './system.js';


/**
 * Where the player's deal flow comes from.
 *
 * Resolved firms apply when they are short of money. Latent firms inside
 * cohorts generate demand statistically -- and because you cannot lend to
 * something that does not exist yet, an application from the pool materialises
 * a real company first. Interacting with the player is precisely what pulls an
 * agent up into full detail.
 */
export const creditDemandSystem = defineSystem({
  id: 'credit.demand',
  phase: PHASE.CREDIT_DEMAND,
  description: 'Firms ask to borrow; latent firms are materialised when they do',
  run(ctx) {
    if (!isBusinessDay(ctx.tick)) return;
    const { world } = ctx;
    const rng = ctx.rng('credit.demand');
    let created = 0;

    for (const company of resolvedCompanies(world)) {
      if (created >= world.config.maxNewApplicationsPerDay) break;
      if (company.status === 'defaulted') continue;
      if (company.fundingNeed <= 0) continue;
      if (company.applicationId && world.applications[company.applicationId]?.status === 'pending') continue;

      const banksWithPlayer = company.bankId === world.playerBankId;
      if (!banksWithPlayer && !bernoulli(rng, world.config.shopAroundChance)) continue;

      submitApplication(ctx, {
        applicantId: company.id,
        lenderId: world.playerBankId,
        amount: company.fundingNeed,
        termMonths: randInt(rng, 12, 60),
        purpose: 'workingCapital',
      });
      created++;
    }

    for (const cohort of cohorts(world)) {
      if (created >= world.config.maxNewApplicationsPerDay) break;
      if (cohort.memberKind !== 'company' || cohort.count <= 0) continue;

      // Demand is stronger when the economy is running hot.
      const cyclical = 1 + Math.max(-0.6, Math.min(1.5, world.economy.outputGap * 3));
      const expected = cohort.count * world.config.cohortApplicationRate * cyclical;
      let n = Math.floor(expected);
      if (bernoulli(rng, expected - n)) n++;

      for (let i = 0; i < n && created < world.config.maxNewApplicationsPerDay; i++) {
        const promoted = promoteMember(ctx, cohort.id, 'credit application');
        if (!promoted || promoted.entity.kind !== 'company') continue;
        const company = promoted.entity;
        const archetype = cohort.archetype as CompanyArchetype;
        const monthlyWages = scale(
          (company.employees * archetype.meanWagePerEmployee) as Money,
          21,
        );
        const amount = scale(monthlyWages, 0.5 + rng() * 2.5);
        company.fundingNeed = amount;
        submitApplication(ctx, {
          applicantId: company.id,
          lenderId: world.playerBankId,
          amount,
          termMonths: randInt(rng, 12, 84),
          purpose: rng() < 0.4 ? 'investment' : 'workingCapital',
        });
        created++;
      }
    }
  },
});

export function submitApplication(
  ctx: SimContext,
  args: {
    applicantId: EntityId;
    lenderId: EntityId;
    amount: Money;
    termMonths: number;
    purpose: CreditApplication['purpose'];
  },
): CreditApplication {
  const { world } = ctx;
  const applicant = world.entities[args.applicantId];
  const grade =
    applicant && (applicant.kind === 'company' || applicant.kind === 'person')
      ? applicant.creditGrade
      : 'BB';
  const pdAnnual =
    applicant && (applicant.kind === 'company' || applicant.kind === 'person')
      ? applicant.pdAnnual
      : 0.03;

  const application: CreditApplication = {
    id: nextId(world.ids, 'app'),
    applicantId: args.applicantId,
    lenderId: args.lenderId,
    amount: args.amount,
    termMonths: args.termMonths,
    purpose: args.purpose,
    grade,
    pdAnnual,
    submittedOn: world.tick,
    expiresOn: world.tick + world.config.applicationValidityDays,
    status: 'pending',
  };

  world.applications[application.id] = application;
  if (applicant?.kind === 'company') applicant.applicationId = application.id;
  touch(world, args.applicantId);

  ctx.emit('credit.applicationSubmitted', {
    applicationId: application.id,
    applicantId: args.applicantId,
    amount: args.amount,
    termMonths: args.termMonths,
    grade,
  });
  return application;
}

export const NO_DEMAND = ZERO;
export const applicationMaturity = addMonths;
