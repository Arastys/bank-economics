import { ZERO, add, type Money } from '../core/money.js';
import { bernoulli, hashString } from '../core/rng.js';
import { AC } from '../ledger/accounts.js';
import { naturalBalance } from '../ledger/ledger.js';
import { estimatePd, gradeFromPd, refreshFinancials } from '../agents/credit.js';
import type { InstrumentContext } from '../instruments/types.js';
import { windUpBorrower } from '../instruments/loan.js';
import { cohorts, resolvedCompanies } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

/** Baseline rate at which latent firms fail and are replaced. */
const COHORT_CHURN = 0.00004;
/** Borrowers are re-scored once a week, spread evenly across it. */
const REVIEW_CYCLE = 7;

function reviewDay(id: string): number {
  return hashString(id) % REVIEW_CYCLE;
}

/**
 * Credit risk.
 *
 * Resolved borrowers get an individual probability of default that responds to
 * their own accounts and to the cycle, and a daily draw against it. Latent
 * firms churn statistically -- nobody's balance sheet is examined until they
 * matter to the player.
 */
export const creditRiskSystem = defineSystem({
  id: 'risk.credit',
  phase: PHASE.CREDIT_RISK,
  description: 'Scores borrowers, then decides who fails',
  run(ctx) {
    const { world, ledger } = ctx;
    const rng = ctx.rng('risk.credit');

    for (const company of resolvedCompanies(world)) {
      if (company.status === 'defaulted') continue;

      // Credit reviews are staggered through the week rather than run on every
      // borrower every day: it is both cheaper and closer to how a bank works.
      if (reviewDay(company.id) === ctx.tick % REVIEW_CYCLE) {
        refreshFinancials(ledger, company, ctx.tick);
        // Smooth the estimate, so a grade reflects a trend rather than one
        // noisy month and the customer list is not a wall of downgrades.
        company.pdAnnual = company.pdAnnual * 0.75 + estimatePd(world, company) * 0.25;
        const grade = gradeFromPd(company.pdAnnual);
        if (grade !== company.creditGrade) {
          ctx.emit('company.gradeChanged', { companyId: company.id, from: company.creditGrade, to: grade });
          company.creditGrade = grade;
        }
      }

      const debt = naturalBalance(ledger, company.id, AC.BORROWINGS);
      if (debt <= 0) continue;

      // A firm with no debt cannot default on anyone, so only the indebted draw.
      if (!bernoulli(rng, company.pdAnnual / 365)) continue;

      // This is a business failure, not a cash-flow wobble, so the firm is
      // wound up outright rather than offered the work-out that an illiquid
      // but solvent borrower would get.
      const ictx: InstrumentContext = {
        tick: ctx.tick,
        world,
        ledger,
        emit: ctx.emit,
        rng: ctx.rng,
      };
      const exposure = windUpBorrower(ictx, company.id);

      ctx.emit('notice', {
        severity: exposure > 0 ? 'warning' : 'info',
        message: `${company.name} has failed`,
      });
    }

    // Firms are born and die inside the pools too, which keeps the latent
    // population from being a static backdrop.
    for (const cohort of cohorts(world)) {
      if (cohort.memberKind !== 'company' || cohort.count <= 0) continue;
      const churn = cohort.count * COHORT_CHURN * (1 - Math.min(0.8, world.economy.outputGap * 2));
      if (churn > 0 && bernoulli(rng, Math.min(0.5, churn))) {
        // NOTE: this only sheds headcount. It is not firm demography -- nothing
        // in the model creates firms, so `cohort.count` only ever falls, and the
        // firm population declines by roughly 0.7% a year with no offsetting
        // births. Invisible over a two-year game, corrosive over twenty.
        // See docs/ROADMAP.md.
        const shed = Math.max(1, Math.round(cohort.count * 0.001));
        cohort.pool.employees = Math.max(0, (cohort.pool.employees ?? 0) - shed);
      }
    }
  },
});
